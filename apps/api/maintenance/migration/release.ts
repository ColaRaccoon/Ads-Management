import { asRecord, assertExactKeys, canonicalSha256, sha256Hex } from "../shared/strict-json";

export interface MigrationSourceFile {
  name: string;
  sql: string | Uint8Array;
}

export interface MigrationReleaseRuntime {
  nodePath: string;
  nodeSha256: string;
  prismaCliPath: string;
  prismaCliSha256: string;
  schemaPath: string;
  schemaSha256: string;
}

export interface MigrationReleaseEntry {
  name: string;
  sqlSha256: string;
  bytes: number;
}

export interface MigrationRelease {
  version: "migration-release/v1";
  releaseId: string;
  releaseGitSha: string;
  runtime: MigrationReleaseRuntime;
  managedRelations: string[];
  migrations: MigrationReleaseEntry[];
  chainSha256: string;
}

export function buildMigrationRelease(input: {
  releaseGitSha: string;
  runtime: MigrationReleaseRuntime;
  managedRelations: string[];
  sources: MigrationSourceFile[];
}): MigrationRelease {
  const releaseGitSha = assertSha(input.releaseGitSha, "MIGRATION_RELEASE_GIT_SHA_INVALID", true);
  const runtime = validateRuntime(input.runtime);
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 10_000) {
    throw new Error("MIGRATION_RELEASE_SOURCES_INVALID");
  }
  const migrations = input.sources.map((source) => {
    const name = assertMigrationName(source.name);
    const bytes = typeof source.sql === "string" ? Buffer.from(source.sql, "utf8") : Buffer.from(source.sql);
    if (bytes.byteLength < 1 || bytes.byteLength > 32 * 1024 * 1024) {
      throw new Error("MIGRATION_RELEASE_SQL_SIZE_INVALID");
    }
    return { name, sqlSha256: sha256Hex(bytes), bytes: bytes.byteLength };
  }).sort((left, right) => left.name.localeCompare(right.name));
  assertUnique(migrations.map((migration) => migration.name), "MIGRATION_RELEASE_NAME_DUPLICATE");
  const managedRelations = normalizeRelations(input.managedRelations);
  const chainSha256 = canonicalSha256(migrations);
  const body = {
    version: "migration-release/v1",
    releaseGitSha,
    runtime,
    managedRelations,
    migrations,
    chainSha256
  } as const;
  return { ...body, releaseId: canonicalSha256(body) };
}

export function validateMigrationRelease(input: MigrationRelease): MigrationRelease {
  const releaseRecord = asRecord(input, "MIGRATION_RELEASE_OBJECT_REQUIRED");
  assertExactKeys(releaseRecord, [
    "version", "releaseId", "releaseGitSha", "runtime", "managedRelations", "migrations", "chainSha256"
  ], "MIGRATION_RELEASE_KEYS_INVALID");
  if (input.version !== "migration-release/v1") throw new Error("MIGRATION_RELEASE_VERSION_INVALID");
  const rebuiltBody = {
    version: "migration-release/v1" as const,
    releaseGitSha: assertSha(input.releaseGitSha, "MIGRATION_RELEASE_GIT_SHA_INVALID", true),
    runtime: validateRuntime(input.runtime),
    managedRelations: normalizeRelations(input.managedRelations),
    migrations: validateEntries(input.migrations),
    chainSha256: assertSha(input.chainSha256, "MIGRATION_RELEASE_CHAIN_SHA_INVALID")
  };
  if (rebuiltBody.chainSha256 !== canonicalSha256(rebuiltBody.migrations)) {
    throw new Error("MIGRATION_RELEASE_CHAIN_MISMATCH");
  }
  const releaseId = assertSha(input.releaseId, "MIGRATION_RELEASE_ID_INVALID");
  if (releaseId !== canonicalSha256(rebuiltBody)) throw new Error("MIGRATION_RELEASE_ID_MISMATCH");
  return { ...rebuiltBody, releaseId };
}

function validateRuntime(runtime: MigrationReleaseRuntime): MigrationReleaseRuntime {
  const runtimeRecord = asRecord(runtime, "MIGRATION_RELEASE_RUNTIME_INVALID");
  assertExactKeys(runtimeRecord, [
    "nodePath", "nodeSha256", "prismaCliPath", "prismaCliSha256", "schemaPath", "schemaSha256"
  ], "MIGRATION_RELEASE_RUNTIME_KEYS_INVALID");
  return {
    nodePath: assertPinnedPath(runtime.nodePath, "MIGRATION_RELEASE_NODE_PATH_INVALID"),
    nodeSha256: assertSha(runtime.nodeSha256, "MIGRATION_RELEASE_NODE_SHA_INVALID"),
    prismaCliPath: assertPinnedPath(runtime.prismaCliPath, "MIGRATION_RELEASE_PRISMA_PATH_INVALID"),
    prismaCliSha256: assertSha(runtime.prismaCliSha256, "MIGRATION_RELEASE_PRISMA_SHA_INVALID"),
    schemaPath: assertPinnedPath(runtime.schemaPath, "MIGRATION_RELEASE_SCHEMA_PATH_INVALID"),
    schemaSha256: assertSha(runtime.schemaSha256, "MIGRATION_RELEASE_SCHEMA_SHA_INVALID")
  };
}

function validateEntries(entries: MigrationReleaseEntry[]): MigrationReleaseEntry[] {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 10_000) {
    throw new Error("MIGRATION_RELEASE_ENTRIES_INVALID");
  }
  const normalized = entries.map((entry) => {
    const entryRecord = asRecord(entry, "MIGRATION_RELEASE_ENTRY_INVALID");
    assertExactKeys(entryRecord, ["name", "sqlSha256", "bytes"], "MIGRATION_RELEASE_ENTRY_KEYS_INVALID");
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 32 * 1024 * 1024) {
      throw new Error("MIGRATION_RELEASE_SQL_SIZE_INVALID");
    }
    return {
      name: assertMigrationName(entry.name),
      sqlSha256: assertSha(entry.sqlSha256, "MIGRATION_RELEASE_SQL_SHA_INVALID"),
      bytes: entry.bytes
    };
  });
  if (normalized.some((entry, index) => index > 0 && normalized[index - 1].name >= entry.name)) {
    throw new Error("MIGRATION_RELEASE_ORDER_INVALID");
  }
  assertUnique(normalized.map((entry) => entry.name), "MIGRATION_RELEASE_NAME_DUPLICATE");
  return normalized;
}

function normalizeRelations(relations: string[]): string[] {
  if (!Array.isArray(relations) || relations.length < 1 || relations.length > 10_000) {
    throw new Error("MIGRATION_RELEASE_RELATIONS_INVALID");
  }
  const normalized = relations.map((relation) => {
    if (typeof relation !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(relation)) {
      throw new Error("MIGRATION_RELEASE_RELATION_INVALID");
    }
    return relation;
  }).sort((left, right) => left.localeCompare(right));
  assertUnique(normalized, "MIGRATION_RELEASE_RELATION_DUPLICATE");
  return normalized;
}

function assertMigrationName(value: string): string {
  if (typeof value !== "string" || !/^\d{14}_[a-z0-9][a-z0-9_]{0,100}$/u.test(value)) {
    throw new Error("MIGRATION_RELEASE_NAME_INVALID");
  }
  return value;
}

function assertPinnedPath(value: string, code: string): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 1024 || value.includes("\0") ||
    value.includes("\n") || value.includes("\r") || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)) {
    throw new Error(code);
  }
  if (!(value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value))) throw new Error(code);
  return value;
}

function assertSha(value: string, code: string, allowGitSha = false): string {
  const pattern = allowGitSha ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u : /^[a-f0-9]{64}$/u;
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(code);
  return value;
}

function assertUnique(values: string[], code: string): void {
  if (new Set(values).size !== values.length) throw new Error(code);
}
