import "reflect-metadata";
import { INestApplication, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChangeLogsController } from "../change-logs/change-logs.controller";
import { ChangeLogsService } from "../change-logs/change-logs.service";
import { CoupangController } from "../coupang/coupang.controller";
import { CoupangService } from "../coupang/coupang.service";
import { DecisionsController } from "../decisions/decisions.controller";
import { DecisionsService } from "../decisions/decisions.service";
import { MappingsController } from "../mappings/mappings.controller";
import { MappingsService } from "../mappings/mappings.service";
import { ProductRulesController } from "../products/product-rules.controller";
import { ProductsController } from "../products/products.controller";
import { ProductsService } from "../products/products.service";
import { SettingsController } from "../products/settings.controller";
import { ReportsController } from "../reports/reports.controller";
import { ReportsService } from "../reports/reports.service";
import { Cafe24CouponRulesController } from "../sales/cafe24-coupon-rules.controller";
import { Cafe24CouponRulesService } from "../sales/cafe24-coupon-rules.service";
import { Cafe24UploadsController } from "../sales/cafe24-uploads.controller";
import { Cafe24UploadsService } from "../sales/cafe24-uploads.service";
import { UploadsController } from "../uploads/uploads.controller";
import { UploadsService } from "../uploads/uploads.service";
import { SecurityAuditController } from "../security-audit/security-audit.controller";
import { SecurityAuditService } from "../security-audit/security-audit.service";
import { UsersController } from "../users/users.controller";
import { UsersService } from "../users/users.service";
import { authError } from "./auth.errors";
import { AuthService } from "./auth.service";
import { AuthenticationGuard } from "./authentication.guard";
import { AuthCookieService } from "./cookie.service";
import { PermissionGuard } from "./permission.guard";
import { AuthRequestSecurityService } from "./request-security.service";

type BusinessPermission = "change_logs.create" | "reports.generate" | "products.manage"
  | "imports.manage" | "mappings.manage" | "operations.run" | "settings.manage"
  | "users.manage" | "audit.read";
type TestRole = "GUEST" | "USER" | "ADMIN" | "SUPER_ADMIN";
type Mutation = { method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; permission: BusinessPermission };

// This HTTP table is intentionally independent from the decorators and the
// production ROLE_PERMISSIONS mapping. Every active business mutation appears
// once, so a denied request proves the real controller handler was not invoked.
const mutations: Mutation[] = [
  mutation("POST", "/uploads/meta-ad-daily-csv", "imports.manage"),
  mutation("POST", "/uploads/meta-adset-csv", "imports.manage"),
  mutation("DELETE", "/uploads/:id", "imports.manage"),
  mutation("POST", "/uploads/storage-tombstones/:id/restore", "settings.manage"),
  mutation("POST", "/uploads/storage-tombstones/:id/purge", "settings.manage"),
  mutation("POST", "/products", "products.manage"),
  mutation("PATCH", "/products/:id", "products.manage"),
  mutation("DELETE", "/products/:id", "products.manage"),
  mutation("POST", "/product-cost-rules", "products.manage"),
  mutation("POST", "/products/:productId/cost-rule-snapshots", "products.manage"),
  mutation("PATCH", "/products/:productId/cost-rules/:ruleId/correction", "products.manage"),
  mutation("POST", "/product-cpa-rules", "products.manage"),
  mutation("POST", "/products/:productId/cpa-rule-snapshots", "products.manage"),
  mutation("PATCH", "/products/:productId/cpa-rules/:ruleId/correction", "products.manage"),
  mutation("PATCH", "/settings/:key", "settings.manage"),
  mutation("PATCH", "/settings/products/coupang-manual-purchase-vendor-fee", "products.manage"),
  mutation("POST", "/mappings/product-rules", "mappings.manage"),
  mutation("POST", "/mappings/rematch", "mappings.manage"),
  mutation("POST", "/mappings/product/manual", "mappings.manage"),
  mutation("POST", "/mappings/stage/manual", "mappings.manage"),
  mutation("POST", "/decisions/run", "operations.run"),
  mutation("POST", "/reports/export", "reports.generate"),
  mutation("POST", "/change-logs/creatives/:creativeId/logs", "change_logs.create"),
  mutation("POST", "/change-logs/products/:productId/logs", "change_logs.create"),
  mutation("POST", "/change-logs", "change_logs.create"),
  mutation("POST", "/sales/cafe24/uploads", "imports.manage"),
  mutation("DELETE", "/sales/cafe24/uploads/:id", "imports.manage"),
  mutation("POST", "/sales/cafe24/rematch", "mappings.manage"),
  mutation("POST", "/sales/cafe24/rules", "mappings.manage"),
  mutation("PATCH", "/sales/cafe24/rules/:id", "mappings.manage"),
  mutation("DELETE", "/sales/cafe24/rules/:id", "mappings.manage"),
  mutation("POST", "/sales/cafe24/coupon-rules", "products.manage"),
  mutation("PATCH", "/sales/cafe24/coupon-rules/:id", "products.manage"),
  mutation("POST", "/coupang/uploads/sales", "imports.manage"),
  mutation("POST", "/coupang/uploads/ads", "imports.manage"),
  mutation("POST", "/coupang/uploads/margin", "imports.manage"),
  mutation("POST", "/coupang/uploads/price-text", "imports.manage"),
  mutation("POST", "/coupang/uploads/promotion", "imports.manage"),
  mutation("POST", "/coupang/uploads/bundle", "imports.manage"),
  mutation("DELETE", "/coupang/uploads/:id", "imports.manage"),
  mutation("POST", "/coupang/product-settings", "products.manage"),
  mutation("PATCH", "/coupang/product-settings/:id/configuration", "products.manage"),
  mutation("PATCH", "/coupang/product-settings/:productId/cost-rules/:costRuleId", "products.manage"),
  mutation("POST", "/coupang/sales-fee-rules", "products.manage"),
  mutation("PATCH", "/coupang/sales-fee-rules/:id", "products.manage"),
  mutation("PATCH", "/coupang/product-settings/:id", "products.manage"),
  mutation("DELETE", "/coupang/product-settings/:id", "products.manage"),
  mutation("POST", "/coupang/product-groups", "products.manage"),
  mutation("PATCH", "/coupang/product-groups/:id", "products.manage"),
  mutation("DELETE", "/coupang/product-groups/:id", "products.manage"),
  mutation("POST", "/coupang/mapping-rules", "mappings.manage"),
  mutation("PATCH", "/coupang/mapping-rules/:id", "mappings.manage"),
  mutation("DELETE", "/coupang/mapping-rules/:id", "mappings.manage"),
  mutation("PUT", "/coupang/manual-purchases/:date", "operations.run"),
  mutation("DELETE", "/coupang/manual-purchases/:id", "operations.run"),
  mutation("POST", "/coupang/rematch", "mappings.manage"),
  mutation("POST", "/coupang/daily-report/categories", "products.manage"),
  mutation("PATCH", "/coupang/daily-report/categories/:id", "products.manage"),
  mutation("PUT", "/coupang/daily-report/categories/:id/products", "products.manage"),
  mutation("DELETE", "/coupang/daily-report/categories/:id", "products.manage")
];

const rolePermissions: Record<TestRole, readonly BusinessPermission[]> = {
  GUEST: [],
  USER: ["change_logs.create", "reports.generate"],
  ADMIN: [
    "change_logs.create", "reports.generate", "products.manage", "imports.manage",
    "mappings.manage", "operations.run"
  ],
  SUPER_ADMIN: [
    "change_logs.create", "reports.generate", "products.manage", "imports.manage",
    "mappings.manage", "operations.run", "settings.manage", "users.manage", "audit.read"
  ]
};

const actorForwardingMutations = new Set([
  "POST /uploads/meta-ad-daily-csv",
  "POST /uploads/meta-adset-csv",
  "POST /uploads/storage-tombstones/:id/restore",
  "POST /uploads/storage-tombstones/:id/purge",
  "POST /product-cost-rules",
  "POST /products/:productId/cost-rule-snapshots",
  "PATCH /products/:productId/cost-rules/:ruleId/correction",
  "POST /product-cpa-rules",
  "POST /products/:productId/cpa-rule-snapshots",
  "PATCH /products/:productId/cpa-rules/:ruleId/correction",
  "PATCH /settings/:key",
  "PATCH /settings/products/coupang-manual-purchase-vendor-fee",
  "POST /mappings/product-rules",
  "POST /mappings/product/manual",
  "POST /mappings/stage/manual",
  "POST /decisions/run",
  "POST /reports/export",
  "POST /change-logs/creatives/:creativeId/logs",
  "POST /change-logs/products/:productId/logs",
  "POST /change-logs",
  "POST /sales/cafe24/uploads",
  "POST /sales/cafe24/coupon-rules",
  "PATCH /sales/cafe24/coupon-rules/:id",
  "POST /coupang/uploads/sales",
  "POST /coupang/uploads/ads",
  "POST /coupang/uploads/margin",
  "POST /coupang/uploads/price-text",
  "POST /coupang/uploads/promotion",
  "POST /coupang/uploads/bundle",
  "POST /coupang/product-groups",
  "PATCH /coupang/product-groups/:id",
  "DELETE /coupang/product-groups/:id",
  "POST /coupang/daily-report/categories",
  "PATCH /coupang/daily-report/categories/:id",
  "PUT /coupang/daily-report/categories/:id/products",
  "DELETE /coupang/daily-report/categories/:id"
]);

const serviceInvocation = vi.fn().mockResolvedValue({});
const serviceMock = new Proxy({}, {
  get: () => serviceInvocation
});

@Module({
  controllers: [
    UploadsController,
    ProductsController,
    ProductRulesController,
    SettingsController,
    MappingsController,
    DecisionsController,
    ReportsController,
    ChangeLogsController,
    Cafe24UploadsController,
    Cafe24CouponRulesController,
    CoupangController,
    UsersController,
    SecurityAuditController
  ],
  providers: [
    { provide: UploadsService, useValue: serviceMock },
    { provide: ProductsService, useValue: serviceMock },
    { provide: MappingsService, useValue: serviceMock },
    { provide: DecisionsService, useValue: serviceMock },
    { provide: ReportsService, useValue: serviceMock },
    { provide: ChangeLogsService, useValue: serviceMock },
    { provide: Cafe24UploadsService, useValue: serviceMock },
    { provide: Cafe24CouponRulesService, useValue: serviceMock },
    { provide: CoupangService, useValue: serviceMock },
    { provide: UsersService, useValue: serviceMock },
    { provide: SecurityAuditService, useValue: serviceMock },
    {
      provide: AuthRequestSecurityService,
      useValue: { assertCsrfMutation: vi.fn().mockResolvedValue(undefined) }
    },
    {
      provide: AuthService,
      useValue: {
        authenticateAccessToken: vi.fn(async (role: string) => {
          if (role === "INACTIVE") throw authError("ACCOUNT_INACTIVE");
          if (role === "ONBOARDING") throw authError("ACCOUNT_ONBOARDING_REQUIRED");
          if (role === "UNPROVISIONED") throw authError("ACCOUNT_NOT_PROVISIONED");
          const permissions = rolePermissions[role as TestRole];
          if (!permissions) throw authError("AUTHENTICATION_REQUIRED");
          return { id: `actor-${role}`, permissions: [...permissions] };
        })
      }
    },
    {
      provide: AuthCookieService,
      useValue: {
        readAccessToken: (request: { headers: Record<string, string | string[] | undefined> }) => {
          const role = request.headers["x-test-role"];
          return Array.isArray(role) ? role[0] : role;
        }
      }
    },
    {
      provide: AuthenticationGuard,
      useFactory: (authService: AuthService, cookies: AuthCookieService, reflector: Reflector) =>
        new AuthenticationGuard(authService, cookies, reflector),
      inject: [AuthService, AuthCookieService, Reflector]
    },
    {
      provide: PermissionGuard,
      useFactory: (reflector: Reflector) => new PermissionGuard(reflector),
      inject: [Reflector]
    },
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard }
  ]
})
class RolePermissionHttpModule {}

describe("role permissions through the Nest HTTP pipeline", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(RolePermissionHttpModule, { logger: false });
    // Vitest's fast transform does not emit constructor type metadata. Wire the
    // controller doubles explicitly so an allowed HTTP request reaches the
    // shared service spy, while the production build continues to use Nest DI.
    Object.assign(app.get(UploadsController), { uploadsService: serviceMock });
    Object.assign(app.get(ProductsController), { productsService: serviceMock });
    Object.assign(app.get(ProductRulesController), { productsService: serviceMock });
    Object.assign(app.get(SettingsController), { productsService: serviceMock });
    Object.assign(app.get(MappingsController), { mappingsService: serviceMock });
    Object.assign(app.get(DecisionsController), { decisionsService: serviceMock });
    Object.assign(app.get(ReportsController), { reportsService: serviceMock });
    Object.assign(app.get(ChangeLogsController), { changeLogsService: serviceMock });
    Object.assign(app.get(Cafe24UploadsController), { cafe24UploadsService: serviceMock });
    Object.assign(app.get(Cafe24CouponRulesController), { couponRulesService: serviceMock });
    Object.assign(app.get(CoupangController), { coupangService: serviceMock });
    Object.assign(app.get(UsersController), {
      users: serviceMock,
      requestSecurity: app.get(AuthRequestSecurityService)
    });
    Object.assign(app.get(SecurityAuditController), { audit: serviceMock });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("covers every active business mutation independently", () => {
    expect(mutations).toHaveLength(60);
    expect(new Set(mutations.map(({ method, path }) => `${method} ${path}`)).size).toBe(60);
  });

  it.each([
    "ANONYMOUS", "UNPROVISIONED", "INACTIVE", "ONBOARDING",
    "GUEST", "USER", "ADMIN", "SUPER_ADMIN"
  ] as const)(
    "enforces every mutation for %s before its service call",
    async (requester) => {
      for (const route of mutations) {
        serviceInvocation.mockClear();
        const response = await fetch(`${baseUrl}/api${materialize(route.path)}`, {
          method: route.method,
          headers: {
            "content-type": "application/json",
            ...(requester === "ANONYMOUS" ? {} : { "x-test-role": requester })
          },
          body: JSON.stringify({ valueJson: 1 })
        });

        const activePermissions = rolePermissions[requester as TestRole];
        const allowed = activePermissions?.includes(route.permission) ?? false;
        if (allowed) {
          expect(response.status, `${requester} ${route.method} ${route.path}`).toBeLessThan(400);
          expect(serviceInvocation, `${requester} ${route.method} ${route.path}`).toHaveBeenCalled();
          if (actorForwardingMutations.has(`${route.method} ${route.path}`)) {
            expect(serviceInvocation.mock.calls[0], `${requester} ${route.method} ${route.path}`)
              .toContain(`actor-${requester}`);
          }
        } else {
          const expectedStatus = requester === "ANONYMOUS" ? 401 : requester === "INACTIVE" ? 403 : 403;
          expect(response.status, `${requester} ${route.method} ${route.path}`).toBe(expectedStatus);
          expect(serviceInvocation, `${requester} ${route.method} ${route.path}`).not.toHaveBeenCalled();
        }
      }
    }
  );

  it.each([
    "ANONYMOUS", "GUEST", "USER", "ADMIN", "SUPER_ADMIN"
  ] as const)("enforces every security administration endpoint for %s", async (requester) => {
    const routes = [
      { method: "GET", path: "/users", body: undefined },
      {
        method: "POST",
        path: "/users/invitations",
        body: { email: "guest@example.com", name: "Guest", role: "GUEST" }
      },
      {
        method: "PATCH",
        path: "/users/22222222-2222-4222-8222-222222222222",
        body: { name: "Changed" }
      },
      {
        method: "POST",
        path: "/users/22222222-2222-4222-8222-222222222222/reconcile-invitation",
        body: { action: "CANCEL" }
      },
      { method: "GET", path: "/security-audit?limit=20", body: undefined }
    ] as const;
    for (const route of routes) {
      serviceInvocation.mockClear();
      const response = await fetch(`${baseUrl}/api${route.path}`, {
        method: route.method,
        headers: {
          ...(route.body ? { "content-type": "application/json" } : {}),
          ...(requester === "ANONYMOUS" ? {} : { "x-test-role": requester })
        },
        body: route.body ? JSON.stringify(route.body) : undefined
      });
      const allowed = requester === "SUPER_ADMIN";
      if (allowed) {
        expect(response.status, `${requester} ${route.method} ${route.path}`).toBeLessThan(400);
        expect(serviceInvocation).toHaveBeenCalled();
      } else {
        expect(response.status, `${requester} ${route.method} ${route.path}`)
          .toBe(requester === "ANONYMOUS" ? 401 : 403);
        expect(serviceInvocation).not.toHaveBeenCalled();
      }
    }
  });
});

function mutation(method: Mutation["method"], path: string, permission: BusinessPermission): Mutation {
  return { method, path, permission };
}

function materialize(path: string) {
  return path.replace(/:date\b/g, "2026-08-24").replace(/:[^/]+/g, "test-id");
}
