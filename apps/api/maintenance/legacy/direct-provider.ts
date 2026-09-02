import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  asIsoTimestamp,
  asRecord,
  asSafeInteger,
  asStrictString,
  assertExactKeys,
  canonicalSha256,
  sha256Hex
} from "../shared/strict-json";
import {
  assertTargetConfirmation,
  parseCloudTargetBinding,
  targetBindingSha256,
  type CloudTargetBinding
} from "../shared/target-binding";
import {
  createBoundLegacyMigrationAdapter,
  MAX_LEGACY_SOURCE_BYTES,
  pairLegacyTombstonePlans,
  type LegacyManifestApplyAdapter,
  type LegacyManifestRollbackAdapter,
  type LegacyMigrationAdapter,
  type LegacyMigrationPlan,
  type LegacyRollbackAdapter,
  type LegacyTombstonePairAdapter,
  type LegacyTombstonePairPlan,
  type LegacyTombstonePairRollbackAdapter,
  type LegacyTombstonePairState,
  type ReferenceField,
  type ReferenceModel
} from "./reference-inventory";

export type ApprovedSourceRoot = {
  rootId: string;
  rootPath: string;
  fileCount: number;
  totalBytes: number;
  manifestSha256: string;
};

export type LegacySourceInventoryApproval = {
  version: "legacy-source-inventory-approval/v1";
  projectRef: string;
  releaseGitSha: string;
  targetSha256: string;
  referenceInventoryDigestSha256: string;
  executionPlanDigestSha256: string;
  driftDisposition: "APPROVED_CURRENT_INVENTORY";
  issuedAt: string;
  expiresAt: string;
  roots: ApprovedSourceRoot[];
  approvalSha256: string;
};

export type LegacyProviderBinding = {
  version: "legacy-provider-binding/v1";
  projectRef: string;
  releaseGitSha: string;
  targetSha256: string;
  database: CloudTargetBinding["database"];
  supabaseOrigin: string;
  bucket: string;
  bucketVisibility: "private";
  storageTokenScope: "LEGACY_PRIVATE_OBJECT_READ_WRITE_NO_DELETE";
  storageTokenSha256: string;
  approvedSourceRoots: Array<{ rootId: string; rootPath: string }>;
  sourceInventoryApprovalSha256: string;
  referenceInventoryDigestSha256: string;
  executionPlanDigestSha256: string;
  issuedAt: string;
  expiresAt: string;
  providerBindingSha256: string;
};

export type LegacySourceFs = {
  lstat: typeof lstat;
  realpath: typeof realpath;
  readdir: typeof readdir;
  open: typeof open;
};

type PrismaModule = {
  PrismaClient: new (input: { datasourceUrl: string }) => PrismaClientLike;
  Prisma: { sql: (parts: TemplateStringsArray, ...values: unknown[]) => unknown };
};

type Delegate = {
  findUnique(input: unknown): Promise<any>;
  updateMany(input: unknown): Promise<{ count: number }>;
};

type PrismaClientLike = {
  uploadBatch: Delegate;
  cafe24UploadBatch: Delegate;
  coupangUploadBatch: Delegate;
  reportExport: Delegate;
  storageTombstone: Delegate;
  $queryRaw<T>(query: unknown): Promise<T>;
  $transaction<T>(callback: (transaction: PrismaClientLike) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
};

type ReferenceState = { value: string | null; provider?: string; status: string };

export type LegacyDirectFactories = {
  loadPrismaModule(): unknown;
  fetch(input: string, init: RequestInit): Promise<Response>;
  fs: LegacySourceFs;
};

export type LegacyDirectContext = {
  adapter: LegacyMigrationAdapter;
  rollbackAdapter: LegacyRollbackAdapter;
  tombstonePairAdapter: LegacyTombstonePairAdapter;
  tombstonePairRollbackAdapter: LegacyTombstonePairRollbackAdapter;
  manifestAdapter: LegacyManifestApplyAdapter;
  manifestRollbackAdapter: LegacyManifestRollbackAdapter;
  close(): Promise<void>;
};

export function parseLegacySourceInventoryApproval(input: {
  value: unknown;
  target: CloudTargetBinding;
  referenceInventoryDigestSha256: string;
  executionPlanDigestSha256: string;
  confirmApprovalSha256: string;
  now?: Date;
}): LegacySourceInventoryApproval {
  const value = asRecord(input.value, "LEGACY_SOURCE_APPROVAL_OBJECT_REQUIRED");
  assertExactKeys(value, [
    "version", "projectRef", "releaseGitSha", "targetSha256", "referenceInventoryDigestSha256",
    "executionPlanDigestSha256", "driftDisposition", "issuedAt", "expiresAt", "roots", "approvalSha256"
  ], "LEGACY_SOURCE_APPROVAL_KEYS_INVALID");
  if (value.version !== "legacy-source-inventory-approval/v1") throw new Error("LEGACY_SOURCE_APPROVAL_VERSION_INVALID");
  if (value.driftDisposition !== "APPROVED_CURRENT_INVENTORY") {
    throw new Error("LEGACY_SOURCE_DRIFT_NOT_APPROVED");
  }
  const target = parseCloudTargetBinding(input.target, input.now ?? new Date());
  const roots = parseApprovedRoots(value.roots);
  const approval = {
    version: value.version,
    projectRef: asStrictString(value.projectRef, "LEGACY_SOURCE_PROJECT_INVALID", /^[a-z]{20}$/u, 20),
    releaseGitSha: asGitSha(value.releaseGitSha, "LEGACY_SOURCE_RELEASE_INVALID"),
    targetSha256: asHash(value.targetSha256, "LEGACY_SOURCE_TARGET_INVALID"),
    referenceInventoryDigestSha256: asHash(
      value.referenceInventoryDigestSha256,
      "LEGACY_SOURCE_REFERENCE_INVENTORY_INVALID"
    ),
    executionPlanDigestSha256: asHash(value.executionPlanDigestSha256, "LEGACY_SOURCE_PLAN_INVALID"),
    driftDisposition: value.driftDisposition,
    issuedAt: asIsoTimestamp(value.issuedAt, "LEGACY_SOURCE_ISSUED_AT_INVALID"),
    expiresAt: asIsoTimestamp(value.expiresAt, "LEGACY_SOURCE_EXPIRES_AT_INVALID"),
    roots,
    approvalSha256: asHash(value.approvalSha256, "LEGACY_SOURCE_APPROVAL_SHA_INVALID")
  } satisfies LegacySourceInventoryApproval;
  assertApprovalWindow(approval.issuedAt, approval.expiresAt, input.now ?? new Date(), "LEGACY_SOURCE_APPROVAL");
  const { approvalSha256, ...unsigned } = approval;
  if (canonicalSha256(unsigned) !== approvalSha256 || input.confirmApprovalSha256 !== approvalSha256) {
    throw new Error("LEGACY_SOURCE_APPROVAL_CONFIRMATION_MISMATCH");
  }
  assertTargetConfirmation(target, {
    projectRef: approval.projectRef,
    releaseGitSha: approval.releaseGitSha,
    targetSha256: approval.targetSha256
  });
  if (approval.referenceInventoryDigestSha256 !== input.referenceInventoryDigestSha256 ||
    approval.executionPlanDigestSha256 !== input.executionPlanDigestSha256) {
    throw new Error("LEGACY_SOURCE_APPROVAL_BINDING_MISMATCH");
  }
  return approval;
}

export function buildLegacySourceInventoryApproval(
  input: Omit<LegacySourceInventoryApproval, "version" | "approvalSha256" | "driftDisposition">
): LegacySourceInventoryApproval {
  const unsigned = {
    version: "legacy-source-inventory-approval/v1" as const,
    ...input,
    driftDisposition: "APPROVED_CURRENT_INVENTORY" as const
  };
  return { ...unsigned, approvalSha256: canonicalSha256(unsigned) };
}

export function parseLegacyProviderBinding(input: {
  value: unknown;
  target: CloudTargetBinding;
  sourceApproval: LegacySourceInventoryApproval;
  referenceInventoryDigestSha256: string;
  executionPlanDigestSha256: string;
  confirmProviderBindingSha256: string;
  now?: Date;
}): LegacyProviderBinding {
  const value = asRecord(input.value, "LEGACY_PROVIDER_BINDING_OBJECT_REQUIRED");
  assertExactKeys(value, [
    "version", "projectRef", "releaseGitSha", "targetSha256", "database", "supabaseOrigin", "bucket",
    "bucketVisibility", "storageTokenScope", "storageTokenSha256", "approvedSourceRoots", "sourceInventoryApprovalSha256",
    "referenceInventoryDigestSha256", "executionPlanDigestSha256", "issuedAt", "expiresAt",
    "providerBindingSha256"
  ], "LEGACY_PROVIDER_BINDING_KEYS_INVALID");
  if (value.version !== "legacy-provider-binding/v1") throw new Error("LEGACY_PROVIDER_BINDING_VERSION_INVALID");
  if (value.bucketVisibility !== "private") throw new Error("LEGACY_PROVIDER_BUCKET_NOT_PRIVATE");
  if (value.storageTokenScope !== "LEGACY_PRIVATE_OBJECT_READ_WRITE_NO_DELETE") {
    throw new Error("LEGACY_PROVIDER_TOKEN_SCOPE_INVALID");
  }
  const target = parseCloudTargetBinding(input.target, input.now ?? new Date());
  const database = parseBoundDatabase(value.database);
  const approvedSourceRoots = parseBoundRootIdentities(value.approvedSourceRoots);
  const binding = {
    version: value.version,
    projectRef: asStrictString(value.projectRef, "LEGACY_PROVIDER_PROJECT_INVALID", /^[a-z]{20}$/u, 20),
    releaseGitSha: asGitSha(value.releaseGitSha, "LEGACY_PROVIDER_RELEASE_INVALID"),
    targetSha256: asHash(value.targetSha256, "LEGACY_PROVIDER_TARGET_INVALID"),
    database,
    supabaseOrigin: asStrictString(value.supabaseOrigin, "LEGACY_PROVIDER_ORIGIN_INVALID", undefined, 256),
    bucket: asStrictString(value.bucket, "LEGACY_PROVIDER_BUCKET_INVALID", /^[a-z0-9][a-z0-9._-]{0,62}$/u, 63),
    bucketVisibility: value.bucketVisibility,
    storageTokenScope: value.storageTokenScope,
    storageTokenSha256: asHash(value.storageTokenSha256, "LEGACY_PROVIDER_TOKEN_DIGEST_INVALID"),
    approvedSourceRoots,
    sourceInventoryApprovalSha256: asHash(
      value.sourceInventoryApprovalSha256,
      "LEGACY_PROVIDER_SOURCE_APPROVAL_INVALID"
    ),
    referenceInventoryDigestSha256: asHash(
      value.referenceInventoryDigestSha256,
      "LEGACY_PROVIDER_REFERENCE_INVENTORY_INVALID"
    ),
    executionPlanDigestSha256: asHash(value.executionPlanDigestSha256, "LEGACY_PROVIDER_PLAN_INVALID"),
    issuedAt: asIsoTimestamp(value.issuedAt, "LEGACY_PROVIDER_ISSUED_AT_INVALID"),
    expiresAt: asIsoTimestamp(value.expiresAt, "LEGACY_PROVIDER_EXPIRES_AT_INVALID"),
    providerBindingSha256: asHash(value.providerBindingSha256, "LEGACY_PROVIDER_BINDING_SHA_INVALID")
  } satisfies LegacyProviderBinding;
  assertApprovalWindow(binding.issuedAt, binding.expiresAt, input.now ?? new Date(), "LEGACY_PROVIDER_BINDING");
  const { providerBindingSha256, ...unsigned } = binding;
  if (canonicalSha256(unsigned) !== providerBindingSha256 ||
    input.confirmProviderBindingSha256 !== providerBindingSha256) {
    throw new Error("LEGACY_PROVIDER_CONFIRMATION_MISMATCH");
  }
  assertTargetConfirmation(target, {
    projectRef: binding.projectRef,
    releaseGitSha: binding.releaseGitSha,
    targetSha256: binding.targetSha256
  });
  if (canonicalSha256(database) !== canonicalSha256(target.database) ||
    binding.supabaseOrigin !== target.supabaseOrigin ||
    binding.sourceInventoryApprovalSha256 !== input.sourceApproval.approvalSha256 ||
    binding.referenceInventoryDigestSha256 !== input.referenceInventoryDigestSha256 ||
    binding.executionPlanDigestSha256 !== input.executionPlanDigestSha256 ||
    canonicalSha256(binding.approvedSourceRoots) !== canonicalSha256(
      input.sourceApproval.roots.map(({ rootId, rootPath }) => ({ rootId, rootPath }))
    )) {
    throw new Error("LEGACY_PROVIDER_BINDING_MISMATCH");
  }
  return binding;
}

export function buildLegacyProviderBinding(
  input: Omit<LegacyProviderBinding, "version" | "providerBindingSha256">
): LegacyProviderBinding {
  const unsigned = { version: "legacy-provider-binding/v1" as const, ...input };
  return { ...unsigned, providerBindingSha256: canonicalSha256(unsigned) };
}

export async function createDirectLegacyContext(input: {
  target: CloudTargetBinding;
  sourceApproval: LegacySourceInventoryApproval;
  providerBinding: LegacyProviderBinding;
  env: NodeJS.ProcessEnv;
  factories?: Partial<LegacyDirectFactories>;
  now?: Date;
}): Promise<LegacyDirectContext> {
  const now = input.now ?? new Date();
  const target = parseCloudTargetBinding(input.target, now);
  const factories = completeFactories(input.factories);
  const databaseUrl = requireCredential(input.env.DATABASE_URL, "LEGACY_DATABASE_CREDENTIAL_REQUIRED");
  const storageToken = requireCredential(input.env.STORAGE_ACCESS_TOKEN, "LEGACY_STORAGE_CREDENTIAL_REQUIRED");
  assertDatabaseUrl(databaseUrl, target);
  if (sha256Hex(storageToken) !== input.providerBinding.storageTokenSha256) {
    throw new Error("LEGACY_STORAGE_TOKEN_BINDING_MISMATCH");
  }
  if (input.providerBinding.supabaseOrigin !== target.supabaseOrigin ||
    input.providerBinding.projectRef !== target.projectRef || input.providerBinding.bucketVisibility !== "private") {
    throw new Error("LEGACY_PROVIDER_BINDING_MISMATCH");
  }

  const source = createSafeLegacySourceReader(input.sourceApproval, factories.fs);
  await source.verifyApprovedInventory();

  const prismaModule = loadPrismaModule(factories.loadPrismaModule);
  const prisma = new prismaModule.PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await assertDatabaseIdentity(prisma, prismaModule.Prisma, target);
    const referenceIo = createPrismaLegacyReferenceIo(prisma);
    const storage = createSupabaseLegacyStorage({
      origin: input.providerBinding.supabaseOrigin,
      bucket: input.providerBinding.bucket,
      token: storageToken,
      fetchImpl: factories.fetch
    });
    const adapter = createBoundLegacyMigrationAdapter({
      projectRef: target.projectRef,
      supabaseOrigin: target.supabaseOrigin,
      bucket: input.providerBinding.bucket,
      targetSha256: targetBindingSha256(target),
      confirmTargetSha256: input.providerBinding.targetSha256,
      storageCredentialReference: input.providerBinding.storageTokenSha256,
      approvedLocalRoots: input.sourceApproval.roots.map((root) => root.rootPath),
      io: {
        readSourceBody: source.readSourceBody,
        readTargetBody: storage.readTargetBody,
        putTargetNoOverwrite: storage.putTargetNoOverwrite,
        compareAndSwapReference: referenceIo.compareAndSwapReference,
        readReference: referenceIo.readReference
      }
    });
    const rollbackAdapter: LegacyRollbackAdapter = {
      inspectSource: source.inspectSource,
      readReference: referenceIo.readReference,
      compareAndSwapReferenceBack: referenceIo.compareAndSwapReferenceBack
    };
    const tombstonePairAdapter: LegacyTombstonePairAdapter = {
      inspectTarget: adapter.inspectTarget,
      copyNoOverwrite: adapter.copyNoOverwrite,
      readTombstonePair: referenceIo.readTombstonePair,
      compareAndSwapTombstonePair: referenceIo.compareAndSwapTombstonePair
    };
    const tombstonePairRollbackAdapter: LegacyTombstonePairRollbackAdapter = {
      inspectSource: source.inspectSource,
      readTombstonePair: referenceIo.readTombstonePair,
      compareAndSwapTombstonePairBack: referenceIo.compareAndSwapTombstonePairBack
    };
    const manifestAdapter: LegacyManifestApplyAdapter = {
      inspectTarget: adapter.inspectTarget,
      copyNoOverwrite: adapter.copyNoOverwrite,
      compareAndSwapManifest: referenceIo.compareAndSwapManifest
    };
    const manifestRollbackAdapter: LegacyManifestRollbackAdapter = {
      inspectSource: source.inspectSource,
      compareAndSwapManifestBack: referenceIo.compareAndSwapManifestBack
    };
    return {
      adapter,
      rollbackAdapter,
      tombstonePairAdapter,
      tombstonePairRollbackAdapter,
      manifestAdapter,
      manifestRollbackAdapter,
      close: () => prisma.$disconnect()
    };
  } catch (failure) {
    await prisma.$disconnect();
    throw failure;
  }
}

export function createSafeLegacySourceReader(approval: LegacySourceInventoryApproval, fs: LegacySourceFs) {
  const roots = new Map(approval.roots.map((root) => [path.resolve(root.rootPath), root]));
  const readSourceBody = async (plan: LegacyMigrationPlan): Promise<Uint8Array> => {
    const root = roots.get(path.resolve(plan.sourceRoot));
    if (!root || !safeRelativeKey(plan.sourceKey)) throw new Error("LEGACY_SOURCE_PLAN_SCOPE_INVALID");
    const body = await readContainedFile(root.rootPath, plan.sourceKey, fs);
    const metadata = bodyMetadata(body);
    if (metadata.hashSha256 !== plan.sourceHashSha256 || metadata.byteSize !== plan.sourceByteSize) {
      throw new Error("LEGACY_MIGRATION_SOURCE_MISMATCH");
    }
    return body;
  };
  return {
    async verifyApprovedInventory() {
      for (const root of approval.roots) {
        const entries = await inventoryRoot(root.rootPath, fs);
        const totalBytes = entries.reduce((sum, entry) => sum + entry.byteSize, 0);
        if (entries.length !== root.fileCount || totalBytes !== root.totalBytes ||
          canonicalSha256(entries) !== root.manifestSha256) {
          throw new Error("LEGACY_SOURCE_INVENTORY_DRIFT");
        }
      }
    },
    readSourceBody,
    async inspectSource(plan: LegacyMigrationPlan) {
      return bodyMetadata(await readSourceBody(plan));
    }
  };
}

export function createPrismaLegacyReferenceIo(client: PrismaClientLike) {
  return {
    readReference: (plan: LegacyMigrationPlan) => readReference(client, plan),
    compareAndSwapReference: (plan: LegacyMigrationPlan) => casReference(client, plan, false),
    compareAndSwapReferenceBack: (plan: LegacyMigrationPlan) => casReference(client, plan, true),
    readTombstonePair: (pair: LegacyTombstonePairPlan) => readTombstonePair(client, pair),
    compareAndSwapTombstonePair: (pair: LegacyTombstonePairPlan) => casTombstonePair(client, pair, false),
    compareAndSwapTombstonePairBack: (pair: LegacyTombstonePairPlan) => casTombstonePair(client, pair, true),
    compareAndSwapManifest: (plans: LegacyMigrationPlan[]) => casManifest(client, plans, false),
    compareAndSwapManifestBack: (plans: LegacyMigrationPlan[]) => casManifest(client, plans, true)
  };
}

function createSupabaseLegacyStorage(input: {
  origin: string;
  bucket: string;
  token: string;
  fetchImpl(input: string, init: RequestInit): Promise<Response>;
}) {
  const request = async (plan: LegacyMigrationPlan, init: RequestInit) => input.fetchImpl(
    `${input.origin}/storage/v1/object/${encodeURIComponent(input.bucket)}/${encodeStorageKey(plan.targetKey)}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${input.token}`,
        ...init.headers
      }
    }
  );
  return {
    async readTargetBody(plan: LegacyMigrationPlan): Promise<Uint8Array | null> {
      const response = await request(plan, { method: "GET", redirect: "error" });
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error("LEGACY_STORAGE_READ_FAILED");
      return readBoundedStorageBody(response);
    },
    async putTargetNoOverwrite(plan: LegacyMigrationPlan, body: Uint8Array): Promise<void> {
      if (body.byteLength > MAX_LEGACY_SOURCE_BYTES || body.byteLength !== plan.sourceByteSize) {
        throw new Error("LEGACY_STORAGE_BODY_TOO_LARGE");
      }
      const response = await request(plan, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/octet-stream", "x-upsert": "false" },
        body: body as unknown as BodyInit
      });
      if (response.status !== 200 && response.status !== 201) {
        if (response.status === 409) throw new Error("LEGACY_MIGRATION_TARGET_COLLISION");
        throw new Error("LEGACY_STORAGE_WRITE_FAILED");
      }
    }
  };
}

async function readBoundedStorageBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_LEGACY_SOURCE_BYTES) {
      throw new Error("LEGACY_STORAGE_BODY_TOO_LARGE");
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_LEGACY_SOURCE_BYTES) throw new Error("LEGACY_STORAGE_BODY_TOO_LARGE");
      chunks.push(next.value);
    }
  } catch (failure) {
    await reader.cancel().catch(() => undefined);
    throw failure;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readTombstonePair(
  client: PrismaClientLike,
  pair: LegacyTombstonePairPlan
): Promise<LegacyTombstonePairState> {
  assertTombstonePairModelFields(pair);
  const row = await client.storageTombstone.findUnique({
    where: { id: pair.original.recordId },
    select: { originalKey: true, trashKey: true, provider: true, state: true }
  });
  if (!row || typeof row.originalKey !== "string" || typeof row.trashKey !== "string" ||
    typeof row.provider !== "string") throw new Error("LEGACY_REFERENCE_ROW_MISSING");
  return {
    originalKey: row.originalKey,
    trashKey: row.trashKey,
    provider: row.provider,
    status: String(row.state)
  };
}

async function casTombstonePair(client: PrismaClientLike, pair: LegacyTombstonePairPlan, rollback: boolean) {
  assertTombstonePairModelFields(pair);
  const before = rollback
    ? {
        originalKey: pair.original.targetReference,
        trashKey: pair.trash.targetReference,
        provider: "supabase",
        status: pair.original.expectedOldStatus
      }
    : {
        originalKey: pair.original.expectedOldValue,
        trashKey: pair.trash.expectedOldValue,
        provider: pair.original.expectedOldProvider!,
        status: pair.original.expectedOldStatus
      };
  const after = rollback
    ? {
        originalKey: pair.original.expectedOldValue,
        trashKey: pair.trash.expectedOldValue,
        provider: pair.original.expectedOldProvider!,
        status: pair.original.expectedOldStatus
      }
    : {
        originalKey: pair.original.targetReference,
        trashKey: pair.trash.targetReference,
        provider: "supabase",
        status: pair.original.expectedOldStatus
      };
  return client.$transaction(async (tx) => {
    const current = await readTombstonePair(tx, pair);
    if (!sameTombstonePairState(current, before)) return false;
    const update = await tx.storageTombstone.updateMany({
      where: {
        id: pair.original.recordId,
        originalKey: before.originalKey,
        trashKey: before.trashKey,
        provider: before.provider,
        state: before.status
      },
      data: {
        originalKey: after.originalKey,
        trashKey: after.trashKey,
        provider: after.provider,
        state: after.status
      }
    });
    if (update.count !== 1) return false;
    const verified = await readTombstonePair(tx, pair);
    if (!sameTombstonePairState(verified, after)) throw new Error("LEGACY_REFERENCE_CAS_VERIFY_FAILED");
    return true;
  });
}

function assertTombstonePairModelFields(pair: LegacyTombstonePairPlan) {
  if (pair.original.model !== "StorageTombstone" || pair.original.field !== "originalKey" ||
    pair.trash.model !== "StorageTombstone" || pair.trash.field !== "trashKey" ||
    pair.original.recordId !== pair.trash.recordId || !pair.original.expectedOldProvider ||
    pair.original.expectedOldProvider !== pair.trash.expectedOldProvider ||
    pair.original.expectedOldStatus !== pair.trash.expectedOldStatus) {
    throw new Error("LEGACY_TOMBSTONE_PAIR_INCOMPLETE");
  }
}

function sameTombstonePairState(left: LegacyTombstonePairState, right: LegacyTombstonePairState) {
  return left.originalKey === right.originalKey && left.trashKey === right.trashKey &&
    left.provider === right.provider && left.status === right.status;
}

type LegacyManifestSnapshot = {
  ordinary: Array<{ plan: LegacyMigrationPlan; state: ReferenceState }>;
  tombstones: Array<{ pair: LegacyTombstonePairPlan; state: LegacyTombstonePairState }>;
};

async function casManifest(
  client: PrismaClientLike,
  plans: LegacyMigrationPlan[],
  rollback: false
): Promise<"UPDATED" | "ALREADY_DESIRED">;
async function casManifest(
  client: PrismaClientLike,
  plans: LegacyMigrationPlan[],
  rollback: true
): Promise<"UPDATED" | "ALREADY_ORIGINAL">;
async function casManifest(
  client: PrismaClientLike,
  plans: LegacyMigrationPlan[],
  rollback: boolean
): Promise<"UPDATED" | "ALREADY_DESIRED" | "ALREADY_ORIGINAL"> {
  if (plans.length < 1) throw new Error("LEGACY_MIGRATION_PLANS_REQUIRED");
  const identities = new Set(plans.map((plan) => `${plan.model}|${plan.recordId}|${plan.field}`));
  if (identities.size !== plans.length) throw new Error("LEGACY_MIGRATION_PLAN_DUPLICATE");
  pairLegacyTombstonePlans(plans);
  return client.$transaction(async (tx) => {
    const before = await readManifestSnapshot(tx, plans);
    const allDesired = manifestSnapshotMatches(before, true);
    const allOriginal = manifestSnapshotMatches(before, false);
    if (rollback) {
      if (allOriginal) return "ALREADY_ORIGINAL";
      if (!allDesired) throw new Error("LEGACY_MANIFEST_DB_MIXED_STATE");
    } else {
      if (allDesired) return "ALREADY_DESIRED";
      if (!allOriginal) throw new Error("LEGACY_MANIFEST_DB_MIXED_STATE");
    }

    for (const { plan } of before.ordinary) {
      if (!await updateRegularReferenceExact(tx, plan, rollback)) throw new Error("LEGACY_MIGRATION_CAS_MISS");
    }
    for (const { pair } of before.tombstones) {
      if (!await updateTombstonePairExact(tx, pair, rollback)) throw new Error("LEGACY_MIGRATION_CAS_MISS");
    }
    const verified = await readManifestSnapshot(tx, plans);
    if (!manifestSnapshotMatches(verified, !rollback)) {
      throw new Error("LEGACY_MANIFEST_DB_VERIFY_FAILED");
    }
    return "UPDATED";
  });
}

async function readManifestSnapshot(
  client: PrismaClientLike,
  plans: LegacyMigrationPlan[]
): Promise<LegacyManifestSnapshot> {
  const ordinaryPlans = plans.filter((plan) => plan.model !== "StorageTombstone");
  const tombstonePairs = pairLegacyTombstonePlans(plans);
  const ordinary: LegacyManifestSnapshot["ordinary"] = [];
  const tombstones: LegacyManifestSnapshot["tombstones"] = [];
  for (const plan of ordinaryPlans) ordinary.push({ plan, state: await readReference(client, plan) });
  for (const pair of tombstonePairs) tombstones.push({ pair, state: await readTombstonePair(client, pair) });
  return { ordinary, tombstones };
}

function manifestSnapshotMatches(snapshot: LegacyManifestSnapshot, desired: boolean) {
  return snapshot.ordinary.every(({ plan, state }) =>
    state.value === (desired ? plan.targetReference : plan.expectedOldValue) &&
    state.status === plan.expectedOldStatus
  ) && snapshot.tombstones.every(({ pair, state }) => sameTombstonePairState(state, desired
    ? {
        originalKey: pair.original.targetReference,
        trashKey: pair.trash.targetReference,
        provider: "supabase",
        status: pair.original.expectedOldStatus
      }
    : {
        originalKey: pair.original.expectedOldValue,
        trashKey: pair.trash.expectedOldValue,
        provider: pair.original.expectedOldProvider!,
        status: pair.original.expectedOldStatus
      }
  ));
}

async function updateRegularReferenceExact(
  client: PrismaClientLike,
  plan: LegacyMigrationPlan,
  rollback: boolean
) {
  assertModelField(plan.model, plan.field);
  if (plan.model === "StorageTombstone") throw new Error("LEGACY_TOMBSTONE_PAIR_REQUIRED");
  const expectedValue = rollback ? plan.targetReference : plan.expectedOldValue;
  const nextValue = rollback ? plan.expectedOldValue : plan.targetReference;
  if (plan.model === "UploadBatch") return (await client.uploadBatch.updateMany({
    where: { id: plan.recordId, storedFilePath: expectedValue, status: plan.expectedOldStatus },
    data: { storedFilePath: nextValue }
  })).count === 1;
  if (plan.model === "Cafe24UploadBatch") return (await client.cafe24UploadBatch.updateMany({
    where: { id: plan.recordId, storedFilePath: expectedValue, status: plan.expectedOldStatus },
    data: { storedFilePath: nextValue }
  })).count === 1;
  if (plan.model === "CoupangUploadBatch") return (await client.coupangUploadBatch.updateMany({
    where: { id: plan.recordId, storedFilePath: expectedValue, status: plan.expectedOldStatus },
    data: { storedFilePath: nextValue }
  })).count === 1;
  return (await client.reportExport.updateMany({
    where: { id: plan.recordId, filePath: expectedValue, status: plan.expectedOldStatus },
    data: { filePath: nextValue }
  })).count === 1;
}

async function updateTombstonePairExact(
  client: PrismaClientLike,
  pair: LegacyTombstonePairPlan,
  rollback: boolean
) {
  assertTombstonePairModelFields(pair);
  const before = rollback
    ? {
        originalKey: pair.original.targetReference,
        trashKey: pair.trash.targetReference,
        provider: "supabase",
        status: pair.original.expectedOldStatus
      }
    : {
        originalKey: pair.original.expectedOldValue,
        trashKey: pair.trash.expectedOldValue,
        provider: pair.original.expectedOldProvider!,
        status: pair.original.expectedOldStatus
      };
  const after = rollback
    ? {
        originalKey: pair.original.expectedOldValue,
        trashKey: pair.trash.expectedOldValue,
        provider: pair.original.expectedOldProvider!,
        status: pair.original.expectedOldStatus
      }
    : {
        originalKey: pair.original.targetReference,
        trashKey: pair.trash.targetReference,
        provider: "supabase",
        status: pair.original.expectedOldStatus
      };
  const update = await client.storageTombstone.updateMany({
    where: {
      id: pair.original.recordId,
      originalKey: before.originalKey,
      trashKey: before.trashKey,
      provider: before.provider,
      state: before.status
    },
    data: {
      originalKey: after.originalKey,
      trashKey: after.trashKey,
      provider: after.provider,
      state: after.status
    }
  });
  return update.count === 1;
}

async function readReference(client: PrismaClientLike, plan: LegacyMigrationPlan): Promise<ReferenceState> {
  assertModelField(plan.model, plan.field);
  if (plan.model === "UploadBatch") return mapRegular(await client.uploadBatch.findUnique({
    where: { id: plan.recordId }, select: { storedFilePath: true, status: true }
  }), "storedFilePath");
  if (plan.model === "Cafe24UploadBatch") return mapRegular(await client.cafe24UploadBatch.findUnique({
    where: { id: plan.recordId }, select: { storedFilePath: true, status: true }
  }), "storedFilePath");
  if (plan.model === "CoupangUploadBatch") return mapRegular(await client.coupangUploadBatch.findUnique({
    where: { id: plan.recordId }, select: { storedFilePath: true, status: true }
  }), "storedFilePath");
  if (plan.model === "ReportExport") return mapRegular(await client.reportExport.findUnique({
    where: { id: plan.recordId }, select: { filePath: true, status: true }
  }), "filePath");
  const row = await client.storageTombstone.findUnique({
    where: { id: plan.recordId }, select: { originalKey: true, trashKey: true, provider: true, state: true }
  });
  if (!row) throw new Error("LEGACY_REFERENCE_ROW_MISSING");
  return {
    value: plan.field === "originalKey" ? row.originalKey : row.trashKey,
    provider: row.provider,
    status: String(row.state)
  };
}

async function casReference(client: PrismaClientLike, plan: LegacyMigrationPlan, rollback: boolean): Promise<boolean> {
  assertModelField(plan.model, plan.field);
  if (plan.model === "StorageTombstone") throw new Error("LEGACY_TOMBSTONE_PAIR_REQUIRED");
  return client.$transaction(async (tx) => {
    const current = await readReference(tx, plan);
    const expectedValue = rollback ? plan.targetReference : plan.expectedOldValue;
    const nextValue = rollback ? plan.expectedOldValue : plan.targetReference;
    const expectedProvider = rollback ? "supabase" : plan.expectedOldProvider;
    const nextProvider = rollback ? plan.expectedOldProvider : "supabase";
    if (current.value !== expectedValue || current.status !== plan.expectedOldStatus ||
      (plan.model === "StorageTombstone" && current.provider !== expectedProvider)) return false;
    let count = 0;
    if (plan.model === "UploadBatch") count = (await tx.uploadBatch.updateMany({
      where: { id: plan.recordId, storedFilePath: expectedValue, status: plan.expectedOldStatus },
      data: { storedFilePath: nextValue }
    })).count;
    else if (plan.model === "Cafe24UploadBatch") count = (await tx.cafe24UploadBatch.updateMany({
      where: { id: plan.recordId, storedFilePath: expectedValue, status: plan.expectedOldStatus },
      data: { storedFilePath: nextValue }
    })).count;
    else if (plan.model === "CoupangUploadBatch") count = (await tx.coupangUploadBatch.updateMany({
      where: { id: plan.recordId, storedFilePath: expectedValue, status: plan.expectedOldStatus },
      data: { storedFilePath: nextValue }
    })).count;
    else if (plan.model === "ReportExport") count = (await tx.reportExport.updateMany({
      where: { id: plan.recordId, filePath: expectedValue, status: plan.expectedOldStatus },
      data: { filePath: nextValue }
    })).count;
    if (count !== 1) return false;
    const after = await readReference(tx, plan);
    if (after.value !== nextValue || after.status !== plan.expectedOldStatus ||
      (plan.model === "StorageTombstone" && after.provider !== nextProvider)) {
      throw new Error("LEGACY_REFERENCE_CAS_VERIFY_FAILED");
    }
    return true;
  });
}

function mapRegular(row: any, field: "storedFilePath" | "filePath"): ReferenceState {
  if (!row) throw new Error("LEGACY_REFERENCE_ROW_MISSING");
  return { value: row[field] ?? null, status: String(row.status) };
}

function assertModelField(model: ReferenceModel, field: ReferenceField) {
  const valid = (model === "UploadBatch" || model === "Cafe24UploadBatch" || model === "CoupangUploadBatch")
    ? field === "storedFilePath"
    : model === "ReportExport"
      ? field === "filePath"
      : model === "StorageTombstone" && (field === "originalKey" || field === "trashKey");
  if (!valid) throw new Error("LEGACY_REFERENCE_MODEL_FIELD_NOT_ALLOWED");
}

async function assertDatabaseIdentity(client: PrismaClientLike, Prisma: PrismaModule["Prisma"], target: CloudTargetBinding) {
  const rows = await client.$queryRaw<Array<{
    current_user: string;
    current_database: string;
    current_schema: string;
    has_required_role: boolean;
  }>>(Prisma.sql`
    SELECT current_user,
           current_database() AS current_database,
           current_schema() AS current_schema,
           pg_has_role(current_user, ${target.database.requiredRole}, 'USAGE') AS has_required_role
  `);
  const row = rows[0];
  if (!row || row.current_user !== target.database.expectedCurrentUser ||
    row.current_database !== target.database.name || row.current_schema !== target.database.schema ||
    row.has_required_role !== true) throw new Error("LEGACY_DATABASE_IDENTITY_MISMATCH");
}

async function inventoryRoot(rootPath: string, fs: LegacySourceFs) {
  const canonicalRoot = await assertRoot(rootPath, fs);
  const files: Array<{ relativePath: string; byteSize: number; hashSha256: string }> = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }) as any[];
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.name || entry.name === "." || entry.name === "..") throw new Error("LEGACY_SOURCE_ENTRY_INVALID");
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("LEGACY_SOURCE_REPARSE_FORBIDDEN");
      if (stat.isDirectory()) await visit(absolute, relative);
      else if (stat.isFile()) {
        const body = await readContainedFile(canonicalRoot, relative, fs);
        files.push({ relativePath: relative, ...bodyMetadata(body) });
      } else throw new Error("LEGACY_SOURCE_ENTRY_INVALID");
    }
  };
  await visit(canonicalRoot, "");
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readContainedFile(rootPath: string, relativeKey: string, fs: LegacySourceFs): Promise<Uint8Array> {
  if (!safeRelativeKey(relativeKey)) throw new Error("LEGACY_SOURCE_PATH_INVALID");
  const root = await assertRoot(rootPath, fs);
  const segments = relativeKey.split("/");
  let candidate = root;
  let finalPathMetadata: Awaited<ReturnType<LegacySourceFs["lstat"]>> | undefined;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    const metadata = await fs.lstat(candidate);
    if (metadata.isSymbolicLink()) throw new Error("LEGACY_SOURCE_REPARSE_FORBIDDEN");
    finalPathMetadata = metadata;
  }
  const resolved = path.resolve(await fs.realpath(candidate));
  if (!pathContained(root, resolved)) throw new Error("LEGACY_SOURCE_PATH_ESCAPE");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await fs.open(candidate, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!finalPathMetadata) throw new Error("LEGACY_SOURCE_FILE_INVALID");
    assertSameFile(finalPathMetadata, before);
    if (!before.isFile() || before.size < 0 || before.size > MAX_LEGACY_SOURCE_BYTES) {
      throw new Error("LEGACY_SOURCE_FILE_INVALID");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertSameFile(before, after);
    if (bytes.byteLength !== before.size) throw new Error("LEGACY_SOURCE_FILE_CHANGED");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertRoot(rootPath: string, fs: LegacySourceFs): Promise<string> {
  if (!path.isAbsolute(rootPath)) throw new Error("LEGACY_SOURCE_ROOT_INVALID");
  const resolved = path.resolve(rootPath);
  const metadata = await fs.lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("LEGACY_SOURCE_ROOT_INVALID");
  const canonical = path.resolve(await fs.realpath(resolved));
  if (canonical !== resolved) throw new Error("LEGACY_SOURCE_ROOT_INVALID");
  return canonical;
}

function assertSameFile(
  before: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number | bigint },
  after: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number | bigint }
) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs) throw new Error("LEGACY_SOURCE_FILE_CHANGED");
}

function bodyMetadata(body: Uint8Array) {
  return { byteSize: body.byteLength, hashSha256: createHash("sha256").update(body).digest("hex") };
}

function safeRelativeKey(value: string) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\\") &&
    !value.includes(":") && !value.startsWith("/") &&
    !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function pathContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function encodeStorageKey(key: string) {
  if (!safeRelativeKey(key)) throw new Error("LEGACY_STORAGE_KEY_INVALID");
  return key.split("/").map(encodeURIComponent).join("/");
}

function completeFactories(input: Partial<LegacyDirectFactories> | undefined): LegacyDirectFactories {
  return {
    loadPrismaModule: input?.loadPrismaModule ?? (() => require("@prisma/client")),
    fetch: input?.fetch ?? ((url, init) => fetch(url, init)),
    fs: input?.fs ?? { lstat, realpath, readdir, open }
  };
}

function loadPrismaModule(loader: () => unknown): PrismaModule {
  let loaded: unknown;
  try {
    loaded = loader();
  } catch {
    throw new Error("LEGACY_PRISMA_MODULE_MISSING");
  }
  const module = asRecord(loaded, "LEGACY_PRISMA_MODULE_INVALID");
  if (typeof module.PrismaClient !== "function" || !asRecord(module.Prisma, "LEGACY_PRISMA_MODULE_INVALID").sql) {
    throw new Error("LEGACY_PRISMA_MODULE_INVALID");
  }
  return module as unknown as PrismaModule;
}

function parseApprovedRoots(value: unknown): ApprovedSourceRoot[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("LEGACY_SOURCE_ROOTS_INVALID");
  const roots = value.map((entry) => {
    const root = asRecord(entry, "LEGACY_SOURCE_ROOT_INVALID");
    assertExactKeys(root, ["rootId", "rootPath", "fileCount", "totalBytes", "manifestSha256"], "LEGACY_SOURCE_ROOT_KEYS_INVALID");
    const rootPath = asStrictString(root.rootPath, "LEGACY_SOURCE_ROOT_PATH_INVALID", undefined, 1024);
    if (!path.isAbsolute(rootPath)) throw new Error("LEGACY_SOURCE_ROOT_PATH_INVALID");
    return {
      rootId: asStrictString(root.rootId, "LEGACY_SOURCE_ROOT_ID_INVALID", /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u, 128),
      rootPath: path.resolve(rootPath),
      fileCount: asSafeInteger(root.fileCount, "LEGACY_SOURCE_FILE_COUNT_INVALID", 0, 1_000_000),
      totalBytes: asSafeInteger(root.totalBytes, "LEGACY_SOURCE_TOTAL_BYTES_INVALID", 0),
      manifestSha256: asHash(root.manifestSha256, "LEGACY_SOURCE_MANIFEST_INVALID")
    };
  });
  if (new Set(roots.map((root) => root.rootId)).size !== roots.length ||
    new Set(roots.map((root) => root.rootPath)).size !== roots.length) throw new Error("LEGACY_SOURCE_ROOT_DUPLICATE");
  return roots.sort((left, right) => left.rootId.localeCompare(right.rootId));
}

function parseBoundRootIdentities(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("LEGACY_PROVIDER_ROOTS_INVALID");
  return value.map((entry) => {
    const root = asRecord(entry, "LEGACY_PROVIDER_ROOT_INVALID");
    assertExactKeys(root, ["rootId", "rootPath"], "LEGACY_PROVIDER_ROOT_KEYS_INVALID");
    const rootPath = asStrictString(root.rootPath, "LEGACY_PROVIDER_ROOT_PATH_INVALID", undefined, 1024);
    if (!path.isAbsolute(rootPath)) throw new Error("LEGACY_PROVIDER_ROOT_PATH_INVALID");
    return {
      rootId: asStrictString(root.rootId, "LEGACY_PROVIDER_ROOT_ID_INVALID", /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u, 128),
      rootPath: path.resolve(rootPath)
    };
  }).sort((left, right) => left.rootId.localeCompare(right.rootId));
}

function parseBoundDatabase(value: unknown): CloudTargetBinding["database"] {
  const database = asRecord(value, "LEGACY_PROVIDER_DATABASE_INVALID");
  assertExactKeys(database, [
    "connectionMode", "host", "port", "name", "schema", "loginUser", "expectedCurrentUser",
    "requiredRole", "sslMode", "tlsServerName"
  ], "LEGACY_PROVIDER_DATABASE_KEYS_INVALID");
  return database as unknown as CloudTargetBinding["database"];
}

function assertDatabaseUrl(databaseUrl: string, target: CloudTargetBinding) {
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("LEGACY_DATABASE_CREDENTIAL_INVALID"); }
  let username: string;
  try { username = decodeURIComponent(parsed.username); } catch { throw new Error("LEGACY_DATABASE_CREDENTIAL_INVALID"); }
  if ((parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") ||
    parsed.hostname !== target.database.host || (parsed.port || "5432") !== "5432" ||
    parsed.pathname !== `/${target.database.name}` || username !== target.database.loginUser || !parsed.password ||
    parsed.searchParams.getAll("schema").length !== 1 || parsed.searchParams.get("schema") !== target.database.schema ||
    parsed.searchParams.getAll("sslmode").length !== 1 || parsed.searchParams.get("sslmode") !== "verify-full" ||
    parsed.hash) throw new Error("LEGACY_DATABASE_TARGET_MISMATCH");
}

function requireCredential(value: string | undefined, code: string) {
  return asStrictString(value, code, undefined, 8192);
}

function assertApprovalWindow(issuedAt: string, expiresAt: string, now: Date, prefix: string) {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (issued > now.getTime() || expires <= now.getTime() || expires <= issued || expires - issued > 24 * 60 * 60_000) {
    throw new Error(`${prefix}_WINDOW_INVALID`);
  }
}

function asHash(value: unknown, code: string) {
  return asStrictString(value, code, /^[0-9a-f]{64}$/u, 64);
}

function asGitSha(value: unknown, code: string) {
  return asStrictString(value, code, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, 64);
}
