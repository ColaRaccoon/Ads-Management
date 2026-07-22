import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(process.cwd(), "prisma/migrations/20260721173000_add_coupang_manual_purchase_product_cost/migration.sql"),
  "utf8"
);

describe("Coupang manual-purchase product-cost migration", () => {
  it("is replay-safe and blocks only unbackfilled rows without a dated cost rule", () => {
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "product_cost_krw"');
    expect(migrationSql).toContain(
      'WHERE manual_purchase."product_cost_krw" IS NULL\n      AND NOT EXISTS ('
    );
    expect(migrationSql).toContain('AND manual_purchase."product_cost_krw" IS NULL;');
    expect(migrationSql).toContain('ALTER COLUMN "product_cost_krw" DROP DEFAULT');
  });

  it("uses the same stable rule-id tie-breaker as runtime selection", () => {
    expect(migrationSql).toContain('rule."id" DESC');
  });

  it("locks cost rules before manual purchases to match existing writer lock order", () => {
    const costRuleLock = migrationSql.indexOf('LOCK TABLE "coupang_cost_rules" IN SHARE MODE');
    const manualPurchaseLock = migrationSql.indexOf(
      'LOCK TABLE "coupang_manual_purchases" IN ACCESS EXCLUSIVE MODE'
    );
    expect(costRuleLock).toBeGreaterThan(-1);
    expect(manualPurchaseLock).toBeGreaterThan(costRuleLock);
  });
});
