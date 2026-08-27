import { describe, expect, it, vi } from "vitest";
import { AuthConfig } from "./auth.config";
import { AuthCookieService } from "./cookie.service";

const appSessionId = "33333333-3333-4333-8333-333333333333";
const providerSessionId = "22222222-2222-4222-8222-222222222222";

describe("AuthCookieService", () => {
  it("uses production __Host cookies with Secure, root Path, and no Domain", () => {
    const cookies = new AuthCookieService(config(true));
    const response = { cookie: vi.fn() };
    cookies.setAuthenticatedCookies(response as never, {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresIn: 600,
      sessionId: appSessionId
    });

    expect(response.cookie).toHaveBeenCalledTimes(4);
    for (const [name, _value, options] of response.cookie.mock.calls) {
      expect(name).toMatch(/^__Host-/);
      expect(options).toMatchObject({ secure: true, sameSite: "lax", path: "/" });
      expect(options).not.toHaveProperty("domain");
    }
    expect(response.cookie.mock.calls.slice(0, 3).every((call) => call[2].httpOnly)).toBe(true);
    expect(response.cookie.mock.calls[3][2].httpOnly).toBe(false);
  });

  it("signs an opaque app-session handle and rejects tampering", () => {
    const cookies = new AuthCookieService(config(false));
    const response = { cookie: vi.fn() };
    cookies.setAuthenticatedCookies(response as never, {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresIn: 600,
      sessionId: appSessionId
    });
    const handle = response.cookie.mock.calls[2][1] as string;
    expect(handle).toContain(appSessionId);
    expect(handle).not.toContain(providerSessionId);
    expect(handle).not.toMatch(/USER|user@example\.com|access-secret|refresh-secret/);
    expect(cookies.verifySessionHandle(handle)).toBe(appSessionId);
    expect(cookies.verifySessionHandle(`${handle.slice(0, -1)}x`)).toBeNull();
    expect(cookies.verifySessionHandle(undefined)).toBeNull();
  });

  it("requires the signed CSRF cookie and header to match", () => {
    const cookies = new AuthCookieService(config(false));
    const response = { cookie: vi.fn() };
    const token = cookies.issueCsrfCookie(response as never);
    expect(cookies.verifyCsrfToken(token, token)).toBe(true);
    expect(cookies.verifyCsrfToken(token, `${token}x`)).toBe(false);
    expect(cookies.verifyCsrfToken(undefined, undefined)).toBe(false);
  });

  it("rejects an otherwise valid signed CSRF token after its server-enforced expiry", () => {
    let now = Date.parse("2026-08-25T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const cookies = new AuthCookieService(config(false));
      const token = cookies.issueCsrfCookie({ cookie: vi.fn() } as never);
      expect(cookies.verifyCsrfToken(token, token)).toBe(true);
      now += 8 * 60 * 60 * 1000 + 1_000;
      expect(cookies.verifyCsrfToken(token, token)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("can preserve only a rotated refresh token during verifier recovery", () => {
    const cookies = new AuthCookieService(config(true));
    const response = { cookie: vi.fn() };
    cookies.setRefreshCookie(response as never, "rotated-refresh");
    expect(response.cookie).toHaveBeenCalledWith(
      "__Host-staging-meta_refresh",
      "rotated-refresh",
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: "lax", path: "/" })
    );
    expect(response.cookie.mock.calls[0][2]).not.toHaveProperty("domain");
  });

  it("separates deployment cookie names and supports a two-phase secret rotation overlap", () => {
    const oldConfig = config(true);
    const newConfig = {
      ...config(true),
      cookieNamespace: "production",
      sessionHandleSecret: "n".repeat(48),
      sessionHandlePreviousSecret: oldConfig.sessionHandleSecret,
      csrfSecret: "x".repeat(48),
      csrfPreviousSecret: oldConfig.csrfSecret
    } as AuthConfig;
    const preparedOld = {
      ...oldConfig,
      sessionHandlePreviousSecret: newConfig.sessionHandleSecret,
      csrfPreviousSecret: newConfig.csrfSecret
    } as AuthConfig;
    const oldCookies = new AuthCookieService(oldConfig);
    const newCookies = new AuthCookieService(newConfig);
    const rollbackCookies = new AuthCookieService(preparedOld);
    const oldResponse = { cookie: vi.fn() };
    const newResponse = { cookie: vi.fn() };
    oldCookies.setAuthenticatedCookies(oldResponse as never, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresIn: 600,
      sessionId: appSessionId
    });
    newCookies.setAuthenticatedCookies(newResponse as never, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 600,
      sessionId: appSessionId
    });
    const oldHandle = oldResponse.cookie.mock.calls[2][1] as string;
    const newHandle = newResponse.cookie.mock.calls[2][1] as string;
    const oldCsrf = oldResponse.cookie.mock.calls[3][1] as string;
    const newCsrf = newResponse.cookie.mock.calls[3][1] as string;

    expect(newCookies.verifySessionHandle(oldHandle)).toBe(appSessionId);
    expect(rollbackCookies.verifySessionHandle(newHandle)).toBe(appSessionId);
    expect(newCookies.verifyCsrfToken(oldCsrf, oldCsrf)).toBe(true);
    expect(rollbackCookies.verifyCsrfToken(newCsrf, newCsrf)).toBe(true);
    expect(newCookies.authorizationVersion(appSessionId, 7))
      .toBe(oldCookies.authorizationVersion(appSessionId, 7));
    expect(rollbackCookies.authorizationVersion(appSessionId, 7))
      .toBe(oldCookies.authorizationVersion(appSessionId, 7));
    expect(oldCookies.accessCookieName).toBe("__Host-staging-meta_access");
    expect(newCookies.accessCookieName).toBe("__Host-production-meta_access");
  });
});

function config(production: boolean) {
  return {
    production,
    cookieSecure: production,
    cookieNamespace: production ? "staging" : "",
    sessionHandleSecret: "s".repeat(48),
    authorizationVersionSecret: "a".repeat(48),
    csrfSecret: "c".repeat(48),
    csrfTtlMs: 8 * 60 * 60 * 1000
  } as AuthConfig;
}
