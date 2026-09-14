import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { AuthenticationGuard } from "./authentication.guard";

describe("AuthenticationGuard", () => {
  it("rejects a request without the access cookie", async () => {
    const guard = new AuthenticationGuard(
      { authenticateAccessToken: vi.fn() } as never,
      { readAccessToken: vi.fn().mockReturnValue(undefined), readSessionHandle: vi.fn() } as never,
      new Reflector()
    );
    await expect(guard.canActivate(contextFor({}) as unknown as ExecutionContext)).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED"
    });
  });

  it.each([true, false])("requires a valid signed session to refresh a missing access cookie (%s)", async (valid) => {
    const authenticate = vi.fn();
    const guard = new AuthenticationGuard(
      { authenticateAccessToken: authenticate } as never,
      { readAccessToken: vi.fn(), readSessionHandle: () => "handle", verifySessionHandle: () => valid ? "id" : null,
        readRefreshToken: () => "refresh" } as never, new Reflector()
    );
    await expect(guard.canActivate(contextFor({}) as unknown as ExecutionContext)).rejects.toMatchObject({
      code: valid ? "ACCESS_TOKEN_EXPIRED" : "AUTHENTICATION_REQUIRED"
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("attaches the DB-resolved principal to the request", async () => {
    const request: Record<string, unknown> = {};
    const principal = { id: "app-user" };
    const authenticateAccessToken = vi.fn().mockResolvedValue(principal);
    const guard = new AuthenticationGuard(
      { authenticateAccessToken } as never,
      { readAccessToken: vi.fn().mockReturnValue("access-token") } as never,
      new Reflector()
    );
    await expect(guard.canActivate(contextFor(request) as unknown as ExecutionContext)).resolves.toBe(true);
    expect(authenticateAccessToken).toHaveBeenCalledWith("access-token", undefined);
    expect(request.authenticatedUser).toBe(principal);
  });
});

function contextFor(request: object) {
  return {
    getHandler: () => function handler() {},
    switchToHttp: () => ({ getRequest: () => request })
  };
}
