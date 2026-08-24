import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeEmail } from "./email-normalizer";

const sql = readFileSync(resolve(
  __dirname,
  "../../prisma/migrations/20260824110000_add_security_auth/migration.sql"
), "utf8");

describe("security auth migration", () => {
  it("is atomic and refuses unknown roles without deleting or mass-promoting role data", () => {
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain("SECURITY_AUTH_MIGRATION_UNKNOWN_ROLE");
    expect(sql).toContain("NOT IN ('SUPER_ADMIN', 'ADMIN', 'USER', 'GUEST')");
    expect(sql).toContain('ALTER COLUMN "role" TYPE "app_role"');
    expect(sql).toContain("USING CASE");
    expect(sql).toContain("SET DEFAULT 'GUEST'");
    expect(sql).not.toMatch(/DROP\s+COLUMN\s+"?role"?/i);
    expect(sql).not.toMatch(/UPDATE\s+"app_users"\s+SET\s+"role"\s*=\s*'SUPER_ADMIN'/i);
  });

  it("backfills only legacy onboarding status and stores no provider tokens", () => {
    expect(sql).toContain('UPDATE "app_users" SET "invite_status" = \'ACTIVE\'');
    expect(sql).toContain("ALTER COLUMN \"invite_status\" SET DEFAULT 'PENDING_PROVIDER'");
    expect(sql).toContain('"provider_session_id" TEXT NOT NULL');
    expect(sql).not.toMatch(/access_token|refresh_token/i);
  });

  it("fails closed on invalid, non-ASCII, oversized, or colliding normalized emails", () => {
    expect(sql).toContain("SECURITY_AUTH_MIGRATION_INVALID_EMAIL");
    expect(sql).toContain("SECURITY_AUTH_MIGRATION_NORMALIZED_EMAIL_COLLISION");
    expect(sql).toContain("char_length(btrim(\"email\")) > 320");
    expect(sql).toContain("octet_length(btrim(\"email\")) <> char_length(btrim(\"email\"))");
    expect(sql).toContain("btrim(\"email\") !~ '^[!-~]+$'");
    expect(sql).toContain('SET "normalized_email" = lower(btrim("email"))');
    expect(sql).toMatch(/WHERE\s+"email" IS NULL\s+OR \(/);
    expect(sql).toMatch(/SELECT 1 FROM "app_users"\s+WHERE "normalized_email" IS NULL/);
    expect(() => normalizeEmail("caf\u00e9@example.com")).toThrow("INVALID_EMAIL");
    expect(() => normalizeEmail("user\u0007@example.com")).toThrow("INVALID_EMAIL");
    expect(normalizeEmail(" User+tag@EXAMPLE.COM ")).toBe("user+tag@example.com");
  });
});
