import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  BUNDLE_STATES,
  CLOUD_API_PORT,
  createLaunchPlan,
  launchBundle,
  loadBundleRuntime,
  MAX_COMBINED_HEAP_MB
} from "./launch-bundle.mjs";

const releaseGitSha = "25748e71a95a09990968e0f198c5fd877897dc88";
const runtimeConfigFingerprint = "b".repeat(64);
const probeToken = "internal-probe-token-with-more-than-thirty-two-bytes";

function cloudEnvironment(overrides = {}) {
  return {
    NODE_ENV: "production",
    APP_ENV: "production",
    DEPLOYMENT_MODE: "cloud_container",
    AUTH_PROVIDER: "supabase",
    STORAGE_PROVIDER: "supabase",
    PORT: "8000",
    API_INTERNAL_PORT: "4200",
    RELEASE_GIT_SHA: releaseGitSha,
    IMAGE_RELEASE_GIT_SHA: releaseGitSha,
    INTERNAL_PROBE_TOKEN: probeToken,
    ...overrides
  };
}

test("validates production identity, readiness contract, and 1GB heap budget", () => {
  const runtime = loadBundleRuntime(cloudEnvironment());
  assert.equal(runtime.webPort, 8000);
  assert.equal(runtime.apiPort, CLOUD_API_PORT);
  assert.equal(runtime.apiHeapMb + runtime.webHeapMb, MAX_COMBINED_HEAP_MB);
  assert.equal(runtime.readyUrl, "http://127.0.0.1:4200/api/health/ready");

  for (const [overrides, pattern] of [
    [{ DEPLOYMENT_MODE: "local_lan" }, /DEPLOYMENT_MODE must be cloud_container/],
    [{ AUTH_PROVIDER: "local" }, /AUTH_PROVIDER must be supabase/],
    [{ API_INTERNAL_PORT: "4300" }, /API_INTERNAL_PORT must be between 4200 and 4200/],
    [{ API_NODE_MAX_OLD_SPACE_MB: "520", WEB_NODE_MAX_OLD_SPACE_MB: "192" }, /must total at most 704 MB/],
    [{ NODE_OPTIONS: "--max-old-space-size=900" }, /must not set max-old-space-size/],
    [{ NODE_OPTIONS: "--inspect=0.0.0.0:9229" }, /must not enable a production inspector/],
    [{ IMAGE_RELEASE_GIT_SHA: "abcdef0" }, /must be a full 40-character SHA-1 or 64-character SHA-256/],
    [{ INTERNAL_PROBE_TOKEN: "too-short" }, /must contain between 32 and 256 bytes/]
  ]) {
    assert.throws(() => loadBundleRuntime(cloudEnvironment(overrides)), pattern);
  }
  assert.throws(
    () => createLaunchPlan(cloudEnvironment(), { resolveRuntimeFingerprint: () => "a".repeat(63) }),
    /derived runtime config fingerprint must be a 64-character lowercase hexadecimal/
  );
});

test("launch plan is non-secret evidence while child environments remain isolated", async () => {
  const secret = "database-secret-must-not-appear-in-evidence";
  const env = cloudEnvironment({
    PORT: "8443",
    DATABASE_URL: `postgresql://${secret}`,
    SUPABASE_SECRET_KEY: secret,
    SUPABASE_STORAGE_ACCESS_TOKEN: secret,
    AUTH_SESSION_HANDLE_SECRET: secret,
    AUTH_CSRF_SECRET: secret,
    INTERNAL_PROBE_TOKEN: `${secret}-probe-token-value-long-enough`,
    NEXT_TELEMETRY_DISABLED: "1"
  });
  const plan = createLaunchPlan(env, { resolveRuntimeFingerprint: () => runtimeConfigFingerprint });
  const serializedPlan = JSON.stringify(plan);
  assert.equal(serializedPlan.includes(secret), false);
  assert.deepEqual(plan.children.map(({ name, args }) => ({ name, args })), [
    { name: "api", args: ["apps/api/dist/main.js"] },
    { name: "web", args: ["apps/web/server.js"] }
  ]);

  let releaseProbe;
  const harness = createHarness({
    env,
    probeReady: async (input) => {
      releaseProbe = input;
      return { ready: true, retryable: false };
    }
  });
  const bundle = launchBundle(harness.options);
  await waitFor(() => bundle.state === BUNDLE_STATES.RUNNING);
  const [apiSpawn, webSpawn] = harness.spawns;
  assert.equal(apiSpawn.options.env.DATABASE_URL, `postgresql://${secret}`);
  assert.equal(webSpawn.options.env.DATABASE_URL, undefined);
  assert.equal(webSpawn.options.env.INTERNAL_PROBE_TOKEN, undefined);
  assert.equal(webSpawn.options.env.SUPABASE_SECRET_KEY, undefined);
  assert.equal(releaseProbe.token, env.INTERNAL_PROBE_TOKEN);
  assert.equal(releaseProbe.releaseId, releaseGitSha);
  assert.equal(releaseProbe.runtimeConfigFingerprint, runtimeConfigFingerprint);
  assert.equal(JSON.stringify(harness.logs).includes(secret), false);
  await terminateBundle(bundle, harness, "SIGTERM");
});

test("clean-source tests inject the fingerprint while the production default fails closed without compiled output", async (t) => {
  const env = cloudEnvironment();
  let resolverEnvironment;
  const plan = createLaunchPlan(env, {
    resolveRuntimeFingerprint(candidate) {
      resolverEnvironment = candidate;
      return runtimeConfigFingerprint;
    }
  });
  assert.notEqual(resolverEnvironment, env);
  assert.equal(resolverEnvironment.INTERNAL_PROBE_TOKEN, probeToken);
  assert.equal(plan.readiness.runtimeConfigFingerprint, runtimeConfigFingerprint);
  assert.match(plan.readiness.runtimeConfigFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(plan).includes(env.INTERNAL_PROBE_TOKEN), false);

  const isolatedRoot = await mkdtemp(path.join(tmpdir(), "meta-launch-clean-source-"));
  t.after(() => rm(isolatedRoot, { recursive: true, force: true }));
  const isolatedDeploy = path.join(isolatedRoot, "deploy");
  const isolatedCloud = path.join(isolatedDeploy, "cloud");
  await mkdir(isolatedCloud, { recursive: true });
  await Promise.all([
    copyFile(new URL("./launch-bundle.mjs", import.meta.url), path.join(isolatedDeploy, "launch-bundle.mjs")),
    copyFile(new URL("./cloud/ready-barrier.mjs", import.meta.url), path.join(isolatedCloud, "ready-barrier.mjs"))
  ]);
  const isolatedLauncher = await import(pathToFileURL(path.join(isolatedDeploy, "launch-bundle.mjs")).href);
  assert.throws(
    () => isolatedLauncher.createLaunchPlan(env),
    /compiled runtime environment validator is unavailable/
  );
});

test("spawns API first and does not spawn Web until exact protected-ready success", async () => {
  const ready = deferred();
  const harness = createHarness({ probeReady: () => ready.promise });
  const bundle = launchBundle(harness.options);
  assert.equal(bundle.state, BUNDLE_STATES.WAITING_READY);
  assert.equal(harness.children.length, 1);
  assert.deepEqual(harness.spawns[0].args, ["apps/api/dist/main.js"]);

  ready.resolve({ ready: true, retryable: false });
  await waitFor(() => bundle.state === BUNDLE_STATES.RUNNING);
  assert.equal(harness.children.length, 2);
  assert.deepEqual(harness.spawns[1].args, ["apps/web/server.js"]);
  await terminateBundle(bundle, harness, "SIGTERM");
});

test("API exit before readiness fails without ever spawning Web", async () => {
  const harness = createHarness({ probeReady: () => new Promise(() => {}) });
  const bundle = launchBundle(harness.options);
  harness.children[0].emit("exit", 0, null);
  const result = await bundle.completion;
  assert.deepEqual(result, { exitCode: 1, signal: null });
  assert.equal(harness.children.length, 1);
  assert.equal(bundle.state, BUNDLE_STATES.FAILED);
});

test("API exit after readiness stops Web and returns failure", async () => {
  const harness = createHarness();
  const bundle = launchBundle(harness.options);
  await waitFor(() => bundle.state === BUNDLE_STATES.RUNNING);
  harness.children[0].emit("exit", 7, null);
  assert.deepEqual(harness.children[1].kills, ["SIGTERM"]);
  harness.children[1].emit("exit", null, "SIGTERM");
  assert.deepEqual(await bundle.completion, { exitCode: 7, signal: null });
});

test("Web exit after readiness stops API and returns failure", async () => {
  const harness = createHarness();
  const bundle = launchBundle(harness.options);
  await waitFor(() => bundle.state === BUNDLE_STATES.RUNNING);
  harness.children[1].emit("exit", 0, null);
  assert.deepEqual(harness.children[0].kills, ["SIGTERM"]);
  harness.children[0].emit("exit", null, "SIGTERM");
  assert.deepEqual(await bundle.completion, { exitCode: 1, signal: null });
});

test("readiness timeout fails closed and terminates API", async () => {
  let clock = 0;
  const harness = createHarness({
    env: cloudEnvironment({ BUNDLE_READY_TIMEOUT_MS: "1000", BUNDLE_READY_INTERVAL_MS: "250" }),
    probeReady: async () => ({ ready: false, retryable: true }),
    sleep: async (ms) => { clock += ms; },
    now: () => clock
  });
  const bundle = launchBundle(harness.options);
  await waitFor(() => harness.children[0].kills.includes("SIGTERM"));
  assert.equal(harness.children.length, 1);
  assert.equal(findLogCode(harness.errors, "bundle-readiness-failed"), "READY_BARRIER_TIMEOUT");
  harness.children[0].emit("exit", null, "SIGTERM");
  assert.deepEqual(await bundle.completion, { exitCode: 1, signal: null });
});

test("401 and 403 protected-ready responses are terminal", async () => {
  for (const status of [401, 403]) {
    const harness = createHarness({
      useDefaultProbe: true,
      fetchImpl: async () => response(status, {})
    });
    const bundle = launchBundle(harness.options);
    await waitFor(() => harness.children[0].kills.includes("SIGTERM"));
    assert.equal(harness.children.length, 1);
    assert.equal(findLogCode(harness.errors, "bundle-readiness-failed"), "READY_PROBE_AUTH_REJECTED");
    harness.children[0].emit("exit", null, "SIGTERM");
    assert.deepEqual(await bundle.completion, { exitCode: 1, signal: null });
  }
});

test("503 retries and only a later exact 200 opens the Web barrier", async () => {
  let calls = 0;
  const harness = createHarness({
    useDefaultProbe: true,
    fetchImpl: async () => ++calls === 1
      ? response(503, {})
      : response(200, { status: "ready", releaseId: releaseGitSha, runtimeConfigFingerprint }),
    sleep: async () => {}
  });
  const bundle = launchBundle(harness.options);
  await waitFor(() => bundle.state === BUNDLE_STATES.RUNNING);
  assert.equal(calls, 2);
  assert.equal(harness.children.length, 2);
  await terminateBundle(bundle, harness, "SIGTERM");
});

test("release or fingerprint mismatch never opens the Web barrier", async () => {
  for (const [payload, code] of [
    [{ status: "ready", releaseId: "c".repeat(40), runtimeConfigFingerprint }, "READY_RELEASE_MISMATCH"],
    [{ status: "ready", releaseId: releaseGitSha, runtimeConfigFingerprint: "d".repeat(64) }, "READY_FINGERPRINT_MISMATCH"]
  ]) {
    const harness = createHarness({ useDefaultProbe: true, fetchImpl: async () => response(200, payload) });
    const bundle = launchBundle(harness.options);
    await waitFor(() => harness.children[0].kills.includes("SIGTERM"));
    assert.equal(harness.children.length, 1);
    assert.equal(findLogCode(harness.errors, "bundle-readiness-failed"), code);
    harness.children[0].emit("exit", null, "SIGTERM");
    await bundle.completion;
  }
});

test("SIGINT before readiness and SIGTERM after readiness terminate exactly the spawned children", async () => {
  const before = createHarness({ probeReady: () => new Promise(() => {}) });
  const beforeBundle = launchBundle(before.options);
  before.processRef.emit("SIGINT");
  assert.deepEqual(before.children.map(({ kills }) => kills), [["SIGINT"]]);
  before.children[0].emit("exit", null, "SIGINT");
  assert.deepEqual(await beforeBundle.completion, { exitCode: 0, signal: "SIGINT" });

  const after = createHarness();
  const afterBundle = launchBundle(after.options);
  await waitFor(() => afterBundle.state === BUNDLE_STATES.RUNNING);
  after.processRef.emit("SIGTERM");
  assert.deepEqual(after.children.map(({ kills }) => kills), [["SIGTERM"], ["SIGTERM"]]);
  after.children[0].emit("exit", null, "SIGTERM");
  after.children[1].emit("exit", null, "SIGTERM");
  assert.deepEqual(await afterBundle.completion, { exitCode: 0, signal: "SIGTERM" });
});

test("shutdown grace expiry forces SIGKILL and the parent fail-safe remains armed", async () => {
  const harness = createHarness();
  const bundle = launchBundle(harness.options);
  await waitFor(() => bundle.state === BUNDLE_STATES.RUNNING);
  bundle.stop("SIGTERM", "test-failure");
  assert.deepEqual(harness.children.map(({ kills }) => kills), [["SIGTERM"], ["SIGTERM"]]);
  const grace = harness.timers.find(({ delay }) => delay === 10_000);
  const parentFailSafe = harness.timers.find(({ delay }) => delay === 12_000);
  assert.ok(grace);
  assert.ok(parentFailSafe);
  grace.callback();
  assert.deepEqual(harness.children.map(({ kills }) => kills), [
    ["SIGTERM", "SIGKILL"],
    ["SIGTERM", "SIGKILL"]
  ]);
  parentFailSafe.callback();
  assert.deepEqual(harness.forcedParentExits, [1]);
  harness.children[0].emit("exit", null, "SIGKILL");
  harness.children[1].emit("exit", null, "SIGKILL");
  assert.deepEqual(await bundle.completion, { exitCode: 1, signal: null });
});

test("ships a single hardened runtime with the closure checker removed after verification", async () => {
  const [dockerfile, compose] = await Promise.all([
    readFile(new URL("./Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("./cloud/compose.local.yaml", import.meta.url), "utf8")
  ]);
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM ${NODE_IMAGE} AS runtime"));

  assert.match(dockerfile, /NEXT_PUBLIC_API_BASE_URL=\/backend-api/);
  assert.match(dockerfile, /NEXT_PUBLIC_AUTH_PROVIDER=supabase/);
  assert.match(dockerfile, /HSTS_ENABLED=true/);
  assert.match(dockerfile, /^ARG NODE_IMAGE$/m);
  assert.doesNotMatch(dockerfile, /^ARG NODE_IMAGE=/m);
  assert.match(dockerfile, /\@sha256:\[a-f0-9\]\{64\}\$/);
  assert.match(compose, /NODE_IMAGE: \$\{NODE_IMAGE:\?Set NODE_IMAGE to an approved node image pinned by sha256 digest\}/);
  assert.match(runtimeStage, /ENV IMAGE_RELEASE_GIT_SHA=\$\{RELEASE_GIT_SHA\}/);
  assert.match(runtimeStage, /apt-get install --yes --no-install-recommends ca-certificates openssl/);
  assert.match(runtimeStage, /COPY --chown=node:node deploy\/cloud\/ready-barrier\.mjs \.\/deploy\/cloud\/ready-barrier\.mjs/);
  assert.match(runtimeStage, /COPY --chown=node:node deploy\/cloud\/assert-runtime-closure\.mjs \.\/deploy\/cloud\/assert-runtime-closure\.mjs/);
  assert.match(runtimeStage, /node deploy\/cloud\/assert-runtime-closure\.mjs \/srv\/app/);
  assert.match(runtimeStage, /rm -f deploy\/cloud\/assert-runtime-closure\.mjs/);
  assert.ok(runtimeStage.indexOf("assert-runtime-closure.mjs /srv/app") < runtimeStage.indexOf("USER node"));
  assert.match(runtimeStage, /USER node/);
  assert.match(runtimeStage, /EXPOSE 8000/);
  assert.match(runtimeStage, /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/lib\/node_modules\/corepack/);
  assert.match(runtimeStage, /rm -f \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx \/usr\/local\/bin\/corepack/);
  assert.doesNotMatch(runtimeStage, /deploy\/(?:local|windows)|edge\.Dockerfile/);
  assert.match(dockerfile, /find apps\/web\/\.next\/standalone -type f -name '\*\.map' -delete/);
  assert.match(dockerfile, /npm prune --omit=dev --legacy-peer-deps/);
  assert.match(dockerfile, /COPY apps\/e2e\/package\.json apps\/e2e\/package\.json/);
  assert.match(dockerfile, /COPY packages\/shared\/package\.json packages\/shared\/package\.json/);
  assert.match(dockerfile, /rm -rf node_modules\/@playwright node_modules\/playwright node_modules\/playwright-core node_modules\/@meta-ads-performance\/e2e/);
  assert.match(dockerfile, /rm -rf node_modules\/@aws-sdk node_modules\/@smithy/);
  assert.doesNotMatch(runtimeStage, /postgresql-client|pg_dump|BACKUP_|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
  assert.equal((compose.match(/^  [a-z][a-z0-9_-]*:\s*$/gm) ?? []).length, 1);
  assert.match(compose, /"127\.0\.0\.1:3200:8000"/);
  assert.doesNotMatch(compose, /(?:^|:)4200:4200(?:$|\s|")/m);
  assert.match(compose, /mem_limit: 1g/);
  assert.match(compose, /memswap_limit: 1g/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s+- ALL/);
  assert.match(compose, /\/tmp:size=192m/);
});

function createHarness({
  env = cloudEnvironment(),
  probeReady = async () => ({ ready: true, retryable: false }),
  useDefaultProbe = false,
  fetchImpl,
  sleep = async () => {},
  now = Date.now
} = {}) {
  const processRef = new EventEmitter();
  const forcedParentExits = [];
  processRef.exitCode = undefined;
  processRef.exit = (code) => { forcedParentExits.push(code); };
  const children = [];
  const spawns = [];
  const timers = [];
  const logs = [];
  const errors = [];
  const options = {
    env,
    processRef,
    spawnProcess: (executable, args, spawnOptions) => {
      const child = new EventEmitter();
      child.pid = 10_000 + children.length;
      child.exitCode = null;
      child.signalCode = null;
      child.kills = [];
      child.kill = (signal) => { child.kills.push(signal); return true; };
      children.push(child);
      spawns.push({ executable, args, options: spawnOptions });
      return child;
    },
    sleep,
    now,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    log: (record) => logs.push(record),
    logError: (record) => errors.push(record)
  };
  options.resolveRuntimeFingerprint = () => runtimeConfigFingerprint;
  if (useDefaultProbe) options.fetchImpl = fetchImpl;
  else options.probeReady = probeReady;
  return { children, errors, forcedParentExits, logs, options, processRef, spawns, timers };
}

async function terminateBundle(bundle, harness, signal) {
  harness.processRef.emit(signal);
  for (const child of harness.children) child.emit("exit", null, signal);
  assert.deepEqual(await bundle.completion, { exitCode: 0, signal });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function response(status, payload) {
  return { status, json: async () => payload };
}

function findLogCode(records, event) {
  return records.find((record) => record.event === event)?.code;
}
