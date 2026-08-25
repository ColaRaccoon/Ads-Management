import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "prisma/migrations/20260825170000_minimize_cafe24_coupang_raw_rows/migration.sql"
), "utf8");

describe("STEP7-EVAL-012 Cafe24/Coupang raw-row minimization migration", () => {
  it("scrubs exactly the four normalized business tables with SQL NULL", () => {
    const expectedTables = [
      "cafe24_order_lines",
      "coupang_sale_lines",
      "coupang_ad_metrics",
      "coupang_promotion_prices"
    ];
    for (const table of expectedTables) {
      expect(migration).toContain(`UPDATE "${table}"`);
      expect(migration).toMatch(new RegExp(
        `UPDATE "${table}"\\s+SET "raw_row" = NULL\\s+WHERE "raw_row" IS NOT NULL;`
      ));
    }
    expect(migration.match(/UPDATE\s+"[^"]+"/g)).toHaveLength(expectedTables.length);
  });

  it("does not scrub Meta or generic UploadRow provenance tables", () => {
    expect(migration).not.toMatch(/UPDATE\s+"upload_rows"/);
    expect(migration).not.toMatch(/UPDATE\s+"meta_ad_daily_metrics"/);
    expect(migration).not.toMatch(/UPDATE\s+"meta_adset_daily_metrics"/);
  });
});
