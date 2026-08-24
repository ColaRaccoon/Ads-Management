import { describe, expect, it, vi } from "vitest";
import { AuthConfig } from "./auth.config";
import {
  AuthRequestSecurityService,
  InMemorySecurityRateLimiter
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
    const consume = vi.fn().mockResolvedValue(true);
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
    const consume = vi.fn().mockResolvedValue(true);
    const verifyCsrfToken = vi.fn().mockReturnValue(false);
    const service = makeService(consume, verifyCsrfToken);
    await expect(service.assertSessionCsrfAndRate(
      request("http://localhost:3200", "10.0.0.1"),
      "refresh"
    )).rejects.toMatchObject({ code: "CSRF_INVALID" });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(verifyCsrfToken).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the development adapter reaches its bounded key capacity", async () => {
    const limiter = new InMemorySecurityRateLimiter();
    for (let index = 0; index < 10_000; index += 1) {
      await expect(limiter.consume(`key-${index}`, 2, 60_000)).resolves.toBe(true);
    }
    await expect(limiter.consume("key-over-capacity", 2, 60_000)).resolves.toBe(false);
  });

  it("preserves a live long-window bucket while sweeping expired short-window buckets", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const limiter = new InMemorySecurityRateLimiter();
      await expect(limiter.consume("long-window", 1, 5 * 60_000)).resolves.toBe(true);
      for (let index = 0; index < 9_999; index += 1) {
        await limiter.consume(`short-${index}`, 2, 60_000);
      }
      now += 2 * 60_000;
      await expect(limiter.consume("new-short", 2, 60_000)).resolves.toBe(true);
      await expect(limiter.consume("long-window", 1, 5 * 60_000)).resolves.toBe(false);
    } finally {
      clock.mockRestore();
    }
  });
});

function makeService(
  consume = vi.fn().mockResolvedValue(true),
  verifyCsrfToken = vi.fn().mockReturnValue(true)
) {
  return new AuthRequestSecurityService(
    config,
    { csrfCookieName: "meta_csrf", verifyCsrfToken } as never,
    { consume } as never
  );
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
