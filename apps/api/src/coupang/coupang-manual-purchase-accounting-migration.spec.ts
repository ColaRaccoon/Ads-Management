import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/20260724000000_normalize_manual_purchase_accounting/migration.sql"
  ),
  "utf8"
);

describe("Coupang manual-purchase accounting normalization migration", () => {
  it("fails closed when a positive base sale price snapshot is missing", () => {
    expect(migrationSql).toContain('"base_sale_price_krw" IS NULL');
    expect(migrationSql).toContain('"base_sale_price_krw" <= 0');
    expect(migrationSql).toContain("RAISE EXCEPTION");
  });

  it("fails closed before normalization when a row has a non-positive quantity", () => {
    expect(migrationSql).toContain('OR "quantity" < 1');
    expect(migrationSql).toContain("positive base sale price snapshot and quantity");
  });

  it("uses only base sale price for the sales and VAT snapshots", () => {
    expect(migrationSql).toContain('"sales_amount_krw" = ROUND("base_sale_price_krw" * "quantity", 2)');
    expect(migrationSql).toContain('"sale_price_krw" = "base_sale_price_krw"');
    expect(migrationSql).toContain('"promotion_price_krw" = NULL');
    expect(migrationSql).toContain('"price_source" = \'BASE\'');
    expect(migrationSql).toContain('"vat_krw" = ROUND("base_sale_price_krw" * "quantity" / 11, 2)');
  });

  it("zeros unrelated costs and totals only vendor fees plus VAT", () => {
    for (const assignment of [
      '"product_cost_krw" = 0',
      '"coupang_sales_fee_krw" = 0',
      '"sales_fee_rate_applied" = 0',
      '"shipping_cost_krw" = 0',
      '"other_cost_krw" = 0'
    ]) {
      expect(migrationSql).toContain(assignment);
    }
    expect(migrationSql).toContain(
      '"vendor_fee_total_krw" + ROUND("base_sale_price_krw" * "quantity" / 11, 2)'
    );
  });

  it("normalizes all rows atomically", () => {
    expect(migrationSql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(migrationSql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(migrationSql).toContain('LOCK TABLE "coupang_manual_purchases" IN ACCESS EXCLUSIVE MODE');
  });
});
