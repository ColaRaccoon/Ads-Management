import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(
  process.cwd(),
  "prisma/migrations/20260825110000_protect_security_audit_truncate/migration.sql"
), "utf8");

describe("security audit truncate protection migration", () => {
  it("adds a statement-level BEFORE TRUNCATE guard using the existing rejector", () => {
    expect(sql).toContain('BEFORE TRUNCATE ON "security_audit_events"');
    expect(sql).toContain("FOR EACH STATEMENT");
    expect(sql).toContain('EXECUTE FUNCTION "security_audit_events_append_only"()');
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE)/i);
  });
});
