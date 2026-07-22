import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(process.cwd(), "prisma/migrations/20260722150000_split_coupang_shipping_fees/migration.sql"),
  "utf8"
);

describe("Coupang shipping-fee split migration", () => {
  it("preserves legacy values by renaming them to Hanaro shipping before adding seller shipping", () => {
    const renameIndex = migrationSql.indexOf(
      'RENAME COLUMN "seller_shipping_fee_krw" TO "hanaro_shipping_fee_krw"'
    );
    const addIndex = migrationSql.indexOf('ADD COLUMN "seller_shipping_fee_krw" DECIMAL(14,2)');

    expect(renameIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(renameIndex);
    expect(migrationSql).not.toContain("UPDATE \"coupang_cost_rules\"");
  });

  it("keeps the new seller shipping field nullable so unset and explicit zero remain distinct", () => {
    expect(migrationSql).toContain('ALTER COLUMN "hanaro_shipping_fee_krw" DROP DEFAULT');
    expect(migrationSql).toContain('ALTER COLUMN "hanaro_shipping_fee_krw" DROP NOT NULL');
    expect(migrationSql).not.toMatch(/ADD COLUMN "seller_shipping_fee_krw"[^;]*NOT NULL/);
    expect(migrationSql).not.toMatch(/ADD COLUMN "seller_shipping_fee_krw"[^;]*DEFAULT/);
  });
});
