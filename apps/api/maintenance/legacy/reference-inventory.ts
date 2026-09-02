import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalSha256 } from "../shared/strict-json";

export const LEGACY_REFERENCE_CONTRACT_VERSION = 1 as const;
export const MAX_LEGACY_SOURCE_BYTES = 24 * 1024 * 1024;
export const REFERENCE_MODELS = [
  "UploadBatch", "Cafe24UploadBatch", "CoupangUploadBatch", "ReportExport", "StorageTombstone"
] as const;
export type ReferenceModel = typeof REFERENCE_MODELS[number];
export type ReferenceField = "storedFilePath" | "filePath" | "originalKey" | "trashKey";
export type ReferenceCategory =
  | "NULL"
  | "SUPABASE"
  | "LOCAL_TAGGED"
  | "UNTAGGED_CONTAINED"
  | "ABSOLUTE_CONTAINED"
  | "INVALID"
  | "MIXED";

export type ReferenceCandidate = {
  model: ReferenceModel;
  recordId: string;
  field: ReferenceField;
  value: string | null;
  declaredProvider?: string;
  sourceRoot?: string;
  status: string;
  expectedHashSha256?: string;
  expectedByteSize?: number;
  observation: "NOT_CHECKED" | "FOUND" | "MISSING";
};

export type InventoriedReference = ReferenceCandidate & {
  category: ReferenceCategory;
  normalizedProvider: string | null;
  normalizedKey: string | null;
  stable: boolean;
  orphan: boolean;
  migrationCandidate: boolean;
};

export type ReferenceInventory = {
  contractVersion: typeof LEGACY_REFERENCE_CONTRACT_VERSION;
  entries: InventoriedReference[];
  counts: Record<ReferenceCategory, number>;
  total: number;
  unstableCount: number;
  orphanCount: number;
  migrationCandidateCount: number;
  inventoryDigestSha256: string;
};

export function inventoryStorageReferences(candidates: ReferenceCandidate[], approvedLocalRoots: string[]): ReferenceInventory {
  if (candidates.length > 1_000_000) throw new Error("LEGACY_REFERENCE_LIMIT");
  const roots = normalizeRoots(approvedLocalRoots);
  const identities = new Set<string>();
  const entries = candidates.map((candidate) => {
    validateCandidate(candidate);
    const identity = `${candidate.model}|${candidate.recordId}|${candidate.field}`;
    if (identities.has(identity)) throw new Error("LEGACY_REFERENCE_DUPLICATE");
    identities.add(identity);
    const classified = classify(candidate, roots);
    const stable = isStable(candidate.model, candidate.status);
    const orphan = candidate.observation === "MISSING" && classified.category !== "NULL" && classified.category !== "INVALID";
    const migrationCandidate = stable && !orphan && ["LOCAL_TAGGED", "UNTAGGED_CONTAINED", "ABSOLUTE_CONTAINED"]
      .includes(classified.category);
    return { ...candidate, ...classified, stable, orphan, migrationCandidate };
  }).sort((left, right) => `${left.model}|${left.recordId}|${left.field}`.localeCompare(`${right.model}|${right.recordId}|${right.field}`));
  const counts = Object.fromEntries([
    "NULL", "SUPABASE", "LOCAL_TAGGED", "UNTAGGED_CONTAINED", "ABSOLUTE_CONTAINED", "INVALID", "MIXED"
  ].map((category) => [category, entries.filter((entry) => entry.category === category).length])) as Record<ReferenceCategory, number>;
  const digestEntries = entries.map(({ sourceRoot: _sourceRoot, ...entry }) => ({
    ...entry,
    sourceRootBound: Boolean(_sourceRoot)
  }));
  return {
    contractVersion: LEGACY_REFERENCE_CONTRACT_VERSION,
    entries,
    counts,
    total: entries.length,
    unstableCount: entries.filter((entry) => !entry.stable).length,
    orphanCount: entries.filter((entry) => entry.orphan).length,
    migrationCandidateCount: entries.filter((entry) => entry.migrationCandidate).length,
    inventoryDigestSha256: canonicalSha256(digestEntries)
  };
}

export type SourceInspection = { hashSha256: string; byteSize: number };
export type LegacyMigrationPlan = {
  contractVersion: typeof LEGACY_REFERENCE_CONTRACT_VERSION;
  model: ReferenceModel;
  recordId: string;
  field: ReferenceField;
  expectedOldValue: string;
  expectedOldProvider?: string;
  expectedOldStatus: string;
  sourceRoot: string;
  sourceKey: string;
  sourceHashSha256: string;
  sourceByteSize: number;
  targetProvider: "supabase";
  targetKey: string;
  targetReference: string;
  planDigestSha256: string;
};

export function createLegacyMigrationPlan(entry: InventoriedReference, source: SourceInspection): LegacyMigrationPlan {
  if (!entry.migrationCandidate || !entry.value || !entry.sourceRoot || !entry.normalizedKey) {
    throw new Error("LEGACY_MIGRATION_ENTRY_NOT_ELIGIBLE");
  }
  assertHash(source.hashSha256, "LEGACY_MIGRATION_SOURCE_HASH_INVALID");
  if (!Number.isSafeInteger(source.byteSize) || source.byteSize < 0 || source.byteSize > MAX_LEGACY_SOURCE_BYTES) {
    throw new Error("LEGACY_MIGRATION_SOURCE_SIZE_INVALID");
  }
  if (entry.expectedHashSha256 && entry.expectedHashSha256 !== source.hashSha256) {
    throw new Error("LEGACY_MIGRATION_DATABASE_HASH_MISMATCH");
  }
  if (entry.expectedByteSize !== undefined && entry.expectedByteSize !== source.byteSize) {
    throw new Error("LEGACY_MIGRATION_DATABASE_SIZE_MISMATCH");
  }
  const modelSegment = entry.model.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  const fieldSegment = entry.field.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  const targetKey = `legacy/${modelSegment}/${entry.recordId}/${fieldSegment}/${source.hashSha256}`;
  const unsigned = {
    contractVersion: LEGACY_REFERENCE_CONTRACT_VERSION,
    model: entry.model,
    recordId: entry.recordId,
    field: entry.field,
    expectedOldValue: entry.value,
    ...(entry.declaredProvider ? { expectedOldProvider: entry.declaredProvider } : {}),
    expectedOldStatus: entry.status,
    sourceRoot: entry.sourceRoot,
    sourceKey: entry.normalizedKey,
    sourceHashSha256: source.hashSha256,
    sourceByteSize: source.byteSize,
    targetProvider: "supabase" as const,
    targetKey,
    targetReference: entry.model === "StorageTombstone" ? targetKey : `supabase:${targetKey}`
  };
  return { ...unsigned, planDigestSha256: canonicalSha256(unsigned) };
}

export type LegacyMigrationAdapter = {
  inspectTarget(plan: LegacyMigrationPlan): Promise<
    | { state: "MISSING" }
    | { state: "FOUND"; hashSha256: string; byteSize: number }
  >;
  copyNoOverwrite(plan: LegacyMigrationPlan): Promise<{ hashSha256: string; byteSize: number }>;
  compareAndSwapReference(plan: LegacyMigrationPlan): Promise<boolean>;
  readReference(plan: LegacyMigrationPlan): Promise<{ value: string | null; provider?: string; status: string }>;
};

export type LegacyRollbackAdapter = {
  inspectSource(plan: LegacyMigrationPlan): Promise<{ hashSha256: string; byteSize: number }>;
  readReference(plan: LegacyMigrationPlan): Promise<{ value: string | null; provider?: string; status: string }>;
  compareAndSwapReferenceBack(plan: LegacyMigrationPlan): Promise<boolean>;
};

export async function applyLegacyMigrationPlan(plan: LegacyMigrationPlan, adapter: LegacyMigrationAdapter) {
  const journal: string[] = ["PLANNED", "SOURCE_VERIFIED"];
  let target = await adapter.inspectTarget(plan);
  if (target.state === "MISSING") {
    const copied = await adapter.copyNoOverwrite(plan);
    assertTargetMatches(plan, copied);
    journal.push("TARGET_COPIED");
    target = await adapter.inspectTarget(plan);
  } else {
    journal.push("TARGET_REUSED");
  }
  if (target.state !== "FOUND") throw new Error("LEGACY_MIGRATION_TARGET_ACK_MISSING");
  assertTargetMatches(plan, target);
  journal.push("TARGET_VERIFIED");
  const current = await adapter.readReference(plan);
  if (isDesiredReference(plan, current)) {
    journal.push("REFERENCE_ALREADY_UPDATED");
  } else {
    if (!await adapter.compareAndSwapReference(plan)) throw new Error("LEGACY_MIGRATION_CAS_MISS");
    journal.push("REFERENCE_CAS_UPDATED");
  }
  const verified = await adapter.readReference(plan);
  if (!isDesiredReference(plan, verified)) throw new Error("LEGACY_MIGRATION_REFERENCE_VERIFY_FAILED");
  journal.push("COMPLETE");
  return { result: "PASS" as const, planDigestSha256: plan.planDigestSha256, journal, sourcePreserved: true as const };
}

export async function rollbackLegacyMigrationReference(plan: LegacyMigrationPlan, adapter: LegacyRollbackAdapter) {
  const source = await adapter.inspectSource(plan);
  if (source.hashSha256 !== plan.sourceHashSha256 || source.byteSize !== plan.sourceByteSize) {
    throw new Error("LEGACY_ROLLBACK_SOURCE_MISMATCH");
  }
  const current = await adapter.readReference(plan);
  if (!isDesiredReference(plan, current)) throw new Error("LEGACY_ROLLBACK_CURRENT_REFERENCE_MISMATCH");
  if (!await adapter.compareAndSwapReferenceBack(plan)) throw new Error("LEGACY_ROLLBACK_CAS_MISS");
  const restored = await adapter.readReference(plan);
  if (restored.value !== plan.expectedOldValue || restored.status !== plan.expectedOldStatus ||
      (plan.model === "StorageTombstone" && restored.provider !== plan.expectedOldProvider)) {
    throw new Error("LEGACY_ROLLBACK_REFERENCE_VERIFY_FAILED");
  }
  return { result: "PASS" as const, sourcePreserved: true as const, targetDeletionRequired: false as const };
}

export type LegacyTombstonePairPlan = {
  original: LegacyMigrationPlan & { model: "StorageTombstone"; field: "originalKey" };
  trash: LegacyMigrationPlan & { model: "StorageTombstone"; field: "trashKey" };
};

export type LegacyTombstonePairState = {
  originalKey: string;
  trashKey: string;
  provider: string;
  status: string;
};

export type LegacyTombstonePairAdapter = Pick<LegacyMigrationAdapter, "inspectTarget" | "copyNoOverwrite"> & {
  readTombstonePair(pair: LegacyTombstonePairPlan): Promise<LegacyTombstonePairState>;
  compareAndSwapTombstonePair(pair: LegacyTombstonePairPlan): Promise<boolean>;
};

export type LegacyTombstonePairRollbackAdapter = {
  inspectSource(plan: LegacyMigrationPlan): Promise<{ hashSha256: string; byteSize: number }>;
  readTombstonePair(pair: LegacyTombstonePairPlan): Promise<LegacyTombstonePairState>;
  compareAndSwapTombstonePairBack(pair: LegacyTombstonePairPlan): Promise<boolean>;
};

export type LegacyManifestApplyAdapter = Pick<LegacyMigrationAdapter, "inspectTarget" | "copyNoOverwrite"> & {
  compareAndSwapManifest(plans: LegacyMigrationPlan[]): Promise<"UPDATED" | "ALREADY_DESIRED">;
};

export type LegacyManifestRollbackAdapter = {
  inspectSource(plan: LegacyMigrationPlan): Promise<{ hashSha256: string; byteSize: number }>;
  compareAndSwapManifestBack(plans: LegacyMigrationPlan[]): Promise<"UPDATED" | "ALREADY_ORIGINAL">;
};

export async function applyLegacyMigrationManifest(
  plans: LegacyMigrationPlan[],
  adapter: LegacyManifestApplyAdapter
) {
  assertManifestPlanSet(plans);
  const journal: string[] = ["MANIFEST_PLANNED"];
  for (const plan of plans) {
    let target = await adapter.inspectTarget(plan);
    if (target.state === "MISSING") {
      const copied = await adapter.copyNoOverwrite(plan);
      assertTargetMatches(plan, copied);
      journal.push(`TARGET_COPIED:${plan.planDigestSha256}`);
      target = await adapter.inspectTarget(plan);
    } else {
      journal.push(`TARGET_REUSED:${plan.planDigestSha256}`);
    }
    if (target.state !== "FOUND") throw new Error("LEGACY_MIGRATION_TARGET_ACK_MISSING");
    assertTargetMatches(plan, target);
    journal.push(`TARGET_VERIFIED:${plan.planDigestSha256}`);
  }
  journal.push("ALL_TARGETS_VERIFIED");
  const databaseResult = await adapter.compareAndSwapManifest(plans);
  if (databaseResult !== "UPDATED" && databaseResult !== "ALREADY_DESIRED") {
    throw new Error("LEGACY_MANIFEST_DB_RESULT_INVALID");
  }
  journal.push(databaseResult === "UPDATED" ? "MANIFEST_DB_UPDATED" : "MANIFEST_DB_ALREADY_DESIRED");
  journal.push("COMPLETE");
  return {
    result: "PASS" as const,
    manifestDigestSha256: canonicalSha256(plans.map((plan) => plan.planDigestSha256).sort()),
    journal,
    sourcePreserved: true as const,
    targetDeletionRequired: false as const
  };
}

export async function rollbackLegacyMigrationManifest(
  plans: LegacyMigrationPlan[],
  adapter: LegacyManifestRollbackAdapter
) {
  assertManifestPlanSet(plans);
  for (const plan of plans) {
    const source = await adapter.inspectSource(plan);
    if (source.hashSha256 !== plan.sourceHashSha256 || source.byteSize !== plan.sourceByteSize) {
      throw new Error("LEGACY_ROLLBACK_SOURCE_MISMATCH");
    }
  }
  const databaseResult = await adapter.compareAndSwapManifestBack(plans);
  if (databaseResult !== "UPDATED" && databaseResult !== "ALREADY_ORIGINAL") {
    throw new Error("LEGACY_MANIFEST_ROLLBACK_RESULT_INVALID");
  }
  return {
    result: "PASS" as const,
    databaseResult,
    sourcePreserved: true as const,
    targetDeletionRequired: false as const
  };
}

export function pairLegacyTombstonePlans(plans: LegacyMigrationPlan[]): LegacyTombstonePairPlan[] {
  const groups = new Map<string, LegacyMigrationPlan[]>();
  for (const plan of plans.filter((candidate) => candidate.model === "StorageTombstone")) {
    const existing = groups.get(plan.recordId) ?? [];
    existing.push(plan);
    groups.set(plan.recordId, existing);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => {
    const original = group.find((plan) => plan.field === "originalKey");
    const trash = group.find((plan) => plan.field === "trashKey");
    if (group.length !== 2 || !original || !trash ||
      original.expectedOldStatus !== trash.expectedOldStatus ||
      original.expectedOldProvider !== trash.expectedOldProvider ||
      original.targetProvider !== "supabase" || trash.targetProvider !== "supabase") {
      throw new Error("LEGACY_TOMBSTONE_PAIR_INCOMPLETE");
    }
    const pair = {
      original: original as LegacyTombstonePairPlan["original"],
      trash: trash as LegacyTombstonePairPlan["trash"]
    };
    assertTombstonePair(pair);
    return pair;
  });
}

function assertManifestPlanSet(plans: LegacyMigrationPlan[]) {
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > 1_000_000) {
    throw new Error("LEGACY_MIGRATION_PLANS_REQUIRED");
  }
  const identities = new Set<string>();
  for (const plan of plans) {
    const identity = `${plan.model}|${plan.recordId}|${plan.field}`;
    if (identities.has(identity)) throw new Error("LEGACY_MIGRATION_PLAN_DUPLICATE");
    identities.add(identity);
    if (!Number.isSafeInteger(plan.sourceByteSize) || plan.sourceByteSize < 0 ||
      plan.sourceByteSize > MAX_LEGACY_SOURCE_BYTES) {
      throw new Error("LEGACY_MIGRATION_SOURCE_SIZE_INVALID");
    }
    const { planDigestSha256, ...unsigned } = plan;
    if (canonicalSha256(unsigned) !== planDigestSha256) throw new Error("LEGACY_MIGRATION_PLAN_DIGEST_MISMATCH");
  }
  pairLegacyTombstonePlans(plans);
}

export async function applyLegacyTombstonePair(
  pair: LegacyTombstonePairPlan,
  adapter: LegacyTombstonePairAdapter
) {
  assertTombstonePair(pair);
  const journal: string[] = ["PAIR_PLANNED", "PAIR_SOURCES_VERIFIED"];
  for (const plan of [pair.original, pair.trash]) {
    let target = await adapter.inspectTarget(plan);
    if (target.state === "MISSING") {
      const copied = await adapter.copyNoOverwrite(plan);
      assertTargetMatches(plan, copied);
      journal.push(plan.field === "originalKey" ? "ORIGINAL_TARGET_COPIED" : "TRASH_TARGET_COPIED");
      target = await adapter.inspectTarget(plan);
    } else {
      journal.push(plan.field === "originalKey" ? "ORIGINAL_TARGET_REUSED" : "TRASH_TARGET_REUSED");
    }
    if (target.state !== "FOUND") throw new Error("LEGACY_MIGRATION_TARGET_ACK_MISSING");
    assertTargetMatches(plan, target);
  }
  journal.push("PAIR_TARGETS_VERIFIED");
  const current = await adapter.readTombstonePair(pair);
  if (isDesiredTombstonePair(pair, current)) journal.push("PAIR_REFERENCE_ALREADY_UPDATED");
  else {
    if (!isOriginalTombstonePair(pair, current)) throw new Error("LEGACY_TOMBSTONE_PAIR_BEFORE_MISMATCH");
    if (!await adapter.compareAndSwapTombstonePair(pair)) throw new Error("LEGACY_MIGRATION_CAS_MISS");
    journal.push("PAIR_REFERENCE_CAS_UPDATED");
  }
  const verified = await adapter.readTombstonePair(pair);
  if (!isDesiredTombstonePair(pair, verified)) throw new Error("LEGACY_MIGRATION_REFERENCE_VERIFY_FAILED");
  journal.push("COMPLETE");
  return {
    result: "PASS" as const,
    planDigestSha256: canonicalSha256([pair.original.planDigestSha256, pair.trash.planDigestSha256].sort()),
    journal,
    sourcePreserved: true as const
  };
}

export async function rollbackLegacyTombstonePair(
  pair: LegacyTombstonePairPlan,
  adapter: LegacyTombstonePairRollbackAdapter
) {
  assertTombstonePair(pair);
  for (const plan of [pair.original, pair.trash]) {
    const source = await adapter.inspectSource(plan);
    if (source.hashSha256 !== plan.sourceHashSha256 || source.byteSize !== plan.sourceByteSize) {
      throw new Error("LEGACY_ROLLBACK_SOURCE_MISMATCH");
    }
  }
  const current = await adapter.readTombstonePair(pair);
  if (!isDesiredTombstonePair(pair, current)) throw new Error("LEGACY_ROLLBACK_CURRENT_REFERENCE_MISMATCH");
  if (!await adapter.compareAndSwapTombstonePairBack(pair)) throw new Error("LEGACY_ROLLBACK_CAS_MISS");
  const restored = await adapter.readTombstonePair(pair);
  if (!isOriginalTombstonePair(pair, restored)) throw new Error("LEGACY_ROLLBACK_REFERENCE_VERIFY_FAILED");
  return { result: "PASS" as const, sourcePreserved: true as const, targetDeletionRequired: false as const };
}

function assertTombstonePair(pair: LegacyTombstonePairPlan) {
  const plans = [pair.original, pair.trash] as const;
  if (pair.original.model !== "StorageTombstone" || pair.original.field !== "originalKey" ||
    pair.trash.model !== "StorageTombstone" || pair.trash.field !== "trashKey" ||
    pair.original.recordId !== pair.trash.recordId ||
    pair.original.expectedOldStatus !== pair.trash.expectedOldStatus ||
    pair.original.expectedOldProvider !== pair.trash.expectedOldProvider ||
    typeof pair.original.expectedOldProvider !== "string" || !pair.original.expectedOldProvider ||
    pair.original.expectedOldValue === pair.trash.expectedOldValue ||
    pair.original.targetKey === pair.trash.targetKey) {
    throw new Error("LEGACY_TOMBSTONE_PAIR_INCOMPLETE");
  }
  for (const plan of plans) {
    if (plan.targetProvider !== "supabase" || plan.targetReference !== plan.targetKey ||
      !Number.isSafeInteger(plan.sourceByteSize) || plan.sourceByteSize < 0 ||
      plan.sourceByteSize > MAX_LEGACY_SOURCE_BYTES) {
      throw new Error("LEGACY_TOMBSTONE_PAIR_INVALID");
    }
    const { planDigestSha256, ...unsigned } = plan;
    if (canonicalSha256(unsigned) !== planDigestSha256) {
      throw new Error("LEGACY_MIGRATION_PLAN_DIGEST_MISMATCH");
    }
  }
}

function isDesiredTombstonePair(pair: LegacyTombstonePairPlan, state: LegacyTombstonePairState) {
  return state.originalKey === pair.original.targetReference && state.trashKey === pair.trash.targetReference &&
    state.provider === "supabase" && state.status === pair.original.expectedOldStatus;
}

function isOriginalTombstonePair(pair: LegacyTombstonePairPlan, state: LegacyTombstonePairState) {
  return state.originalKey === pair.original.expectedOldValue && state.trashKey === pair.trash.expectedOldValue &&
    state.provider === pair.original.expectedOldProvider && state.status === pair.original.expectedOldStatus;
}

export function createBoundLegacyMigrationAdapter(input: {
  projectRef: string;
  supabaseOrigin: string;
  bucket: string;
  targetSha256: string;
  confirmTargetSha256: string;
  storageCredentialReference: string;
  approvedLocalRoots: string[];
  io: {
    readSourceBody(plan: LegacyMigrationPlan): Promise<Uint8Array>;
    readTargetBody(plan: LegacyMigrationPlan): Promise<Uint8Array | null>;
    putTargetNoOverwrite(plan: LegacyMigrationPlan, body: Uint8Array): Promise<void>;
    compareAndSwapReference(plan: LegacyMigrationPlan): Promise<boolean>;
    readReference(plan: LegacyMigrationPlan): Promise<{ value: string | null; provider?: string; status: string }>;
  };
}): LegacyMigrationAdapter {
  if (!/^[a-z]{20}$/.test(input.projectRef) || input.supabaseOrigin !== `https://${input.projectRef}.supabase.co` ||
      !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.bucket) || !/^[0-9a-f]{64}$/.test(input.targetSha256) ||
      input.targetSha256 !== input.confirmTargetSha256 || !input.storageCredentialReference || !input.io) {
    throw new Error("LEGACY_PROVIDER_BINDING_REQUIRED");
  }
  const roots = normalizeRoots(input.approvedLocalRoots);
  const inspect = async (plan: LegacyMigrationPlan) => {
    assertPlanBinding(plan, roots);
    const body = await input.io.readTargetBody(plan);
    return body === null ? { state: "MISSING" as const } : { state: "FOUND" as const, ...actualBody(body) };
  };
  return {
    inspectTarget: inspect,
    copyNoOverwrite: async (plan) => {
      assertPlanBinding(plan, roots);
      const source = await input.io.readSourceBody(plan);
      const metadata = actualBody(source);
      assertTargetMatches(plan, metadata);
      if (await input.io.readTargetBody(plan) !== null) throw new Error("LEGACY_MIGRATION_TARGET_COLLISION");
      await input.io.putTargetNoOverwrite(plan, source);
      const copied = await input.io.readTargetBody(plan);
      if (copied === null) throw new Error("LEGACY_MIGRATION_TARGET_ACK_MISSING");
      const copiedMetadata = actualBody(copied);
      assertTargetMatches(plan, copiedMetadata);
      return copiedMetadata;
    },
    compareAndSwapReference: input.io.compareAndSwapReference,
    readReference: input.io.readReference
  };
}

export function legacyInventoryPublicEvidence(inventory: ReferenceInventory) {
  return {
    event: "legacy-reference-inventory",
    contractVersion: inventory.contractVersion,
    counts: inventory.counts,
    total: inventory.total,
    unstableCount: inventory.unstableCount,
    orphanCount: inventory.orphanCount,
    migrationCandidateCount: inventory.migrationCandidateCount,
    inventoryDigestSha256: inventory.inventoryDigestSha256,
    sourcePathsIncluded: false,
    result: "NOT_RUN" as const
  };
}

function classify(candidate: ReferenceCandidate, roots: string[]): Pick<InventoriedReference, "category" | "normalizedProvider" | "normalizedKey"> {
  if (candidate.value === null) return { category: "NULL", normalizedProvider: null, normalizedKey: null };
  const value = candidate.value;
  if (!value || value.length > 4_096 || value.includes("\0")) return invalid();
  const tagged = /^([a-z][a-z0-9-]{0,31}):(.+)$/.exec(value);
  if (tagged) {
    if (!safeRelativeKey(tagged[2])) return invalid();
    if (candidate.declaredProvider && candidate.declaredProvider !== tagged[1]) {
      return { category: "MIXED", normalizedProvider: tagged[1], normalizedKey: tagged[2] };
    }
    if (tagged[1] === "supabase") return { category: "SUPABASE", normalizedProvider: "supabase", normalizedKey: tagged[2] };
    if (tagged[1] === "local") return withBoundRoot(candidate, roots, tagged[2], "LOCAL_TAGGED");
    return { category: "MIXED", normalizedProvider: tagged[1], normalizedKey: tagged[2] };
  }
  if (candidate.declaredProvider === "supabase") {
    return safeRelativeKey(value)
      ? { category: "SUPABASE", normalizedProvider: "supabase", normalizedKey: value }
      : invalid();
  }
  if (candidate.declaredProvider && candidate.declaredProvider !== "local") {
    return { category: "MIXED", normalizedProvider: candidate.declaredProvider, normalizedKey: safeRelativeKey(value) ? value : null };
  }
  if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    const root = boundRoot(candidate.sourceRoot, roots);
    if (!root || !pathContained(root, value)) return invalid();
    const relative = path.relative(root, path.resolve(value)).split(path.sep).join("/");
    return safeRelativeKey(relative)
      ? { category: "ABSOLUTE_CONTAINED", normalizedProvider: "local", normalizedKey: relative }
      : invalid();
  }
  return withBoundRoot(candidate, roots, value, "UNTAGGED_CONTAINED");
}

function withBoundRoot(
  candidate: ReferenceCandidate,
  roots: string[],
  key: string,
  category: "LOCAL_TAGGED" | "UNTAGGED_CONTAINED"
) {
  if (!boundRoot(candidate.sourceRoot, roots) || !safeRelativeKey(key)) return invalid();
  return { category, normalizedProvider: "local", normalizedKey: key } as const;
}

function boundRoot(candidateRoot: string | undefined, roots: string[]) {
  if (!candidateRoot) return null;
  const resolved = path.resolve(candidateRoot);
  return roots.includes(resolved) ? resolved : null;
}

function pathContained(root: string, candidate: string) {
  const relative = path.relative(root, path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeRelativeKey(value: string) {
  return value.length > 0 && value.length <= 1_024 && !value.includes("\\") && !value.includes(":") &&
    !value.startsWith("/") && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function normalizeRoots(roots: string[]) {
  const normalized = [...new Set(roots.map((root) => path.resolve(root)))];
  if (normalized.some((root) => !path.isAbsolute(root))) throw new Error("LEGACY_ROOT_INVALID");
  return normalized;
}

function validateCandidate(candidate: ReferenceCandidate) {
  const allowed = new Set([
    "model", "recordId", "field", "value", "declaredProvider", "sourceRoot", "status",
    "expectedHashSha256", "expectedByteSize", "observation"
  ]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) throw new Error("LEGACY_REFERENCE_FIELDS_INVALID");
  if (!REFERENCE_MODELS.includes(candidate.model) || !isUuid(candidate.recordId)) throw new Error("LEGACY_REFERENCE_IDENTITY_INVALID");
  if (!candidate.status || candidate.status.length > 64) throw new Error("LEGACY_REFERENCE_STATUS_INVALID");
  if (!candidate.field || !["storedFilePath", "filePath", "originalKey", "trashKey"].includes(candidate.field)) {
    throw new Error("LEGACY_REFERENCE_FIELD_INVALID");
  }
  if (candidate.expectedHashSha256) assertHash(candidate.expectedHashSha256, "LEGACY_REFERENCE_HASH_INVALID");
  if (candidate.expectedByteSize !== undefined && (!Number.isSafeInteger(candidate.expectedByteSize) || candidate.expectedByteSize < 0)) {
    throw new Error("LEGACY_REFERENCE_SIZE_INVALID");
  }
}

function isStable(model: ReferenceModel, status: string) {
  if (model === "StorageTombstone") return !["PENDING"].includes(status);
  if (model === "ReportExport") return !["PENDING", "CREATING"].includes(status);
  return !["PENDING", "VALIDATING"].includes(status);
}

function assertTargetMatches(plan: LegacyMigrationPlan, value: { hashSha256: string; byteSize: number }) {
  if (value.hashSha256 !== plan.sourceHashSha256 || value.byteSize !== plan.sourceByteSize) {
    throw new Error("LEGACY_MIGRATION_TARGET_COLLISION");
  }
}

function assertPlanBinding(plan: LegacyMigrationPlan, roots: string[]) {
  if (!roots.includes(path.resolve(plan.sourceRoot)) || !safeRelativeKey(plan.sourceKey) || !safeRelativeKey(plan.targetKey) ||
    !Number.isSafeInteger(plan.sourceByteSize) || plan.sourceByteSize < 0 ||
    plan.sourceByteSize > MAX_LEGACY_SOURCE_BYTES) {
    throw new Error("LEGACY_MIGRATION_PLAN_SCOPE_INVALID");
  }
  const { planDigestSha256, ...unsigned } = plan;
  if (canonicalSha256(unsigned) !== planDigestSha256) throw new Error("LEGACY_MIGRATION_PLAN_DIGEST_MISMATCH");
}

function actualBody(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_LEGACY_SOURCE_BYTES) {
    throw new Error("LEGACY_MIGRATION_BODY_INVALID");
  }
  return { byteSize: value.byteLength, hashSha256: createHash("sha256").update(value).digest("hex") };
}

function isDesiredReference(plan: LegacyMigrationPlan, value: { value: string | null; provider?: string; status: string }) {
  return value.value === plan.targetReference && value.status === plan.expectedOldStatus &&
    (plan.model !== "StorageTombstone" || value.provider === plan.targetProvider);
}

function invalid() {
  return { category: "INVALID" as const, normalizedProvider: null, normalizedKey: null };
}

function assertHash(value: string, code: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(code);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
