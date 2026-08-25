import { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { HttpSecurityGuard, isExpensiveMutation, requestPath } from "./http-security.guard";

describe("HttpSecurityGuard", () => {
  it("applies shared read limits and signed CSRF/origin checks to domain mutations", async () => {
    const security = {
      assertGeneralRead: vi.fn(),
      assertGeneralMutation: vi.fn()
    };
    const guard = new HttpSecurityGuard(security as never);
    await expect(guard.canActivate(context("GET", "/api/products?take=10"))).resolves.toBe(true);
    await expect(guard.canActivate(context("PATCH", "/api/products/id"))).resolves.toBe(true);
    await expect(guard.canActivate(context("POST", "/api/reports/export"))).resolves.toBe(true);
    expect(security.assertGeneralRead).toHaveBeenCalledTimes(1);
    expect(security.assertGeneralMutation).toHaveBeenNthCalledWith(1, expect.anything(), false);
    expect(security.assertGeneralMutation).toHaveBeenNthCalledWith(2, expect.anything(), true);
  });

  it("does not double-consume stricter auth/user policies and exempts health probes", async () => {
    const security = { assertGeneralRead: vi.fn(), assertGeneralMutation: vi.fn() };
    const guard = new HttpSecurityGuard(security as never);
    for (const [method, path] of [
      ["POST", "/api/auth/login"],
      ["POST", "/api/auth/refresh"],
      ["PATCH", "/api/users/11111111-1111-4111-8111-111111111111"],
      ["GET", "/api/health/live"],
      ["GET", "/api/health/ready"]
    ]) {
      await expect(guard.canActivate(context(method, path))).resolves.toBe(true);
    }
    expect(security.assertGeneralRead).not.toHaveBeenCalled();
    expect(security.assertGeneralMutation).not.toHaveBeenCalled();
  });

  it("normalizes queryless paths and classifies all costly route groups", () => {
    expect(requestPath({ originalUrl: "/api/products?x=1", url: "" } as never))
      .toBe("/api/products");
    expect(isExpensiveMutation("/api/uploads/meta-ad-daily-csv")).toBe(true);
    expect(isExpensiveMutation("/api/coupang/rematch")).toBe(true);
    expect(isExpensiveMutation("/api/decisions/run")).toBe(true);
    expect(isExpensiveMutation("/api/products")).toBe(false);
  });
});

function context(method: string, originalUrl: string) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, originalUrl, url: originalUrl }) })
  } as unknown as ExecutionContext;
}
