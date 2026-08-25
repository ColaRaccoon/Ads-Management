import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "prisma/migrations/20260825210000_add_storage_tombstones/migration.sql"
), "utf8");

describe("storage tombstone migration", () => {
  it("stores only server keys, integrity metadata, retention state, and actor attribution", () => {
    expect(migration).toContain("CREATE TABLE \"storage_tombstones\"");
    expect(migration).toContain("\"storage_tombstone_state\"");
    expect(migration).toContain("\"hash_sha256\" CHAR(64) NOT NULL");
    expect(migration).toContain("\"byte_size\" BIGINT NOT NULL");
    expect(migration).toContain("\"purge_after\" TIMESTAMPTZ(3) NOT NULL");
    expect(migration).toContain("REFERENCES \"app_users\"(\"id\")");
    expect(migration).toContain("CHECK (\"hash_sha256\" ~ '^[0-9a-f]{64}$')");
    expect(migration).not.toMatch(/original_filename|file_content|email|password|token/i);
  });

  it("enforces one lifecycle per domain record and a unique provider trash key", () => {
    expect(migration).toContain(
      "ON \"storage_tombstones\"(\"domain\", \"business_record_id\")"
    );
    expect(migration).toContain(
      "ON \"storage_tombstones\"(\"provider\", \"trash_key\")"
    );
    expect(migration.trim().startsWith("BEGIN;")).toBe(true);
    expect(migration.trim().endsWith("COMMIT;")).toBe(true);
  });
});
