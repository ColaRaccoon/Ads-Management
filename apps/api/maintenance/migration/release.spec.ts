import { describe, expect, it } from "vitest";
import { buildMigrationRelease, validateMigrationRelease, type MigrationReleaseRuntime } from "./release";

const releaseGitSha = "023eed569ca2640a47952c1b23ce74ee09c625d9";

describe("migration release", () => {
  it("builds a deterministic, sorted, content-addressed release", () => {
    const release = buildMigrationRelease({
      releaseGitSha,
      runtime: runtime(),
      managedRelations: ["users", "products"],
      sources: [
        { name: "20260826020000_add_nonce", sql: "ALTER TABLE users ADD COLUMN nonce text;" },
        { name: "20250101000000_init", sql: "CREATE TABLE products(id text);" }
      ]
    });
    expect(release.migrations.map((entry) => entry.name)).toEqual([
      "20250101000000_init",
      "20260826020000_add_nonce"
    ]);
    expect(release.managedRelations).toEqual(["products", "users"]);
    expect(release.releaseId).toMatch(/^[a-f0-9]{64}$/);
    expect(validateMigrationRelease(release)).toEqual(release);
  });

  it("detects a changed SQL checksum or release body", () => {
    const release = releaseFixture();
    const tampered = {
      ...release,
      migrations: [{ ...release.migrations[0], sqlSha256: "f".repeat(64) }]
    };
    expect(() => validateMigrationRelease(tampered)).toThrow("MIGRATION_RELEASE_CHAIN_MISMATCH");
  });

  it("rejects traversal, duplicate migrations, and duplicate managed relations", () => {
    expect(() => buildMigrationRelease({
      releaseGitSha,
      runtime: { ...runtime(), schemaPath: "/srv/release/../schema.prisma" },
      managedRelations: ["products"],
      sources: [{ name: "20250101000000_init", sql: "select 1" }]
    })).toThrow("MIGRATION_RELEASE_SCHEMA_PATH_INVALID");
    expect(() => buildMigrationRelease({
      releaseGitSha,
      runtime: runtime(),
      managedRelations: ["products", "products"],
      sources: [{ name: "20250101000000_init", sql: "select 1" }]
    })).toThrow("MIGRATION_RELEASE_RELATION_DUPLICATE");
  });

  it("does not serialize credentials", () => {
    expect(JSON.stringify(releaseFixture())).not.toMatch(/password|credential|database_url|secret/i);
  });

  it("rejects unrecognized release fields", () => {
    const release = { ...releaseFixture(), extra: "not-allowed" };
    expect(() => validateMigrationRelease(release as never)).toThrow("MIGRATION_RELEASE_KEYS_INVALID");
  });
});

function releaseFixture() {
  return buildMigrationRelease({
    releaseGitSha,
    runtime: runtime(),
    managedRelations: ["products"],
    sources: [{ name: "20250101000000_init", sql: "CREATE TABLE products(id text);" }]
  });
}

function runtime(): MigrationReleaseRuntime {
  return {
    nodePath: "/opt/node/bin/node",
    nodeSha256: "a".repeat(64),
    prismaCliPath: "/srv/release/node_modules/prisma/build/index.js",
    prismaCliSha256: "b".repeat(64),
    schemaPath: "/srv/release/apps/api/prisma/schema.prisma",
    schemaSha256: "c".repeat(64)
  };
}
