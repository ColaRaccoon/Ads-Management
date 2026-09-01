import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const CLOUD_API_PORT = 4200;
export const DEFAULT_API_HEAP_MB = 512;
export const DEFAULT_WEB_HEAP_MB = 192;
export const MAX_COMBINED_HEAP_MB = 704;
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
export const DEFAULT_FORCE_EXIT_MS = 12_000;

export function loadBundleRuntime(env = process.env) {
  requireValue(env.NODE_ENV, "NODE_ENV", "production");
  requireValue(env.APP_ENV, "APP_ENV", "production");
  requireValue(env.DEPLOYMENT_MODE, "DEPLOYMENT_MODE", "cloud_container");
  requireValue(env.AUTH_PROVIDER, "AUTH_PROVIDER", "supabase");
  requireValue(env.STORAGE_PROVIDER, "STORAGE_PROVIDER", "supabase");

  const webPort = boundedInteger(env.PORT, "PORT", 1_024, 65_535, 8_000);
  const apiPort = boundedInteger(
    env.API_INTERNAL_PORT,
    "API_INTERNAL_PORT",
    CLOUD_API_PORT,
    CLOUD_API_PORT,
    CLOUD_API_PORT
  );
  if (webPort === apiPort) {
    throw new Error("PORT must differ from the fixed loopback API port 4200.");
  }

  const apiHeapMb = boundedInteger(
    env.API_NODE_MAX_OLD_SPACE_MB,
    "API_NODE_MAX_OLD_SPACE_MB",
    256,
    576,
    DEFAULT_API_HEAP_MB
  );
  const webHeapMb = boundedInteger(
    env.WEB_NODE_MAX_OLD_SPACE_MB,
    "WEB_NODE_MAX_OLD_SPACE_MB",
    128,
    256,
    DEFAULT_WEB_HEAP_MB
  );
  if (apiHeapMb + webHeapMb > MAX_COMBINED_HEAP_MB) {
    throw new Error(
      `API and Web old-space limits must total at most ${MAX_COMBINED_HEAP_MB} MB in the 1GB container.`
    );
  }
  rejectUnsafeNodeOptions(env.NODE_OPTIONS);

  const releaseGitSha = env.RELEASE_GIT_SHA?.trim().toLowerCase() ?? "";
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(releaseGitSha)) {
    throw new Error("RELEASE_GIT_SHA must be a full 40-character SHA-1 or 64-character SHA-256 commit id.");
  }
  const imageReleaseGitSha = env.IMAGE_RELEASE_GIT_SHA?.trim().toLowerCase() ?? "";
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(imageReleaseGitSha)) {
    throw new Error("IMAGE_RELEASE_GIT_SHA must identify the immutable image source revision.");
  }
  if (imageReleaseGitSha !== releaseGitSha) {
    throw new Error("RELEASE_GIT_SHA must match the immutable image source revision.");
  }

  return {
    webPort,
    apiPort,
    apiHeapMb,
    webHeapMb,
    releaseGitSha,
    shutdownGraceMs: boundedInteger(
      env.BUNDLE_SHUTDOWN_GRACE_MS,
      "BUNDLE_SHUTDOWN_GRACE_MS",
      1_000,
      DEFAULT_SHUTDOWN_GRACE_MS,
      DEFAULT_SHUTDOWN_GRACE_MS
    )
  };
}

export function createLaunchPlan(env = process.env) {
  const runtime = loadBundleRuntime(env);
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
  return {
    runtime,
    children: [
      {
        name: "api",
        executable: process.execPath,
        args: ["apps/api/dist/main.js"],
        env: {
          ...env,
          PORT: String(CLOUD_API_PORT),
          API_INTERNAL_PORT: String(CLOUD_API_PORT),
          HOSTNAME: "127.0.0.1",
          RELEASE_GIT_SHA: runtime.releaseGitSha,
          NODE_OPTIONS: withHeapLimit(env.NODE_OPTIONS, runtime.apiHeapMb)
        }
      },
      {
        name: "web",
        executable: process.execPath,
        args: ["apps/web/server.js"],
        env: webEnvironment
      }
    ]
  };
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
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = (record) => console.log(JSON.stringify(record)),
  logError = (record) => console.error(JSON.stringify(record))
} = {}) {
  const plan = createLaunchPlan(env);
  const childStates = new Map();
  let stopping = false;
  let requestedSignal = null;
  let firstFailureCode = null;
  let killTimer = null;
  let forceExitTimer = null;
  let spawningComplete = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });

  const signalHandlers = {
    SIGINT: () => stop("SIGINT", "parent-signal"),
    SIGTERM: () => stop("SIGTERM", "parent-signal")
  };

  const finishIfComplete = () => {
    if (!spawningComplete) return;
    if ([...childStates.values()].some((state) => !state.finished)) return;
    if (killTimer) clearTimer(killTimer);
    if (forceExitTimer) clearTimer(forceExitTimer);
    for (const signal of ["SIGINT", "SIGTERM"]) processRef.off(signal, signalHandlers[signal]);
    const exitCode = requestedSignal ? 0 : (firstFailureCode ?? 1);
    processRef.exitCode = exitCode;
    resolveCompletion({ exitCode, signal: requestedSignal });
  };

  const stop = (signal = "SIGTERM", reason = "shutdown-requested") => {
    if (stopping) return;
    stopping = true;
    requestedSignal = reason === "parent-signal" ? signal : null;
    log({ event: "bundle-stopping", reason, signal });
    for (const { child, finished } of childStates.values()) {
      if (!finished) child.kill(signal);
    }
    killTimer = setTimer(() => {
      logError({ event: "bundle-forced-child-stop", signal: "SIGKILL" });
      for (const { child, finished } of childStates.values()) {
        if (!finished) child.kill("SIGKILL");
      }
    }, plan.runtime.shutdownGraceMs);
    killTimer.unref?.();
    forceExitTimer = setTimer(() => {
      const exitCode = requestedSignal ? 0 : (firstFailureCode ?? 1);
      logError({ event: "bundle-forced-parent-exit", exitCode });
      processRef.exit(exitCode);
    }, Math.max(DEFAULT_FORCE_EXIT_MS, plan.runtime.shutdownGraceMs + 2_000));
    forceExitTimer.unref?.();
  };

  for (const signal of ["SIGINT", "SIGTERM"]) processRef.on(signal, signalHandlers[signal]);

  try {
    for (const childPlan of plan.children) {
      const child = spawnProcess(childPlan.executable, childPlan.args, {
        env: childPlan.env,
        stdio: "inherit"
      });
      const state = { child, finished: false };
      childStates.set(childPlan.name, state);
      child.once("error", (error) => {
        if (state.finished) return;
        state.finished = true;
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
        if (state.finished) return;
        state.finished = true;
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
    }
    spawningComplete = true;
    finishIfComplete();
  } catch {
    spawningComplete = true;
    firstFailureCode = 1;
    logError({ event: "bundle-spawn-failed" });
    stop("SIGTERM", "spawn-failed");
    if (childStates.size === 0) {
      for (const signal of ["SIGINT", "SIGTERM"]) processRef.off(signal, signalHandlers[signal]);
      processRef.exitCode = 1;
      resolveCompletion({ exitCode: 1, signal: null });
    }
    finishIfComplete();
  }

  return {
    plan,
    children: [...childStates.values()].map(({ child }) => child),
    completion,
    stop
  };
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

function rejectUnsafeNodeOptions(value) {
  if (/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s|$)/i.test(value ?? "")) {
    throw new Error(
      "NODE_OPTIONS must not set max-old-space-size; use the child-specific heap variables."
    );
  }
  if (/(?:^|\s)--inspect(?:[-_][^\s=]+)?(?:=|\s|$)/i.test(value ?? "")) {
    throw new Error("NODE_OPTIONS must not enable a production inspector listener.");
  }
}

function withHeapLimit(existing, heapMb) {
  return [existing?.trim(), `--max-old-space-size=${heapMb}`].filter(Boolean).join(" ");
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
