import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type ControllerInventory = {
  file: string;
  routes: number;
  body: number;
  query: number;
  param: number;
  files: number;
};

// Literal inventory of the AppModule controller graph. Health routes have no transport inputs.
const ACTIVE_CONTROLLER_INVENTORY: ControllerInventory[] = [
  { file: "auth/auth.controller.ts", routes: 6, body: 3, query: 0, param: 0, files: 0 },
  { file: "change-logs/change-logs.controller.ts", routes: 8, body: 3, query: 5, param: 4, files: 0 },
  { file: "coupang/coupang.controller.ts", routes: 45, body: 20, query: 17, param: 17, files: 6 },
  { file: "decisions/decisions.controller.ts", routes: 2, body: 1, query: 1, param: 0, files: 0 },
  { file: "health/health.controller.ts", routes: 2, body: 0, query: 0, param: 0, files: 0 },
  { file: "mappings/mappings.controller.ts", routes: 5, body: 4, query: 0, param: 0, files: 0 },
  { file: "metrics/dashboard.controller.ts", routes: 2, body: 0, query: 2, param: 0, files: 0 },
  { file: "metrics/metrics.controller.ts", routes: 10, body: 0, query: 10, param: 2, files: 0 },
  { file: "products/product-rules.controller.ts", routes: 9, body: 6, query: 2, param: 4, files: 0 },
  { file: "products/products.controller.ts", routes: 4, body: 2, query: 1, param: 2, files: 0 },
  { file: "products/settings.controller.ts", routes: 3, body: 2, query: 0, param: 1, files: 0 },
  { file: "reports/reports.controller.ts", routes: 3, body: 1, query: 0, param: 1, files: 0 },
  { file: "sales/cafe24-coupon-rules.controller.ts", routes: 3, body: 2, query: 1, param: 1, files: 0 },
  { file: "sales/cafe24-uploads.controller.ts", routes: 10, body: 3, query: 4, param: 5, files: 1 },
  { file: "sales/sales-metrics.controller.ts", routes: 3, body: 0, query: 3, param: 0, files: 0 },
  { file: "security-audit/security-audit.controller.ts", routes: 1, body: 0, query: 1, param: 0, files: 0 },
  { file: "uploads/uploads.controller.ts", routes: 6, body: 2, query: 1, param: 3, files: 2 },
  { file: "users/users.controller.ts", routes: 4, body: 3, query: 0, param: 2, files: 0 }
];

const SRC_ROOT = path.resolve(__dirname, "..");
const ACTIVE_DTO_FILES = [
  "auth/dto/accept-invitation.dto.ts",
  "auth/dto/login.dto.ts",
  "auth/dto/set-initial-password.dto.ts",
  "change-logs/dto/change-log-transport.dto.ts",
  "coupang/dto/coupang-transport.dto.ts",
  "decisions/dto/decision-transport.dto.ts",
  "mappings/dto/mappings-transport.dto.ts",
  "metrics/dto/metrics-query.dto.ts",
  "products/dto/product-transport.dto.ts",
  "products/dto/update-coupang-manual-purchase-vendor-fee.dto.ts",
  "reports/dto/report-transport.dto.ts",
  "sales/dto/sales-transport.dto.ts",
  "security-audit/dto/list-security-audit.dto.ts",
  "uploads/dto/upload-transport.dto.ts",
  "users/dto/invite-user.dto.ts",
  "users/dto/reconcile-invitation.dto.ts",
  "users/dto/update-user.dto.ts",
  "validation/transport-validation.ts"
] as const;

describe("active transport input inventory", () => {
  it("keeps the literal 126-route / 151-input inventory in sync", () => {
    const totals = { routes: 0, body: 0, query: 0, param: 0, files: 0 };
    for (const expected of ACTIVE_CONTROLLER_INVENTORY) {
      const source = fs.readFileSync(path.join(SRC_ROOT, expected.file), "utf8");
      const actual = {
        routes: matches(source, /@(Get|Post|Put|Patch|Delete)\s*\(/g),
        body: matches(source, /@Body\(/g),
        query: matches(source, /@Query\(/g),
        param: matches(source, /@Param\(/g),
        files: matches(source, /@UploadedFiles?\(/g)
      };
      expect(actual, expected.file).toEqual({
        routes: expected.routes,
        body: expected.body,
        query: expected.query,
        param: expected.param,
        files: expected.files
      });
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += actual[key];
    }
    expect(ACTIVE_CONTROLLER_INVENTORY).toHaveLength(18);
    expect(totals).toEqual({ routes: 126, body: 52, query: 48, param: 42, files: 9 });
    expect(totals.body + totals.query + totals.param + totals.files).toBe(151);
  });

  it("has zero raw Body/Query/Param inputs in the active controller graph", () => {
    for (const expected of ACTIVE_CONTROLLER_INVENTORY) {
      const source = fs.readFileSync(path.join(SRC_ROOT, expected.file), "utf8");
      expect(source, `${expected.file}: property-level body`).not.toMatch(/@Body\(\s*["']/);
      expect(source, `${expected.file}: property-level query`).not.toMatch(/@Query\(\s*["']/);
      expect(source, `${expected.file}: raw Record body`).not.toMatch(/@Body\(\)\s+\w+\s*:\s*Record</);
      expect(source, `${expected.file}: inline body`).not.toMatch(/@Body\(\)\s+\w+\s*:\s*\{/);
      expect(matches(source, /@Body\(\)\s+\w+\s*:\s*[A-Za-z0-9_]*Dto\b/g), `${expected.file}: DTO body`)
        .toBe(expected.body);
      expect(matches(source, /@Query\(\)\s+\w+\s*:\s*[A-Za-z0-9_]*Dto\b/g), `${expected.file}: DTO query`)
        .toBe(expected.query);

      const propertyParams = source.match(/@Param\(\s*["'][^"']+["'][^)]*\)/g) ?? [];
      if (expected.file === "users/users.controller.ts") {
        expect(propertyParams).toHaveLength(2);
        for (const decorator of propertyParams) expect(decorator).toContain("ParseUUIDPipe");
        expect(matches(source, /@Param\(\)\s+\w+\s*:\s*[A-Za-z0-9_]*Dto\b/g)).toBe(0);
      } else {
        expect(propertyParams, `${expected.file}: raw property param`).toHaveLength(0);
        expect(matches(source, /@Param\(\)\s+\w+\s*:\s*[A-Za-z0-9_]*Dto\b/g), `${expected.file}: DTO param`)
          .toBe(expected.param);
      }
    }
  });

  it("binds every multipart file endpoint to a full form DTO", () => {
    const formControllers = ACTIVE_CONTROLLER_INVENTORY.filter((entry) => entry.files > 0);
    for (const expected of formControllers) {
      const source = fs.readFileSync(path.join(SRC_ROOT, expected.file), "utf8");
      expect(matches(source, /@Body\(\)\s+body:\s+[A-Za-z0-9_]*FormDto\b/g), expected.file)
        .toBe(expected.files);
    }
  });

  it("wires overloading-prone Coupang routes to endpoint-specific DTOs", () => {
    const source = fs.readFileSync(path.join(SRC_ROOT, "coupang/coupang.controller.ts"), "utf8");
    expect(source).toMatch(/listProductSettings\(@Query\(\) query: CoupangProductSettingsQueryDto\)/);
    expect(matches(source, /@Query\(\) query: CoupangIncludeInactiveQueryDto/g)).toBe(4);
    expect(source).toMatch(/createProductSetting\(@Body\(\) body: CoupangCreateProductSettingDto/);
    expect(source).toMatch(/correctProductCostRule\([\s\S]*?@Body\(\) body: CoupangCostRuleCorrectionDto/);
    expect(source).toMatch(/createDailyReportCategory\([\s\S]*?@Body\(\) body: CreateCoupangDailyReportCategoryDto/);
    expect(source).toMatch(/updateDailyReportCategory\([\s\S]*?@Body\(\) body: UpdateCoupangDailyReportCategoryDto/);
    expect(source).toMatch(/replaceDailyReportCategoryProducts\([\s\S]*?@Body\(\) body: ReplaceCoupangDailyReportCategoryProductsDto/);
  });

  it("uses undefined-only optional validation for every non-null optional DTO field", () => {
    let undefinedOnlyCount = 0;
    let explicitNullableCount = 0;
    for (const relativePath of ACTIVE_DTO_FILES) {
      const filePath = path.join(SRC_ROOT, relativePath);
      const source = fs.readFileSync(filePath, "utf8");
      const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isPropertyDeclaration(node)) {
          const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
          const decoratorNames = decorators.map((decorator) => decorator.getText(sourceFile));
          const type = node.type?.getText(sourceFile) ?? "";
          const property = `${relativePath}:${node.name.getText(sourceFile)}`;
          const allowsNull = type.includes("| null");
          const isOptional = decoratorNames.some((name) => name.startsWith("@IsOptional()"));
          const isOptionalUndefined = decoratorNames.some((name) => name.startsWith("@IsOptionalUndefined()"));
          if (node.questionToken) {
            expect(isOptional || isOptionalUndefined, `${property} must declare optional semantics`).toBe(true);
            expect(isOptional && isOptionalUndefined, `${property} must have one optional decorator`).toBe(false);
            expect(isOptional, `${property} nullable/decorator mismatch`).toBe(allowsNull);
            expect(isOptionalUndefined, `${property} undefined-only/decorator mismatch`).toBe(!allowsNull);
          }
          if (isOptional) {
            expect(type, `${property} must explicitly declare null`).toContain("| null");
            explicitNullableCount += 1;
          }
          if (isOptionalUndefined) {
            expect(type, `${property} must not accept null`).not.toContain("| null");
            undefinedOnlyCount += 1;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(ACTIVE_DTO_FILES).toHaveLength(18);
    expect(undefinedOnlyCount).toBe(157);
    expect(explicitNullableCount).toBe(37);
  });
});

function matches(source: string, pattern: RegExp) {
  return source.match(pattern)?.length ?? 0;
}
