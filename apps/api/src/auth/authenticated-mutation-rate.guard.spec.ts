import { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedMutationRateGuard } from "./authenticated-mutation-rate.guard";

describe("AuthenticatedMutationRateGuard", () => {
  it("applies the business quota only after authentication and classifies expensive work", async () => {
    const security = { assertAuthenticatedMutationRate: vi.fn() };
    const guard = new AuthenticatedMutationRateGuard(security as never);
    await expect(guard.canActivate(context("PATCH", "/api/products/id"))).resolves.toBe(true);
    await expect(guard.canActivate(context("POST", "/api/reports/export"))).resolves.toBe(true);
    expect(security.assertAuthenticatedMutationRate).toHaveBeenNthCalledWith(1, expect.anything(), false);
    expect(security.assertAuthenticatedMutationRate).toHaveBeenNthCalledWith(2, expect.anything(), true);
  });

  it("does not duplicate public auth, user-management, health, or safe-read policies", async () => {
    const security = { assertAuthenticatedMutationRate: vi.fn() };
    const guard = new AuthenticatedMutationRateGuard(security as never);
    for (const [method, path] of [
      ["POST", "/api/auth/login"], ["PATCH", "/api/users/id"],
      ["GET", "/api/products"], ["GET", "/api/health/ready"]
    ]) await expect(guard.canActivate(context(method, path))).resolves.toBe(true);
    expect(security.assertAuthenticatedMutationRate).not.toHaveBeenCalled();
  });
});

function context(method: string, originalUrl: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, originalUrl, url: originalUrl, authenticatedUser: { id: "user-id" } })
    })
  } as unknown as ExecutionContext;
}
