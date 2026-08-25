import "reflect-metadata";
import { DynamicModule, ExecutionContext, RequestMethod, Type } from "@nestjs/common";
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { AuthModule } from "./auth.module";
import { AuthenticationGuard } from "./authentication.guard";
import { PermissionGuard } from "./permission.guard";
import {
  AUTH_ROUTE_ACCESS,
  REQUIRED_PERMISSIONS
} from "./route-decorators";

type ExpectedAccess = "public" | "authenticated" | "internal-probe" | "data.read" | "change_logs.create"
  | "reports.generate" | "products.manage" | "imports.manage" | "mappings.manage"
  | "operations.run" | "settings.manage" | "users.manage" | "audit.read";

const expectedRoutes = new Map<string, ExpectedAccess>([
  route("POST", "/api/auth/login", "public"),
  route("POST", "/api/auth/refresh", "public"),
  route("POST", "/api/auth/logout", "public"),
  route("GET", "/api/auth/me", "authenticated"),
  route("POST", "/api/auth/invitations/accept", "public"),
  route("POST", "/api/auth/password", "authenticated"),
  route("GET", "/api/users", "users.manage"),
  route("POST", "/api/users/invitations", "users.manage"),
  route("PATCH", "/api/users/:id", "users.manage"),
  route("POST", "/api/users/:id/reconcile-invitation", "users.manage"),
  route("GET", "/api/security-audit", "audit.read"),
  route("GET", "/api/health/live", "public"),
  route("GET", "/api/health/ready", "internal-probe"),

  route("POST", "/api/uploads/meta-ad-daily-csv", "imports.manage"),
  route("POST", "/api/uploads/meta-adset-csv", "imports.manage"),
  route("GET", "/api/uploads", "data.read"),
  route("GET", "/api/uploads/:id/preview", "data.read"),
  route("GET", "/api/uploads/:id/errors", "data.read"),
  route("POST", "/api/uploads/storage-tombstones/:id/restore", "settings.manage"),
  route("POST", "/api/uploads/storage-tombstones/:id/purge", "settings.manage"),
  route("DELETE", "/api/uploads/:id", "imports.manage"),

  route("GET", "/api/products", "data.read"),
  route("POST", "/api/products", "products.manage"),
  route("PATCH", "/api/products/:id", "products.manage"),
  route("DELETE", "/api/products/:id", "products.manage"),
  route("GET", "/api/product-cost-rules", "data.read"),
  route("POST", "/api/product-cost-rules", "products.manage"),
  route("POST", "/api/products/:productId/cost-rule-snapshots", "products.manage"),
  route("PATCH", "/api/products/:productId/cost-rules/:ruleId/correction", "products.manage"),
  route("GET", "/api/product-cpa-rules", "data.read"),
  route("POST", "/api/product-cpa-rules", "products.manage"),
  route("POST", "/api/products/:productId/cpa-rule-snapshots", "products.manage"),
  route("PATCH", "/api/products/:productId/cpa-rules/:ruleId/correction", "products.manage"),
  route("GET", "/api/product-rule-duplicate-diagnostics", "data.read"),
  route("GET", "/api/settings", "data.read"),
  route("PATCH", "/api/settings/:key", "settings.manage"),
  route("PATCH", "/api/settings/products/coupang-manual-purchase-vendor-fee", "products.manage"),

  route("GET", "/api/mappings/product-rules", "data.read"),
  route("POST", "/api/mappings/product-rules", "mappings.manage"),
  route("POST", "/api/mappings/rematch", "mappings.manage"),
  route("POST", "/api/mappings/product/manual", "mappings.manage"),
  route("POST", "/api/mappings/stage/manual", "mappings.manage"),

  route("GET", "/api/dashboard/summary", "data.read"),
  route("GET", "/api/dashboard/trends", "data.read"),
  route("GET", "/api/metrics/campaigns", "data.read"),
  route("GET", "/api/metrics/adsets", "data.read"),
  route("GET", "/api/metrics/adsets/:metaAdsetId/ads", "data.read"),
  route("GET", "/api/metrics/campaigns/:metaCampaignId/adsets", "data.read"),
  route("GET", "/api/metrics/ads/compare-by-name", "data.read"),
  route("GET", "/api/metrics/ads/creatives", "data.read"),
  route("GET", "/api/metrics/ads/creative-video-trends", "data.read"),
  route("GET", "/api/metrics/ads", "data.read"),
  route("GET", "/api/metrics/products", "data.read"),
  route("GET", "/api/metrics/unmatched", "data.read"),

  route("POST", "/api/decisions/run", "operations.run"),
  route("GET", "/api/decisions", "data.read"),
  route("POST", "/api/reports/export", "reports.generate"),
  route("GET", "/api/reports", "data.read"),
  route("GET", "/api/reports/:id/download", "data.read"),
  route("GET", "/api/change-logs/creatives", "data.read"),
  route("GET", "/api/change-logs/creatives/:creativeId", "data.read"),
  route("POST", "/api/change-logs/creatives/:creativeId/logs", "change_logs.create"),
  route("GET", "/api/change-logs/products", "data.read"),
  route("GET", "/api/change-logs/products/:productId", "data.read"),
  route("POST", "/api/change-logs/products/:productId/logs", "change_logs.create"),
  route("GET", "/api/change-logs", "data.read"),
  route("POST", "/api/change-logs", "change_logs.create"),

  route("GET", "/api/sales/product-performance", "data.read"),
  route("GET", "/api/sales/cafe24/coupon-matches", "data.read"),
  route("GET", "/api/sales/cafe24/unmatched", "data.read"),
  route("POST", "/api/sales/cafe24/uploads", "imports.manage"),
  route("GET", "/api/sales/cafe24/uploads", "data.read"),
  route("GET", "/api/sales/cafe24/uploads/:id/preview", "data.read"),
  route("GET", "/api/sales/cafe24/uploads/:id/errors", "data.read"),
  route("DELETE", "/api/sales/cafe24/uploads/:id", "imports.manage"),
  route("POST", "/api/sales/cafe24/rematch", "mappings.manage"),
  route("GET", "/api/sales/cafe24/rules", "data.read"),
  route("POST", "/api/sales/cafe24/rules", "mappings.manage"),
  route("PATCH", "/api/sales/cafe24/rules/:id", "mappings.manage"),
  route("DELETE", "/api/sales/cafe24/rules/:id", "mappings.manage"),
  route("GET", "/api/sales/cafe24/coupon-rules", "data.read"),
  route("POST", "/api/sales/cafe24/coupon-rules", "products.manage"),
  route("PATCH", "/api/sales/cafe24/coupon-rules/:id", "products.manage"),

  route("POST", "/api/coupang/uploads/sales", "imports.manage"),
  route("POST", "/api/coupang/uploads/ads", "imports.manage"),
  route("POST", "/api/coupang/uploads/margin", "imports.manage"),
  route("POST", "/api/coupang/uploads/price-text", "imports.manage"),
  route("POST", "/api/coupang/uploads/promotion", "imports.manage"),
  route("POST", "/api/coupang/uploads/bundle", "imports.manage"),
  route("GET", "/api/coupang/uploads", "data.read"),
  route("GET", "/api/coupang/uploads/:id/preview", "data.read"),
  route("GET", "/api/coupang/uploads/:id/errors", "data.read"),
  route("DELETE", "/api/coupang/uploads/:id", "imports.manage"),
  route("GET", "/api/coupang/product-settings", "data.read"),
  route("POST", "/api/coupang/product-settings", "products.manage"),
  route("PATCH", "/api/coupang/product-settings/:id/configuration", "products.manage"),
  route("PATCH", "/api/coupang/product-settings/:productId/cost-rules/:costRuleId", "products.manage"),
  route("GET", "/api/coupang/sales-fee-rules/current", "data.read"),
  route("GET", "/api/coupang/sales-fee-rules", "data.read"),
  route("POST", "/api/coupang/sales-fee-rules", "products.manage"),
  route("PATCH", "/api/coupang/sales-fee-rules/:id", "products.manage"),
  route("PATCH", "/api/coupang/product-settings/:id", "products.manage"),
  route("DELETE", "/api/coupang/product-settings/:id", "products.manage"),
  route("GET", "/api/coupang/product-groups", "data.read"),
  route("POST", "/api/coupang/product-groups", "products.manage"),
  route("PATCH", "/api/coupang/product-groups/:id", "products.manage"),
  route("DELETE", "/api/coupang/product-groups/:id", "products.manage"),
  route("GET", "/api/coupang/mapping-rules", "data.read"),
  route("POST", "/api/coupang/mapping-rules", "mappings.manage"),
  route("PATCH", "/api/coupang/mapping-rules/:id", "mappings.manage"),
  route("DELETE", "/api/coupang/mapping-rules/:id", "mappings.manage"),
  route("GET", "/api/coupang/manual-purchases/options", "data.read"),
  route("GET", "/api/coupang/manual-purchases", "data.read"),
  route("PUT", "/api/coupang/manual-purchases/:date", "operations.run"),
  route("DELETE", "/api/coupang/manual-purchases/:id", "operations.run"),
  route("POST", "/api/coupang/rematch", "mappings.manage"),
  route("GET", "/api/coupang/dashboard", "data.read"),
  route("GET", "/api/coupang/product-profit", "data.read"),
  route("GET", "/api/coupang/ads-analysis", "data.read"),
  route("GET", "/api/coupang/unmatched", "data.read"),
  route("GET", "/api/coupang/mapping-issues", "data.read"),
  route("GET", "/api/coupang/daily-report", "data.read"),
  route("GET", "/api/coupang/daily-report/categories", "data.read"),
  route("GET", "/api/coupang/daily-report/category-catalog", "data.read"),
  route("POST", "/api/coupang/daily-report/categories", "products.manage"),
  route("PATCH", "/api/coupang/daily-report/categories/:id", "products.manage"),
  route("PUT", "/api/coupang/daily-report/categories/:id/products", "products.manage"),
  route("DELETE", "/api/coupang/daily-report/categories/:id", "products.manage")
]);

const discoveredRoutes = discoverRoutes(AppModule);

describe("active AppModule route permissions", () => {
  it("registers authentication then authorization as ordered global guards", () => {
    const globalGuards = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule) ?? [])
      .filter((provider: { provide?: unknown }) => provider?.provide === APP_GUARD)
      .map((provider: { useExisting?: Type<unknown> }) => provider.useExisting?.name);
    expect(globalGuards).toEqual([
      "AuthenticationGuard",
      "InternalProbeGuard",
      "PermissionGuard",
      "HttpSecurityGuard"
    ]);
  });

  it("matches the independent method and normalized-path inventory", () => {
    expect(discoveredRoutes.controllers).toBe(18);
    expect([...discoveredRoutes.routes.keys()].sort()).toEqual([...expectedRoutes.keys()].sort());
    expect(discoveredRoutes.routes.size).toBe(128);
  });

  it("gives every handler exactly one explicit access contract with the expected permission", () => {
    for (const [key, expected] of expectedRoutes) {
      const actual = discoveredRoutes.routes.get(key);
      expect(actual, key).toBeDefined();
      const access = Reflect.getMetadata(AUTH_ROUTE_ACCESS, actual!.handler);
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS, actual!.handler);
      if (expected === "public" || expected === "authenticated" || expected === "internal-probe") {
        expect(access, key).toBe(expected);
        expect(permissions, key).toBeUndefined();
      } else {
        expect(access, key).toBe("permission");
        expect(permissions, key).toEqual([expected]);
      }
    }
  });

  it("keeps public and internal-probe markers on their exact allowlists", () => {
    const publicRoutes = [...discoveredRoutes.routes]
      .filter(([, value]) => Reflect.getMetadata(AUTH_ROUTE_ACCESS, value.handler) === "public")
      .map(([key]) => key)
      .sort();
    expect(publicRoutes).toEqual([
      "GET /api/health/live",
      "POST /api/auth/invitations/accept",
      "POST /api/auth/login",
      "POST /api/auth/logout",
      "POST /api/auth/refresh"
    ]);
    expect([...discoveredRoutes.routes].filter(
      ([, { handler }]) => Reflect.getMetadata(AUTH_ROUTE_ACCESS, handler) === "internal-probe"
    ).map(([key]) => key)).toEqual(["GET /api/health/ready"]);
  });
});

describe("role permission guard matrix for every active method/path", () => {
  const roles = {
    GUEST: ["data.read"],
    USER: ["data.read", "change_logs.create", "reports.generate"],
    ADMIN: [
      "data.read", "change_logs.create", "reports.generate", "products.manage",
      "imports.manage", "mappings.manage", "operations.run"
    ],
    SUPER_ADMIN: [
      "data.read", "change_logs.create", "reports.generate", "products.manage", "imports.manage",
      "mappings.manage", "operations.run", "settings.manage", "users.manage", "audit.read"
    ]
  } as const;

  it("rejects anonymous requests before any non-public handler", async () => {
    const authenticate = new AuthenticationGuard(
      { authenticateAccessToken: vi.fn() } as never,
      { readAccessToken: vi.fn() } as never,
      new Reflector()
    );
    for (const [key, expected] of expectedRoutes) {
      const context = contextFor(discoveredRoutes.routes.get(key)!.handler, {});
      if (expected === "public" || expected === "internal-probe") {
        await expect(authenticate.canActivate(context)).resolves.toBe(true);
      } else {
        await expect(authenticate.canActivate(context)).rejects.toMatchObject({
          code: "AUTHENTICATION_REQUIRED",
          status: 401
        });
      }
    }
  });

  it.each(Object.entries(roles))("enforces %s permissions on the complete route set", async (_role, permissions) => {
    const principal = { permissions: [...permissions] };
    const authenticate = new AuthenticationGuard(
      { authenticateAccessToken: vi.fn().mockResolvedValue(principal) } as never,
      { readAccessToken: vi.fn().mockReturnValue("opaque-access") } as never,
      new Reflector()
    );
    const authorize = new PermissionGuard(new Reflector());

    for (const [key, expected] of expectedRoutes) {
      const request: Record<string, unknown> = {};
      const context = contextFor(discoveredRoutes.routes.get(key)!.handler, request);
      await expect(authenticate.canActivate(context), key).resolves.toBe(true);
      const allowed = expected === "public" || expected === "authenticated" || permissions.includes(expected as never);
      if (allowed) {
        expect(authorize.canActivate(context), key).toBe(true);
      } else {
        expect(() => authorize.canActivate(context), key).toThrow(
          expect.objectContaining({ code: "PERMISSION_DENIED", status: 403 })
        );
      }
    }
  });
});

function route(method: string, path: string, access: ExpectedAccess): [string, ExpectedAccess] {
  return [`${method} ${path}`, access];
}

function discoverRoutes(root: Type<unknown>) {
  const controllers = new Set<Type<unknown>>();
  const visited = new Set<Type<unknown>>();
  const visit = (moduleType: Type<unknown>) => {
    if (visited.has(moduleType)) return;
    visited.add(moduleType);
    for (const controller of Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleType) ?? []) {
      controllers.add(controller);
    }
    for (const imported of Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleType) ?? []) {
      const importedType = dynamicModuleType(imported);
      if (importedType) visit(importedType);
    }
  };
  visit(root);

  const routes = new Map<string, { controller: Type<unknown>; handler: Function }>();
  for (const controller of controllers) {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) ?? "";
    for (const methodName of Object.getOwnPropertyNames(controller.prototype)) {
      if (methodName === "constructor") continue;
      const handler = controller.prototype[methodName];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const handlerPath = Reflect.getMetadata(PATH_METADATA, handler);
      if (method === undefined || handlerPath === undefined) continue;
      const key = `${RequestMethod[method]} ${normalizedPath("api", controllerPath, handlerPath)}`;
      if (routes.has(key)) throw new Error(`Duplicate active route: ${key}`);
      routes.set(key, { controller, handler });
    }
  }
  return { controllers: controllers.size, routes };
}

function dynamicModuleType(value: Type<unknown> | DynamicModule): Type<unknown> | undefined {
  if (typeof value === "function") return value;
  if (value && typeof value === "object" && "module" in value) return value.module;
  return undefined;
}

function normalizedPath(...parts: unknown[]) {
  return `/${parts.map((part) => String(part ?? "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean).join("/")}`;
}

function contextFor(handler: Function, request: Record<string, unknown>) {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext;
}
