import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createProtectedReadyProbe, ReadyBarrierError } from "./cloud/ready-barrier.mjs";

export const CLOUD_API_PORT = 4200;
export const DEFAULT_API_HEAP_MB = 512;
export const DEFAULT_WEB_HEAP_MB = 192;
export const MAX_COMBINED_HEAP_MB = 704;
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
export const DEFAULT_FORCE_EXIT_MS = 12_000;
export const DEFAULT_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_READY_INTERVAL_MS = 250;

export const BUNDLE_STATES = Object.freeze({
  CREATED: "created",
  API_STARTING: "api-starting",
  WAITING_READY: "waiting-ready",
  WEB_STARTING: "web-starting",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
  FAILED: "failed"
});

const privatePlans = new WeakMap();
const require = createRequire(import.meta.url);

export function loadBundleRuntime(env = process.env) {
  requireValue(env.NODE_ENV, "NODE_ENV", "production");
  requireValue(env.APP_ENV, "APP_ENV", "production");
  requireValue(env.DEPLOYMENT_MODE, "DEPLOYMENT_MODE", "cloud_container");
  requireValue(env.AUTH_PROVIDER, "AUTH_PROVIDER", "supabase");
  requireValue(env.STORAGE_PROVIDER, "STORAGE_PROVIDER", "supabase");

  const webPort = boundedInteger(env.PORT, "PORT", 1_024, 65_535, 8_000);
  const apiPort = boundedInteger(env.API_INTERNAL_PORT, "API_INTERNAL_PORT", CLOUD_API_PORT, CLOUD_API_PORT, CLOUD_API_PORT);
  if (webPort === apiPort) throw new Error("PORT must differ from the fixed loopback API port 4200.");

  const apiHeapMb = boundedInteger(env.API_NODE_MAX_OLD_SPACE_MB, "API_NODE_MAX_OLD_SPACE_MB", 256, 576, DEFAULT_API_HEAP_MB);
  const webHeapMb = boundedInteger(env.WEB_NODE_MAX_OLD_SPACE_MB, "WEB_NODE_MAX_OLD_SPACE_MB", 128, 256, DEFAULT_WEB_HEAP_MB);
  if (apiHeapMb + webHeapMb > MAX_COMBINED_HEAP_MB) {
    throw new Error(`API and Web old-space limits must total at most ${MAX_COMBINED_HEAP_MB} MB in the 1GB container.`);
  }
  rejectUnsafeNodeOptions(env.NODE_OPTIONS);

  const releaseGitSha = fullReleaseId(env.RELEASE_GIT_SHA, "RELEASE_GIT_SHA");
  const imageReleaseGitSha = fullReleaseId(env.IMAGE_RELEASE_GIT_SHA, "IMAGE_RELEASE_GIT_SHA");
  if (imageReleaseGitSha !== releaseGitSha) {
    throw new Error("RELEASE_GIT_SHA must match the immutable image source revision.");
  }
  requireProbeToken(env.INTERNAL_PROBE_TOKEN);

  return Object.freeze({
    webPort,
    apiPort,
    apiHeapMb,
    webHeapMb,
    releaseGitSha,
    readyUrl: `http://127.0.0.1:${CLOUD_API_PORT}/api/health/ready`,
    readyTimeoutMs: boundedInteger(
      env.BUNDLE_READY_TIMEOUT_MS,
      "BUNDLE_READY_TIMEOUT_MS",
      1_000,
      120_000,
      DEFAULT_READY_TIMEOUT_MS
    ),
    readyIntervalMs: boundedInteger(
      env.BUNDLE_READY_INTERVAL_MS,
      "BUNDLE_READY_INTERVAL_MS",
      50,
      5_000,
      DEFAULT_READY_INTERVAL_MS
    ),
    shutdownGraceMs: boundedInteger(
      env.BUNDLE_SHUTDOWN_GRACE_MS,
      "BUNDLE_SHUTDOWN_GRACE_MS",
      1_000,
      DEFAULT_SHUTDOWN_GRACE_MS,
      DEFAULT_SHUTDOWN_GRACE_MS
    )
  });
}

export function createLaunchPlan(env = process.env, {
  resolveRuntimeFingerprint = deriveRuntimeConfigFingerprint
} = {}) {
  const baseRuntime = loadBundleRuntime(env);
  const runtime = Object.freeze({
    ...baseRuntime,
    runtimeConfigFingerprint: fixedHex(
      resolveRuntimeFingerprint({ ...env }),
      64,
      "derived runtime config fingerprint"
    )
  });
  const webEnvironment = {
    NODE_ENV: "production",
    APP_ENV: "production",
    DEPLOYMENT_MODE: "cloud_container",
    PORT: String(runtime.webPort),
    API_INTERNAL_PORT: String(CLOUD_API_PORT),
    HOSTNAME: "0.0.0.0",
    RELEASE_GIT_SHA: runtime.releaseGitSha,
    IMAGE_RELEASE_GIT_SHA: env.IMAGE_RELEASE_GIT_SHA,
    NODE_OPTIONS: withHeapLimit(env.NODE_OPTIONS, runtime.webHeapMb)
  };
  copyOptionalEnvironment(env, webEnvironment, ["NEXT_TELEMETRY_DISABLED", "TZ"]);

  const children = Object.freeze([
    Object.freeze({ name: "api", executable: process.execPath, args: Object.freeze(["apps/api/dist/main.js"]) }),
    Object.freeze({ name: "web", executable: process.execPath, args: Object.freeze(["apps/web/server.js"]) })
  ]);
  const plan = Object.freeze({
    runtime,
    readiness: Object.freeze({
      url: runtime.readyUrl,
      releaseGitSha: runtime.releaseGitSha,
      runtimeConfigFingerprint: runtime.runtimeConfigFingerprint
    }),
    children
  });
  privatePlans.set(plan, {
    probeToken: env.INTERNAL_PROBE_TOKEN,
    environments: new Map([
      ["api", {
        ...env,
        PORT: String(CLOUD_API_PORT),
        API_INTERNAL_PORT: String(CLOUD_API_PORT),
        HOSTNAME: "127.0.0.1",
        RELEASE_GIT_SHA: runtime.releaseGitSha,
        NODE_OPTIONS: withHeapLimit(env.NODE_OPTIONS, runtime.apiHeapMb)
      }],
      ["web", webEnvironment]
    ])
  });
  return plan;
}

function copyOptionalEnvironment(source, target, keys) {
  for (const key of keys) {
    if (typeof source[key] === "string" && source[key].length > 0) target[key] = source[key];
  }
}

export function launchBundle({
  env = process.env,
  spawnProcess = spawn,
  processRef = process,
  fetchImpl = globalThis.fetch,
  probeReady,
  resolveRuntimeFingerprint = deriveRuntimeConfigFingerprint,
  sleep = abortableSleep,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = (record) => console.log(JSON.stringify(record)),
  logError = (record) => console.error(JSON.stringify(record))
} = {}) {
  const plan = createLaunchPlan(env, { resolveRuntimeFingerprint });
  const privatePlan = privatePlans.get(plan);
  const protectedProbe = probeReady ?? createProtectedReadyProbe({ fetchImpl });
  const childStates = new Map();
  const controller = new AbortController();
  let state = BUNDLE_STATES.CREATED;
  let stopping = false;
  let requestedSignal = null;
  let firstFailureCode = null;
  let killTimer = null;
  let forceExitTimer = null;
  let spawningComplete = false;
  let resolveCompletion;
  let resolveStopped;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });

  const transition = (next, code) => {
    state = next;
    log({ event: "bundle-state", state: next, code, releaseGitSha: plan.runtime.releaseGitSha });
  };

  const signalHandlers = {
    SIGINT: () => stop("SIGINT", "parent-signal"),
    SIGTERM: () => stop("SIGTERM", "parent-signal")
  };

  const finishIfComplete = () => {
    if (!spawningComplete) return;
    if ([...childStates.values()].some((childState) => !childState.finished)) return;
    if (killTimer) clearTimer(killTimer);
    if (forceExitTimer) clearTimer(forceExitTimer);
    for (const signal of ["SIGINT", "SIGTERM"]) processRef.off(signal, signalHandlers[signal]);
    const exitCode = requestedSignal ? 0 : (firstFailureCode ?? 1);
    processRef.exitCode = exitCode;
    transition(requestedSignal ? BUNDLE_STATES.STOPPED : BUNDLE_STATES.FAILED, "BUNDLE_COMPLETE");
    resolveCompletion({ exitCode, signal: requestedSignal });
  };

  const killUnfinished = (signal) => {
    for (const { child, finished } of childStates.values()) {
      if (finished) continue;
      try {
        child.kill(signal);
      } catch {
        logError({ event: "bundle-child-kill-failed", signal });
      }
    }
  };

  const stop = (signal = "SIGTERM", reason = "shutdown-requested") => {
    if (stopping) return;
    stopping = true;
    requestedSignal = reason === "parent-signal" ? signal : null;
    transition(BUNDLE_STATES.STOPPING, reason === "parent-signal" ? "BUNDLE_PARENT_SIGNAL" : "BUNDLE_FAILURE_STOP");
    controller.abort(new ReadyBarrierError("BUNDLE_STARTUP_STOPPED"));
    resolveStopped({ kind: "stopped" });
    log({ event: "bundle-stopping", reason, signal });
    killUnfinished(signal);
    killTimer = setTimer(() => {
      logError({ event: "bundle-forced-child-stop", signal: "SIGKILL" });
      killUnfinished("SIGKILL");
    }, plan.runtime.shutdownGraceMs);
    killTimer.unref?.();
    forceExitTimer = setTimer(() => {
      const exitCode = requestedSignal ? 0 : (firstFailureCode ?? 1);
      logError({ event: "bundle-forced-parent-exit", exitCode });
      processRef.exit(exitCode);
    }, Math.max(DEFAULT_FORCE_EXIT_MS, plan.runtime.shutdownGraceMs + 2_000));
    forceExitTimer.unref?.();
  };

  const spawnChild = (childPlan) => {
    const child = spawnProcess(childPlan.executable, childPlan.args, {
      env: privatePlan.environments.get(childPlan.name),
      stdio: "inherit"
    });
    if (!child || typeof child.once !== "function") throw new Error("BUNDLE_CHILD_SPAWN_INVALID");
    const childState = { child, finished: false };
    childStates.set(childPlan.name, childState);
    child.once("error", (error) => {
      if (childState.finished) return;
      childState.finished = true;
      firstFailureCode ??= 1;
      logError({
        event: "bundle-child-error",
        child: childPlan.name,
        code: typeof error?.code === "string" ? error.code : "SPAWN_ERROR"
      });
      stop("SIGTERM", "child-error");
      finishIfComplete();
    });
    child.once("exit", (code, signal) => {
      if (childState.finished) return;
      childState.finished = true;
      if (!stopping) {
        firstFailureCode = Number.isInteger(code) && code > 0 ? code : 1;
        logError({ event: "bundle-child-exit", child: childPlan.name, code, signal });
        stop("SIGTERM", "child-exit");
      }
      finishIfComplete();
    });
    log({
      event: "bundle-child-started",
      child: childPlan.name,
      pid: child.pid ?? null,
      releaseGitSha: plan.runtime.releaseGitSha
    });
    return child;
  };

  const waitForReadiness = async () => {
    const startedAt = now();
    while (true) {
      if (stopping) throw new ReadyBarrierError("BUNDLE_STARTUP_STOPPED");
      if (now() - startedAt >= plan.runtime.readyTimeoutMs) {
        throw new ReadyBarrierError("READY_BARRIER_TIMEOUT");
      }
      const outcome = await Promise.race([
        Promise.resolve(protectedProbe({
          url: plan.readiness.url,
          token: privatePlan.probeToken,
          releaseId: plan.readiness.releaseGitSha,
          runtimeConfigFingerprint: plan.readiness.runtimeConfigFingerprint,
          signal: controller.signal
        })).then((result) => ({ kind: "probe", result })),
        stopped
      ]);
      if (outcome.kind === "stopped") throw new ReadyBarrierError("BUNDLE_STARTUP_STOPPED");
      if (outcome.result?.ready === true) return;
      if (outcome.result?.retryable !== true) throw new ReadyBarrierError("READY_PROBE_TERMINAL_FAILURE");
      const remaining = plan.runtime.readyTimeoutMs - (now() - startedAt);
      if (remaining <= 0) throw new ReadyBarrierError("READY_BARRIER_TIMEOUT");
      const waitOutcome = await Promise.race([
        Promise.resolve(sleep(Math.min(plan.runtime.readyIntervalMs, remaining), controller.signal))
          .then(() => ({ kind: "waited" })),
        stopped
      ]);
      if (waitOutcome.kind === "stopped") throw new ReadyBarrierError("BUNDLE_STARTUP_STOPPED");
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"]) processRef.on(signal, signalHandlers[signal]);

  const startup = async () => {
    try {
      transition(BUNDLE_STATES.API_STARTING, "BUNDLE_API_SPAWN");
      spawnChild(plan.children[0]);
      transition(BUNDLE_STATES.WAITING_READY, "BUNDLE_PROTECTED_READY_WAIT");
      await waitForReadiness();
      if (stopping) throw new ReadyBarrierError("BUNDLE_STARTUP_STOPPED");
      transition(BUNDLE_STATES.WEB_STARTING, "BUNDLE_WEB_SPAWN");
      spawnChild(plan.children[1]);
      if (stopping) throw new ReadyBarrierError("BUNDLE_STARTUP_STOPPED");
      transition(BUNDLE_STATES.RUNNING, "BUNDLE_READY");
    } catch (error) {
      if (!stopping) {
        firstFailureCode ??= 1;
        logError({ event: "bundle-readiness-failed", code: safeFailureCode(error) });
        stop("SIGTERM", "readiness-failed");
      }
    } finally {
      spawningComplete = true;
      finishIfComplete();
    }
  };
  void startup();

  return {
    plan,
    get children() { return [...childStates.values()].map(({ child }) => child); },
    get state() { return state; },
    completion,
    stop
  };
}

function safeFailureCode(error) {
  if (error instanceof ReadyBarrierError) return error.code;
  return "BUNDLE_STARTUP_FAILED";
}

function requireValue(value, key, expected) {
  if (value?.trim().toLowerCase() !== expected) {
    throw new Error(`${key} must be ${expected} for the production cloud bundle.`);
  }
}

function boundedInteger(value, key, minimum, maximum, fallback) {
  const normalized = value?.trim() || String(fallback);
  if (!/^\d+$/.test(normalized)) throw new Error(`${key} must be an integer.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function fullReleaseId(value, key) {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(normalized)) {
    throw new Error(`${key} must be a full 40-character SHA-1 or 64-character SHA-256 commit id.`);
  }
  return normalized;
}

function fixedHex(value, length, key) {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(normalized)) {
    throw new Error(`${key} must be a ${length}-character lowercase hexadecimal value.`);
  }
  return normalized;
}

function deriveRuntimeConfigFingerprint(env) {
  const module = require("../apps/api/dist/common/http-security.config.js");
  if (typeof module.validateRuntimeEnvironment !== "function") {
    throw new Error("compiled runtime environment validator is unavailable.");
  }
  const normalized = module.validateRuntimeEnvironment(env);
  return normalized?.RUNTIME_CONFIG_FINGERPRINT;
}

function requireProbeToken(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32 || value.length > 256) {
    throw new Error("INTERNAL_PROBE_TOKEN must contain between 32 and 256 bytes.");
  }
}

function rejectUnsafeNodeOptions(value) {
  if (/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s|$)/i.test(value ?? "")) {
    throw new Error("NODE_OPTIONS must not set max-old-space-size; use the child-specific heap variables.");
  }
  if (/(?:^|\s)--inspect(?:[-_][^\s=]+)?(?:=|\s|$)/i.test(value ?? "")) {
    throw new Error("NODE_OPTIONS must not enable a production inspector listener.");
  }
}

function withHeapLimit(existing, heapMb) {
  return [existing?.trim(), `--max-old-space-size=${heapMb}`].filter(Boolean).join(" ");
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const bundle = launchBundle();
    await bundle.completion;
  } catch (error) {
    console.error(JSON.stringify({
      event: "bundle-config-rejected",
      message: error instanceof Error ? error.message : "Unknown launcher error."
    }));
    process.exitCode = 1;
  }
}
