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

  it("can preserve only a rotated refresh token during verifier recovery", () => {
    const cookies = new AuthCookieService(config(true));
    const response = { cookie: vi.fn() };
    cookies.setRefreshCookie(response as never, "rotated-refresh");
    expect(response.cookie).toHaveBeenCalledWith(
      "__Host-meta_refresh",
      "rotated-refresh",
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: "lax", path: "/" })
    );
    expect(response.cookie.mock.calls[0][2]).not.toHaveProperty("domain");
  });
});

function config(production: boolean) {
  return {
    production,
    cookieSecure: production,
    sessionHandleSecret: "s".repeat(48),
    csrfSecret: "c".repeat(48)
  } as AuthConfig;
}
