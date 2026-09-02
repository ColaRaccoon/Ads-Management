import assert from "node:assert/strict";
import test from "node:test";
import { ReadyBarrierError, createProtectedReadyProbe } from "./ready-barrier.mjs";

const releaseId = "a".repeat(40);
const runtimeConfigFingerprint = "b".repeat(64);
const token = "probe-token-with-at-least-thirty-two-bytes";
const input = {
  url: "http://127.0.0.1:4200/api/health/ready",
  token,
  releaseId,
  runtimeConfigFingerprint
};

test("protected probe sends the token only as a header and matches exact identity", async () => {
  let captured;
  const probe = createProtectedReadyProbe({ fetchImpl: async (url, options) => {
    captured = { url, options };
    return response(200, { status: "ready", releaseId, runtimeConfigFingerprint });
  }});
  assert.equal((await probe(input)).ready, true);
  assert.equal(captured.options.headers["x-internal-probe-token"], token);
  assert.equal(captured.url.includes(token), false);
  assert.equal(captured.options.redirect, "error");
});

test("protected probe permits only the fixed HTTP loopback ready endpoint", async () => {
  const probe = createProtectedReadyProbe({ fetchImpl: async () => response(200, {
    status: "ready", releaseId, runtimeConfigFingerprint
  }) });
  for (const url of [
    "https://127.0.0.1:4200/api/health/ready",
    "http://example.com/api/health/ready",
    "http://127.0.0.1:4200/api/health/live",
    "http://127.0.0.1:4200/api/health/ready?token=x"
  ]) {
    await assert.rejects(() => probe({ ...input, url }), errorCode("READY_PROBE_URL_INVALID"));
  }
});

test("401 and 403 are terminal while 503 is retryable", async () => {
  for (const status of [401, 403]) {
    const probe = createProtectedReadyProbe({ fetchImpl: async () => response(status, {}) });
    await assert.rejects(() => probe(input), errorCode("READY_PROBE_AUTH_REJECTED"));
  }
  const unavailable = createProtectedReadyProbe({ fetchImpl: async () => response(503, {}) });
  assert.deepEqual(await unavailable(input), {
    ready: false,
    retryable: true,
    code: "READY_PROBE_NOT_READY"
  });
});

test("exact release and fingerprint mismatches fail closed", async () => {
  const releaseMismatch = createProtectedReadyProbe({ fetchImpl: async () => response(200, {
    status: "ready", releaseId: "c".repeat(40), runtimeConfigFingerprint
  }) });
  await assert.rejects(() => releaseMismatch(input), errorCode("READY_RELEASE_MISMATCH"));

  const fingerprintMismatch = createProtectedReadyProbe({ fetchImpl: async () => response(200, {
    status: "ready", releaseId, runtimeConfigFingerprint: "d".repeat(64)
  }) });
  await assert.rejects(() => fingerprintMismatch(input), errorCode("READY_FINGERPRINT_MISMATCH"));
});

function response(status, payload) {
  return { status, json: async () => payload };
}

function errorCode(code) {
  return (error) => error instanceof ReadyBarrierError && error.code === code;
}
