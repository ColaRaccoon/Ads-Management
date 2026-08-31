import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AuthConfig } from "./auth.config";
import { AuthRequestSecurityService, clientAddress } from "./request-security.service";

const config = {
  allowedOrigins: new Set(["http://localhost:3200"])
} as unknown as AuthConfig;
const edgeKeys = generateKeyPairSync("ed25519");
const edgePublicKey = edgeKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const emptyBodySha256=createHash("sha256").digest("hex");

describe("AuthRequestSecurityService", () => {
  it("rejects missing, suffix-matched, and cross-site login origins", async () => {
    const service = makeService();
    await expect(service.assertLoginRequest(request(undefined), "user@example.com"))
      .rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    await expect(service.assertLoginRequest(
      request("http://localhost:3200.attacker.example"),
      "user@example.com"
    )).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    await expect(service.assertLoginRequest(
      request("http://localhost:3200", "10.0.0.1", "cross-site"),
      "user@example.com"
    )).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });

  it("uses an IP-independent account bucket as well as IP buckets", async () => {
    const consume = vi.fn().mockResolvedValue(allowed());
    const service = makeService(consume);
    await service.assertLoginRequest(request("http://localhost:3200", "10.0.0.1"), "user@example.com");
    await service.assertLoginRequest(request("http://localhost:3200", "10.0.0.2"), "user@example.com");
    const globalKeys = consume.mock.calls
      .map((call) => call[0] as string)
      .filter((key) => key.includes("account-global"));
    expect(globalKeys).toHaveLength(2);
    expect(globalKeys[0]).toBe(globalKeys[1]);
  });

  it("rate-limits invalid CSRF attempts before verifying the token", async () => {
    const consume = vi.fn().mockResolvedValue(allowed());
    const verifyCsrfToken = vi.fn().mockReturnValue(false);
    const service = makeService(consume, verifyCsrfToken);
    await expect(service.assertSessionCsrfAndRate(
      request("http://localhost:3200", "10.0.0.1"),
      "refresh"
    )).rejects.toMatchObject({ code: "CSRF_INVALID" });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(verifyCsrfToken).toHaveBeenCalledTimes(1);
  });

  it("separates pre-authenticated abuse quota from per-user business quota on the same IP", async () => {
    const consume = vi.fn().mockResolvedValue(allowed());
    const invalidCsrf = makeService(consume, vi.fn().mockReturnValue(false));
    await expect(invalidCsrf.assertGeneralMutationTransport(
      request("http://localhost:3200", "10.0.0.1"), true
    )).rejects.toMatchObject({ code: "CSRF_INVALID" });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][0]).toContain("http:expensive-abuse:10.0.0.1");

    const authenticated = makeService(consume);
    const first = request("http://localhost:3200", "10.0.0.1") as unknown as {
      authenticatedUser: { id: string };
    };
    const second = request("http://localhost:3200", "10.0.0.1") as unknown as {
      authenticatedUser: { id: string };
    };
    first.authenticatedUser = { id: "account-one" };
    second.authenticatedUser = { id: "account-two" };
    await authenticated.assertAuthenticatedMutationRate(first as never, true);
    await authenticated.assertAuthenticatedMutationRate(second as never, true);
    const businessKeys = consume.mock.calls.slice(1).map((call) => call[0] as string);
    expect(businessKeys).toHaveLength(2);
    expect(businessKeys[0]).not.toBe(businessKeys[1]);
    expect(businessKeys.every((key) => key.startsWith("http:expensive:10.0.0.1:"))).toBe(true);
  });

  it("requires exact same-site invitation acceptance and never uses the raw link hash as a limiter key", async () => {
    const consume = vi.fn().mockResolvedValue(allowed());
    const service = makeService(consume);
    const tokenHash = "sensitive-link-hash-value";
    await expect(service.assertInvitationAccept(
      request("http://localhost:3200", "10.0.0.1", "cross-site"),
      tokenHash
    )).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    await expect(service.assertInvitationAccept(
      request("http://localhost:3200", "10.0.0.1"),
      tokenHash
    )).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    await service.assertInvitationAccept(
      request("http://localhost:3200", "10.0.0.1", "same-origin"),
      tokenHash
    );
    expect(JSON.stringify(consume.mock.calls)).not.toContain(tokenHash);
  });

  it("returns a stable 429 decision with bounded Retry-After metadata", async () => {
    const service = makeService(vi.fn().mockResolvedValue({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 17
    }));
    await expect(service.assertGeneralRead(request(undefined))).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      response: {
        code: "RATE_LIMITED",
        details: { retryAfterSeconds: 17 }
      }
    });
  });

  it("uses only fresh Ed25519-authenticated edge client metadata in local mode", () => {
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const address = "192.168.10.21";
    const target = "/api/metrics?from=2026-08-01";
    const signature = sign(null, Buffer.from(`${address}\0${timestamp}\0${nonce}\0GET\0${target}\0${emptyBodySha256}`), edgeKeys.privateKey).toString("base64url");
    const headers = {
      "x-local-client-ip": address,
      "x-local-edge-timestamp": timestamp,
      "x-local-edge-nonce": nonce,
      "x-local-edge-target": target,
      "x-local-edge-body-sha256": emptyBodySha256,
      "x-local-edge-signature": signature
    };
    const signed = request(undefined, "127.0.0.1", undefined, headers, target);
    const localHttp = { deploymentMode: "local_lan", localEdgeProxyPublicKey: edgePublicKey } as const;
    expect(clientAddress(signed, localHttp)).toBe(address);
    const corrupted = Buffer.from(signature, "base64url"); corrupted[0] ^= 0x80;
    headers["x-local-edge-signature"] = corrupted.toString("base64url");
    expect(clientAddress(signed, localHttp)).toBe("unknown");
  });

  it("rejects a direct loopback request and atomically rejects replayed HTTPS edge nonces", async () => {
    const localHttp = { deploymentMode: "local_lan", localEdgeProxyPublicKey: edgePublicKey } as const;
    const createNonce = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6.12.0" }));
    const service = new AuthRequestSecurityService(
      config,
      { csrfCookieName: "meta_csrf", verifyCsrfToken: vi.fn() } as never,
      { consume: vi.fn().mockResolvedValue(allowed()) } as never,
      localHttp as never,
      { localEdgeRequestNonce: { create: createNonce, deleteMany: vi.fn() } } as never
    );
    await expect(service.assertTrustedTransport(request(undefined, "127.0.0.1")))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: "LOCAL_HTTPS_EDGE_REQUIRED" }) });

    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const address = "192.168.10.21";
    const target = "/api/health/ready";
    const signature = sign(
      null,
      Buffer.from(`${address}\0${timestamp}\0${nonce}\0GET\0${target}\0${emptyBodySha256}`),
      edgeKeys.privateKey
    ).toString("base64url");
    const signedRequest = request(undefined, "127.0.0.1", undefined, {
      "x-local-client-ip": address,
      "x-local-edge-timestamp": timestamp,
      "x-local-edge-nonce": nonce,
      "x-local-edge-target": target,
      "x-local-edge-body-sha256": emptyBodySha256,
      "x-local-edge-signature": signature
    }, target);
    await expect(service.assertTrustedTransport(signedRequest)).resolves.toBeUndefined();
    await expect(service.assertTrustedTransport(signedRequest)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "LOCAL_EDGE_REQUEST_REPLAYED" })
    });
  });
});

function makeService(
  consume = vi.fn().mockResolvedValue(allowed()),
  verifyCsrfToken = vi.fn().mockReturnValue(true)
) {
  return new AuthRequestSecurityService(
    config,
    { csrfCookieName: "meta_csrf", verifyCsrfToken } as never,
    { consume } as never,
    { deploymentMode: "legacy", localEdgeProxyPublicKey: null } as never,
    { localEdgeRequestNonce: { create: vi.fn(), deleteMany: vi.fn() } } as never
  );
}

function allowed() {
  return { allowed: true, limit: 100, remaining: 99, retryAfterSeconds: 60 };
}

function request(
  origin: string | undefined,
  ip = "10.0.0.1",
  fetchSite?: string,
  extraHeaders: Record<string, string> = {},
  requestUrl = "/api/test"
) {
  return {
    method: "GET",
    originalUrl: requestUrl,
    url: requestUrl,
    headers: extraHeaders,
    localRawBodySha256: emptyBodySha256,
    localRawBodyDigestComplete: true,
    ip,
    socket: { remoteAddress: ip },
    get: vi.fn((name: string) => {
      if (name.toLowerCase() === "origin") return origin;
      if (name.toLowerCase() === "sec-fetch-site") return fetchSite;
      return extraHeaders[name.toLowerCase()];
    })
  } as never;
}
