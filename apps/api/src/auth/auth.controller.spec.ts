import { ArgumentsHost, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import { ApiExceptionFilter } from "../common/api-exception.filter";
import { AuthConfig } from "./auth.config";
import { AuthController } from "./auth.controller";
import { authError } from "./auth.errors";
import { AuthCookieService } from "./cookie.service";
import { AUTH_ROUTE_ACCESS, AUTHENTICATED_ROUTE, PUBLIC_ROUTE } from "./route-decorators";

const config = {
  production: false,
  cookieSecure: false,
  sessionHandleSecret: "s".repeat(48),
  csrfSecret: "c".repeat(48)
} as AuthConfig;

describe("AuthController", () => {
  it("sets secure cookie contract without returning provider tokens", async () => {
    const authService = {
      login: vi.fn().mockResolvedValue({
        response: responseBody(),
        cookies: {
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          expiresIn: 600,
          sessionId: "33333333-3333-4333-8333-333333333333"
        }
      })
    };
    const cookies = new AuthCookieService(config);
    const requestSecurity = { assertLoginRequest: vi.fn() };
    const controller = new AuthController(authService as never, cookies, requestSecurity as never);
    const response = responseFake();
    const body = await controller.login(
      { email: "User@Example.com", password: "password" },
      requestFake(),
      response as never
    );

    expect(body).toEqual(responseBody());
    expect(JSON.stringify(body)).not.toMatch(/access-secret|refresh-secret/);
    for (const call of response.cookie.mock.calls.slice(0, 3)) {
      expect(call[2]).toMatchObject({ httpOnly: true, secure: false, sameSite: "lax", path: "/" });
      expect(call[2]).not.toHaveProperty("domain");
    }
    expect(response.cookie.mock.calls[3][2]).toMatchObject({ httpOnly: false, path: "/" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
  });

  it("checks Origin then reports missing refresh cookie as AUTHENTICATION_REQUIRED before CSRF", async () => {
    const order: string[] = [];
    const cookies = {
      readRefreshToken: vi.fn().mockImplementation(() => { order.push("read-cookie"); }),
      readSessionHandle: vi.fn(),
      clearAuthenticationCookies: vi.fn(),
      csrfCookieName: "meta_csrf"
    };
    const security = {
      assertMutationOrigin: vi.fn().mockImplementation(() => { order.push("origin"); }),
      assertSessionCsrfAndRate: vi.fn()
    };
    const controller = new AuthController({} as never, cookies as never, security as never);
    await expect(controller.refresh(requestFake(), responseFake() as never)).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED"
    });
    expect(order).toEqual(["origin", "read-cookie"]);
    expect(security.assertSessionCsrfAndRate).not.toHaveBeenCalled();
  });

  it.each(["REFRESH_RACE_RETRY", "AUTH_PROVIDER_UNAVAILABLE"] as const)(
    "preserves cookies for recoverable %s",
    async (code) => {
      const cookies = cookieReaderFake();
      const controller = new AuthController(
        { refresh: vi.fn().mockRejectedValue(authError(code)) } as never,
        cookies as never,
        {
          assertMutationOrigin: vi.fn(),
          assertSessionCsrfAndRate: vi.fn()
        } as never
      );
      await expect(controller.refresh(requestFake(), responseFake() as never)).rejects.toMatchObject({ code });
      expect(cookies.clearAuthenticationCookies).not.toHaveBeenCalled();
    }
  );

  it("stores a rotated refresh cookie without exposing it when JWKS verification is unavailable", async () => {
    const cookies = {
      ...cookieReaderFake(),
      setRefreshCookie: vi.fn()
    };
    const controller = new AuthController(
      { refresh: vi.fn().mockResolvedValue({ recoveryRefreshToken: "rotated-refresh" }) } as never,
      cookies as never,
      {
        assertMutationOrigin: vi.fn(),
        assertSessionCsrfAndRate: vi.fn()
      } as never
    );
    let thrown: unknown;
    try {
      await controller.refresh(requestFake(), responseFake() as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "AUTH_PROVIDER_UNAVAILABLE", status: 503 });
    expect(JSON.stringify((thrown as { getResponse(): unknown }).getResponse()))
      .not.toContain("rotated-refresh");
    expect(cookies.setRefreshCookie).toHaveBeenCalledWith(expect.anything(), "rotated-refresh");
    expect(cookies.clearAuthenticationCookies).not.toHaveBeenCalled();
  });

  it("marks exact auth method/path access contracts", () => {
    const expected = [
      ["login", "login", RequestMethod.POST, PUBLIC_ROUTE],
      ["refresh", "refresh", RequestMethod.POST, PUBLIC_ROUTE],
      ["logout", "logout", RequestMethod.POST, PUBLIC_ROUTE],
      ["me", "me", RequestMethod.GET, AUTHENTICATED_ROUTE]
    ] as const;
    expect(Reflect.getMetadata(PATH_METADATA, AuthController)).toBe("auth");
    for (const [method, path, requestMethod, access] of expected) {
      const handler = AuthController.prototype[method];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(requestMethod);
      expect(Reflect.getMetadata(AUTH_ROUTE_ACCESS, handler)).toBe(access);
    }
  });

  it("keeps the stable auth error shape and no-store headers on early exceptions", () => {
    const response = responseFake();
    new ApiExceptionFilter().catch(
      authError("CSRF_INVALID"),
      filterHost(response, "/api/auth/refresh") as ArgumentsHost
    );
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      code: "CSRF_INVALID",
      message: "The CSRF token is invalid.",
      details: null
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("always clears local cookies when logout provider work fails", async () => {
    const cookies = {
      readSessionHandle: vi.fn().mockReturnValue("handle"),
      readAccessToken: vi.fn().mockReturnValue("expired-access"),
      readRefreshToken: vi.fn().mockReturnValue("refresh"),
      clearAuthenticationCookies: vi.fn()
    };
    const controller = new AuthController(
      { logout: vi.fn().mockRejectedValue(new Error("provider unavailable")) } as never,
      cookies as never,
      { assertSessionMutation: vi.fn() } as never
    );
    await expect(controller.logout(requestFake(), responseFake() as never))
      .rejects.toThrow("provider unavailable");
    expect(cookies.clearAuthenticationCookies).toHaveBeenCalledTimes(1);
  });
});

function responseBody() {
  return {
    user: {
      id: "app-user",
      email: "user@example.com",
      name: "User",
      role: "USER",
      isActive: true
    },
    permissions: ["data.read"],
    authorizationVersion: "opaque"
  };
}

function requestFake() {
  return {
    headers: {},
    socket: {},
    get: vi.fn((name: string) => name.toLowerCase() === "origin" ? "http://localhost:3200" : undefined)
  } as never;
}

function responseFake() {
  const headers = new Map<string, string>();
  const response = {
    headers,
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    setHeader: vi.fn((name: string, value: string) => { headers.set(name, value); }),
    status: vi.fn(),
    json: vi.fn()
  };
  response.status.mockReturnValue(response);
  return response;
}

function cookieReaderFake() {
  return {
    readRefreshToken: vi.fn().mockReturnValue("refresh"),
    readSessionHandle: vi.fn().mockReturnValue("handle"),
    clearAuthenticationCookies: vi.fn(),
    setAuthenticatedCookies: vi.fn()
  };
}

function filterHost(response: ReturnType<typeof responseFake>, url: string) {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ originalUrl: url })
    })
  };
}
