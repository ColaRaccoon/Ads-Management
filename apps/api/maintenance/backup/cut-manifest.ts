import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { canonicalSha256 } from "../shared/strict-json";
import { createRedactedEvidence, RedactedEvidence } from "../shared/redacted-evidence";
import { CloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";

export const BACKUP_CUT_CONTRACT_VERSION = 1 as const;
export const BACKUP_REFERENCE_MODELS = [
  "UploadBatch", "Cafe24UploadBatch", "CoupangUploadBatch", "ReportExport", "StorageTombstone"
] as const;
export type BackupReferenceModel = typeof BACKUP_REFERENCE_MODELS[number];

export type BackupReference = {
  model: BackupReferenceModel;
  recordId: string;
  field: "storedFilePath" | "filePath" | "originalKey" | "trashKey";
  provider: string;
  key: string;
  hashSha256: string;
  byteSize: number;
  state: string;
};

export type BackedUpObject = {
  provider: string;
  key: string;
  byteSize: number;
  hashSha256: string;
  backupLocator: string;
};

export type DatabaseCut = {
  backupId: string;
  watermark: string;
  dumpHashSha256: string;
  migrationHistoryDigestSha256: string;
  kpiDigestSha256: string;
};

export type BackupDestination = {
  provider: "CLOUDFLARE_R2";
  destinationId: string;
  accountId: string;
  bucket: string;
  endpoint: string;
  region: "auto";
  publicAccess: "PRIVATE";
  residencyGuarantee: "NONE";
  encryption: "CUSTOMER_MANAGED";
  keyCustodyReference: string;
  retentionUntil: string;
  retentionDays: 30;
  retentionApproval: "NOT_APPROVED";
  independentFromSourceProject: true;
};

export type BackupCutManifest = {
  contractVersion: typeof BACKUP_CUT_CONTRACT_VERSION;
  cutId: string;
  targetSha256: string;
  sourceProjectRef: string;
  bucket: string;
  writeBlockReceipt: string;
  databaseCut: DatabaseCut;
  destination: BackupDestination;
  references: BackupReference[];
  objects: BackedUpObject[];
  referenceDigestBeforeSha256: string;
  referenceDigestAfterSha256: string;
  objectDigestSha256: string;
  manifestDigestSha256: string;
  result: "PASS";
};

export type BackupCutAdapter = {
  verifyExternalWriteBlock(target: CloudTargetBinding): Promise<{ receiptDigestSha256: string }>;
  requestExternalWriteRelease(target: CloudTargetBinding, receiptDigestSha256: string): Promise<void>;
  readDrainState(target: CloudTargetBinding): Promise<{ inFlight: number; pending: number; creating: number }>;
  captureDatabaseCut(target: CloudTargetBinding, cutId: string): Promise<DatabaseCut>;
  listReferences(target: CloudTargetBinding): Promise<BackupReference[]>;
  copyObjectsNoOverwrite(input: {
    target: CloudTargetBinding;
    bucket: string;
    cutId: string;
    references: BackupReference[];
    destination: BackupDestination;
  }): Promise<BackedUpObject[]>;
  readDatabaseWatermark(target: CloudTargetBinding): Promise<string>;
};

export type BackupCutResult =
  | { result: "PASS"; manifest: BackupCutManifest; evidence: RedactedEvidence }
  | { result: "FAIL"; code: string; evidence: RedactedEvidence };

export async function runConsistentBackupCut(input: {
  target: CloudTargetBinding;
  bucket: string;
  destination: BackupDestination;
  adapter: BackupCutAdapter;
  cutId?: string;
}): Promise<BackupCutResult> {
  validateBucket(input.bucket);
  const destination = validateBackupDestination(input.destination);
  const cutId = input.cutId ?? randomUUID();
  if (!isUuid(cutId)) throw new Error("BACKUP_CUT_ID_INVALID");
  let receipt = "";
  try {
    receipt = (await input.adapter.verifyExternalWriteBlock(input.target)).receiptDigestSha256;
    assertHash(receipt, "BACKUP_WRITE_BLOCK_RECEIPT_INVALID");
    const drain = await input.adapter.readDrainState(input.target);
    if ([drain.inFlight, drain.pending, drain.creating].some((count) => !Number.isSafeInteger(count) || count < 0)) {
      throw new Error("BACKUP_DRAIN_STATE_INVALID");
    }
    if (drain.inFlight !== 0 || drain.pending !== 0 || drain.creating !== 0) {
      return failed(input.target, "BACKUP_DRAIN_NOT_ZERO", drain);
    }
    const databaseCut = validateDatabaseCut(await input.adapter.captureDatabaseCut(input.target, cutId));
    const references = normalizeReferences(await input.adapter.listReferences(input.target));
    const beforeDigest = canonicalSha256(references);
    const objects = normalizeObjects(await input.adapter.copyObjectsNoOverwrite({
      target: input.target,
      bucket: input.bucket,
      cutId,
      references,
      destination
    }));
    assertObjectCoverage(references, objects);
    const afterWatermark = await input.adapter.readDatabaseWatermark(input.target);
    const afterReferences = normalizeReferences(await input.adapter.listReferences(input.target));
    const afterDigest = canonicalSha256(afterReferences);
    if (afterWatermark !== databaseCut.watermark || afterDigest !== beforeDigest) {
      return failed(input.target, "BACKUP_CROSS_SYSTEM_DRIFT", {
        references: references.length,
        objects: objects.length
      });
    }
    const unsigned = {
      contractVersion: BACKUP_CUT_CONTRACT_VERSION,
      cutId,
      targetSha256: targetBindingSha256(input.target),
      sourceProjectRef: input.target.projectRef,
      bucket: input.bucket,
      writeBlockReceipt: receipt,
      databaseCut,
      destination,
      references,
      objects,
      referenceDigestBeforeSha256: beforeDigest,
      referenceDigestAfterSha256: afterDigest,
      objectDigestSha256: canonicalSha256(objects),
      result: "PASS" as const
    };
    const manifest: BackupCutManifest = { ...unsigned, manifestDigestSha256: canonicalSha256(unsigned) };
    return {
      result: "PASS",
      manifest,
      evidence: createRedactedEvidence({
        kind: "backup.cut",
        target: input.target,
        result: "PASS",
        counts: {
          reference_count: references.length,
          object_count: objects.length,
          object_bytes: objects.reduce((sum, object) => sum + object.byteSize, 0)
        },
        codes: ["EXTERNAL_WRITE_BLOCK_RECEIPT_VERIFIED", "DRAIN_ZERO", "DB_REVERIFIED", "OBJECT_HASHED"]
      })
    };
  } catch (error) {
    return failed(input.target, safeCode(error), {});
  } finally {
    if (receipt) await input.adapter.requestExternalWriteRelease(input.target, receipt);
  }
}

export type RestoreReceiptSignatureVerifier = {
  verify(input: { kind: "database" | "objects"; canonicalPayload: string; signature: string; producerArtifactDigestSha256: string }): Promise<boolean>;
};

export function createPublicKeyRestoreReceiptVerifier(input: { publicKeyPem: string; confirmPublicKeySha256: string }): RestoreReceiptSignatureVerifier {
  assertHash(input.confirmPublicKeySha256, "BACKUP_RESTORE_PUBLIC_KEY_DIGEST_INVALID");
  if (!input.publicKeyPem || input.publicKeyPem.length > 32 * 1024 || /PRIVATE KEY/.test(input.publicKeyPem)) {
    throw new Error("BACKUP_RESTORE_PUBLIC_KEY_INVALID");
  }
  const publicKey = createPublicKey(input.publicKeyPem);
  if (!publicKey.asymmetricKeyType || !["ec", "rsa", "rsa-pss"].includes(publicKey.asymmetricKeyType)) {
    throw new Error("BACKUP_RESTORE_PUBLIC_KEY_INVALID");
  }
  const digest = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  if (digest !== input.confirmPublicKeySha256) throw new Error("BACKUP_RESTORE_PUBLIC_KEY_MISMATCH");
  return {
    verify: async ({ canonicalPayload, signature }) => /^[A-Za-z0-9_-]{40,2048}$/.test(signature) &&
      verify("sha256", Buffer.from(canonicalPayload), publicKey, Buffer.from(signature, "base64url"))
  };
}

export async function verifyBackupRestore(input: {
  manifest: unknown;
  databaseReceipt: unknown;
  objectReceipt: unknown;
  approvedDatabaseReceiptSha256: string;
  approvedObjectReceiptSha256: string;
  producerArtifactDigestSha256: string;
  signatureVerifier: RestoreReceiptSignatureVerifier;
}) {
  const manifest = parseBackupCutManifest(input.manifest);
  assertHash(input.producerArtifactDigestSha256, "BACKUP_RESTORE_PRODUCER_DIGEST_INVALID");
  const database = parseDatabaseRestoreReceipt(input.databaseReceipt);
  const objects = parseObjectRestoreReceipt(input.objectReceipt);
  await verifyRestoreReceipt(database, "database", input.approvedDatabaseReceiptSha256, input.producerArtifactDigestSha256, input.signatureVerifier);
  await verifyRestoreReceipt(objects, "objects", input.approvedObjectReceiptSha256, input.producerArtifactDigestSha256, input.signatureVerifier);
  if (database.manifestDigestSha256 !== manifest.manifestDigestSha256 || objects.manifestDigestSha256 !== manifest.manifestDigestSha256 ||
      database.sourceProjectRef !== manifest.sourceProjectRef || database.isolatedProjectRef === manifest.sourceProjectRef ||
      database.restoredDumpHashSha256 !== manifest.databaseCut.dumpHashSha256 ||
      database.migrationHistoryDigestSha256 !== manifest.databaseCut.migrationHistoryDigestSha256 ||
      database.watermark !== manifest.databaseCut.watermark || database.referenceDigestSha256 !== manifest.referenceDigestBeforeSha256 ||
      database.kpiDigestSha256 !== manifest.databaseCut.kpiDigestSha256) {
    throw new Error("BACKUP_RESTORE_DATABASE_RECEIPT_MISMATCH");
  }
  if (objects.isolatedDestinationId !== manifest.destination.destinationId ||
      (manifest.objects.length > 0 && objects.entries.length === 0)) throw new Error("BACKUP_RESTORE_OBJECT_RECEIPT_EMPTY");
  const expected = manifest.objects.map(({ provider, key, byteSize, hashSha256 }) => ({ provider, key, byteSize, bodyHashSha256: hashSha256 }));
  if (canonicalSha256(objects.entries) !== canonicalSha256(expected)) throw new Error("BACKUP_RESTORE_OBJECT_BODY_MISMATCH");
  return {
    result: "PASS" as const,
    manifestDigestSha256: manifest.manifestDigestSha256,
    databaseReceiptSha256: database.receiptDigestSha256,
    objectReceiptSha256: objects.receiptDigestSha256
  };
}

export function parseBackupCutManifest(value: unknown): BackupCutManifest {
  const input = runtimeRecord(value, "BACKUP_MANIFEST_OBJECT_REQUIRED");
  assertRuntimeExactKeys(input, [
    "contractVersion", "cutId", "targetSha256", "sourceProjectRef", "bucket", "writeBlockReceipt", "databaseCut",
    "destination", "references", "objects", "referenceDigestBeforeSha256", "referenceDigestAfterSha256",
    "objectDigestSha256", "manifestDigestSha256", "result"
  ], "BACKUP_MANIFEST_FIELDS_INVALID");
  if (input.contractVersion !== BACKUP_CUT_CONTRACT_VERSION || input.result !== "PASS" || !isUuid(String(input.cutId)) ||
      !/^[a-z]{20}$/.test(String(input.sourceProjectRef)) || typeof input.writeBlockReceipt !== "string" ||
      !input.writeBlockReceipt || input.writeBlockReceipt.length > 512 || !Array.isArray(input.references) || !Array.isArray(input.objects)) {
    throw new Error("BACKUP_MANIFEST_IDENTITY_INVALID");
  }
  validateBucket(String(input.bucket));
  assertHash(String(input.targetSha256), "BACKUP_MANIFEST_TARGET_DIGEST_INVALID");
  const databaseCut = validateDatabaseCut(runtimeRecord(input.databaseCut, "BACKUP_DATABASE_CUT_INVALID") as DatabaseCut);
  const destination = validateBackupDestination(runtimeRecord(input.destination, "BACKUP_DESTINATION_INVALID") as BackupDestination);
  const references = normalizeReferences(input.references as BackupReference[]);
  const objects = normalizeObjects(input.objects as BackedUpObject[]);
  const unsigned = {
    contractVersion: BACKUP_CUT_CONTRACT_VERSION,
    cutId: input.cutId as string,
    targetSha256: input.targetSha256 as string,
    sourceProjectRef: input.sourceProjectRef as string,
    bucket: input.bucket as string,
    writeBlockReceipt: input.writeBlockReceipt,
    databaseCut,
    destination,
    references,
    objects,
    referenceDigestBeforeSha256: input.referenceDigestBeforeSha256 as string,
    referenceDigestAfterSha256: input.referenceDigestAfterSha256 as string,
    objectDigestSha256: input.objectDigestSha256 as string,
    result: "PASS" as const
  };
  for (const digest of [unsigned.referenceDigestBeforeSha256, unsigned.referenceDigestAfterSha256, unsigned.objectDigestSha256, input.manifestDigestSha256]) {
    assertHash(String(digest), "BACKUP_MANIFEST_DIGEST_INVALID");
  }
  if (unsigned.referenceDigestBeforeSha256 !== canonicalSha256(references) ||
      unsigned.referenceDigestAfterSha256 !== canonicalSha256(references) || unsigned.objectDigestSha256 !== canonicalSha256(objects) ||
      input.manifestDigestSha256 !== canonicalSha256(unsigned)) throw new Error("BACKUP_MANIFEST_DIGEST_MISMATCH");
  assertObjectCoverage(references, objects);
  return { ...unsigned, manifestDigestSha256: input.manifestDigestSha256 as string };
}

export function createBoundBackupObjectCopyAdapter(input: {
  target: CloudTargetBinding;
  bucket: string;
  destination: BackupDestination;
  confirmTargetSha256: string;
  sourceCredentialReference: string;
  destinationCredentialReference: string;
  io: {
    readSourceBody(provider: string, bucket: string, key: string): Promise<Uint8Array>;
    inspectDestination(locator: string): Promise<"MISSING" | "FOUND">;
    putDestinationNoOverwrite(locator: string, body: Uint8Array): Promise<void>;
    readDestinationBody(locator: string): Promise<Uint8Array>;
  };
}) {
  validateBucket(input.bucket);
  const destination = validateBackupDestination(input.destination);
  if (input.confirmTargetSha256 !== targetBindingSha256(input.target) || !input.sourceCredentialReference ||
      !input.destinationCredentialReference || input.sourceCredentialReference === input.destinationCredentialReference ||
      !input.io) throw new Error("BACKUP_OBJECT_ADAPTER_BINDING_REQUIRED");
  return async (cutId: string, references: BackupReference[]): Promise<BackedUpObject[]> => {
    if (!isUuid(cutId)) throw new Error("BACKUP_CUT_ID_INVALID");
    const unique = new Map(normalizeReferences(references).map((reference) => [`${reference.provider}:${reference.key}`, reference]));
    const output: BackedUpObject[] = [];
    for (const reference of unique.values()) {
      const sourceBody = await input.io.readSourceBody(reference.provider, input.bucket, reference.key);
      assertActualBody(reference, sourceBody, "BACKUP_SOURCE_BODY_MISMATCH");
      const locator = `${destination.destinationId}/${cutId}/${reference.provider}/${reference.key}`;
      const state = await input.io.inspectDestination(locator);
      if (state === "MISSING") await input.io.putDestinationNoOverwrite(locator, sourceBody);
      const destinationBody = await input.io.readDestinationBody(locator);
      assertActualBody(reference, destinationBody, "BACKUP_DESTINATION_BODY_MISMATCH");
      output.push({
        provider: reference.provider, key: reference.key, byteSize: destinationBody.byteLength,
        hashSha256: bodySha256(destinationBody), backupLocator: locator
      });
    }
    return normalizeObjects(output);
  };
}

function failed(target: CloudTargetBinding, code: string, counts: Record<string, number>): BackupCutResult {
  return {
    result: "FAIL",
    code,
    evidence: createRedactedEvidence({ kind: "backup.cut", target, result: "FAIL", counts, codes: [code] })
  };
}

function normalizeReferences(references: BackupReference[]) {
  if (references.length > 1_000_000) throw new Error("BACKUP_REFERENCE_LIMIT");
  return references.map((reference) => {
    assertRuntimeExactKeys(reference, ["model", "recordId", "field", "provider", "key", "hashSha256", "byteSize", "state"], "BACKUP_REFERENCE_FIELDS_INVALID");
    if (!BACKUP_REFERENCE_MODELS.includes(reference.model) || !isUuid(reference.recordId) ||
        !["storedFilePath", "filePath", "originalKey", "trashKey"].includes(reference.field) ||
        typeof reference.state !== "string" || !reference.state || reference.state.length > 64) {
      throw new Error("BACKUP_REFERENCE_IDENTITY_INVALID");
    }
    if (typeof reference.provider !== "string" || typeof reference.key !== "string" ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(reference.provider) || !safeKey(reference.key)) {
      throw new Error("BACKUP_REFERENCE_LOCATION_INVALID");
    }
    assertHash(reference.hashSha256, "BACKUP_REFERENCE_HASH_INVALID");
    if (!Number.isSafeInteger(reference.byteSize) || reference.byteSize < 0) throw new Error("BACKUP_REFERENCE_SIZE_INVALID");
    return {
      model: reference.model,
      recordId: reference.recordId,
      field: reference.field,
      provider: reference.provider,
      key: reference.key,
      hashSha256: reference.hashSha256,
      byteSize: reference.byteSize,
      state: reference.state
    };
  }).sort((left, right) => `${left.model}|${left.recordId}|${left.field}`.localeCompare(`${right.model}|${right.recordId}|${right.field}`));
}

function normalizeObjects(objects: BackedUpObject[]) {
  if (objects.length > 1_000_000) throw new Error("BACKUP_OBJECT_LIMIT");
  return objects.map((object) => {
    assertRuntimeExactKeys(object, ["provider", "key", "byteSize", "hashSha256", "backupLocator"], "BACKUP_OBJECT_FIELDS_INVALID");
    if (typeof object.provider !== "string" || typeof object.key !== "string" ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(object.provider) || !safeKey(object.key)) {
      throw new Error("BACKUP_OBJECT_LOCATION_INVALID");
    }
    assertHash(object.hashSha256, "BACKUP_OBJECT_HASH_INVALID");
    if (!Number.isSafeInteger(object.byteSize) || object.byteSize < 0 || typeof object.backupLocator !== "string" ||
        !safeKey(object.backupLocator)) {
      throw new Error("BACKUP_OBJECT_METADATA_INVALID");
    }
    return {
      provider: object.provider,
      key: object.key,
      byteSize: object.byteSize,
      hashSha256: object.hashSha256,
      backupLocator: object.backupLocator
    };
  }).sort((left, right) => `${left.provider}|${left.key}`.localeCompare(`${right.provider}|${right.key}`));
}

function assertObjectCoverage(references: BackupReference[], objects: BackedUpObject[]) {
  const index = new Map(objects.map((object) => [`${object.provider}:${object.key}`, object]));
  for (const reference of references) {
    const object = index.get(`${reference.provider}:${reference.key}`);
    if (!object || object.byteSize !== reference.byteSize || object.hashSha256 !== reference.hashSha256) {
      throw new Error("BACKUP_OBJECT_COVERAGE_MISMATCH");
    }
  }
}

function validateDatabaseCut(value: DatabaseCut) {
  assertRuntimeExactKeys(value, [
    "backupId", "watermark", "dumpHashSha256", "migrationHistoryDigestSha256", "kpiDigestSha256"
  ], "BACKUP_DATABASE_CUT_FIELDS_INVALID");
  if (typeof value.backupId !== "string" || !value.backupId || value.backupId.length > 512 ||
      typeof value.watermark !== "string" || !value.watermark || value.watermark.length > 512) throw new Error("BACKUP_DATABASE_CUT_INVALID");
  assertHash(value.dumpHashSha256, "BACKUP_DATABASE_HASH_INVALID");
  assertHash(value.migrationHistoryDigestSha256, "BACKUP_DATABASE_MIGRATION_DIGEST_INVALID");
  assertHash(value.kpiDigestSha256, "BACKUP_DATABASE_KPI_DIGEST_INVALID");
  return { ...value };
}

export function validateBackupDestination(value: BackupDestination): BackupDestination {
  assertRuntimeExactKeys(value, [
    "provider", "destinationId", "accountId", "bucket", "endpoint", "region", "publicAccess", "residencyGuarantee",
    "encryption", "keyCustodyReference", "retentionUntil", "retentionDays", "retentionApproval", "independentFromSourceProject"
  ], "BACKUP_DESTINATION_FIELDS_INVALID");
  if (value.provider !== "CLOUDFLARE_R2" || typeof value.destinationId !== "string" || !value.destinationId ||
      typeof value.accountId !== "string" || typeof value.bucket !== "string" || typeof value.endpoint !== "string" ||
      typeof value.keyCustodyReference !== "string" || !value.keyCustodyReference || value.independentFromSourceProject !== true) {
    throw new Error("BACKUP_DESTINATION_INVALID");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.destinationId) || !/^[a-f0-9]{32}$/.test(value.accountId) ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket) ||
      value.endpoint !== `https://${value.accountId}.r2.cloudflarestorage.com` || value.region !== "auto" ||
      value.publicAccess !== "PRIVATE" || value.residencyGuarantee !== "NONE" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.keyCustodyReference)) throw new Error("BACKUP_DESTINATION_INVALID");
  if (value.encryption !== "CUSTOMER_MANAGED") {
    throw new Error("BACKUP_DESTINATION_ENCRYPTION_INVALID");
  }
  if (!Number.isFinite(Date.parse(value.retentionUntil)) || value.retentionDays !== 30 || value.retentionApproval !== "NOT_APPROVED") {
    throw new Error("BACKUP_RETENTION_INVALID");
  }
  return {
    provider: "CLOUDFLARE_R2",
    destinationId: value.destinationId,
    accountId: value.accountId,
    bucket: value.bucket,
    endpoint: value.endpoint,
    region: "auto",
    publicAccess: "PRIVATE",
    residencyGuarantee: "NONE",
    encryption: "CUSTOMER_MANAGED",
    keyCustodyReference: value.keyCustodyReference,
    retentionUntil: value.retentionUntil,
    retentionDays: 30,
    retentionApproval: "NOT_APPROVED",
    independentFromSourceProject: true
  };
}

function validateBucket(value: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value)) throw new Error("BACKUP_BUCKET_INVALID");
}

function safeKey(value: string) {
  return value.length > 0 && value.length <= 1_024 && !value.includes("\\") && !value.includes("\0") &&
    !value.startsWith("/") && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function bodySha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function assertActualBody(reference: BackupReference, value: Uint8Array, code: string) {
  if (!(value instanceof Uint8Array) || value.byteLength !== reference.byteSize || bodySha256(value) !== reference.hashSha256) {
    throw new Error(code);
  }
}

function assertHash(value: string, code: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(code);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeCode(error: unknown) {
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "BACKUP_CUT_FAILED";
}

function assertRuntimeExactKeys(value: object, expected: string[], code: string) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) throw new Error(code);
}

type DatabaseRestoreReceipt = {
  version: "backup-database-restore-receipt/v1";
  manifestDigestSha256: string;
  sourceProjectRef: string;
  isolatedProjectRef: string;
  isolatedSchema: string;
  restoredDumpHashSha256: string;
  migrationHistoryDigestSha256: string;
  watermark: string;
  referenceDigestSha256: string;
  kpiDigestSha256: string;
  producerArtifactDigestSha256: string;
  signature: string;
  receiptDigestSha256: string;
};

type ObjectRestoreReceipt = {
  version: "backup-object-restore-receipt/v1";
  manifestDigestSha256: string;
  isolatedDestinationId: string;
  isolatedPrefix: string;
  entries: Array<{ provider: string; key: string; byteSize: number; bodyHashSha256: string }>;
  producerArtifactDigestSha256: string;
  signature: string;
  receiptDigestSha256: string;
};

function parseDatabaseRestoreReceipt(value: unknown): DatabaseRestoreReceipt {
  const input = runtimeRecord(value, "BACKUP_RESTORE_DATABASE_RECEIPT_REQUIRED");
  assertRuntimeExactKeys(input, [
    "version", "manifestDigestSha256", "sourceProjectRef", "isolatedProjectRef", "isolatedSchema", "restoredDumpHashSha256",
    "migrationHistoryDigestSha256", "watermark", "referenceDigestSha256", "kpiDigestSha256", "producerArtifactDigestSha256",
    "signature", "receiptDigestSha256"
  ], "BACKUP_RESTORE_DATABASE_RECEIPT_FIELDS_INVALID");
  if (input.version !== "backup-database-restore-receipt/v1" || !/^[a-z]{20}$/.test(String(input.sourceProjectRef)) ||
      !/^[a-z]{20}$/.test(String(input.isolatedProjectRef)) || !/^[a-z_][a-z0-9_]{0,62}$/.test(String(input.isolatedSchema)) ||
      typeof input.watermark !== "string" || !input.watermark || !validSignature(input.signature)) {
    throw new Error("BACKUP_RESTORE_DATABASE_RECEIPT_INVALID");
  }
  for (const key of [
    "manifestDigestSha256", "restoredDumpHashSha256", "migrationHistoryDigestSha256", "referenceDigestSha256",
    "kpiDigestSha256", "producerArtifactDigestSha256", "receiptDigestSha256"
  ]) assertHash(String(input[key]), "BACKUP_RESTORE_DATABASE_RECEIPT_DIGEST_INVALID");
  return input as unknown as DatabaseRestoreReceipt;
}

function parseObjectRestoreReceipt(value: unknown): ObjectRestoreReceipt {
  const input = runtimeRecord(value, "BACKUP_RESTORE_OBJECT_RECEIPT_REQUIRED");
  assertRuntimeExactKeys(input, [
    "version", "manifestDigestSha256", "isolatedDestinationId", "isolatedPrefix", "entries",
    "producerArtifactDigestSha256", "signature", "receiptDigestSha256"
  ], "BACKUP_RESTORE_OBJECT_RECEIPT_FIELDS_INVALID");
  if (input.version !== "backup-object-restore-receipt/v1" || typeof input.isolatedDestinationId !== "string" ||
      !input.isolatedDestinationId || !safeKey(String(input.isolatedPrefix)) || !Array.isArray(input.entries) || !validSignature(input.signature)) {
    throw new Error("BACKUP_RESTORE_OBJECT_RECEIPT_INVALID");
  }
  assertHash(String(input.manifestDigestSha256), "BACKUP_RESTORE_OBJECT_RECEIPT_DIGEST_INVALID");
  assertHash(String(input.producerArtifactDigestSha256), "BACKUP_RESTORE_OBJECT_RECEIPT_DIGEST_INVALID");
  assertHash(String(input.receiptDigestSha256), "BACKUP_RESTORE_OBJECT_RECEIPT_DIGEST_INVALID");
  const entries = input.entries.map((raw) => {
    const entry = runtimeRecord(raw, "BACKUP_RESTORE_OBJECT_ENTRY_INVALID");
    assertRuntimeExactKeys(entry, ["provider", "key", "byteSize", "bodyHashSha256"], "BACKUP_RESTORE_OBJECT_ENTRY_FIELDS_INVALID");
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(entry.provider)) || !safeKey(String(entry.key)) ||
        !Number.isSafeInteger(entry.byteSize) || (entry.byteSize as number) < 0) throw new Error("BACKUP_RESTORE_OBJECT_ENTRY_INVALID");
    assertHash(String(entry.bodyHashSha256), "BACKUP_RESTORE_OBJECT_BODY_HASH_INVALID");
    return entry as { provider: string; key: string; byteSize: number; bodyHashSha256: string };
  }).sort((left, right) => `${left.provider}|${left.key}`.localeCompare(`${right.provider}|${right.key}`));
  return { ...input, entries } as unknown as ObjectRestoreReceipt;
}

async function verifyRestoreReceipt(
  receipt: DatabaseRestoreReceipt | ObjectRestoreReceipt,
  kind: "database" | "objects",
  approvedDigest: string,
  producerDigest: string,
  verifier: RestoreReceiptSignatureVerifier
) {
  assertHash(approvedDigest, "BACKUP_RESTORE_APPROVED_DIGEST_INVALID");
  if (receipt.producerArtifactDigestSha256 !== producerDigest) throw new Error("BACKUP_RESTORE_PRODUCER_BINDING_MISMATCH");
  const { receiptDigestSha256, ...signed } = receipt;
  if (canonicalSha256(signed) !== receiptDigestSha256 || receiptDigestSha256 !== approvedDigest) {
    throw new Error("BACKUP_RESTORE_RECEIPT_DIGEST_MISMATCH");
  }
  const { signature, ...payload } = signed;
  if (!await verifier.verify({ kind, canonicalPayload: JSON.stringify(sortCanonical(payload)), signature, producerArtifactDigestSha256: producerDigest })) {
    throw new Error("BACKUP_RESTORE_RECEIPT_SIGNATURE_INVALID");
  }
}

function runtimeRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function validSignature(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,2048}$/.test(value);
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortCanonical(entry)]));
  return value;
}
