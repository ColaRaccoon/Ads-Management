const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class ReadyBarrierError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "ReadyBarrierError";
    this.code = code;
  }
}

export function createProtectedReadyProbe({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new ReadyBarrierError("READY_FETCH_UNAVAILABLE");

  return async function protectedReadyProbe({
    url,
    token,
    releaseId,
    runtimeConfigFingerprint,
    signal
  }) {
    const endpoint = assertLoopbackReadyUrl(url);
    assertProbeToken(token);
    assertHex(releaseId, "READY_RELEASE_ID_INVALID", new Set([40, 64]));
    assertHex(runtimeConfigFingerprint, "READY_FINGERPRINT_INVALID", new Set([64]));

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-internal-probe-token": token
        },
        redirect: "error",
        signal
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      return { ready: false, retryable: true, code: "READY_PROBE_UNREACHABLE" };
    }

    if (response.status === 503) {
      return { ready: false, retryable: true, code: "READY_PROBE_NOT_READY" };
    }
    if (response.status === 401 || response.status === 403) {
      throw new ReadyBarrierError("READY_PROBE_AUTH_REJECTED");
    }
    if (response.status !== 200) {
      throw new ReadyBarrierError("READY_PROBE_HTTP_REJECTED");
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ReadyBarrierError("READY_PROBE_RESPONSE_INVALID");
    }
    if (!isPlainRecord(payload) || Object.keys(payload).length !== 3 || payload.status !== "ready") {
      throw new ReadyBarrierError("READY_PROBE_RESPONSE_INVALID");
    }
    if (payload.releaseId !== releaseId) {
      throw new ReadyBarrierError("READY_RELEASE_MISMATCH");
    }
    if (payload.runtimeConfigFingerprint !== runtimeConfigFingerprint) {
      throw new ReadyBarrierError("READY_FINGERPRINT_MISMATCH");
    }
    return { ready: true, retryable: false, code: "READY_PROBE_MATCHED" };
  };
}

function assertLoopbackReadyUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ReadyBarrierError("READY_PROBE_URL_INVALID");
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/api/health/ready") {
    throw new ReadyBarrierError("READY_PROBE_URL_INVALID");
  }
  return url.href;
}

function assertHex(value, code, lengths) {
  if (typeof value !== "string" || !/^[a-f0-9]+$/u.test(value) || !lengths.has(value.length)) {
    throw new ReadyBarrierError(code);
  }
}

function assertProbeToken(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32 || value.length > 256) {
    throw new ReadyBarrierError("READY_PROBE_TOKEN_REQUIRED");
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
