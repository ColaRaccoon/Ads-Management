import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { PermissionGuard } from "./permission.guard";
import { Authenticated, Public, RequirePermissions } from "./route-decorators";

class GuardFixture {
  @Public()
  publicRoute() {}

  @Authenticated()
  authenticatedRoute() {}

  @RequirePermissions("products.manage")
  productMutation() {}

  missingMetadata() {}
}

describe("PermissionGuard", () => {
  const guard = new PermissionGuard(new Reflector());

  it("allows public and explicitly authenticated handlers", () => {
    expect(guard.canActivate(contextFor("publicRoute"))).toBe(true);
    expect(guard.canActivate(contextFor("authenticatedRoute", ["data.read"]))).toBe(true);
  });

  it("requires every declared permission", () => {
    expect(guard.canActivate(contextFor("productMutation", ["data.read", "products.manage"]))).toBe(true);
    expect(() => guard.canActivate(contextFor("productMutation", ["data.read"])))
      .toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("fails closed when route metadata is missing", () => {
    expect(() => guard.canActivate(contextFor("missingMetadata", ["products.manage"])))
      .toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });
});

function contextFor(method: keyof GuardFixture, permissions: string[] = []) {
  const request = permissions.length
    ? { authenticatedUser: { permissions } }
    : {};
  return {
    getHandler: () => GuardFixture.prototype[method],
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext;
}
