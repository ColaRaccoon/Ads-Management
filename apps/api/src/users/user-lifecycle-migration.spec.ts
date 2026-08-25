import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(
  process.cwd(),
  "prisma/migrations/20260825090000_add_user_lifecycle_audit/migration.sql"
), "utf8");

describe("user lifecycle audit migration", () => {
  it("is additive and adds only invitation metadata plus audit storage", () => {
    expect(sql).toContain('ADD COLUMN "invited_at"');
    expect(sql).toContain('CREATE TABLE "security_audit_events"');
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE)/i);
    expect(sql).not.toMatch(/otp|mfa|two.factor|password_hash/i);
  });

  it("enforces append-only rows in the database", () => {
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON \"security_audit_events\"");
    expect(sql).toContain("security_audit_events is append-only");
  });

  it("imports the bootstrap marker without credentials", () => {
    expect(sql).toContain("BOOTSTRAP_SUPER_ADMIN_IMPORTED");
    expect(sql).not.toMatch(/access.token|refresh.token|cookie|secret/i);
  });
});
