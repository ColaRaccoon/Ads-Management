import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const apiRoot = existsSync(resolve(process.cwd(), "prisma"))
  ? process.cwd()
  : resolve(process.cwd(), "apps/api");
const migrationSql = readFileSync(
  resolve(apiRoot, "prisma/migrations/20260723110000_normalize_coupang_cost_rule_history/migration.sql"),
  "utf8"
);

describe("Coupang cost-rule history migration", () => {
  it("locks and normalizes the complete migration atomically", () => {
    const beginIndex = migrationSql.indexOf("BEGIN;");
    const lockIndex = migrationSql.indexOf("LOCK TABLE coupang_cost_rules IN ACCESS EXCLUSIVE MODE;");
    const backupIndex = migrationSql.indexOf("CREATE TABLE coupang_cost_rules_backup_20260723 AS");
    const deleteIndex = migrationSql.indexOf("DELETE FROM coupang_cost_rules rules");
    const uniqueIndex = migrationSql.indexOf("ADD CONSTRAINT coupang_cost_rules_coupang_product_id_effective_from_key");
    const commitIndex = migrationSql.lastIndexOf("COMMIT;");

    expect(beginIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeGreaterThan(beginIndex);
    expect(backupIndex).toBeGreaterThan(lockIndex);
    expect(deleteIndex).toBeGreaterThan(backupIndex);
    expect(uniqueIndex).toBeGreaterThan(deleteIndex);
    expect(commitIndex).toBeGreaterThan(uniqueIndex);
    expect(migrationSql.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("fails closed unless duplicates exactly match the approved production baseline", () => {
    expect(migrationSql).toContain("unexpected_duplicate_group_count");
    expect(migrationSql).toContain("2ef42677-d4b9-4d11-aae8-9b79c0c952bd");
    expect(migrationSql).toContain("DATE '2026-07-01'");
    expect(migrationSql).toContain("DATE '2026-07-22'");
    expect(migrationSql).toContain("duplicate_group_count <> 2");
    expect(migrationSql).toContain("total_row_count <> 122");
    expect(migrationSql).toContain("july_01_row_count <> 3 OR july_22_row_count <> 2");
    expect(migrationSql).toContain("9b2cb398-f0f9-4e8a-bbb8-85d90a71c659");
    expect(migrationSql).toContain("099139d9-1586-47fa-a7ed-73fe8c354b19");
    expect(migrationSql).toContain("sale_price_krw = 49800");
    expect(migrationSql).toContain("product_cost_krw = 12800");
    expect(migrationSql).toContain("product_cost_krw = 0");
    expect(migrationSql.indexOf("canonical ids differ from the approved baseline"))
      .toBeLessThan(migrationSql.indexOf("CREATE TABLE coupang_cost_rules_backup_20260723 AS"));
  });

  it("requires an explicit approved fingerprint of every value in all five duplicate rows", () => {
    expect(migrationSql).toContain("md5(string_agg(");
    expect(migrationSql).toContain("jsonb_build_array(");
    expect(migrationSql).toContain("note, created_at, updated_at");
    expect(migrationSql).toContain("E'\\n' ORDER BY effective_from, created_at, id");
    expect(migrationSql).toContain(
      "current_setting('meta_ads.approved_coupang_cost_rule_duplicate_fingerprint', true)"
    );
    expect(migrationSql).toContain("approved duplicate fingerprint is missing");
    expect(migrationSql).toContain("approved duplicate fingerprint mismatch");
    expect(migrationSql.indexOf("approved duplicate fingerprint mismatch"))
      .toBeLessThan(migrationSql.indexOf("DELETE FROM coupang_cost_rules rules"));
  });

  it("keeps the in-database full backup and external pg_dump prerequisite", () => {
    expect(migrationSql).toContain("take an external pg_dump");
    expect(migrationSql).toContain("SELECT rules.*, products.display_name AS product_display_name");
    expect(migrationSql).toContain("source count % differs from backup count %");
    expect(migrationSql).toContain("source fingerprint differs from backup fingerprint");
  });

  it("enforces unique starts and valid ranges after normalization", () => {
    expect(migrationSql).toContain("UNIQUE (coupang_product_id, effective_from)");
    expect(migrationSql).toContain("CHECK (effective_to IS NULL OR effective_to >= effective_from)");
  });
});
