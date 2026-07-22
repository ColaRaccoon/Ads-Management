import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(__dirname, "../../prisma/migrations/20260722000000_backfill_coupang_manual_purchase_sales_amount/migration.sql"),
  "utf8"
);

describe("Coupang manual-purchase sales snapshot migration", () => {
  it("backfills only null snapshots from stored historical prices", () => {
    expect(migrationSql).toContain('WHERE "sales_amount_krw" IS NULL');
    expect(migrationSql).toContain('"sale_price_krw"');
    expect(migrationSql).toContain('"promotion_price_krw"');
    expect(migrationSql).toContain('"base_sale_price_krw"');
    expect(migrationSql).not.toContain("coupang_cost_rules");
    expect(migrationSql).not.toContain("coupang_promotion_prices");
  });

  it("does not replace rows with no historical price snapshot with zero", () => {
    expect(migrationSql).toContain(
      'COALESCE("sale_price_krw", "promotion_price_krw", "base_sale_price_krw") IS NOT NULL'
    );
    expect(migrationSql).not.toMatch(/COALESCE\([^)]*,\s*0\)/);
  });
});
