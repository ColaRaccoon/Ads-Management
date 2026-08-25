import { describe, expect, it, vi } from "vitest";
import { AuthConfig } from "./auth.config";
import {
  AuthRequestSecurityService
} from "./request-security.service";

const config = {
  allowedOrigins: new Set(["http://localhost:3200"])
} as unknown as AuthConfig;

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
});

function makeService(
  consume = vi.fn().mockResolvedValue(allowed()),
  verifyCsrfToken = vi.fn().mockReturnValue(true)
) {
  return new AuthRequestSecurityService(
    config,
    { csrfCookieName: "meta_csrf", verifyCsrfToken } as never,
    { consume } as never
  );
}

function allowed() {
  return { allowed: true, limit: 100, remaining: 99, retryAfterSeconds: 60 };
}

function request(origin: string | undefined, ip = "10.0.0.1", fetchSite?: string) {
  return {
    headers: {},
    ip,
    socket: {},
    get: vi.fn((name: string) => {
      if (name.toLowerCase() === "origin") return origin;
      if (name.toLowerCase() === "sec-fetch-site") return fetchSite;
      return undefined;
    })
  } as never;
}
