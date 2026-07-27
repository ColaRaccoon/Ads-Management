import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(
  process.cwd(),
  "prisma/migrations/20260724170000_add_coupang_daily_report_categories/migration.sql"
), "utf8");

describe("Coupang daily report category migration", () => {
  it("adds isolated category tables, constraints, indexes, and cascade relations without backfill", () => {
    expect(sql).toContain('CREATE TABLE "coupang_daily_report_categories"');
    expect(sql).toContain('CREATE TABLE "coupang_daily_report_category_products"');
    expect(sql).toContain('PRIMARY KEY ("category_id","coupang_product_id")');
    expect(sql).toContain("standard_name_key");
    expect(sql).toContain("coupang_product_id_idx");
    expect(sql.match(/ON DELETE CASCADE/g)).toHaveLength(2);
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE)\b/im);
    expect(sql).not.toContain("group_id");
  });
});
