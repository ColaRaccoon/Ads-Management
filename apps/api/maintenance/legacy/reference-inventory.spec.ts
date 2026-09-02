import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  applyLegacyMigrationPlan,
  applyLegacyMigrationManifest,
  applyLegacyTombstonePair,
  createBoundLegacyMigrationAdapter,
  createLegacyMigrationPlan,
  inventoryStorageReferences,
  LegacyMigrationAdapter,
  MAX_LEGACY_SOURCE_BYTES,
  pairLegacyTombstonePlans,
  ReferenceCandidate,
  rollbackLegacyMigrationReference,
  rollbackLegacyMigrationManifest,
  rollbackLegacyTombstonePair,
  type LegacyTombstonePairAdapter
} from "./reference-inventory";
import { legacyExecutionPlanSha256, runLegacyCli } from "./legacy.cli";
import { buildLegacyProviderBinding, buildLegacySourceInventoryApproval } from "./direct-provider";
import { CloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";

const root = path.resolve("C:/approved/legacy");
const id = "11111111-1111-4111-8111-111111111111";
const hash = "a".repeat(64);

describe("legacy reference inventory and conditional migration", () => {
  it("classifies all five model families without exposing source roots in the digest input", () => {
    const records: ReferenceCandidate[] = [
      candidate("UploadBatch", "storedFilePath", null),
      candidate("Cafe24UploadBatch", "storedFilePath", "supabase:uploads/current"),
      candidate("CoupangUploadBatch", "storedFilePath", "local:legacy/coupang.xlsx"),
      candidate("ReportExport", "filePath", "legacy/report.xlsx"),
      { ...candidate("StorageTombstone", "trashKey", "trash/legacy"), declaredProvider: "local", status: "RETAINED" }
    ];
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555"
    ];
    const inventory = inventoryStorageReferences(records.map((record, index) => ({
      ...record,
      recordId: ids[index]
    })), [root]);
    expect(inventory.counts).toMatchObject({ NULL: 1, SUPABASE: 1, LOCAL_TAGGED: 1, UNTAGGED_CONTAINED: 2 });
    expect(inventory.migrationCandidateCount).toBe(3);
    expect(inventory.inventoryDigestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks escapes, mixed providers, or unstable/orphan rows from migration", () => {
    const inventory = inventoryStorageReferences([
      { ...candidate("UploadBatch", "storedFilePath", "../escape"), recordId: id },
      { ...candidate("Cafe24UploadBatch", "storedFilePath", "supabase:uploads/a"), recordId: "22222222-2222-4222-8222-222222222222", declaredProvider: "local" },
      { ...candidate("CoupangUploadBatch", "storedFilePath", "legacy/a"), recordId: "33333333-3333-4333-8333-333333333333", status: "PENDING" },
      { ...candidate("ReportExport", "filePath", "legacy/b"), recordId: "44444444-4444-4444-8444-444444444444", observation: "MISSING" }
    ], [root]);
    expect(inventory.entries.map((entry) => entry.category)).toEqual(["MIXED", "UNTAGGED_CONTAINED", "UNTAGGED_CONTAINED", "INVALID"]);
    expect(inventory.migrationCandidateCount).toBe(0);
    expect(inventory).toMatchObject({ unstableCount: 1, orphanCount: 1 });
  });

  it("copies no-overwrite, verifies hash, CAS-updates, and resumes after a lost copy acknowledgement", async () => {
    const entry = inventoryStorageReferences([{ ...candidate("UploadBatch", "storedFilePath", "legacy/a.csv"), recordId: id }], [root]).entries[0];
    const plan = createLegacyMigrationPlan(entry, { hashSha256: hash, byteSize: 7 });
    const state = { target: false, value: entry.value, provider: entry.declaredProvider, copies: 0 };
    const adapter = migrationAdapter(state, plan);
    const first = await applyLegacyMigrationPlan(plan, adapter);
    expect(first).toMatchObject({ result: "PASS", sourcePreserved: true });
    expect(state.copies).toBe(1);
    const resumed = await applyLegacyMigrationPlan(plan, adapter);
    expect(resumed.journal).toContain("TARGET_REUSED");
    expect(resumed.journal).toContain("REFERENCE_ALREADY_UPDATED");
    expect(state.copies).toBe(1);
  });

  it("aborts on target collision or a CAS miss and has no source-delete capability", async () => {
    const entry = inventoryStorageReferences([{ ...candidate("ReportExport", "filePath", "legacy/a.xlsx"), recordId: id }], [root]).entries[0];
    const plan = createLegacyMigrationPlan(entry, { hashSha256: hash, byteSize: 7 });
    const collision = migrationAdapter({ target: true, value: entry.value, copies: 0 }, plan, { targetHash: "b".repeat(64) });
    await expect(applyLegacyMigrationPlan(plan, collision)).rejects.toThrow("LEGACY_MIGRATION_TARGET_COLLISION");
    const casMiss = migrationAdapter({ target: true, value: entry.value, copies: 0 }, plan, { cas: false });
    await expect(applyLegacyMigrationPlan(plan, casMiss)).rejects.toThrow("LEGACY_MIGRATION_CAS_MISS");
    expect("deleteSource" in casMiss).toBe(false);
  });

  it("rolls only the DB reference back after re-verifying the preserved source", async () => {
    const entry = inventoryStorageReferences([{ ...candidate("UploadBatch", "storedFilePath", "legacy/a.csv"), recordId: id }], [root]).entries[0];
    const plan = createLegacyMigrationPlan(entry, { hashSha256: hash, byteSize: 7 });
    let current = plan.targetReference;
    const result = await rollbackLegacyMigrationReference(plan, {
      inspectSource: async () => ({ hashSha256: hash, byteSize: 7 }),
      readReference: async () => ({ value: current, status: plan.expectedOldStatus }),
      compareAndSwapReferenceBack: async () => { current = plan.expectedOldValue; return true; }
    });
    expect(result).toEqual({ result: "PASS", sourcePreserved: true, targetDeletionRequired: false });
    expect(current).toBe(plan.expectedOldValue);
  });

  it("rejects an individual source over 24MiB while allowing a root total to be represented independently", () => {
    const entry = inventoryStorageReferences([{ ...candidate("UploadBatch", "storedFilePath", "legacy/large.csv"), recordId: id }], [root]).entries[0];
    expect(() => createLegacyMigrationPlan(entry, {
      hashSha256: hash,
      byteSize: MAX_LEGACY_SOURCE_BYTES + 1
    })).toThrow("LEGACY_MIGRATION_SOURCE_SIZE_INVALID");
  });

  it("requires a complete StorageTombstone originalKey/trashKey pair", () => {
    const pair = tombstonePairPlans();
    expect(() => pairLegacyTombstonePlans([pair.original])).toThrow("LEGACY_TOMBSTONE_PAIR_INCOMPLETE");
    expect(pairLegacyTombstonePlans([pair.trash, pair.original])).toEqual([pair]);
  });

  it("copies and verifies both tombstone targets before the coupled CAS, and resumes after second-copy failure", async () => {
    const pair = tombstonePairPlans();
    const state = tombstonePairState(pair);
    state.failCopyField = "trashKey";
    const adapter = tombstonePairAdapter(pair, state);
    await expect(applyLegacyTombstonePair(pair, adapter)).rejects.toThrow("SECOND_COPY_FAILED");
    expect(state.targets).toEqual(new Set(["originalKey"]));
    expect(state.casCalls).toBe(0);
    state.failCopyField = undefined;
    await expect(applyLegacyTombstonePair(pair, adapter)).resolves.toMatchObject({ result: "PASS", sourcePreserved: true });
    expect(state.copyCalls).toEqual(["originalKey", "trashKey", "trashKey"]);
    expect(state.casCalls).toBe(1);
    expect(state.row).toEqual({
      originalKey: pair.original.targetReference,
      trashKey: pair.trash.targetReference,
      provider: "supabase",
      status: pair.original.expectedOldStatus
    });
    expect("deleteSource" in adapter).toBe(false);
    expect("deleteTarget" in adapter).toBe(false);
  });

  it("keeps both target copies on coupled CAS miss and performs no partial row update", async () => {
    const pair = tombstonePairPlans();
    const state = tombstonePairState(pair);
    state.casMiss = true;
    const adapter = tombstonePairAdapter(pair, state);
    await expect(applyLegacyTombstonePair(pair, adapter)).rejects.toThrow("LEGACY_MIGRATION_CAS_MISS");
    expect(state.targets).toEqual(new Set(["originalKey", "trashKey"]));
    expect(state.row).toEqual({
      originalKey: pair.original.expectedOldValue,
      trashKey: pair.trash.expectedOldValue,
      provider: pair.original.expectedOldProvider,
      status: pair.original.expectedOldStatus
    });
  });

  it("fails on the first tombstone copy before CAS and rolls both DB keys/provider back atomically", async () => {
    const pair = tombstonePairPlans();
    const failed = tombstonePairState(pair);
    failed.failCopyField = "originalKey";
    await expect(applyLegacyTombstonePair(pair, tombstonePairAdapter(pair, failed))).rejects.toThrow("FIRST_COPY_FAILED");
    expect(failed.copyCalls).toEqual(["originalKey"]);
    expect(failed.casCalls).toBe(0);

    let row = {
      originalKey: pair.original.targetReference,
      trashKey: pair.trash.targetReference,
      provider: "supabase",
      status: pair.original.expectedOldStatus
    };
    let rollbackCalls = 0;
    const rollback = {
      inspectSource: async (plan: typeof pair.original | typeof pair.trash) => ({
        hashSha256: plan.sourceHashSha256,
        byteSize: plan.sourceByteSize
      }),
      readTombstonePair: async () => ({ ...row }),
      compareAndSwapTombstonePairBack: async () => {
        rollbackCalls += 1;
        row = {
          originalKey: pair.original.expectedOldValue,
          trashKey: pair.trash.expectedOldValue,
          provider: pair.original.expectedOldProvider!,
          status: pair.original.expectedOldStatus
        };
        return true;
      }
    };
    await expect(rollbackLegacyTombstonePair(pair, rollback)).resolves.toEqual({
      result: "PASS", sourcePreserved: true, targetDeletionRequired: false
    });
    expect(rollbackCalls).toBe(1);
    expect(row.originalKey).toBe(pair.original.expectedOldValue);
    expect(row.trashKey).toBe(pair.trash.expectedOldValue);
    expect(row.provider).toBe(pair.original.expectedOldProvider);
    expect("deleteSource" in rollback).toBe(false);
    expect("deleteTarget" in rollback).toBe(false);
  });

  it("stages every ordinary and tombstone target before manifest DB mutation and keeps copies on later failure", async () => {
    const plans = manifestPlans();
    const state = manifestAdapterState(plans);
    state.failCopyIndex = 2;
    const adapter = manifestAdapter(plans, state);
    await expect(applyLegacyMigrationManifest(plans, adapter)).rejects.toThrow("MANIFEST_COPY_FAILED_2");
    expect(state.copyAttempts).toBe(3);
    expect(state.targets.size).toBe(2);
    expect(state.databaseCalls).toBe(0);
    expect("deleteSource" in adapter).toBe(false);
    expect("deleteTarget" in adapter).toBe(false);
  });

  it("resumes fully staged targets after a pre-commit crash and makes the full manifest idempotent", async () => {
    const plans = manifestPlans();
    const state = manifestAdapterState(plans);
    state.failDatabaseOnce = true;
    const adapter = manifestAdapter(plans, state);
    await expect(applyLegacyMigrationManifest(plans, adapter)).rejects.toThrow("MANIFEST_TRANSACTION_ABORTED");
    expect(state.targets.size).toBe(plans.length);
    expect(state.databaseState).toBe("ORIGINAL");
    const copiesAfterCrash = state.copyAttempts;
    await expect(applyLegacyMigrationManifest(plans, adapter)).resolves.toMatchObject({ result: "PASS" });
    expect(state.copyAttempts).toBe(copiesAfterCrash);
    expect(state.databaseState).toBe("DESIRED");
    await expect(applyLegacyMigrationManifest(plans, adapter)).resolves.toMatchObject({ result: "PASS" });
    expect(state.databaseResultHistory).toEqual(["ABORTED", "UPDATED", "ALREADY_DESIRED"]);
  });

  it("exposes manifest-wide rollback only after all sources verify and never deletes copied targets", async () => {
    const plans = manifestPlans();
    let databaseState: "ORIGINAL" | "DESIRED" = "DESIRED";
    let transactionCalls = 0;
    const adapter = {
      inspectSource: async (plan: typeof plans[number]) => ({
        hashSha256: plan.sourceHashSha256,
        byteSize: plan.sourceByteSize
      }),
      compareAndSwapManifestBack: async () => {
        transactionCalls += 1;
        databaseState = "ORIGINAL";
        return "UPDATED" as const;
      }
    };
    await expect(rollbackLegacyMigrationManifest(plans, adapter)).resolves.toEqual({
      result: "PASS",
      databaseResult: "UPDATED",
      sourcePreserved: true,
      targetDeletionRequired: false
    });
    expect(transactionCalls).toBe(1);
    expect(databaseState).toBe("ORIGINAL");
    expect("deleteSource" in adapter).toBe(false);
    expect("deleteTarget" in adapter).toBe(false);
  });

  it("requires an exact provider binding and verifies source and copied target bodies", async () => {
    const bytes = Buffer.from("legacy");
    const bodyHash = createHash("sha256").update(bytes).digest("hex");
    const entry = inventoryStorageReferences([{ ...candidate("UploadBatch", "storedFilePath", "legacy/a.csv"), recordId: id }], [root]).entries[0];
    const plan = createLegacyMigrationPlan(entry, { hashSha256: bodyHash, byteSize: bytes.length });
    expect(() => createBoundLegacyMigrationAdapter({
      projectRef: "abcdefghijklmnopqrst", supabaseOrigin: "https://abcdefghijklmnopqrst.supabase.co", bucket: "private",
      targetSha256: "a".repeat(64), confirmTargetSha256: "b".repeat(64), storageCredentialReference: "credential",
      approvedLocalRoots: [root], io: boundIo(bytes, plan)
    })).toThrow("LEGACY_PROVIDER_BINDING_REQUIRED");
    const adapter = createBoundLegacyMigrationAdapter({
      projectRef: "abcdefghijklmnopqrst", supabaseOrigin: "https://abcdefghijklmnopqrst.supabase.co", bucket: "private",
      targetSha256: "a".repeat(64), confirmTargetSha256: "a".repeat(64), storageCredentialReference: "credential",
      approvedLocalRoots: [root], io: boundIo(bytes, plan)
    });
    await expect(applyLegacyMigrationPlan(plan, adapter)).resolves.toMatchObject({ result: "PASS", sourcePreserved: true });
  });

  it("runs the direct legacy CLI only for exact inventory plans and independent confirmations", async () => {
    const bytes = Buffer.from("legacy");
    const bodyHash = createHash("sha256").update(bytes).digest("hex");
    const record = { ...candidate("UploadBatch", "storedFilePath", "legacy/a.csv"), recordId: id, expectedHashSha256: bodyHash, expectedByteSize: bytes.length };
    const inventory = inventoryStorageReferences([record], [root]);
    const plan = createLegacyMigrationPlan(inventory.entries[0], { hashSha256: bodyHash, byteSize: bytes.length });
    const now = Date.now();
    const binding = {
      ...cloudTarget,
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString()
    };
    const planDigestSha256 = legacyExecutionPlanSha256({ target: binding, inventoryDigestSha256: inventory.inventoryDigestSha256, plans: [plan] });
    const issuedAt = new Date(now - 60_000).toISOString();
    const expiresAt = new Date(now + 60 * 60_000).toISOString();
    const sourceApproval = buildLegacySourceInventoryApproval({
      projectRef: binding.projectRef,
      releaseGitSha: binding.releaseGitSha,
      targetSha256: targetBindingSha256(binding),
      referenceInventoryDigestSha256: inventory.inventoryDigestSha256,
      executionPlanDigestSha256: planDigestSha256,
      issuedAt,
      expiresAt,
      roots: [{ rootId: "legacy-source-root-001", rootPath: root, fileCount: 1, totalBytes: 7, manifestSha256: hash }]
    });
    const providerBinding = buildLegacyProviderBinding({
      projectRef: binding.projectRef,
      releaseGitSha: binding.releaseGitSha,
      targetSha256: targetBindingSha256(binding),
      database: binding.database,
      supabaseOrigin: binding.supabaseOrigin,
      bucket: "legacy-private",
      bucketVisibility: "private",
      storageTokenScope: "LEGACY_PRIVATE_OBJECT_READ_WRITE_NO_DELETE",
      storageTokenSha256: "8".repeat(64),
      approvedSourceRoots: sourceApproval.roots.map(({ rootId, rootPath }) => ({ rootId, rootPath })),
      sourceInventoryApprovalSha256: sourceApproval.approvalSha256,
      referenceInventoryDigestSha256: inventory.inventoryDigestSha256,
      executionPlanDigestSha256: planDigestSha256,
      issuedAt,
      expiresAt
    });
    const directory = mkdtempSync(path.join(os.tmpdir(), "legacy-cli-"));
    const file = path.join(directory, "manifest.json");
    const sourceApprovalFile = path.join(directory, "source-approval.json");
    const providerBindingFile = path.join(directory, "provider-binding.json");
    writeFileSync(file, JSON.stringify({
      target: binding,
      confirmation: { projectRef: binding.projectRef, releaseGitSha: binding.releaseGitSha, targetSha256: targetBindingSha256(binding) },
      references: [record], approvedLocalRoots: [root], migrationPlans: [plan],
      executionApproval: {
        planDigestSha256,
        providerBindingSha256: providerBinding.providerBindingSha256,
        sourceInventoryApprovalSha256: sourceApproval.approvalSha256
      }
    }));
    writeFileSync(sourceApprovalFile, JSON.stringify(sourceApproval));
    writeFileSync(providerBindingFile, JSON.stringify(providerBinding));
    const argv = [
      `--manifest=${file}`, `--source-inventory=${sourceApprovalFile}`, `--provider-binding=${providerBindingFile}`,
      "--execute", `--confirm-plan-sha256=${planDigestSha256}`,
      `--confirm-provider-binding-sha256=${providerBinding.providerBindingSha256}`,
      `--confirm-source-inventory-sha256=${sourceApproval.approvalSha256}`
    ];
    let state = { target: false, value: record.value, copies: 0 };
    await expect(runLegacyCli({
      argv, env: {}, providerFactory: ({ plan: approved }) => migrationAdapter(state, approved)
    })).resolves.toContain('"result":"PASS"');
    state = { target: false, value: record.value, copies: 0 };
    await expect(runLegacyCli({
      argv: argv.map((arg) => arg.startsWith("--confirm-plan") ? `--confirm-plan-sha256=${"0".repeat(64)}` : arg),
      env: {}, providerFactory: () => { throw new Error("must not compose"); }
    })).rejects.toThrow("LEGACY_PLAN_CONFIRMATION_MISMATCH");
    await expect(runLegacyCli({ argv, env: {} })).rejects.toThrow("LEGACY_DATABASE_CREDENTIAL_REQUIRED");
  });
});

function candidate(model: ReferenceCandidate["model"], field: ReferenceCandidate["field"], value: string | null): ReferenceCandidate {
  return { model, recordId: id, field, value, sourceRoot: root, status: model === "StorageTombstone" ? "RETAINED" : "IMPORTED", observation: "FOUND" };
}

const cloudTarget = {
  version: "cloud-target-binding/v1", environmentId: "staging-one", environmentClass: "staging",
  projectRef: "abcdefghijklmnopqrst", supabaseOrigin: "https://abcdefghijklmnopqrst.supabase.co",
  database: {
    connectionMode: "direct", host: "db.abcdefghijklmnopqrst.supabase.co", port: 5432, name: "postgres", schema: "app_runtime",
    loginUser: "postgres", expectedCurrentUser: "postgres", requiredRole: "app_maintenance", sslMode: "verify-full",
    tlsServerName: "db.abcdefghijklmnopqrst.supabase.co"
  },
  releaseGitSha: "b".repeat(40), issuedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-01T01:00:00.000Z"
} satisfies CloudTargetBinding;

function boundIo(bytes: Buffer, plan: ReturnType<typeof createLegacyMigrationPlan>) {
  let targetBody: Buffer | null = null;
  let value: string | null = plan.expectedOldValue;
  return {
    readSourceBody: async () => bytes,
    readTargetBody: async () => targetBody,
    putTargetNoOverwrite: async (_plan: typeof plan, body: Uint8Array) => { targetBody = Buffer.from(body); },
    compareAndSwapReference: async () => { value = plan.targetReference; return true; },
    readReference: async () => ({ value, status: plan.expectedOldStatus })
  };
}

function migrationAdapter(
  state: { target: boolean; value: string | null; provider?: string; copies: number },
  plan: ReturnType<typeof createLegacyMigrationPlan>,
  options: { targetHash?: string; cas?: boolean } = {}
): LegacyMigrationAdapter & {
  compareAndSwapManifest(plans: Array<ReturnType<typeof createLegacyMigrationPlan>>): Promise<"UPDATED" | "ALREADY_DESIRED">;
} {
  return {
    inspectTarget: async () => state.target
      ? { state: "FOUND", hashSha256: options.targetHash ?? plan.sourceHashSha256, byteSize: plan.sourceByteSize }
      : { state: "MISSING" },
    copyNoOverwrite: async () => { state.target = true; state.copies += 1; return { hashSha256: plan.sourceHashSha256, byteSize: plan.sourceByteSize }; },
    compareAndSwapReference: async () => {
      if (options.cas === false) return false;
      state.value = plan.targetReference;
      state.provider = plan.targetProvider;
      return true;
    },
    readReference: async () => ({ value: state.value, provider: state.provider, status: plan.expectedOldStatus }),
    compareAndSwapManifest: async (plans) => {
      if (plans.length !== 1 || plans[0].planDigestSha256 !== plan.planDigestSha256) {
        throw new Error("LEGACY_MANIFEST_PLAN_MISMATCH");
      }
      if (state.value === plan.targetReference) return "ALREADY_DESIRED";
      if (state.value !== plan.expectedOldValue) throw new Error("LEGACY_MANIFEST_DB_MIXED_STATE");
      if (options.cas === false) throw new Error("LEGACY_MIGRATION_CAS_MISS");
      state.value = plan.targetReference;
      state.provider = plan.targetProvider;
      return "UPDATED";
    }
  };
}

function tombstonePairPlans() {
  const records: ReferenceCandidate[] = [
    {
      ...candidate("StorageTombstone", "originalKey", "local:objects/original.bin"),
      recordId: id,
      declaredProvider: "local",
      status: "RETAINED"
    },
    {
      ...candidate("StorageTombstone", "trashKey", "local:trash/trashed.bin"),
      recordId: id,
      declaredProvider: "local",
      status: "RETAINED"
    }
  ];
  const entries = inventoryStorageReferences(records, [root]).entries;
  return pairLegacyTombstonePlans(entries.map((entry, index) => createLegacyMigrationPlan(entry, {
    hashSha256: index === 0 ? "a".repeat(64) : "b".repeat(64),
    byteSize: index + 1
  })))[0];
}

function tombstonePairState(pair: ReturnType<typeof tombstonePairPlans>) {
  return {
    targets: new Set<string>(),
    copyCalls: [] as string[],
    casCalls: 0,
    casMiss: false,
    failCopyField: undefined as "originalKey" | "trashKey" | undefined,
    row: {
      originalKey: pair.original.expectedOldValue,
      trashKey: pair.trash.expectedOldValue,
      provider: pair.original.expectedOldProvider!,
      status: pair.original.expectedOldStatus
    }
  };
}

function tombstonePairAdapter(
  pair: ReturnType<typeof tombstonePairPlans>,
  state: ReturnType<typeof tombstonePairState>
): LegacyTombstonePairAdapter {
  return {
    inspectTarget: async (plan) => state.targets.has(plan.field)
      ? { state: "FOUND", hashSha256: plan.sourceHashSha256, byteSize: plan.sourceByteSize }
      : { state: "MISSING" },
    copyNoOverwrite: async (plan) => {
      state.copyCalls.push(plan.field);
      if (state.failCopyField === plan.field) {
        throw new Error(plan.field === "originalKey" ? "FIRST_COPY_FAILED" : "SECOND_COPY_FAILED");
      }
      state.targets.add(plan.field);
      return { hashSha256: plan.sourceHashSha256, byteSize: plan.sourceByteSize };
    },
    readTombstonePair: async () => ({ ...state.row }),
    compareAndSwapTombstonePair: async () => {
      state.casCalls += 1;
      if (state.casMiss) return false;
      state.row = {
        originalKey: pair.original.targetReference,
        trashKey: pair.trash.targetReference,
        provider: "supabase",
        status: pair.original.expectedOldStatus
      };
      return true;
    }
  };
}

function manifestPlans() {
  const ordinaryId = "22222222-2222-4222-8222-222222222222";
  const ordinaryEntry = inventoryStorageReferences([{
    ...candidate("UploadBatch", "storedFilePath", "local:ordinary/a.csv"),
    recordId: ordinaryId,
    declaredProvider: "local"
  }], [root]).entries[0];
  const ordinary = createLegacyMigrationPlan(ordinaryEntry, { hashSha256: "c".repeat(64), byteSize: 3 });
  const pair = tombstonePairPlans();
  return [ordinary, pair.original, pair.trash];
}

function manifestAdapterState(plans: ReturnType<typeof manifestPlans>) {
  return {
    targets: new Set<string>(),
    copyAttempts: 0,
    failCopyIndex: undefined as number | undefined,
    failDatabaseOnce: false,
    databaseCalls: 0,
    databaseState: "ORIGINAL" as "ORIGINAL" | "DESIRED",
    databaseResultHistory: [] as string[],
    plans
  };
}

function manifestAdapter(
  plans: ReturnType<typeof manifestPlans>,
  state: ReturnType<typeof manifestAdapterState>
) {
  return {
    inspectTarget: async (plan: typeof plans[number]) => state.targets.has(plan.planDigestSha256)
      ? { state: "FOUND" as const, hashSha256: plan.sourceHashSha256, byteSize: plan.sourceByteSize }
      : { state: "MISSING" as const },
    copyNoOverwrite: async (plan: typeof plans[number]) => {
      const attempt = state.copyAttempts;
      state.copyAttempts += 1;
      if (state.failCopyIndex === attempt) throw new Error(`MANIFEST_COPY_FAILED_${attempt}`);
      state.targets.add(plan.planDigestSha256);
      return { hashSha256: plan.sourceHashSha256, byteSize: plan.sourceByteSize };
    },
    compareAndSwapManifest: async (approved: typeof plans) => {
      state.databaseCalls += 1;
      if (approved.map((plan) => plan.planDigestSha256).join("|") !==
        plans.map((plan) => plan.planDigestSha256).join("|")) throw new Error("MANIFEST_PLAN_MISMATCH");
      if (state.failDatabaseOnce) {
        state.failDatabaseOnce = false;
        state.databaseResultHistory.push("ABORTED");
        throw new Error("MANIFEST_TRANSACTION_ABORTED");
      }
      if (state.databaseState === "DESIRED") {
        state.databaseResultHistory.push("ALREADY_DESIRED");
        return "ALREADY_DESIRED" as const;
      }
      state.databaseState = "DESIRED";
      state.databaseResultHistory.push("UPDATED");
      return "UPDATED" as const;
    }
  };
}
