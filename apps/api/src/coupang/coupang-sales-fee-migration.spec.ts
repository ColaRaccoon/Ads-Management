import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const apiRoot = existsSync(resolve(process.cwd(), "prisma"))
  ? process.cwd()
  : resolve(process.cwd(), "apps/api");
const migrationSql = readFileSync(
  resolve(apiRoot, "prisma/migrations/20260722200000_add_global_coupang_sales_fee_rules/migration.sql"),
  "utf8"
);

describe("Coupang global sales-fee migration", () => {
  it("holds the manual-purchase table lock for the complete atomic migration", () => {
    const beginIndex = migrationSql.indexOf("BEGIN;");
    const lockIndex = migrationSql.indexOf('LOCK TABLE "coupang_manual_purchases" IN ACCESS EXCLUSIVE MODE;');
    const backfillGuardIndex = migrationSql.indexOf("DO $$");
    const updateIndex = migrationSql.indexOf('UPDATE "coupang_manual_purchases" AS purchase');
    const commitIndex = migrationSql.lastIndexOf("COMMIT;");

    expect(beginIndex).toBe(0);
    expect(lockIndex).toBeGreaterThan(beginIndex);
    expect(backfillGuardIndex).toBeGreaterThan(lockIndex);
    expect(updateIndex).toBeGreaterThan(backfillGuardIndex);
    expect(commitIndex).toBeGreaterThan(updateIndex);
    expect(migrationSql.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("fails closed before recalculation when a legacy manual purchase has no sales snapshot", () => {
    expect(migrationSql).toContain(
      'WHERE COALESCE("sales_amount_krw", "sale_price_krw" * "quantity") IS NULL'
    );
    expect(migrationSql).toContain("RAISE EXCEPTION 'Cannot backfill Coupang sales fees:");
    expect(migrationSql).not.toContain(
      'COALESCE(purchase."sales_amount_krw", purchase."sale_price_krw" * purchase."quantity", 0)'
    );
  });

  it("drops the temporary backfill default so every future writer must supply the applied rate", () => {
    expect(migrationSql).toContain('ADD COLUMN "sales_fee_rate_applied" DECIMAL(8,6) NOT NULL DEFAULT 0.1188;');
    expect(migrationSql).toContain('ALTER COLUMN "sales_fee_rate_applied" DROP DEFAULT;');
  });

  it("enforces one global rule per effective start date", () => {
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "coupang_sales_fee_rules_effective_from_key"');
  });

  it("rebuilds a resolvable total from the stored component sum", () => {
    expect(migrationSql).toContain('resolved."resolved_sales_amount_krw" * resolved."sales_fee_rate"');
    for (const column of [
      "product_cost_krw",
      "vendor_fee_total_krw",
      "shipping_cost_krw",
      "vat_krw",
      "other_cost_krw"
    ]) {
      expect(migrationSql).toContain(`purchase."${column}"`);
    }
  });
});
