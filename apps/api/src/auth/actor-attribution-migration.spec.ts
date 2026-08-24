import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(__dirname, "../../prisma/migrations/20260824140000_add_actor_attribution/migration.sql"),
  "utf8"
);
const schema = readFileSync(resolve(__dirname, "../../prisma/schema.prisma"), "utf8");

describe("actor attribution migration", () => {
  it("adds nullable indexed Cafe24 and Coupang uploader columns without a false legacy backfill", () => {
    expect(migrationSql).toContain('ALTER TABLE "cafe24_upload_batches"');
    expect(migrationSql).toContain('ALTER TABLE "coupang_upload_batches"');
    expect(migrationSql.match(/ADD COLUMN "uploaded_by" UUID;/g)).toHaveLength(2);
    expect(migrationSql).toContain('CREATE INDEX "cafe24_upload_batches_uploaded_by_idx"');
    expect(migrationSql).toContain('CREATE INDEX "coupang_upload_batches_uploaded_by_idx"');
    expect(migrationSql).not.toMatch(/UPDATE\s+"(?:cafe24|coupang)_upload_batches"[\s\S]*?"uploaded_by"/i);
    expect(schema).toMatch(/model Cafe24UploadBatch[\s\S]*?uploadedBy\s+String\?/);
    expect(schema).toMatch(/model CoupangUploadBatch[\s\S]*?uploadedBy\s+String\?/);
  });

  it("fails closed on any legacy orphan before installing restrictive actor foreign keys", () => {
    expect(migrationSql).toContain("SECURITY_ACTOR_ATTRIBUTION_ORPHAN");
    expect(migrationSql).toContain('LEFT JOIN "app_users"');
    expect(migrationSql).toContain('WHERE "app_users"."id" IS NULL');
    expect(migrationSql).toContain('ADD CONSTRAINT "decision_logs_created_by_fkey"');
    expect(migrationSql).toContain('ADD CONSTRAINT "cafe24_upload_batches_uploaded_by_fkey"');
    expect(migrationSql).toContain('ADD CONSTRAINT "coupang_upload_batches_uploaded_by_fkey"');
    expect(migrationSql.match(/ON DELETE RESTRICT ON UPDATE CASCADE/g)).toHaveLength(13);
    expect(migrationSql.indexOf("SECURITY_ACTOR_ATTRIBUTION_ORPHAN")).toBeLessThan(
      migrationSql.indexOf('ADD CONSTRAINT "creative_change_logs_created_by_fkey"')
    );
  });
});
