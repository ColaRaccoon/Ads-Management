import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUSINESS_MUTATION_INVENTORY, visibleBusinessMutations } from "./mutation-inventory";
import type { Permission } from "@/features/auth/auth-types";

const srcRoot = fileURLToPath(new URL("../", import.meta.url));
const activePages = [
  "app/campaigns/page.tsx",
  "app/adsets/page.tsx",
  "app/ads/page.tsx",
  "app/daily-report/page.tsx",
  "app/coupang/dashboard/page.tsx",
  "app/coupang/profit/page.tsx",
  "app/coupang/ads/page.tsx",
  "app/dashboard/page.tsx",
  "app/uploads/page.tsx",
  "app/sales/page.tsx",
  "app/mappings/page.tsx",
  "app/settings/products/page.tsx",
  "app/change-logs/page.tsx",
  "app/coupang/uploads/page.tsx",
  "app/coupang/products/page.tsx",
  "app/coupang/mappings/page.tsx",
  "app/coupang/unmatched/page.tsx",
  "app/coupang/daily-report/page.tsx",
  "app/creative-trends/page.tsx"
] as const;

const source = (relativePath: string) => readFileSync(`${srcRoot}/${relativePath}`, "utf8");

describe("business mutation inventory", () => {
  it("covers the independent 45 active and 5 inactive call-site baseline", () => {
    const active = BUSINESS_MUTATION_INVENTORY.filter((item) => item.active);
    const inactive = BUSINESS_MUTATION_INVENTORY.filter((item) => !item.active);
    expect(active).toHaveLength(45);
    expect(inactive).toHaveLength(5);
    expect(countPermissions(active)).toEqual({
      "products.manage": 20,
      "mappings.manage": 13,
      "imports.manage": 9,
      "operations.run": 2,
      "change_logs.create": 1
    });
  });

  it("maps every call-site to source evidence, a server permission, and a read-only replacement", () => {
    expect(new Set(BUSINESS_MUTATION_INVENTORY.map((item) => item.id)).size).toBe(BUSINESS_MUTATION_INVENTORY.length);
    for (const item of BUSINESS_MUTATION_INVENTORY) {
      expect(source(item.source), item.id).toContain(item.evidence);
      expect(item.permission, item.id).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(item.readOnlyReplacement.trim().length, item.id).toBeGreaterThan(0);
      if (item.active) {
        expect(source(item.gateSource), item.id).toContain(item.gateEvidence);
      }
    }
  });

  it("derives GUEST/USER/ADMIN/SUPER_ADMIN mutation visibility from server permissions only", () => {
    const rolePermissions: Record<string, Permission[]> = {
      GUEST: ["data.read"],
      USER: ["data.read", "change_logs.create", "reports.generate"],
      ADMIN: ["data.read", "change_logs.create", "reports.generate", "products.manage", "imports.manage", "mappings.manage", "operations.run"],
      SUPER_ADMIN: ["data.read", "change_logs.create", "reports.generate", "products.manage", "imports.manage", "mappings.manage", "operations.run", "settings.manage", "users.manage", "audit.read"]
    };
    expect(visibleBusinessMutations(rolePermissions.GUEST)).toEqual([]);
    expect(visibleBusinessMutations(rolePermissions.USER).map((item) => item.id)).toEqual(["change-logs.product-log-create"]);
    expect(visibleBusinessMutations(rolePermissions.ADMIN)).toHaveLength(45);
    expect(visibleBusinessMutations(rolePermissions.SUPER_ADMIN)).toHaveLength(45);
  });

  it("keeps read-only timelines, row selection, filters, detail, and client exports while gating write surfaces", () => {
    expect(source("app/change-logs/page.tsx")).toMatch(/canCreateChangeLogs \?[\s\S]*selectedDetail\.logs\.map/);
    expect(source("app/dashboard/page.tsx")).toMatch(/canRunOperations \?[\s\S]*decisions\.topRecommendations/);
    expect(source("app/uploads/page.tsx")).toContain("...(canManageImports ? [{");
    expect(source("app/coupang/uploads/page.tsx")).toContain("...(canManageImports ? [{");
    expect(source("app/coupang/mappings/page.tsx")).toContain("...(canManageMappings ? [{");
    expect(source("app/settings/products/page.tsx")).toContain("...(canManageProducts ? [{");
    expect(source("app/coupang/products/page.tsx")).toContain("onRowClick={editProduct}");
    expect(source("app/settings/products/page.tsx")).toContain("onRowClick={(row) => selectProduct(row.id)}");
    expect(source("app/sales/page.tsx")).toContain("downloadSalesExcel(");
    expect(source("app/ads/page.tsx")).toContain("downloadAdsExcel(");
    expect(source("app/daily-report/page.tsx")).toContain("onExportXlsx");
    expect(source("app/coupang/daily-report/page.tsx")).toContain("downloadCsv(");
    expect(source("app/coupang/daily-report/page.tsx")).toContain("exportXlsx");
  });

  it("keeps all 19 business pages explicit and does not activate legacy mutation components", () => {
    expect(activePages).toHaveLength(19);
    const activeSource = activePages.map(source).join("\n");
    for (const component of ["UploadDropzone", "ReportExportButton", "ProductRuleEditor", "ManualMappingEditor"]) {
      expect(activeSource).not.toContain(`@/components/${component}`);
    }
    for (const duplicate of ["@/components/AppShell", "@/components/DataTable", "@/components/KpiCard", "@/components/DecisionBadge"]) {
      expect(activeSource).not.toContain(duplicate);
    }
    for (const item of BUSINESS_MUTATION_INVENTORY.filter((entry) => !entry.active)) {
      expect(source(item.source), item.id).toContain("PermissionGate");
      expect(source(item.source), item.id).toContain(`permission=\"${item.permission}\"`);
    }
  });

  it("gates both category management entry points and mounts the mutation dialog only for managers", () => {
    const filter = source("app/coupang/daily-report/category-filter.tsx");
    const report = source("app/coupang/daily-report/page.tsx");
    expect(filter).toMatch(/canManage[\s\S]{0,900}첫 카테고리 만들기/);
    expect(filter).toMatch(/canManage[\s\S]{0,700}카테고리 관리/);
    expect(report).toMatch(/canManageCategories \?[\s\S]{0,200}<DailyCategoryManager/);
  });
});

function countPermissions(items: ArrayLike<{ permission: string }>) {
  return Array.from(items).reduce<Record<string, number>>((counts, item) => {
    counts[item.permission] = (counts[item.permission] ?? 0) + 1;
    return counts;
  }, {});
}
