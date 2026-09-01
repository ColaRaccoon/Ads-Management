import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CLOUD_API_PORT,
  createLaunchPlan,
  launchBundle,
  loadBundleRuntime,
  MAX_COMBINED_HEAP_MB
} from "./launch-bundle.mjs";

const releaseGitSha = "25748e71a95a09990968e0f198c5fd877897dc88";

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
    ...overrides
  };
}

test("validates the production-only cloud runtime and 1GB heap budget", () => {
  const runtime = loadBundleRuntime(cloudEnvironment());
  assert.equal(runtime.webPort, 8000);
  assert.equal(runtime.apiPort, CLOUD_API_PORT);
  assert.equal(runtime.apiHeapMb + runtime.webHeapMb, MAX_COMBINED_HEAP_MB);

  assert.throws(
    () => loadBundleRuntime(cloudEnvironment({ DEPLOYMENT_MODE: "local_lan" })),
    /DEPLOYMENT_MODE must be cloud_container/
  );
  assert.throws(
    () => loadBundleRuntime(cloudEnvironment({ AUTH_PROVIDER: "local" })),
    /AUTH_PROVIDER must be supabase/
  );
  assert.throws(
    () => loadBundleRuntime(cloudEnvironment({ API_INTERNAL_PORT: "4300" })),
    /API_INTERNAL_PORT must be between 4200 and 4200/
  );
  assert.throws(
    () => loadBundleRuntime(cloudEnvironment({
      API_NODE_MAX_OLD_SPACE_MB: "520",
      WEB_NODE_MAX_OLD_SPACE_MB: "192"
    })),
    /must total at most 704 MB/
  );
  assert.throws(
    () => loadBundleRuntime(cloudEnvironment({ NODE_OPTIONS: "--max-old-space-size=900" })),
    /must not set max-old-space-size/
  );
  assert.throws(
    () => loadBundleRuntime(cloudEnvironment({ NODE_OPTIONS: "--inspect=0.0.0.0:9229" })),
    /must not enable a production inspector/
  );
  assert.throws(
    () => loadBundleRuntime(cloudEnvironment({ NODE_OPTIONS: "--inspect-wait=0.0.0.0:9229" })),
    /must not enable a production inspector/
  );
  assert.throws(
    () => loadBundleRuntime(cloudEnvironment({ IMAGE_RELEASE_GIT_SHA: "abcdef0" })),
    /must identify the immutable image/
  );
  assert.throws(
    () => loadBundleRuntime(cloudEnvironment({
      RELEASE_GIT_SHA: "25748e7",
      IMAGE_RELEASE_GIT_SHA: "25748e7"
    })),
    /must be a full 40-character SHA-1 or 64-character SHA-256/
  );
});

test("builds one public Web child and one fixed loopback API child", () => {
  const plan = createLaunchPlan(cloudEnvironment({
    PORT: "8443",
    DATABASE_URL: "postgresql://api-only-secret",
    SUPABASE_SECRET_KEY: "api-only-secret",
    SUPABASE_STORAGE_ACCESS_TOKEN: "api-only-secret",
    AUTH_SESSION_HANDLE_SECRET: "api-only-secret",
    AUTH_CSRF_SECRET: "api-only-secret",
    INTERNAL_PROBE_TOKEN: "api-only-secret",
    NEXT_TELEMETRY_DISABLED: "1"
  }));
  const api = plan.children.find(({ name }) => name === "api");
  const web = plan.children.find(({ name }) => name === "web");

  assert.deepEqual(api.args, ["apps/api/dist/main.js"]);
  assert.equal(api.env.PORT, "4200");
  assert.equal(api.env.HOSTNAME, "127.0.0.1");
  assert.match(api.env.NODE_OPTIONS, /--max-old-space-size=512$/);
  assert.deepEqual(web.args, ["apps/web/server.js"]);
  assert.equal(web.env.PORT, "8443");
  assert.equal(web.env.HOSTNAME, "0.0.0.0");
  assert.match(web.env.NODE_OPTIONS, /--max-old-space-size=192$/);
  assert.equal(web.env.NEXT_TELEMETRY_DISABLED, "1");
  assert.deepEqual(Object.keys(web.env).sort(), [
    "API_INTERNAL_PORT",
    "APP_ENV",
    "DEPLOYMENT_MODE",
    "HOSTNAME",
    "IMAGE_RELEASE_GIT_SHA",
    "NEXT_TELEMETRY_DISABLED",
    "NODE_ENV",
    "NODE_OPTIONS",
    "PORT",
    "RELEASE_GIT_SHA"
  ]);
  assert.equal(api.env.DATABASE_URL, "postgresql://api-only-secret");
});

test("forwards parent termination and waits for both children", async () => {
  const harness = createHarness();
  const bundle = launchBundle(harness.options);

  harness.processRef.emit("SIGTERM");
  assert.deepEqual(harness.children.map(({ kills }) => kills), [["SIGTERM"], ["SIGTERM"]]);
  harness.children[0].emit("exit", null, "SIGTERM");
  harness.children[1].emit("exit", null, "SIGTERM");

  assert.deepEqual(await bundle.completion, { exitCode: 0, signal: "SIGTERM" });
  assert.equal(harness.processRef.exitCode, 0);
});

test("stops the sibling and fails when either child exits unexpectedly", async () => {
  const harness = createHarness();
  const bundle = launchBundle(harness.options);

  harness.children[0].emit("exit", 0, null);
  assert.deepEqual(harness.children[1].kills, ["SIGTERM"]);
  harness.children[1].emit("exit", null, "SIGTERM");

  assert.deepEqual(await bundle.completion, { exitCode: 1, signal: null });
  assert.equal(harness.processRef.exitCode, 1);
});

test("ships a single hardened 1GB service without historical host artifacts", async () => {
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
  assert.match(runtimeStage, /USER node/);
  assert.match(runtimeStage, /EXPOSE 8000/);
  assert.match(runtimeStage, /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/lib\/node_modules\/corepack/);
  assert.match(runtimeStage, /rm -f \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx \/usr\/local\/bin\/corepack/);
  assert.doesNotMatch(runtimeStage, /deploy\/(?:local|windows)|edge\.Dockerfile/);
  expectNoProductionCli(runtimeStage);
  assert.match(dockerfile, /find apps\/web\/\.next\/standalone -type f -name '\*\.map' -delete/);
  assert.match(dockerfile, /npm prune --omit=dev --legacy-peer-deps/);
  assert.equal((compose.match(/^  [a-z][a-z0-9_-]*:\s*$/gm) ?? []).length, 1);
  assert.match(compose, /"127\.0\.0\.1:3200:8000"/);
  assert.doesNotMatch(compose, /(?:^|:)4200:4200(?:$|\s|\")/m);
  assert.match(compose, /mem_limit: 1g/);
  assert.match(compose, /memswap_limit: 1g/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s+- ALL/);
  assert.match(compose, /\/tmp:size=192m/);
});

function expectNoProductionCli(runtimeStage) {
  assert.doesNotMatch(runtimeStage, /\.cli\.(?:js|js\.map)/);
}

function createHarness() {
  const processRef = new EventEmitter();
  processRef.exitCode = undefined;
  processRef.exit = (code) => { throw new Error(`unexpected forced exit ${code}`); };
  const children = [];
  const timers = [];
  const options = {
    env: cloudEnvironment(),
    processRef,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.pid = 10_000 + children.length;
      child.kills = [];
      child.kill = (signal) => { child.kills.push(signal); return true; };
      children.push(child);
      return child;
    },
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    log: () => {},
    logError: () => {}
  };
  return { children, options, processRef, timers };
}
