import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/20260724010000_remove_coupang_manual_purchase_vat/migration.sql"
  ),
  "utf8"
);

describe("Coupang manual-purchase VAT removal migration", () => {
  it("runs atomically while holding an exclusive table lock", () => {
    expect(migrationSql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(migrationSql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(migrationSql).toContain(
      'LOCK TABLE "coupang_manual_purchases" IN ACCESS EXCLUSIVE MODE'
    );
  });

  it("fails closed for an invalid vendor-fee snapshot", () => {
    expect(migrationSql).toContain('"vendor_fee_total_krw" IS NULL');
    expect(migrationSql).toContain('"vendor_fee_total_krw" < 0');
    expect(migrationSql).toContain('ROUND("vendor_fee_total_krw", 2) > 999999999999.99');
    expect(migrationSql).toContain("RAISE EXCEPTION");
  });

  it("corrects total cost to vendor fee and removes the legacy VAT column", () => {
    expect(migrationSql).toContain(
      'SET "total_cost_krw" = ROUND("vendor_fee_total_krw", 2)'
    );
    expect(migrationSql).toContain('DROP COLUMN "vat_krw"');
  });

  it("does not recreate VAT or change the preserved sales snapshots", () => {
    expect(migrationSql).not.toContain("/ 11");
    expect(migrationSql).not.toContain('"sales_amount_krw" =');
    expect(migrationSql).not.toContain('"quantity" =');
    expect(migrationSql).not.toContain('"base_sale_price_krw" =');
    expect(migrationSql).not.toContain('"vendor_fee_total_krw" =');
  });
});
