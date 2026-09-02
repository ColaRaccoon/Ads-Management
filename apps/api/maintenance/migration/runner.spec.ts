import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { targetBindingSha256, type CloudTargetBinding } from "../shared/target-binding";
import { buildMigrationRelease } from "./release";
import { parseMigrationCliArgs, runDirectMigrationCli } from "./migration.cli";
import {
  createPrismaMigrationCatalogInspector,
  createMigrationIntentJournal,
  createPinnedMigrationChildPlan,
  executePinnedMigrationPlan,
  inspectMigrationTarget,
  transitionMigrationJournal,
  type MigrationCatalogSnapshot,
  type MigrationTargetPlan
} from "./runner";

const projectRef = "iygjmosbelbosfxidqxv";
const releaseGitSha = "d0dd9081159a9acad24df458ca14b9f05bdc115a";

describe("migration target inspection", () => {
  it("classifies the 21-relation legacy fixture with only products overlapping as blocked", async () => {
    const snapshot = catalog({
      relationNames: [
        "products", "campaigns", "customers", "orders", "order_items", "payments", "refunds",
        "channels", "creatives", "ad_sets", "audiences", "events", "reports", "imports", "exports",
        "settings", "members", "teams", "notes", "tags", "legacy_jobs"
      ],
      migrationHistoryExists: false,
      history: []
    });
    const inspector = { inspect: vi.fn().mockResolvedValue(snapshot) };
    const plan = await inspectMigrationTarget(target(), release(), inspector, clock());
    expect(plan.classification).toBe("LEGACY_COLLISION_BLOCKED");
    expect(plan.applyRequired).toBe(false);
    expect(plan.counts).toMatchObject({ relations: 21, legacyOverlap: 1, applied: 0 });
    expect(plan.codes).toEqual(["LEGACY_COLLISION_BLOCKED"]);
    expect(JSON.stringify(plan)).not.toContain("products");
    expect(() => createPinnedMigrationChildPlan({
      target: target(),
      release: release(),
      plan,
      approval: approval(plan),
      now: clock()
    })).toThrow("MIGRATION_APPLY_CLASSIFICATION_BLOCKED");
  });

  it("fails closed when the inspection receipt is bound to another target", async () => {
    const inspector = { inspect: vi.fn().mockResolvedValue(catalog({ targetSha256: "f".repeat(64) })) };
    await expect(inspectMigrationTarget(target(), release(), inspector, clock()))
      .rejects.toThrow("MIGRATION_INSPECT_TARGET_MISMATCH");
  });

  it("classifies an empty schema as ready and creates only a pinned migrate deploy child plan", async () => {
    const inspector = { inspect: vi.fn().mockResolvedValue(catalog()) };
    const migrationRelease = release();
    const plan = await inspectMigrationTarget(target(), migrationRelease, inspector, clock());
    expect(plan.classification).toBe("PRISTINE_EMPTY_SCHEMA_READY");
    const child = createPinnedMigrationChildPlan({
      target: target(),
      release: migrationRelease,
      plan,
      approval: approval(plan),
      now: clock()
    });
    expect(child).toMatchObject({
      executable: "/opt/node/bin/node",
      executableSha256: "a".repeat(64),
      operation: "PRISMA_MIGRATE_DEPLOY",
      shell: false,
      environmentKeys: ["DATABASE_URL"]
    });
    expect(child.arguments).toEqual([
      "/srv/release/node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
      "--schema",
      "/srv/release/apps/api/prisma/schema.prisma"
    ]);
    expect(child.arguments.join(" ")).not.toContain("resolve");
    expect(JSON.stringify(child)).not.toMatch(/postgres(?:ql)?:\/\//i);
  });

  it("treats an exactly applied chain as idempotently unchanged", async () => {
    const migrationRelease = release();
    const history = migrationRelease.migrations.map((migration) => ({
      name: migration.name,
      checksum: migration.sqlSha256,
      state: "APPLIED" as const
    }));
    const inspector = {
      inspect: vi.fn().mockResolvedValue(catalog({
        relationNames: ["products"],
        migrationHistoryExists: true,
        history
      }))
    };
    const plan = await inspectMigrationTarget(target(), migrationRelease, inspector, clock());
    expect(plan).toMatchObject({
      classification: "MANAGED_EXACT_CHAIN_READY",
      applyRequired: false,
      counts: { pending: 0 }
    });
    expect(() => createPinnedMigrationChildPlan({
      target: target(),
      release: migrationRelease,
      plan,
      approval: approval(plan),
      now: clock()
    })).toThrow("MIGRATION_APPLY_NOT_REQUIRED");
  });

  it("blocks a checksum mismatch or failed historical attempt", async () => {
    const migrationRelease = release();
    const first = migrationRelease.migrations[0];
    const inspector = {
      inspect: vi.fn().mockResolvedValue(catalog({
        relationNames: ["products"],
        migrationHistoryExists: true,
        history: [
          { name: first.name, checksum: "f".repeat(64), state: "APPLIED" },
          { name: migrationRelease.migrations[1].name, checksum: migrationRelease.migrations[1].sqlSha256, state: "FAILED" }
        ]
      }))
    };
    const plan = await inspectMigrationTarget(target(), migrationRelease, inspector, clock());
    expect(plan.classification).toBe("PARTIAL_OR_DRIFT_BLOCKED");
    expect(plan.counts.failedOrRolledBack).toBe(1);
  });

  it("rejects a post-inspection classification tamper even with matching confirmation fields", async () => {
    const migrationRelease = release();
    const inspector = { inspect: vi.fn().mockResolvedValue(catalog()) };
    const plan = await inspectMigrationTarget(target(), migrationRelease, inspector, clock());
    const tampered = { ...plan, classification: "MANAGED_EXACT_CHAIN_READY" as const };
    expect(() => createPinnedMigrationChildPlan({
      target: target(),
      release: migrationRelease,
      plan: tampered,
      approval: approval(tampered),
      now: clock()
    })).toThrow("MIGRATION_APPLY_PLAN_INTEGRITY_INVALID");
  });
});

describe("migration CLI contract", () => {
  it("is inspect-only by default and exposes only the pinned execute mode", () => {
    expect(parseMigrationCliArgs(["--target", "target.json", "--release", "release.json"]))
      .toMatchObject({ mode: "INSPECT" });
    expect(parseMigrationCliArgs(["--execute", "--target", "target.json", "--release", "release.json"]))
      .toMatchObject({ mode: "EXECUTE" });
    expect(() => parseMigrationCliArgs(["--migrate-resolve", "yes", "--target", "target.json", "--release", "release.json"]))
      .toThrow("MIGRATION_CLI_ARGUMENT_UNKNOWN");
  });

  it("directly composes protected inputs and spawns zero children for the legacy target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "migration-direct-cli-"));
    try {
      const targetPath = join(directory, "target.json");
      const releasePath = join(directory, "release.json");
      const journalPath = join(directory, "journal.jsonl");
      const migrationTarget = target();
      const migrationRelease = release();
      const legacyRelations = [
        "products", "campaigns", "customers", "orders", "order_items", "payments", "refunds",
        "channels", "creatives", "ad_sets", "audiences", "events", "reports", "imports", "exports",
        "settings", "members", "teams", "notes", "tags", "legacy_jobs"
      ];
      const legacyInspector = {
        inspect: vi.fn().mockResolvedValue(catalog({ relationNames: legacyRelations }))
      };
      const plan = await inspectMigrationTarget(migrationTarget, migrationRelease, legacyInspector, clock());
      await Promise.all([
        writeFile(targetPath, JSON.stringify(migrationTarget), { mode: 0o600 }),
        writeFile(releasePath, JSON.stringify(migrationRelease), { mode: 0o600 })
      ]);
      const prisma = {
        $queryRaw: vi.fn()
          .mockResolvedValueOnce([{
            current_user: "migration_owner",
            current_database: "postgres",
            current_schema: "public",
            has_required_role: true
          }])
          .mockResolvedValueOnce(legacyRelations.map((name) => ({ name })))
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ present: false }]),
        $disconnect: vi.fn().mockResolvedValue(undefined)
      };
      const artifactReader = { sha256: vi.fn() };
      const child = { run: vi.fn() };
      const journal = {
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      };
      await expect(runDirectMigrationCli([
        "--execute",
        "--target", targetPath,
        "--release", releasePath,
        "--confirm-plan", plan.planId,
        "--confirm-release-id", migrationRelease.releaseId,
        "--confirm-project-ref", projectRef,
        "--confirm-release-sha", releaseGitSha,
        "--confirm-target", targetBindingSha256(migrationTarget)
      ], {
        createPrismaClient: vi.fn().mockReturnValue(prisma),
        createArtifactReader: vi.fn().mockReturnValue(artifactReader),
        createChild: vi.fn().mockReturnValue(child),
        createJournal: vi.fn().mockReturnValue(journal)
      }, undefined, clock(), {
        DATABASE_URL: databaseUrl(),
        MIGRATION_JOURNAL_FILE: journalPath
      })).rejects.toThrow("MIGRATION_APPLY_CLASSIFICATION_BLOCKED");
      expect(artifactReader.sha256).not.toHaveBeenCalled();
      expect(child.run).not.toHaveBeenCalled();
      expect(journal.write).not.toHaveBeenCalled();
      expect(journal.close).toHaveBeenCalledOnce();
      expect(prisma.$disconnect).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("direct INSPECT composes the entrypoint DATABASE_URL without an adapter-required fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "migration-direct-inspect-"));
    try {
      const targetPath = join(directory, "target.json");
      const releasePath = join(directory, "release.json");
      await Promise.all([
        writeFile(targetPath, JSON.stringify(target()), { mode: 0o600 }),
        writeFile(releasePath, JSON.stringify(release()), { mode: 0o600 })
      ]);
      const prisma = {
        $queryRaw: vi.fn()
          .mockResolvedValueOnce([{
            current_user: "migration_owner",
            current_database: "postgres",
            current_schema: "public",
            has_required_role: true
          }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ present: false }]),
        $disconnect: vi.fn().mockResolvedValue(undefined)
      };
      const createArtifactReader = vi.fn();
      const createChild = vi.fn();
      const createJournal = vi.fn();
      const output: string[] = [];
      await expect(runDirectMigrationCli([
        "--target", targetPath,
        "--release", releasePath
      ], {
        createPrismaClient: vi.fn().mockReturnValue(prisma),
        createArtifactReader,
        createChild,
        createJournal
      }, (value) => output.push(value), clock(), {
        DATABASE_URL: databaseUrl()
      })).resolves.toBe(0);
      expect(JSON.parse(output[0])).toMatchObject({
        classification: "PRISTINE_EMPTY_SCHEMA_READY",
        applyRequired: true
      });
      expect(createArtifactReader).not.toHaveBeenCalled();
      expect(createChild).not.toHaveBeenCalled();
      expect(createJournal).not.toHaveBeenCalled();
      expect(prisma.$disconnect).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("concrete migration catalog and executor", () => {
  it("performs zero catalog I/O before exact target confirmation", () => {
    const client = { $queryRaw: vi.fn() };
    expect(() => createPrismaMigrationCatalogInspector({
      client: client as never,
      target: target(),
      confirmation: { projectRef, releaseGitSha, targetSha256: "f".repeat(64) },
      credentialPurpose: "MIGRATION_INSPECT_DB",
      tls: { authorized: true, mode: "verify-full", serverName: `db.${projectRef}.supabase.co` },
      now: clock()
    })).toThrow("CONFIRM_TARGET_SHA_MISMATCH");
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });

  it("uses fixed read-only catalog queries and verifies actual principal/role/TLS", async () => {
    const client = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{
          current_user: "migration_owner",
          current_database: "postgres",
          current_schema: "public",
          has_required_role: true
        }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ present: false }])
    };
    const inspector = createPrismaMigrationCatalogInspector({
      client: client as never,
      target: target(),
      confirmation: approvalTarget(),
      credentialPurpose: "MIGRATION_INSPECT_DB",
      tls: { authorized: true, mode: "verify-full", serverName: `db.${projectRef}.supabase.co` },
      now: clock()
    });
    await expect(inspector.inspect(target())).resolves.toMatchObject({
      relationNames: [],
      history: [],
      connection: { currentUser: "migration_owner", hasRequiredRole: true }
    });
    expect(client.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it("spawns zero children for the current legacy collision fixture", async () => {
    const migrationRelease = release();
    const legacyInspector = { inspect: vi.fn().mockResolvedValue(catalog({
      relationNames: [
        "products", "campaigns", "customers", "orders", "order_items", "payments", "refunds",
        "channels", "creatives", "ad_sets", "audiences", "events", "reports", "imports", "exports",
        "settings", "members", "teams", "notes", "tags", "legacy_jobs"
      ]
    })) };
    const plan = await inspectMigrationTarget(target(), migrationRelease, legacyInspector, clock());
    const artifactReader = { sha256: vi.fn() };
    const child = { run: vi.fn() };
    const journal = { write: vi.fn() };
    await expect(executePinnedMigrationPlan({
      target: target(),
      release: migrationRelease,
      plan,
      approval: approval(plan),
      databaseUrl: databaseUrl(),
      artifactReader,
      child,
      journal,
      postVerifyInspector: legacyInspector,
      now: clock()
    })).rejects.toThrow("MIGRATION_APPLY_CLASSIFICATION_BLOCKED");
    expect(artifactReader.sha256).not.toHaveBeenCalled();
    expect(child.run).not.toHaveBeenCalled();
    expect(journal.write).not.toHaveBeenCalled();
  });

  it("verifies pinned hashes, journals transitions, runs deploy only, and post-verifies", async () => {
    const migrationRelease = release();
    const initialInspector = { inspect: vi.fn().mockResolvedValue(catalog()) };
    const plan = await inspectMigrationTarget(target(), migrationRelease, initialInspector, clock());
    const artifactReader = {
      sha256: vi.fn(async (path: string) => {
        if (path === migrationRelease.runtime.nodePath) return migrationRelease.runtime.nodeSha256;
        if (path === migrationRelease.runtime.prismaCliPath) return migrationRelease.runtime.prismaCliSha256;
        if (path === migrationRelease.runtime.schemaPath) return migrationRelease.runtime.schemaSha256;
        throw new Error("unexpected path");
      })
    };
    const child = { run: vi.fn().mockResolvedValue({ exitCode: 0, signal: null, timedOut: false }) };
    const journal = { write: vi.fn().mockResolvedValue(undefined) };
    const postVerifyInspector = {
      inspect: vi.fn().mockResolvedValue(catalog({
        relationNames: ["products"],
        migrationHistoryExists: true,
        history: migrationRelease.migrations.map((migration) => ({
          name: migration.name,
          checksum: migration.sqlSha256,
          state: "APPLIED" as const
        }))
      }))
    };
    await expect(executePinnedMigrationPlan({
      target: target(),
      release: migrationRelease,
      plan,
      approval: approval(plan),
      databaseUrl: databaseUrl(),
      artifactReader,
      child,
      journal,
      postVerifyInspector,
      now: clock()
    })).resolves.toMatchObject({ state: "VERIFIED", planId: plan.planId });
    expect(child.run).toHaveBeenCalledWith(expect.objectContaining({
      executable: "/opt/node/bin/node",
      arguments: [
        "/srv/release/node_modules/prisma/build/index.js",
        "migrate",
        "deploy",
        "--schema",
        "/srv/release/apps/api/prisma/schema.prisma"
      ]
    }));
    expect(journal.write.mock.calls.map(([entry]) => entry.state)).toEqual([
      "INTENT_RECORDED", "APPLIED_PENDING_VERIFY", "VERIFIED"
    ]);
  });
});

describe("migration partial journal", () => {
  it("allows intent -> applied pending verify -> verified only", () => {
    const plan = planFixture();
    const intent = createMigrationIntentJournal(plan);
    const pending = transitionMigrationJournal(intent, "APPLIED_PENDING_VERIFY");
    const verified = transitionMigrationJournal(pending, "VERIFIED");
    expect(verified).toMatchObject({ state: "VERIFIED", code: "MIGRATION_APPLY_VERIFIED" });
    expect(() => transitionMigrationJournal(verified, "CHILD_FAILED")).toThrow(
      "MIGRATION_JOURNAL_TRANSITION_INVALID"
    );
  });
});

function target(): CloudTargetBinding {
  return {
    version: "cloud-target-binding/v1",
    environmentId: "production-seoul",
    environmentClass: "production",
    projectRef,
    supabaseOrigin: `https://${projectRef}.supabase.co`,
    database: {
      connectionMode: "direct",
      host: `db.${projectRef}.supabase.co`,
      port: 5432,
      name: "postgres",
      schema: "public",
      loginUser: "migration_owner",
      expectedCurrentUser: "migration_owner",
      requiredRole: "migration_role",
      sslMode: "verify-full",
      tlsServerName: `db.${projectRef}.supabase.co`
    },
    releaseGitSha,
    issuedAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-09-02T12:00:00.000Z"
  };
}

function release() {
  return buildMigrationRelease({
    releaseGitSha,
    runtime: {
      nodePath: "/opt/node/bin/node",
      nodeSha256: "a".repeat(64),
      prismaCliPath: "/srv/release/node_modules/prisma/build/index.js",
      prismaCliSha256: "b".repeat(64),
      schemaPath: "/srv/release/apps/api/prisma/schema.prisma",
      schemaSha256: "c".repeat(64)
    },
    managedRelations: ["products", ...Array.from({ length: 51 }, (_, index) => `repo_table_${index + 1}`)],
    sources: [
      { name: "20250101000000_init", sql: "CREATE TABLE products(id text);" },
      { name: "20260826020000_add_nonce", sql: "ALTER TABLE products ADD COLUMN nonce text;" }
    ]
  });
}

function catalog(overrides: Partial<MigrationCatalogSnapshot> = {}): MigrationCatalogSnapshot {
  return {
    targetSha256: targetBindingSha256(target()),
    schema: "public",
    relationNames: [],
    typeNames: [],
    migrationHistoryExists: false,
    history: [],
    connection: {
      currentUser: "migration_owner",
      database: "postgres",
      schema: "public",
      hasRequiredRole: true,
      tlsAuthorized: true,
      tlsMode: "verify-full",
      serverName: `db.${projectRef}.supabase.co`
    },
    ...overrides
  };
}

function approval(plan: MigrationTargetPlan) {
  return {
    approved: true as const,
    planId: plan.planId,
    releaseId: plan.releaseId,
    projectRef,
    releaseGitSha,
    targetSha256: targetBindingSha256(target())
  };
}

function approvalTarget() {
  return {
    projectRef,
    releaseGitSha,
    targetSha256: targetBindingSha256(target())
  };
}

function databaseUrl() {
  const value = new URL(`postgresql://db.${projectRef}.supabase.co:5432/postgres`);
  value.username = "migration_owner";
  value.password = ["test", "password"].join("-");
  value.searchParams.set("schema", "public");
  value.searchParams.set("sslmode", "verify-full");
  return value.toString();
}

function planFixture(): MigrationTargetPlan {
  return {
    version: "migration-target-plan/v1",
    planId: "d".repeat(64),
    releaseId: "e".repeat(64),
    targetSha256: targetBindingSha256(target()),
    projectRef,
    releaseGitSha,
    mode: "INSPECT_ONLY",
    classification: "PRISTINE_EMPTY_SCHEMA_READY",
    applyRequired: true,
    counts: {
      relations: 0,
      types: 0,
      legacyOverlap: 0,
      applied: 0,
      pending: 2,
      failedOrRolledBack: 0,
      unknownHistory: 0,
      unexpectedRelations: 0
    },
    digests: {
      catalogSha256: "f".repeat(64),
      legacyOverlapSha256: "0".repeat(64),
      connectionSha256: "1".repeat(64)
    },
    codes: ["MIGRATION_PRISTINE_SCHEMA_READY"]
  };
}

function clock(): Date {
  return new Date("2026-09-02T01:00:00.000Z");
}
