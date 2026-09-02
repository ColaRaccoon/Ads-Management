import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalSha256, sha256Hex } from "../shared/strict-json";
import { targetBindingSha256, type CloudTargetBinding } from "../shared/target-binding";
import {
  buildLegacyProviderBinding,
  buildLegacySourceInventoryApproval,
  createDirectLegacyContext,
  createPrismaLegacyReferenceIo,
  createSafeLegacySourceReader,
  type LegacyDirectFactories
} from "./direct-provider";
import { legacyExecutionPlanSha256, runLegacyCli } from "./legacy.cli";
import {
  createLegacyMigrationPlan,
  inventoryStorageReferences,
  MAX_LEGACY_SOURCE_BYTES,
  pairLegacyTombstonePlans,
  rollbackLegacyMigrationReference,
  type LegacyMigrationPlan,
  type ReferenceCandidate
} from "./reference-inventory";

const projectRef = "abcdefghijklmnopqrst";
const releaseGitSha = "b".repeat(40);
const recordId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-02T03:00:00.000Z");
const token = ["test", "scoped", "storage", "token"].join("-");

describe("legacy production direct composition", () => {
  it("blocks current 71-file drift without a new explicit approval before source, Prisma, or fetch", async () => {
    const fixture = await makeFixture();
    try {
      const attempts = [
        {
          ...fixture.sourceApproval,
          driftDisposition: "UNAPPROVED_CURRENT_INVENTORY",
          roots: fixture.sourceApproval.roots.map((root) => ({
            ...root,
            fileCount: 71,
            totalBytes: 1_929_577,
            manifestSha256: "39bbbc78c61de1c8b5e12f14b44ed9ad08064acf891f7621a02a7dfc92e9e11d"
          }))
        },
        {
          ...fixture.sourceApproval,
          version: "legacy-source-inventory-approval/v0",
          roots: fixture.sourceApproval.roots.map((root) => ({
            ...root,
            fileCount: 64,
            totalBytes: 1_633_227
          }))
        }
      ];
      for (const attempt of attempts) {
        await writeFile(fixture.sourceApprovalFile, JSON.stringify(attempt), { mode: 0o600 });
        const lstatSpy = vi.fn();
        const loadPrismaModule = vi.fn();
        const fetchSpy = vi.fn();
        await expect(runLegacyCli({
          argv: fixture.argv,
          env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
          directFactories: {
            loadPrismaModule,
            fetch: fetchSpy as never,
            fs: { lstat: lstatSpy, realpath: vi.fn(), readdir: vi.fn(), open: vi.fn() } as never
          },
          now
        })).rejects.toThrow(/LEGACY_SOURCE_(?:DRIFT_NOT_APPROVED|APPROVAL_VERSION_INVALID)/u);
        expect(lstatSpy).not.toHaveBeenCalled();
        expect(loadPrismaModule).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects inventory substitution under the independent confirmation before composition", async () => {
    const fixture = await makeFixture();
    try {
      const substituted = buildLegacySourceInventoryApproval({
        ...withoutApprovalIdentity(fixture.sourceApproval),
        roots: fixture.sourceApproval.roots.map((root) => ({ ...root, fileCount: 71 }))
      });
      await writeFile(fixture.sourceApprovalFile, JSON.stringify(substituted), { mode: 0o600 });
      const loadPrismaModule = vi.fn();
      const fetchSpy = vi.fn();
      await expect(runLegacyCli({
        argv: fixture.argv,
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
        directFactories: { loadPrismaModule, fetch: fetchSpy as never },
        now
      })).rejects.toThrow("LEGACY_SOURCE_APPROVAL_CONFIRMATION_MISMATCH");
      expect(loadPrismaModule).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects an approved plan over 24MiB before source fs, Prisma, or fetch composition", async () => {
    const fixture = await makeFixture();
    try {
      const manifest = JSON.parse(await readFile(fixture.manifestFile, "utf8"));
      manifest.migrationPlans[0].sourceByteSize = MAX_LEGACY_SOURCE_BYTES + 1;
      await writeFile(fixture.manifestFile, JSON.stringify(manifest), { mode: 0o600 });
      const lstatSpy = vi.fn();
      const loadPrismaModule = vi.fn();
      const fetchSpy = vi.fn();
      await expect(runLegacyCli({
        argv: fixture.argv,
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
        directFactories: {
          loadPrismaModule,
          fetch: fetchSpy as never,
          fs: { lstat: lstatSpy, realpath: vi.fn(), readdir: vi.fn(), open: vi.fn() } as never
        },
        now
      })).rejects.toThrow("LEGACY_MIGRATION_SOURCE_SIZE_INVALID");
      expect(lstatSpy).not.toHaveBeenCalled();
      expect(loadPrismaModule).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects an oversized target response from Content-Length before buffering or DB CAS", async () => {
    const fixture = await makeFixture();
    try {
      const prisma = prismaHarness(fixture.plan);
      const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-length": String(MAX_LEGACY_SOURCE_BYTES + 1) }
      }));
      await expect(runLegacyCli({
        argv: fixture.argv,
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
        directFactories: directFactories(prisma.client, fetchSpy),
        now
      })).rejects.toThrow("LEGACY_STORAGE_BODY_TOO_LARGE");
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(prisma.updateMany).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("bounds a chunked target response without Content-Length and performs zero DB CAS", async () => {
    const fixture = await makeFixture();
    try {
      const prisma = prismaHarness(fixture.plan);
      let chunks = 0;
      const responseBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks > 24) {
            controller.close();
            return;
          }
          chunks += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
        }
      });
      const fetchSpy = vi.fn(async () => new Response(responseBody, { status: 200 }));
      await expect(runLegacyCli({
        argv: fixture.argv,
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
        directFactories: directFactories(prisma.client, fetchSpy),
        now
      })).rejects.toThrow("LEGACY_STORAGE_BODY_TOO_LARGE");
      expect(chunks).toBe(25);
      expect(prisma.updateMany).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("copies with x-upsert false, post-verifies, CAS-updates an allowlisted field, and preserves source", async () => {
    const fixture = await makeFixture();
    try {
      const prisma = prismaHarness(fixture.plan);
      const storage = storageHarness();
      const output = await runLegacyCli({
        argv: fixture.argv,
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
        directFactories: directFactories(prisma.client, storage.fetch),
        now
      });
      expect(JSON.parse(output)).toMatchObject({ result: "PASS", migratedCount: 1, sourcePreserved: true });
      expect(storage.methods).toEqual(["GET", "GET", "POST", "GET", "GET"]);
      expect(storage.upsertHeaders).toEqual(["false"]);
      expect(storage.methods).not.toContain("DELETE");
      expect(prisma.row.storedFilePath).toBe(fixture.plan.targetReference);
      expect(prisma.updateMany).toHaveBeenCalledOnce();
      expect((await readFile(fixture.sourceFile)).equals(fixture.body)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("blocks token and database principal mismatches without storage mutation", async () => {
    const fixture = await makeFixture();
    try {
      const sourceFs = { lstat, realpath, readdir, open };
      const loadPrismaModule = vi.fn();
      const fetchSpy = vi.fn();
      const lstatSpy = vi.fn();
      await expect(createDirectLegacyContext({
        target: fixture.target,
        sourceApproval: fixture.sourceApproval,
        providerBinding: { ...fixture.providerBinding, supabaseOrigin: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" },
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
        factories: {
          loadPrismaModule,
          fetch: fetchSpy as never,
          fs: { lstat: lstatSpy, realpath: vi.fn(), readdir: vi.fn(), open: vi.fn() } as never
        },
        now
      })).rejects.toThrow("LEGACY_PROVIDER_BINDING_MISMATCH");
      expect(lstatSpy).not.toHaveBeenCalled();
      expect(loadPrismaModule).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      await expect(createDirectLegacyContext({
        target: fixture.target,
        sourceApproval: fixture.sourceApproval,
        providerBinding: fixture.providerBinding,
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: "wrong-token" },
        factories: { loadPrismaModule, fetch: fetchSpy as never, fs: sourceFs },
        now
      })).rejects.toThrow("LEGACY_STORAGE_TOKEN_BINDING_MISMATCH");
      expect(loadPrismaModule).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      const prisma = prismaHarness(fixture.plan, { principal: "wrong_principal" });
      await expect(createDirectLegacyContext({
        target: fixture.target,
        sourceApproval: fixture.sourceApproval,
        providerBinding: fixture.providerBinding,
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
        factories: directFactories(prisma.client, fetchSpy as never),
        now
      })).rejects.toThrow("LEGACY_DATABASE_IDENTITY_MISMATCH");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(prisma.disconnect).toHaveBeenCalledOnce();
    } finally {
      await fixture.cleanup();
    }
  });

  it("never overwrites an existing different destination and never touches the DB reference", async () => {
    const fixture = await makeFixture();
    try {
      const prisma = prismaHarness(fixture.plan);
      const storage = storageHarness(Buffer.from("different"));
      await expect(runLegacyCli({
        argv: fixture.argv,
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
        directFactories: directFactories(prisma.client, storage.fetch),
        now
      })).rejects.toThrow("LEGACY_MIGRATION_TARGET_COLLISION");
      expect(storage.methods).toEqual(["GET"]);
      expect(storage.methods).not.toContain("POST");
      expect(storage.methods).not.toContain("DELETE");
      expect(prisma.updateMany).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("leaves a verified copied target resumable on CAS conflict and does not delete source", async () => {
    const fixture = await makeFixture();
    try {
      const prisma = prismaHarness(fixture.plan, { casMiss: true });
      const storage = storageHarness();
      await expect(runLegacyCli({
        argv: fixture.argv,
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
        directFactories: directFactories(prisma.client, storage.fetch),
        now
      })).rejects.toThrow("LEGACY_MIGRATION_CAS_MISS");
      expect(storage.target?.equals(fixture.body)).toBe(true);
      expect(storage.methods).not.toContain("DELETE");
      expect(prisma.row.storedFilePath).toBe(fixture.plan.expectedOldValue);
      expect((await readFile(fixture.sourceFile)).equals(fixture.body)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rollback restores the exact old reference and never calls Storage or deletes source", async () => {
    const fixture = await makeFixture();
    try {
      const prisma = prismaHarness(fixture.plan, { initialValue: fixture.plan.targetReference });
      const fetchSpy = vi.fn();
      const context = await createDirectLegacyContext({
        target: fixture.target,
        sourceApproval: fixture.sourceApproval,
        providerBinding: fixture.providerBinding,
        env: { DATABASE_URL: databaseUrl(), STORAGE_ACCESS_TOKEN: token },
        factories: directFactories(prisma.client, fetchSpy as never),
        now
      });
      try {
        await expect(rollbackLegacyMigrationReference(fixture.plan, context.rollbackAdapter)).resolves.toEqual({
          result: "PASS", sourcePreserved: true, targetDeletionRequired: false
        });
      } finally {
        await context.close();
      }
      expect(prisma.row.storedFilePath).toBe(fixture.plan.expectedOldValue);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await readFile(fixture.sourceFile)).equals(fixture.body)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("legacy safe source reader adversarial paths", () => {
  it("rejects escape and symlink/reparse candidates", async () => {
    const fixture = await makeFixture();
    try {
      const reader = createSafeLegacySourceReader(fixture.sourceApproval, { lstat, realpath, readdir, open });
      await expect(reader.readSourceBody({ ...fixture.plan, sourceKey: "../escape" } as LegacyMigrationPlan))
        .rejects.toThrow("LEGACY_SOURCE_PLAN_SCOPE_INVALID");
      const symlinkFs = {
        lstat: vi.fn(async (candidate: any) => {
          if (String(candidate).endsWith("a.csv")) return fakeStat({ file: true, symlink: true });
          return lstat(candidate);
        }),
        realpath,
        readdir,
        open
      } as never;
      const symlinkReader = createSafeLegacySourceReader(fixture.sourceApproval, symlinkFs);
      await expect(symlinkReader.readSourceBody(fixture.plan)).rejects.toThrow("LEGACY_SOURCE_REPARSE_FORBIDDEN");
    } finally {
      await fixture.cleanup();
    }
  });

  it("detects same-handle stat-read-stat changes", async () => {
    const fixture = await makeFixture();
    try {
      const toctouFs = {
        lstat,
        realpath,
        readdir,
        open: vi.fn(async (candidate: any, flags: any) => {
          const handle = await open(candidate, flags);
          let statCount = 0;
          return {
            stat: async () => {
              const stat = await handle.stat();
              statCount += 1;
              return statCount === 1 ? stat : { ...stat, mtimeMs: stat.mtimeMs + 1 };
            },
            readFile: () => handle.readFile(),
            close: () => handle.close()
          };
        })
      } as never;
      const reader = createSafeLegacySourceReader(fixture.sourceApproval, toctouFs);
      await expect(reader.readSourceBody(fixture.plan)).rejects.toThrow("LEGACY_SOURCE_FILE_CHANGED");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("legacy Prisma allowlist", () => {
  it("rejects arbitrary model/field pairs before a delegate is read or updated", async () => {
    const fixture = await makeFixture();
    try {
      const prisma = prismaHarness(fixture.plan);
      const io = createPrismaLegacyReferenceIo(prisma.client);
      await expect(io.readReference({ ...fixture.plan, field: "filePath" } as LegacyMigrationPlan))
        .rejects.toThrow("LEGACY_REFERENCE_MODEL_FIELD_NOT_ALLOWED");
      await expect(io.compareAndSwapReference({ ...fixture.plan, model: "AppUser" } as never))
        .rejects.toThrow("LEGACY_REFERENCE_MODEL_FIELD_NOT_ALLOWED");
      expect(prisma.client.uploadBatch.findUnique).not.toHaveBeenCalled();
      expect(prisma.updateMany).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("CAS-updates and rolls back both StorageTombstone keys and provider in one exact transaction", async () => {
    const pair = tombstonePairPlans();
    let row = {
      id: pair.original.recordId,
      originalKey: pair.original.expectedOldValue,
      trashKey: pair.trash.expectedOldValue,
      provider: pair.original.expectedOldProvider,
      state: pair.original.expectedOldStatus
    };
    const updateMany = vi.fn(async ({ where, data }: any) => {
      if (where.id !== row.id || where.originalKey !== row.originalKey || where.trashKey !== row.trashKey ||
        where.provider !== row.provider || where.state !== row.state) return { count: 0 };
      row = { ...row, ...data };
      return { count: 1 };
    });
    const empty = { findUnique: vi.fn(), updateMany: vi.fn() };
    const transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(client));
    const client: any = {
      uploadBatch: empty,
      cafe24UploadBatch: empty,
      coupangUploadBatch: empty,
      reportExport: empty,
      storageTombstone: { findUnique: vi.fn(async () => ({ ...row })), updateMany },
      $queryRaw: vi.fn(),
      $transaction: transaction,
      $disconnect: vi.fn()
    };
    const io = createPrismaLegacyReferenceIo(client);
    await expect(io.compareAndSwapReference(pair.original)).rejects.toThrow("LEGACY_TOMBSTONE_PAIR_REQUIRED");
    expect(transaction).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();

    await expect(io.compareAndSwapTombstonePair(pair)).resolves.toBe(true);
    expect(transaction).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        id: pair.original.recordId,
        originalKey: pair.original.expectedOldValue,
        trashKey: pair.trash.expectedOldValue,
        provider: pair.original.expectedOldProvider,
        state: pair.original.expectedOldStatus
      },
      data: {
        originalKey: pair.original.targetReference,
        trashKey: pair.trash.targetReference,
        provider: "supabase",
        state: pair.original.expectedOldStatus
      }
    });
    await expect(io.compareAndSwapTombstonePairBack(pair)).resolves.toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(row).toMatchObject({
      originalKey: pair.original.expectedOldValue,
      trashKey: pair.trash.expectedOldValue,
      provider: pair.original.expectedOldProvider,
      state: pair.original.expectedOldStatus
    });
  });

  it("rolls back the whole manifest when a later CAS fails, then retries/idempotently rolls back in one transaction", async () => {
    const plans = atomicManifestPlans();
    const ordinary = plans[0];
    const pair = pairLegacyTombstonePlans(plans)[0];
    let committed = {
      ordinary: { id: ordinary.recordId, storedFilePath: ordinary.expectedOldValue, status: ordinary.expectedOldStatus },
      tombstone: {
        id: pair.original.recordId,
        originalKey: pair.original.expectedOldValue,
        trashKey: pair.trash.expectedOldValue,
        provider: pair.original.expectedOldProvider,
        state: pair.original.expectedOldStatus
      }
    };
    let failTombstoneCas = true;
    let corruptTombstoneWrite = false;
    let updateAttempts = 0;
    const transaction = vi.fn(async (callback: (tx: any) => unknown) => {
      const draft = structuredClone(committed);
      const empty = { findUnique: vi.fn(), updateMany: vi.fn() };
      const tx: any = {
        uploadBatch: {
          findUnique: vi.fn(async () => ({ ...draft.ordinary })),
          updateMany: vi.fn(async ({ where, data }: any) => {
            updateAttempts += 1;
            if (where.id !== draft.ordinary.id || where.storedFilePath !== draft.ordinary.storedFilePath ||
              where.status !== draft.ordinary.status) return { count: 0 };
            draft.ordinary = { ...draft.ordinary, ...data };
            return { count: 1 };
          })
        },
        cafe24UploadBatch: empty,
        coupangUploadBatch: empty,
        reportExport: empty,
        storageTombstone: {
          findUnique: vi.fn(async () => ({ ...draft.tombstone })),
          updateMany: vi.fn(async ({ where, data }: any) => {
            updateAttempts += 1;
            if (failTombstoneCas || where.id !== draft.tombstone.id ||
              where.originalKey !== draft.tombstone.originalKey || where.trashKey !== draft.tombstone.trashKey ||
              where.provider !== draft.tombstone.provider || where.state !== draft.tombstone.state) return { count: 0 };
            draft.tombstone = corruptTombstoneWrite
              ? { ...draft.tombstone, originalKey: data.originalKey }
              : { ...draft.tombstone, ...data };
            return { count: 1 };
          })
        }
      };
      const result = await callback(tx);
      committed = draft;
      return result;
    });
    const client: any = {
      uploadBatch: {}, cafe24UploadBatch: {}, coupangUploadBatch: {}, reportExport: {}, storageTombstone: {},
      $queryRaw: vi.fn(), $transaction: transaction, $disconnect: vi.fn()
    };
    const io = createPrismaLegacyReferenceIo(client);
    await expect(io.compareAndSwapManifest(plans)).rejects.toThrow("LEGACY_MIGRATION_CAS_MISS");
    expect(committed.ordinary.storedFilePath).toBe(ordinary.expectedOldValue);
    expect(committed.tombstone.originalKey).toBe(pair.original.expectedOldValue);
    expect(committed.tombstone.trashKey).toBe(pair.trash.expectedOldValue);

    failTombstoneCas = false;
    corruptTombstoneWrite = true;
    await expect(io.compareAndSwapManifest(plans)).rejects.toThrow("LEGACY_MANIFEST_DB_VERIFY_FAILED");
    expect(committed.ordinary.storedFilePath).toBe(ordinary.expectedOldValue);
    expect(committed.tombstone.originalKey).toBe(pair.original.expectedOldValue);
    expect(committed.tombstone.trashKey).toBe(pair.trash.expectedOldValue);

    corruptTombstoneWrite = false;
    await expect(io.compareAndSwapManifest(plans)).resolves.toBe("UPDATED");
    expect(committed.ordinary.storedFilePath).toBe(ordinary.targetReference);
    expect(committed.tombstone).toMatchObject({
      originalKey: pair.original.targetReference,
      trashKey: pair.trash.targetReference,
      provider: "supabase"
    });
    const attemptsAfterCommit = updateAttempts;
    await expect(io.compareAndSwapManifest(plans)).resolves.toBe("ALREADY_DESIRED");
    expect(updateAttempts).toBe(attemptsAfterCommit);

    await expect(io.compareAndSwapManifestBack(plans)).resolves.toBe("UPDATED");
    expect(committed.ordinary.storedFilePath).toBe(ordinary.expectedOldValue);
    expect(committed.tombstone).toMatchObject({
      originalKey: pair.original.expectedOldValue,
      trashKey: pair.trash.expectedOldValue,
      provider: pair.original.expectedOldProvider
    });

    committed.ordinary.storedFilePath = ordinary.targetReference;
    const attemptsBeforeMixed = updateAttempts;
    await expect(io.compareAndSwapManifest(plans)).rejects.toThrow("LEGACY_MANIFEST_DB_MIXED_STATE");
    expect(updateAttempts).toBe(attemptsBeforeMixed);
    expect(committed.tombstone.originalKey).toBe(pair.original.expectedOldValue);
  });
});

async function makeFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "legacy-direct-"));
  const root = path.join(directory, "uploads");
  const sourceFile = path.join(root, "legacy", "a.csv");
  await mkdir(path.dirname(sourceFile), { recursive: true });
  const body = Buffer.from("legacy-approved-body");
  await writeFile(sourceFile, body, { mode: 0o600 });
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const target = cloudTarget();
  const record: ReferenceCandidate = {
    model: "UploadBatch",
    recordId,
    field: "storedFilePath",
    value: "local:legacy/a.csv",
    declaredProvider: "local",
    sourceRoot: root,
    status: "IMPORTED",
    expectedHashSha256: bodyHash,
    expectedByteSize: body.length,
    observation: "FOUND"
  };
  const inventory = inventoryStorageReferences([record], [root]);
  const plan = createLegacyMigrationPlan(inventory.entries[0], { hashSha256: bodyHash, byteSize: body.length });
  const planDigest = legacyExecutionPlanSha256({
    target,
    inventoryDigestSha256: inventory.inventoryDigestSha256,
    plans: [plan]
  });
  const sourceApproval = buildLegacySourceInventoryApproval({
    projectRef,
    releaseGitSha,
    targetSha256: targetBindingSha256(target),
    referenceInventoryDigestSha256: inventory.inventoryDigestSha256,
    executionPlanDigestSha256: planDigest,
    issuedAt: "2026-09-02T02:55:00.000Z",
    expiresAt: "2026-09-02T04:00:00.000Z",
    roots: [{
      rootId: "legacy-uploads-root-001",
      rootPath: root,
      fileCount: 1,
      totalBytes: body.length,
      manifestSha256: canonicalSha256([{ relativePath: "legacy/a.csv", byteSize: body.length, hashSha256: bodyHash }])
    }]
  });
  const providerBinding = buildLegacyProviderBinding({
    projectRef,
    releaseGitSha,
    targetSha256: targetBindingSha256(target),
    database: target.database,
    supabaseOrigin: target.supabaseOrigin,
    bucket: "legacy-private",
    bucketVisibility: "private",
    storageTokenScope: "LEGACY_PRIVATE_OBJECT_READ_WRITE_NO_DELETE",
    storageTokenSha256: sha256Hex(token),
    approvedSourceRoots: sourceApproval.roots.map(({ rootId, rootPath }) => ({ rootId, rootPath })),
    sourceInventoryApprovalSha256: sourceApproval.approvalSha256,
    referenceInventoryDigestSha256: inventory.inventoryDigestSha256,
    executionPlanDigestSha256: planDigest,
    issuedAt: "2026-09-02T02:55:00.000Z",
    expiresAt: "2026-09-02T04:00:00.000Z"
  });
  const manifestFile = path.join(directory, "manifest.json");
  const sourceApprovalFile = path.join(directory, "source-approval.json");
  const providerBindingFile = path.join(directory, "provider-binding.json");
  await Promise.all([
    writeFile(manifestFile, JSON.stringify({
      target,
      confirmation: { projectRef, releaseGitSha, targetSha256: targetBindingSha256(target) },
      references: [record],
      approvedLocalRoots: [root],
      migrationPlans: [plan],
      executionApproval: {
        planDigestSha256: planDigest,
        providerBindingSha256: providerBinding.providerBindingSha256,
        sourceInventoryApprovalSha256: sourceApproval.approvalSha256
      }
    }), { mode: 0o600 }),
    writeFile(sourceApprovalFile, JSON.stringify(sourceApproval), { mode: 0o600 }),
    writeFile(providerBindingFile, JSON.stringify(providerBinding), { mode: 0o600 })
  ]);
  return {
    directory,
    root,
    sourceFile,
    body,
    target,
    plan,
    sourceApproval,
    providerBinding,
    manifestFile,
    sourceApprovalFile,
    argv: [
      `--manifest=${manifestFile}`,
      `--source-inventory=${sourceApprovalFile}`,
      `--provider-binding=${providerBindingFile}`,
      "--execute",
      `--confirm-plan-sha256=${planDigest}`,
      `--confirm-provider-binding-sha256=${providerBinding.providerBindingSha256}`,
      `--confirm-source-inventory-sha256=${sourceApproval.approvalSha256}`
    ],
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

function tombstonePairPlans() {
  const root = path.resolve("C:/approved/legacy");
  const records: ReferenceCandidate[] = [
    {
      model: "StorageTombstone",
      recordId,
      field: "originalKey",
      value: "local:objects/original.bin",
      declaredProvider: "local",
      sourceRoot: root,
      status: "RETAINED",
      observation: "FOUND"
    },
    {
      model: "StorageTombstone",
      recordId,
      field: "trashKey",
      value: "local:trash/trashed.bin",
      declaredProvider: "local",
      sourceRoot: root,
      status: "RETAINED",
      observation: "FOUND"
    }
  ];
  return pairLegacyTombstonePlans(inventoryStorageReferences(records, [root]).entries.map((entry, index) =>
    createLegacyMigrationPlan(entry, { hashSha256: String(index + 1).repeat(64), byteSize: index + 1 })
  ))[0];
}

function atomicManifestPlans() {
  const root = path.resolve("C:/approved/legacy");
  const ordinaryRecord: ReferenceCandidate = {
    model: "UploadBatch",
    recordId: "22222222-2222-4222-8222-222222222222",
    field: "storedFilePath",
    value: "local:ordinary/a.csv",
    declaredProvider: "local",
    sourceRoot: root,
    status: "IMPORTED",
    observation: "FOUND"
  };
  const ordinaryEntry = inventoryStorageReferences([ordinaryRecord], [root]).entries[0];
  const ordinary = createLegacyMigrationPlan(ordinaryEntry, { hashSha256: "c".repeat(64), byteSize: 3 });
  const pair = tombstonePairPlans();
  return [ordinary, pair.original, pair.trash];
}

function prismaHarness(plan: LegacyMigrationPlan, options: {
  principal?: string;
  casMiss?: boolean;
  initialValue?: string;
} = {}) {
  const row = { id: plan.recordId, storedFilePath: options.initialValue ?? plan.expectedOldValue, status: plan.expectedOldStatus };
  const updateMany = vi.fn(async ({ where, data }: any) => {
    if (options.casMiss || where.id !== row.id || where.storedFilePath !== row.storedFilePath || where.status !== row.status) {
      return { count: 0 };
    }
    row.storedFilePath = data.storedFilePath;
    return { count: 1 };
  });
  const uploadBatch = { findUnique: vi.fn().mockImplementation(async () => ({ ...row })), updateMany };
  const empty = { findUnique: vi.fn(), updateMany: vi.fn() };
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const client: any = {
    uploadBatch,
    cafe24UploadBatch: empty,
    coupangUploadBatch: empty,
    reportExport: empty,
    storageTombstone: empty,
    $queryRaw: vi.fn().mockResolvedValue([{
      current_user: options.principal ?? "legacy_maintenance",
      current_database: "postgres",
      current_schema: "public",
      has_required_role: true
    }]),
    $transaction: vi.fn(async (callback: (tx: any) => unknown) => callback(client)),
    $disconnect: disconnect
  };
  return { client, row, updateMany, disconnect };
}

function directFactories(client: any, fetchImpl: any): Partial<LegacyDirectFactories> {
  return {
    loadPrismaModule: () => ({
      PrismaClient: class { constructor() { return client; } },
      Prisma: { sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({ parts, values }) }
    }),
    fetch: fetchImpl,
    fs: { lstat, realpath, readdir, open }
  };
}

function storageHarness(initial: Buffer | null = null) {
  let target = initial;
  const methods: string[] = [];
  const upsertHeaders: Array<string | null> = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    methods.push(method);
    if (method === "GET") return target === null
      ? new Response(null, { status: 404 })
      : new Response(target, { status: 200 });
    if (method === "POST") {
      upsertHeaders.push(new Headers(init.headers).get("x-upsert"));
      if (target !== null) return new Response(null, { status: 409 });
      target = Buffer.from(await new Response(init.body).arrayBuffer());
      return new Response(null, { status: 201 });
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { fetch, methods, upsertHeaders, get target() { return target; } };
}

function cloudTarget(): CloudTargetBinding {
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
      loginUser: "legacy_maintenance",
      expectedCurrentUser: "legacy_maintenance",
      requiredRole: "legacy_maintenance_role",
      sslMode: "verify-full",
      tlsServerName: `db.${projectRef}.supabase.co`
    },
    releaseGitSha,
    issuedAt: "2026-09-02T02:50:00.000Z",
    expiresAt: "2026-09-02T04:00:00.000Z"
  };
}

function databaseUrl() {
  const value = new URL(`postgresql://db.${projectRef}.supabase.co:5432/postgres`);
  value.username = "legacy_maintenance";
  value.password = ["test", "password"].join("-");
  value.searchParams.set("schema", "public");
  value.searchParams.set("sslmode", "verify-full");
  return value.toString();
}

function withoutApprovalIdentity(approval: ReturnType<typeof buildLegacySourceInventoryApproval>) {
  const { version: _version, approvalSha256: _approvalSha256, driftDisposition: _driftDisposition, ...input } = approval;
  return input;
}

function fakeStat(input: { file?: boolean; symlink?: boolean }) {
  return {
    isFile: () => input.file === true,
    isDirectory: () => false,
    isSymbolicLink: () => input.symlink === true,
    dev: 1,
    ino: 1,
    size: 1,
    mtimeMs: 1
  };
}
