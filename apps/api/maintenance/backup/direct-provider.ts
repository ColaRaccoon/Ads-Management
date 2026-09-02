import { ChildProcess, spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify
} from "node:crypto";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  asIsoTimestamp,
  asRecord,
  asSafeInteger,
  asStrictString,
  assertExactKeys,
  canonicalJson,
  canonicalSha256,
  sha256Hex
} from "../shared/strict-json";
import { CloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";
import {
  BackedUpObject,
  BackupCutAdapter,
  BackupCutManifest,
  BackupDestination,
  BackupReference,
  BACKUP_REFERENCE_MODELS,
  DatabaseCut,
  validateBackupDestination
} from "./cut-manifest";

export const R2_PROVIDER_BINDING_VERSION = "cloudflare-r2-backup-binding/v1";
export const BACKUP_ENCRYPTION_KEY_VERSION = "customer-managed-backup-key/v1";
export const WRITE_BLOCK_RECEIPT_VERSION = "koyeb-write-block-drain-receipt/v1";
export const BACKUP_ENVELOPE_VERSION = "backup-aes-256-gcm-envelope/v1";
export const BACKUP_MAX_SOURCE_OBJECT_BYTES = 24 * 1024 * 1024;
// Disk/time cap; database encryption memory is separately bounded by BACKUP_DATABASE_CHUNK_BYTES.
export const BACKUP_MAX_DATABASE_DUMP_BYTES = 8 * 1024 * 1024 * 1024;
export const BACKUP_DATABASE_CHUNK_BYTES = 16 * 1024 * 1024;
export const BACKUP_MAX_DATABASE_PARTS = Math.ceil(BACKUP_MAX_DATABASE_DUMP_BYTES / BACKUP_DATABASE_CHUNK_BYTES);
export const BACKUP_DATABASE_INDEX_BASE_BYTES = 64 * 1024;
export const BACKUP_DATABASE_INDEX_PART_BYTES = 4 * 1024;
export const BACKUP_MAX_DATABASE_INDEX_BYTES =
  BACKUP_DATABASE_INDEX_BASE_BYTES + BACKUP_MAX_DATABASE_PARTS * BACKUP_DATABASE_INDEX_PART_BYTES;
export const BACKUP_ENVELOPE_METADATA_MAX_BYTES = 256 * 1024;
export const BACKUP_MAX_SOURCE_ENVELOPE_BYTES =
  4 * Math.ceil(BACKUP_MAX_SOURCE_OBJECT_BYTES / 3) + BACKUP_ENVELOPE_METADATA_MAX_BYTES;
export const BACKUP_MAX_DATABASE_PART_ENVELOPE_BYTES =
  4 * Math.ceil(BACKUP_DATABASE_CHUNK_BYTES / 3) + BACKUP_ENVELOPE_METADATA_MAX_BYTES;
export const BACKUP_MAX_DATABASE_INDEX_ENVELOPE_BYTES =
  4 * Math.ceil(BACKUP_MAX_DATABASE_INDEX_BYTES / 3) + BACKUP_ENVELOPE_METADATA_MAX_BYTES;
export const BACKUP_MAX_R2_ENVELOPE_BYTES = Math.max(
  BACKUP_MAX_SOURCE_ENVELOPE_BYTES,
  BACKUP_MAX_DATABASE_PART_ENVELOPE_BYTES,
  BACKUP_MAX_DATABASE_INDEX_ENVELOPE_BYTES
);
// Unknown-length reads retain one maximum-sized work buffer plus at most one exact-sized result copy.
export const BACKUP_MAX_BOUNDED_PROVIDER_BODY_ALLOCATION_BYTES = 2 * BACKUP_MAX_R2_ENVELOPE_BYTES;
export const BACKUP_PG_DUMP_TIMEOUT_MS = 15 * 60_000;
export const BACKUP_PG_DUMP_STDERR_MAX_BYTES = 16 * 1024;
export const BACKUP_PG_DUMP_FREE_SPACE_RESERVE_BYTES = 1024 * 1024 * 1024;
export const BACKUP_PG_DUMP_LINUX_LIMIT_EXECUTABLE = "/usr/bin/prlimit";

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type R2ProviderBinding = {
  version: typeof R2_PROVIDER_BINDING_VERSION;
  targetSha256: string;
  planDigestSha256: string;
  projectRef: string;
  source: {
    origin: string;
    bucket: string;
    credentialKind: "supabase-private-storage-read-token/v1";
    tokenSha256: string;
  };
  destination: BackupDestination;
  r2Credential: {
    kind: "r2-bucket-object-read-write/v1";
    bucket: string;
    permissions: ["object_read", "object_write"];
    accessKeyIdSha256: string;
    secretAccessKeySha256: string;
  };
  encryption: {
    mode: "CUSTOMER_MANAGED";
    algorithm: "AES-256-GCM";
    keyId: string;
    keySha256: string;
  };
  koyeb: {
    serviceId: string;
    revisionId: string;
    producerArtifactDigestSha256: string;
    signerPublicKeySha256: string;
  };
  issuedAt: string;
  expiresAt: string;
};

export type ParsedBackupEncryptionKey = {
  keyId: string;
  key: Buffer;
  keySha256: string;
};

export type VerifiedWriteBlockReceipt = {
  receiptDigestSha256: string;
  inFlight: 0;
  pending: 0;
  creating: 0;
};

export type BackupPrismaIo = {
  assertIdentity(target: CloudTargetBinding): Promise<void>;
  databaseState(target: CloudTargetBinding): Promise<{
    watermark: string;
    migrationHistoryDigestSha256: string;
    kpiDigestSha256: string;
  }>;
  listReferenceRows(): Promise<Array<{
    model: typeof BACKUP_REFERENCE_MODELS[number];
    recordId: string;
    field: BackupReference["field"];
    key: string;
    hashSha256: string;
    byteSize?: number;
    state: string;
  }>>;
  disconnect(): Promise<void>;
};

export type R2ObjectIo = {
  inspect(key: string): Promise<"MISSING" | "FOUND">;
  putNoOverwrite(key: string, body: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
};

export type DirectBackupDependencies = {
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  databaseChunkBytes?: number;
  createPrismaIo?: (databaseUrl: string, target: CloudTargetBinding) => Promise<BackupPrismaIo>;
  createR2Io?: (input: {
    binding: R2ProviderBinding;
    accessKeyId: string;
    secretAccessKey: string;
  }) => Promise<R2ObjectIo>;
  loadR2Module?: () => Promise<unknown>;
  readSourceBody?: (input: {
    target: CloudTargetBinding;
    bucket: string;
    key: string;
    token: string;
  }) => Promise<Uint8Array>;
  inspectSourceObject?: (input: {
    target: CloudTargetBinding;
    bucket: string;
    key: string;
    token: string;
  }) => Promise<{ byteSize: number }>;
  fetchSource?: typeof fetch;
  runPgDump?: (input: {
    executable: string;
    target: CloudTargetBinding;
    password: string;
    outputFile: string;
  }) => Promise<void>;
};

export function parseR2ProviderBinding(input: {
  value: unknown;
  target: CloudTargetBinding;
  bucket: string;
  destination: BackupDestination;
  planDigestSha256: string;
  confirmBindingSha256: string;
  now?: Date;
}): R2ProviderBinding {
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.bucket)) throw new Error("BACKUP_BUCKET_INVALID");
  const destination = validateBackupDestination(input.destination);
  const value = asRecord(input.value, "BACKUP_PROVIDER_BINDING_REQUIRED");
  assertExactKeys(value, [
    "version", "targetSha256", "planDigestSha256", "projectRef", "source", "destination", "r2Credential",
    "encryption", "koyeb", "issuedAt", "expiresAt"
  ], "BACKUP_PROVIDER_BINDING_FIELDS_INVALID");
  if (value.version !== R2_PROVIDER_BINDING_VERSION) throw new Error("BACKUP_PROVIDER_BINDING_VERSION_INVALID");
  const source = asRecord(value.source, "BACKUP_SOURCE_BINDING_INVALID");
  assertExactKeys(source, ["origin", "bucket", "credentialKind", "tokenSha256"], "BACKUP_SOURCE_BINDING_FIELDS_INVALID");
  const r2Credential = asRecord(value.r2Credential, "BACKUP_R2_CREDENTIAL_BINDING_INVALID");
  assertExactKeys(r2Credential, ["kind", "bucket", "permissions", "accessKeyIdSha256", "secretAccessKeySha256"], "BACKUP_R2_CREDENTIAL_FIELDS_INVALID");
  const encryption = asRecord(value.encryption, "BACKUP_ENCRYPTION_BINDING_INVALID");
  assertExactKeys(encryption, ["mode", "algorithm", "keyId", "keySha256"], "BACKUP_ENCRYPTION_BINDING_FIELDS_INVALID");
  const koyeb = asRecord(value.koyeb, "BACKUP_KOYEB_BINDING_INVALID");
  assertExactKeys(koyeb, ["serviceId", "revisionId", "producerArtifactDigestSha256", "signerPublicKeySha256"], "BACKUP_KOYEB_BINDING_FIELDS_INVALID");
  const targetSha256 = hash(value.targetSha256, "BACKUP_PROVIDER_TARGET_DIGEST_INVALID");
  const planDigestSha256 = hash(value.planDigestSha256, "BACKUP_PROVIDER_PLAN_DIGEST_INVALID");
  const projectRef = asStrictString(value.projectRef, "BACKUP_PROVIDER_PROJECT_INVALID", /^[a-z]{20}$/, 20);
  if (targetSha256 !== targetBindingSha256(input.target) || projectRef !== input.target.projectRef ||
      planDigestSha256 !== input.planDigestSha256) throw new Error("BACKUP_PROVIDER_TARGET_BINDING_MISMATCH");
  if (source.origin !== input.target.supabaseOrigin || source.bucket !== input.bucket ||
      source.credentialKind !== "supabase-private-storage-read-token/v1") throw new Error("BACKUP_SOURCE_BINDING_MISMATCH");
  const tokenSha256 = hash(source.tokenSha256, "BACKUP_SOURCE_TOKEN_DIGEST_INVALID");
  if (canonicalJson(value.destination) !== canonicalJson(destination)) throw new Error("BACKUP_R2_DESTINATION_BINDING_MISMATCH");
  if (r2Credential.kind !== "r2-bucket-object-read-write/v1" || r2Credential.bucket !== destination.bucket ||
      !Array.isArray(r2Credential.permissions) || r2Credential.permissions.length !== 2 ||
      r2Credential.permissions[0] !== "object_read" || r2Credential.permissions[1] !== "object_write") {
    throw new Error("BACKUP_R2_CREDENTIAL_SCOPE_INVALID");
  }
  const accessKeyIdSha256 = hash(r2Credential.accessKeyIdSha256, "BACKUP_R2_ACCESS_KEY_DIGEST_INVALID");
  const secretAccessKeySha256 = hash(r2Credential.secretAccessKeySha256, "BACKUP_R2_SECRET_KEY_DIGEST_INVALID");
  if (encryption.mode !== "CUSTOMER_MANAGED" || encryption.algorithm !== "AES-256-GCM") {
    throw new Error("BACKUP_ENCRYPTION_MODE_INVALID");
  }
  const keyId = asStrictString(encryption.keyId, "BACKUP_ENCRYPTION_KEY_ID_INVALID", /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, 128);
  const keySha256 = hash(encryption.keySha256, "BACKUP_ENCRYPTION_KEY_DIGEST_INVALID");
  const serviceId = asStrictString(koyeb.serviceId, "BACKUP_KOYEB_SERVICE_INVALID", /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/, 128);
  const revisionId = asStrictString(koyeb.revisionId, "BACKUP_KOYEB_REVISION_INVALID", /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/, 128);
  const producerArtifactDigestSha256 = hash(koyeb.producerArtifactDigestSha256, "BACKUP_KOYEB_PRODUCER_DIGEST_INVALID");
  const signerPublicKeySha256 = hash(koyeb.signerPublicKeySha256, "BACKUP_KOYEB_SIGNER_DIGEST_INVALID");
  const issuedAt = asIsoTimestamp(value.issuedAt, "BACKUP_PROVIDER_ISSUED_AT_INVALID");
  const expiresAt = asIsoTimestamp(value.expiresAt, "BACKUP_PROVIDER_EXPIRES_AT_INVALID");
  assertBoundedWindow(issuedAt, expiresAt, input.now ?? new Date(), 60 * 60_000, "BACKUP_PROVIDER_BINDING");
  const result: R2ProviderBinding = {
    version: R2_PROVIDER_BINDING_VERSION,
    targetSha256,
    planDigestSha256,
    projectRef,
    source: {
      origin: input.target.supabaseOrigin,
      bucket: input.bucket,
      credentialKind: "supabase-private-storage-read-token/v1",
      tokenSha256
    },
    destination,
    r2Credential: {
      kind: "r2-bucket-object-read-write/v1",
      bucket: destination.bucket,
      permissions: ["object_read", "object_write"],
      accessKeyIdSha256,
      secretAccessKeySha256
    },
    encryption: { mode: "CUSTOMER_MANAGED", algorithm: "AES-256-GCM", keyId, keySha256 },
    koyeb: { serviceId, revisionId, producerArtifactDigestSha256, signerPublicKeySha256 },
    issuedAt,
    expiresAt
  };
  if (canonicalSha256(result) !== input.confirmBindingSha256) throw new Error("BACKUP_PROVIDER_CONFIRMATION_MISMATCH");
  return result;
}

export function parseBackupEncryptionKey(input: {
  value: unknown;
  binding: R2ProviderBinding;
  confirmKeyArtifactSha256: string;
  now?: Date;
}): ParsedBackupEncryptionKey {
  const value = asRecord(input.value, "BACKUP_ENCRYPTION_KEY_REQUIRED");
  assertExactKeys(value, ["version", "targetSha256", "providerBindingSha256", "keyId", "keyMaterialBase64", "keySha256", "issuedAt", "expiresAt"],
    "BACKUP_ENCRYPTION_KEY_FIELDS_INVALID");
  if (value.version !== BACKUP_ENCRYPTION_KEY_VERSION) throw new Error("BACKUP_ENCRYPTION_KEY_VERSION_INVALID");
  if (value.targetSha256 !== input.binding.targetSha256 || value.providerBindingSha256 !== canonicalSha256(input.binding) ||
      value.keyId !== input.binding.encryption.keyId || value.keySha256 !== input.binding.encryption.keySha256) {
    throw new Error("BACKUP_ENCRYPTION_KEY_BINDING_MISMATCH");
  }
  const material = asStrictString(value.keyMaterialBase64, "BACKUP_ENCRYPTION_KEY_MATERIAL_INVALID", /^[A-Za-z0-9+/]{43}=$/, 44);
  const key = Buffer.from(material, "base64");
  if (key.byteLength !== 32 || sha256Hex(key) !== input.binding.encryption.keySha256) {
    throw new Error("BACKUP_ENCRYPTION_KEY_MATERIAL_INVALID");
  }
  const issuedAt = asIsoTimestamp(value.issuedAt, "BACKUP_ENCRYPTION_KEY_ISSUED_AT_INVALID");
  const expiresAt = asIsoTimestamp(value.expiresAt, "BACKUP_ENCRYPTION_KEY_EXPIRES_AT_INVALID");
  assertBoundedWindow(issuedAt, expiresAt, input.now ?? new Date(), 24 * 60 * 60_000, "BACKUP_ENCRYPTION_KEY");
  if (canonicalSha256(value) !== input.confirmKeyArtifactSha256) throw new Error("BACKUP_ENCRYPTION_KEY_CONFIRMATION_MISMATCH");
  return { keyId: input.binding.encryption.keyId, key, keySha256: input.binding.encryption.keySha256 };
}

export function verifyExternalWriteBlockReceipt(input: {
  value: unknown;
  target: CloudTargetBinding;
  binding: R2ProviderBinding;
  publicKeyPem: string;
  confirmReceiptSha256: string;
  confirmPublicKeySha256: string;
  now?: Date;
}): VerifiedWriteBlockReceipt {
  const value = asRecord(input.value, "BACKUP_WRITE_BLOCK_RECEIPT_REQUIRED");
  assertExactKeys(value, [
    "version", "environmentId", "projectRef", "targetSha256", "releaseGitSha", "koyebServiceId", "koyebRevisionId",
    "traffic", "writes", "inFlight", "pending", "creating", "issuedAt", "expiresAt", "producerArtifactDigestSha256",
    "signerPublicKeySha256", "signature", "receiptDigestSha256"
  ], "BACKUP_WRITE_BLOCK_RECEIPT_FIELDS_INVALID");
  if (value.version !== WRITE_BLOCK_RECEIPT_VERSION || value.environmentId !== input.target.environmentId ||
      value.projectRef !== input.target.projectRef || value.targetSha256 !== input.binding.targetSha256 ||
      value.releaseGitSha !== input.target.releaseGitSha || value.koyebServiceId !== input.binding.koyeb.serviceId ||
      value.koyebRevisionId !== input.binding.koyeb.revisionId || value.traffic !== "BLOCKED" || value.writes !== "BLOCKED" ||
      value.producerArtifactDigestSha256 !== input.binding.koyeb.producerArtifactDigestSha256 ||
      value.signerPublicKeySha256 !== input.binding.koyeb.signerPublicKeySha256) {
    throw new Error("BACKUP_WRITE_BLOCK_RECEIPT_BINDING_MISMATCH");
  }
  for (const field of ["inFlight", "pending", "creating"] as const) {
    if (asSafeInteger(value[field], "BACKUP_DRAIN_STATE_INVALID", 0, 0) !== 0) throw new Error("BACKUP_DRAIN_NOT_ZERO");
  }
  const issuedAt = asIsoTimestamp(value.issuedAt, "BACKUP_WRITE_BLOCK_ISSUED_AT_INVALID");
  const expiresAt = asIsoTimestamp(value.expiresAt, "BACKUP_WRITE_BLOCK_EXPIRES_AT_INVALID");
  assertBoundedWindow(issuedAt, expiresAt, input.now ?? new Date(), 15 * 60_000, "BACKUP_WRITE_BLOCK_RECEIPT");
  const receiptDigestSha256 = hash(value.receiptDigestSha256, "BACKUP_WRITE_BLOCK_RECEIPT_DIGEST_INVALID");
  if (receiptDigestSha256 !== input.confirmReceiptSha256) throw new Error("BACKUP_WRITE_BLOCK_RECEIPT_CONFIRMATION_MISMATCH");
  if (!input.publicKeyPem || /PRIVATE KEY/.test(input.publicKeyPem) || input.publicKeyPem.length > 32 * 1024) {
    throw new Error("BACKUP_WRITE_BLOCK_PUBLIC_KEY_INVALID");
  }
  const publicKey = createPublicKey(input.publicKeyPem);
  const publicKeyDigest = sha256Hex(publicKey.export({ type: "spki", format: "der" }));
  if (publicKeyDigest !== input.confirmPublicKeySha256 || publicKeyDigest !== input.binding.koyeb.signerPublicKeySha256) {
    throw new Error("BACKUP_WRITE_BLOCK_PUBLIC_KEY_MISMATCH");
  }
  const { receiptDigestSha256: _digest, signature, ...payload } = value;
  if (canonicalSha256({ ...payload, signature }) !== receiptDigestSha256 || typeof signature !== "string" ||
      !/^[A-Za-z0-9_-]{40,2048}$/.test(signature) ||
      !verify("sha256", Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(signature, "base64url"))) {
    throw new Error("BACKUP_WRITE_BLOCK_RECEIPT_SIGNATURE_INVALID");
  }
  return { receiptDigestSha256, inFlight: 0, pending: 0, creating: 0 };
}

export function encryptBackupEnvelope(input: {
  plaintext: Uint8Array;
  key: Buffer;
  keyId: string;
  cutId: string;
  locator: string;
  nonce?: Buffer;
}): Buffer {
  if (input.key.byteLength !== 32 || !UUID.test(input.cutId) || !safeLocator(input.locator)) throw new Error("BACKUP_ENVELOPE_INPUT_INVALID");
  const nonce = input.nonce ?? randomBytes(12);
  if (nonce.byteLength !== 12) throw new Error("BACKUP_ENVELOPE_NONCE_INVALID");
  const plaintext = Buffer.from(input.plaintext);
  const plaintextSha256 = sha256Hex(plaintext);
  const aad = canonicalJson({ version: BACKUP_ENVELOPE_VERSION, cutId: input.cutId, locator: input.locator, plaintextSha256 });
  const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(canonicalJson({
    version: BACKUP_ENVELOPE_VERSION,
    algorithm: "AES-256-GCM",
    keyId: input.keyId,
    cutId: input.cutId,
    locator: input.locator,
    plaintextSha256,
    plaintextBytes: plaintext.byteLength,
    nonceBase64: nonce.toString("base64"),
    aadBase64: Buffer.from(aad).toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64")
  }));
}

export function decryptBackupEnvelope(input: { envelope: Uint8Array; key: Buffer; expectedKeyId: string }): Buffer {
  if (!Number.isSafeInteger(input.envelope.byteLength) || input.envelope.byteLength < 1 ||
      input.envelope.byteLength > BACKUP_MAX_R2_ENVELOPE_BYTES) throw new Error("BACKUP_ENVELOPE_TOO_LARGE");
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(input.envelope).toString("utf8")); } catch { throw new Error("BACKUP_ENVELOPE_INVALID"); }
  const value = asRecord(raw, "BACKUP_ENVELOPE_INVALID");
  assertExactKeys(value, [
    "version", "algorithm", "keyId", "cutId", "locator", "plaintextSha256", "plaintextBytes", "nonceBase64", "aadBase64",
    "ciphertextBase64", "authTagBase64"
  ], "BACKUP_ENVELOPE_FIELDS_INVALID");
  if (value.version !== BACKUP_ENVELOPE_VERSION || value.algorithm !== "AES-256-GCM" || value.keyId !== input.expectedKeyId ||
      typeof value.cutId !== "string" || !UUID.test(value.cutId) || typeof value.locator !== "string" || !safeLocator(value.locator) ||
      typeof value.plaintextSha256 !== "string" || !HASH.test(value.plaintextSha256) ||
      !Number.isSafeInteger(value.plaintextBytes) || (value.plaintextBytes as number) < 0) throw new Error("BACKUP_ENVELOPE_INVALID");
  const nonce = strictBase64(value.nonceBase64, 12, "BACKUP_ENVELOPE_INVALID");
  const tag = strictBase64(value.authTagBase64, 16, "BACKUP_ENVELOPE_INVALID");
  const ciphertext = strictBase64(value.ciphertextBase64, value.plaintextBytes as number, "BACKUP_ENVELOPE_INVALID");
  const expectedAad = canonicalJson({
    version: BACKUP_ENVELOPE_VERSION,
    cutId: value.cutId,
    locator: value.locator,
    plaintextSha256: value.plaintextSha256
  });
  if (Buffer.from(asStrictString(value.aadBase64, "BACKUP_ENVELOPE_INVALID"), "base64").toString("utf8") !== expectedAad) {
    throw new Error("BACKUP_ENVELOPE_AAD_MISMATCH");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", input.key, nonce);
    decipher.setAAD(Buffer.from(expectedAad));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength !== value.plaintextBytes || sha256Hex(plaintext) !== value.plaintextSha256) {
      throw new Error("BACKUP_ENVELOPE_PLAINTEXT_MISMATCH");
    }
    return plaintext;
  } catch (error) {
    if (error instanceof Error && error.message === "BACKUP_ENVELOPE_PLAINTEXT_MISMATCH") throw error;
    throw new Error("BACKUP_ENVELOPE_AUTHENTICATION_FAILED");
  }
}

export type DatabaseChunkIndex = {
  version: "backup-database-chunk-index/v1";
  cutId: string;
  indexLocator: string;
  chunkBytes: number;
  partCount: number;
  totalPlaintextBytes: number;
  dumpHashSha256: string;
  parts: Array<{
    index: number;
    locator: string;
    plaintextBytes: number;
    plaintextSha256: string;
    envelopeBytes: number;
    envelopeSha256: string;
  }>;
};

export async function restoreDatabaseDumpFromChunkIndex(input: {
  indexEnvelope: Uint8Array;
  indexLocator: string;
  expectedCutId: string;
  expectedDumpHashSha256: string;
  key: Buffer;
  keyId: string;
  readPartEnvelope(locator: string): Promise<Uint8Array>;
  onChunk(chunk: Uint8Array, index: number): Promise<void> | void;
}) {
  if (input.indexEnvelope.byteLength > BACKUP_MAX_DATABASE_INDEX_ENVELOPE_BYTES) {
    throw new Error("BACKUP_DATABASE_INDEX_ENVELOPE_TOO_LARGE");
  }
  const indexBytes = decryptBackupEnvelope({ envelope: input.indexEnvelope, key: input.key, expectedKeyId: input.keyId });
  if (indexBytes.byteLength > BACKUP_MAX_DATABASE_INDEX_BYTES) throw new Error("BACKUP_DATABASE_INDEX_TOO_LARGE");
  let raw: unknown;
  try { raw = JSON.parse(indexBytes.toString("utf8")); } catch { throw new Error("BACKUP_DATABASE_INDEX_INVALID"); }
  const index = parseDatabaseChunkIndex(raw);
  if (index.indexLocator !== input.indexLocator || index.cutId !== input.expectedCutId ||
      index.dumpHashSha256 !== input.expectedDumpHashSha256) throw new Error("BACKUP_DATABASE_INDEX_BINDING_MISMATCH");
  const hashState = createHash("sha256");
  let totalPlaintextBytes = 0;
  const prefix = index.indexLocator.slice(0, -"index.envelope.json".length);
  for (let cursor = 0; cursor < index.parts.length; cursor += 1) {
    const part = index.parts[cursor];
    const expectedLocator = `${prefix}part-${String(cursor).padStart(6, "0")}.envelope.json`;
    if (part.index !== cursor || part.locator !== expectedLocator) throw new Error("BACKUP_DATABASE_INDEX_ORDER_INVALID");
    const envelope = Buffer.from(await input.readPartEnvelope(part.locator));
    if (envelope.byteLength !== part.envelopeBytes || sha256Hex(envelope) !== part.envelopeSha256) {
      throw new Error("BACKUP_DATABASE_PART_ENVELOPE_MISMATCH");
    }
    if (envelope.byteLength > BACKUP_MAX_DATABASE_PART_ENVELOPE_BYTES) {
      throw new Error("BACKUP_DATABASE_PART_ENVELOPE_TOO_LARGE");
    }
    const plaintext = decryptBackupEnvelope({ envelope, key: input.key, expectedKeyId: input.keyId });
    if (plaintext.byteLength !== part.plaintextBytes || sha256Hex(plaintext) !== part.plaintextSha256) {
      throw new Error("BACKUP_DATABASE_PART_PLAINTEXT_MISMATCH");
    }
    hashState.update(plaintext);
    totalPlaintextBytes += plaintext.byteLength;
    await input.onChunk(plaintext, cursor);
  }
  const dumpHashSha256 = hashState.digest("hex");
  if (totalPlaintextBytes !== index.totalPlaintextBytes || dumpHashSha256 !== index.dumpHashSha256) {
    throw new Error("BACKUP_DATABASE_OVERALL_DIGEST_MISMATCH");
  }
  return { partCount: index.partCount, totalPlaintextBytes, dumpHashSha256 };
}

export function parseDatabaseChunkIndex(value: unknown): DatabaseChunkIndex {
  const input = asRecord(value, "BACKUP_DATABASE_INDEX_INVALID");
  assertExactKeys(input, [
    "version", "cutId", "indexLocator", "chunkBytes", "partCount", "totalPlaintextBytes", "dumpHashSha256", "parts"
  ], "BACKUP_DATABASE_INDEX_FIELDS_INVALID");
  if (input.version !== "backup-database-chunk-index/v1" || typeof input.cutId !== "string" || !UUID.test(input.cutId) ||
      typeof input.indexLocator !== "string" || !safeLocator(input.indexLocator) ||
      !Number.isSafeInteger(input.chunkBytes) || (input.chunkBytes as number) < 1 ||
      (input.chunkBytes as number) > BACKUP_DATABASE_CHUNK_BYTES ||
      !Number.isSafeInteger(input.partCount) || (input.partCount as number) < 1 ||
      (input.partCount as number) > BACKUP_MAX_DATABASE_PARTS ||
      !Number.isSafeInteger(input.totalPlaintextBytes) || (input.totalPlaintextBytes as number) < 1 ||
      (input.totalPlaintextBytes as number) > BACKUP_MAX_DATABASE_DUMP_BYTES ||
      typeof input.dumpHashSha256 !== "string" || !HASH.test(input.dumpHashSha256) || !Array.isArray(input.parts) ||
      input.parts.length !== input.partCount) throw new Error("BACKUP_DATABASE_INDEX_INVALID");
  const parts = input.parts.map((raw, index) => {
    const part = asRecord(raw, "BACKUP_DATABASE_PART_INDEX_INVALID");
    assertExactKeys(part, [
      "index", "locator", "plaintextBytes", "plaintextSha256", "envelopeBytes", "envelopeSha256"
    ], "BACKUP_DATABASE_PART_INDEX_FIELDS_INVALID");
    if (part.index !== index || typeof part.locator !== "string" || !safeLocator(part.locator) ||
        !Number.isSafeInteger(part.plaintextBytes) || (part.plaintextBytes as number) < 1 ||
        (part.plaintextBytes as number) > (input.chunkBytes as number) ||
        typeof part.plaintextSha256 !== "string" || !HASH.test(part.plaintextSha256) ||
        !Number.isSafeInteger(part.envelopeBytes) || (part.envelopeBytes as number) < 1 ||
        (part.envelopeBytes as number) > BACKUP_MAX_DATABASE_PART_ENVELOPE_BYTES ||
        typeof part.envelopeSha256 !== "string" || !HASH.test(part.envelopeSha256)) {
      throw new Error("BACKUP_DATABASE_PART_INDEX_INVALID");
    }
    return {
      index,
      locator: part.locator,
      plaintextBytes: part.plaintextBytes as number,
      plaintextSha256: part.plaintextSha256,
      envelopeBytes: part.envelopeBytes as number,
      envelopeSha256: part.envelopeSha256
    };
  });
  return {
    version: "backup-database-chunk-index/v1",
    cutId: input.cutId,
    indexLocator: input.indexLocator,
    chunkBytes: input.chunkBytes as number,
    partCount: input.partCount as number,
    totalPlaintextBytes: input.totalPlaintextBytes as number,
    dumpHashSha256: input.dumpHashSha256,
    parts
  };
}

export async function createCloudflareR2BackupAdapter(input: {
  target: CloudTargetBinding;
  cutId: string;
  bucket: string;
  destination: BackupDestination;
  planDigestSha256: string;
  providerBinding: unknown;
  confirmProviderBindingSha256: string;
  encryptionKeyArtifact: unknown;
  confirmEncryptionKeySha256: string;
  writeBlockReceipt: unknown;
  confirmWriteBlockReceiptSha256: string;
  writeBlockPublicKeyPem: string;
  confirmWriteBlockPublicKeySha256: string;
  databaseUrl: string;
  pgDumpExecutable: string;
  outputRoot: string;
  sourceToken: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  dependencies?: DirectBackupDependencies;
}): Promise<{ adapter: BackupCutAdapter; persistManifest(manifest: BackupCutManifest): void }> {
  if (!UUID.test(input.cutId)) throw new Error("BACKUP_CUT_ID_INVALID");
  const now = input.dependencies?.now?.() ?? new Date();
  const binding = parseR2ProviderBinding({
    value: input.providerBinding,
    target: input.target,
    bucket: input.bucket,
    destination: input.destination,
    planDigestSha256: input.planDigestSha256,
    confirmBindingSha256: input.confirmProviderBindingSha256,
    now
  });
  const encryptionKey = parseBackupEncryptionKey({
    value: input.encryptionKeyArtifact,
    binding,
    confirmKeyArtifactSha256: input.confirmEncryptionKeySha256,
    now
  });
  const receipt = verifyExternalWriteBlockReceipt({
    value: input.writeBlockReceipt,
    target: input.target,
    binding,
    publicKeyPem: input.writeBlockPublicKeyPem,
    confirmReceiptSha256: input.confirmWriteBlockReceiptSha256,
    confirmPublicKeySha256: input.confirmWriteBlockPublicKeySha256,
    now
  });
  assertCredential(input.sourceToken, binding.source.tokenSha256, "BACKUP_SOURCE_CREDENTIAL_MISMATCH");
  assertCredential(input.r2AccessKeyId, binding.r2Credential.accessKeyIdSha256, "BACKUP_R2_CREDENTIAL_MISMATCH");
  assertCredential(input.r2SecretAccessKey, binding.r2Credential.secretAccessKeySha256, "BACKUP_R2_CREDENTIAL_MISMATCH");
  const database = parseBoundDatabaseUrl(input.databaseUrl, input.target);
  const pgDumpExecutable = validatePgDumpExecutable(input.pgDumpExecutable);
  const outputRoot = validateOutputRoot(input.outputRoot);
  const databaseChunkBytes = input.dependencies?.databaseChunkBytes ?? BACKUP_DATABASE_CHUNK_BYTES;
  if (!Number.isSafeInteger(databaseChunkBytes) || databaseChunkBytes < 1 || databaseChunkBytes > BACKUP_DATABASE_CHUNK_BYTES) {
    throw new Error("BACKUP_DATABASE_CHUNK_SIZE_INVALID");
  }

  const createR2Io = input.dependencies?.createR2Io ?? ((request) => createDefaultR2Io(request, {
    loadModule: input.dependencies?.loadR2Module
  }));
  const r2 = await createR2Io({
    binding,
    accessKeyId: input.r2AccessKeyId,
    secretAccessKey: input.r2SecretAccessKey
  });
  const prisma = await (input.dependencies?.createPrismaIo ?? createDefaultPrismaIo)(input.databaseUrl, input.target);
  const sourceReader = input.dependencies?.readSourceBody ?? ((request) => readDefaultSupabaseSourceBody(request, {
    fetchImpl: input.dependencies?.fetchSource
  }));
  const sourceInspector = input.dependencies?.inspectSourceObject ?? inspectDefaultSupabaseSourceObject;
  const pgDump = input.dependencies?.runPgDump ?? runDefaultPgDump;
  const nonce = input.dependencies?.randomBytes ?? randomBytes;
  const usedNonces = new Set<string>();
  let cutRoot = "";

  const ensureCutRoot = (cutId: string) => {
    if (cutRoot) return cutRoot;
    cutRoot = path.join(outputRoot, `backup-cut-${cutId}`);
    mkdirSync(cutRoot, { recursive: false, mode: 0o700 });
    return cutRoot;
  };
  const putEncrypted = async (cutId: string, locator: string, plaintext: Uint8Array) => {
    const currentNonce = nonce(12);
    const nonceKey = currentNonce.toString("hex");
    if (usedNonces.has(nonceKey)) throw new Error("BACKUP_ENVELOPE_NONCE_REUSE");
    usedNonces.add(nonceKey);
    const envelope = encryptBackupEnvelope({
      plaintext,
      key: encryptionKey.key,
      keyId: encryptionKey.keyId,
      cutId,
      locator,
      nonce: currentNonce
    });
    if (envelope.byteLength > maximumR2EnvelopeBytesForLocator(locator)) {
      throw new Error("BACKUP_ENVELOPE_TOO_LARGE");
    }
    if (await r2.inspect(locator) !== "MISSING") throw new Error("BACKUP_R2_NO_OVERWRITE_VIOLATION");
    await r2.putNoOverwrite(locator, envelope);
    const stored = Buffer.from(await r2.read(locator));
    if (stored.byteLength !== envelope.byteLength || sha256Hex(stored) !== sha256Hex(envelope)) {
      throw new Error("BACKUP_R2_ENVELOPE_VERIFY_MISMATCH");
    }
    const decrypted = decryptBackupEnvelope({ envelope: stored, key: encryptionKey.key, expectedKeyId: encryptionKey.keyId });
    if (sha256Hex(decrypted) !== sha256Hex(plaintext)) throw new Error("BACKUP_R2_VERIFY_MISMATCH");
    return { envelopeBytes: stored.byteLength, envelopeSha256: sha256Hex(stored) };
  };

  const adapter: BackupCutAdapter = {
    verifyExternalWriteBlock: async (target) => {
      assertSameTarget(target, input.target);
      return { receiptDigestSha256: receipt.receiptDigestSha256 };
    },
    requestExternalWriteRelease: async (target, receiptDigestSha256) => {
      assertSameTarget(target, input.target);
      const root = cutRoot || ensureCutRoot(input.cutId);
      writeExclusiveJson(path.join(root, "release-writes-request.json"), {
        version: "backup-write-release-request/v1",
        requestId: randomUUID(),
        targetSha256: binding.targetSha256,
        writeBlockReceiptSha256: receiptDigestSha256,
        action: "RELEASE_WRITES_REQUESTED",
        externalResult: "NOT_RUN",
        issuedAt: (input.dependencies?.now?.() ?? new Date()).toISOString()
      });
      await prisma.disconnect();
    },
    readDrainState: async (target) => {
      assertSameTarget(target, input.target);
      return { inFlight: receipt.inFlight, pending: receipt.pending, creating: receipt.creating };
    },
    captureDatabaseCut: async (target, cutId): Promise<DatabaseCut> => {
      assertSameTarget(target, input.target);
      if (cutId !== input.cutId) throw new Error("BACKUP_CUT_ID_BINDING_MISMATCH");
      await prisma.assertIdentity(input.target);
      const state = await prisma.databaseState(input.target);
      const root = ensureCutRoot(cutId);
      const dumpFile = path.join(root, "database.dump");
      const descriptor = openSync(dumpFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      closeSync(descriptor);
      try {
        await pgDump({ executable: pgDumpExecutable, target: input.target, password: database.password, outputFile: dumpFile });
        const dumpSize = statSync(dumpFile).size;
        if (dumpSize < 1) throw new Error("BACKUP_PG_DUMP_EMPTY");
        if (dumpSize > BACKUP_MAX_DATABASE_DUMP_BYTES) throw new Error("BACKUP_PG_DUMP_SIZE_LIMIT");
        const prefix = `${input.destination.destinationId}/${cutId}/database/`;
        const indexLocator = `${prefix}index.envelope.json`;
        const parts: DatabaseChunkIndex["parts"] = [];
        const dumpHash = createHash("sha256");
        let totalPlaintextBytes = 0;
        let descriptor: number | undefined;
        try {
          descriptor = openSync(dumpFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          for (let index = 0; totalPlaintextBytes < dumpSize; index += 1) {
            if (index >= BACKUP_MAX_DATABASE_PARTS) throw new Error("BACKUP_DATABASE_PART_COUNT_LIMIT");
            const remaining = dumpSize - totalPlaintextBytes;
            const buffer = Buffer.allocUnsafe(Math.min(databaseChunkBytes, remaining));
            const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, totalPlaintextBytes);
            if (bytesRead < 1) throw new Error("BACKUP_PG_DUMP_READ_TRUNCATED");
            const chunk = buffer.subarray(0, bytesRead);
            const locator = `${prefix}part-${String(index).padStart(6, "0")}.envelope.json`;
            const envelope = await putEncrypted(cutId, locator, chunk);
            dumpHash.update(chunk);
            parts.push({
              index,
              locator,
              plaintextBytes: chunk.byteLength,
              plaintextSha256: sha256Hex(chunk),
              envelopeBytes: envelope.envelopeBytes,
              envelopeSha256: envelope.envelopeSha256
            });
            totalPlaintextBytes += chunk.byteLength;
          }
        } finally {
          if (descriptor !== undefined) closeSync(descriptor);
        }
        if (totalPlaintextBytes !== dumpSize || parts.length < 1) throw new Error("BACKUP_PG_DUMP_READ_TRUNCATED");
        const dumpHashSha256 = dumpHash.digest("hex");
        const index: DatabaseChunkIndex = {
          version: "backup-database-chunk-index/v1",
          cutId,
          indexLocator,
          chunkBytes: databaseChunkBytes,
          partCount: parts.length,
          totalPlaintextBytes,
          dumpHashSha256,
          parts
        };
        const indexBytes = Buffer.from(canonicalJson(index));
        if (indexBytes.byteLength > BACKUP_MAX_DATABASE_INDEX_BYTES) throw new Error("BACKUP_DATABASE_INDEX_TOO_LARGE");
        await putEncrypted(cutId, indexLocator, indexBytes);
        return {
          backupId: indexLocator,
          watermark: state.watermark,
          dumpHashSha256,
          migrationHistoryDigestSha256: state.migrationHistoryDigestSha256,
          kpiDigestSha256: state.kpiDigestSha256
        };
      } finally {
        try { unlinkSync(dumpFile); } catch { /* Preserve the failure code; cut directory remains private. */ }
      }
    },
    listReferences: async (target) => {
      assertSameTarget(target, input.target);
      await prisma.assertIdentity(input.target);
      const rows = await prisma.listReferenceRows();
      const references: BackupReference[] = [];
      const inspectedSizes = new Map<string, number>();
      for (const row of rows) {
        if (!BACKUP_REFERENCE_MODELS.includes(row.model) || !UUID.test(row.recordId) || !HASH.test(row.hashSha256)) {
          throw new Error("BACKUP_PRISMA_REFERENCE_INVALID");
        }
        let byteSize = inspectedSizes.get(row.key);
        if (byteSize === undefined) {
          byteSize = (await sourceInspector({
            target: input.target, bucket: input.bucket, key: row.key, token: input.sourceToken
          })).byteSize;
          assertSourceObjectSize(byteSize);
          inspectedSizes.set(row.key, byteSize);
        }
        if (row.byteSize !== undefined && row.byteSize !== byteSize) throw new Error("BACKUP_SOURCE_BODY_MISMATCH");
        references.push({
          model: row.model,
          recordId: row.recordId,
          field: row.field,
          provider: "supabase",
          key: row.key,
          hashSha256: row.hashSha256,
          byteSize,
          state: row.state
        });
      }
      return references;
    },
    copyObjectsNoOverwrite: async ({ target, cutId, references }) => {
      assertSameTarget(target, input.target);
      const output: BackedUpObject[] = [];
      const unique = new Map(references.map((reference) => [`${reference.provider}:${reference.key}`, reference]));
      for (const reference of unique.values()) {
        assertSourceObjectSize(reference.byteSize);
        const sourceBody = await sourceReader({
          target: input.target, bucket: input.bucket, key: reference.key, token: input.sourceToken
        });
        assertSourceObjectSize(sourceBody.byteLength);
        const body = Buffer.from(sourceBody);
        if (body.byteLength !== reference.byteSize || sha256Hex(body) !== reference.hashSha256) {
          throw new Error("BACKUP_SOURCE_BODY_MISMATCH");
        }
        const locator = `${input.destination.destinationId}/${cutId}/objects/${reference.provider}/${reference.key}.envelope.json`;
        await putEncrypted(cutId, locator, body);
        output.push({
          provider: reference.provider,
          key: reference.key,
          byteSize: body.byteLength,
          hashSha256: reference.hashSha256,
          backupLocator: locator
        });
      }
      return output;
    },
    readDatabaseWatermark: async (target) => {
      assertSameTarget(target, input.target);
      await prisma.assertIdentity(input.target);
      return (await prisma.databaseState(input.target)).watermark;
    }
  };
  return {
    adapter,
    persistManifest: (manifest) => {
      if (!cutRoot || manifest.cutId !== path.basename(cutRoot).slice("backup-cut-".length)) {
        throw new Error("BACKUP_MANIFEST_OUTPUT_BINDING_MISMATCH");
      }
      writeExclusiveJson(path.join(cutRoot, "backup-cut-manifest.json"), manifest);
    }
  };
}

async function createDefaultR2Io(input: {
  binding: R2ProviderBinding;
  accessKeyId: string;
  secretAccessKey: string;
}, dependencies: { loadModule?: () => Promise<unknown> } = {}): Promise<R2ObjectIo> {
  let loaded: unknown;
  try {
    const exactModuleName = "@aws-sdk/client-s3";
    loaded = await (dependencies.loadModule ?? (() => import(exactModuleName)))();
  } catch {
    throw new Error("BACKUP_R2_MODULE_UNAVAILABLE");
  }
  if (typeof loaded !== "object" || loaded === null) throw new Error("BACKUP_R2_MODULE_INVALID");
  const sdk = loaded as Record<string, unknown>;
  const S3Client = sdk.S3Client;
  const HeadObjectCommand = sdk.HeadObjectCommand;
  const PutObjectCommand = sdk.PutObjectCommand;
  const GetObjectCommand = sdk.GetObjectCommand;
  if (typeof S3Client !== "function" || typeof HeadObjectCommand !== "function" ||
      typeof PutObjectCommand !== "function" || typeof GetObjectCommand !== "function") {
    throw new Error("BACKUP_R2_MODULE_INVALID");
  }
  type S3Constructor = new (input: unknown) => unknown;
  const Client = S3Client as unknown as S3Constructor;
  const client = new Client({
    endpoint: input.binding.destination.endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey }
  } as never) as unknown as { send?: (command: unknown) => Promise<Record<string, unknown>> };
  if (!client || typeof client.send !== "function") throw new Error("BACKUP_R2_MODULE_INVALID");
  const send = client.send.bind(client);
  const Head = HeadObjectCommand as S3Constructor;
  const Put = PutObjectCommand as S3Constructor;
  const Get = GetObjectCommand as S3Constructor;
  return {
    inspect: async (key) => {
      try {
        await send(new Head({ Bucket: input.binding.destination.bucket, Key: key }));
        return "FOUND";
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return "MISSING";
        throw new Error("BACKUP_R2_HEAD_FAILED");
      }
    },
    putNoOverwrite: async (key, body) => {
      try {
        await send(new Put({
          Bucket: input.binding.destination.bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
          IfNoneMatch: "*"
        }));
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 409 || status === 412) throw new Error("BACKUP_R2_NO_OVERWRITE_VIOLATION");
        throw new Error("BACKUP_R2_PUT_FAILED");
      }
    },
    read: async (key) => {
      const response = await send(new Get({ Bucket: input.binding.destination.bucket, Key: key }));
      return readBoundedR2GetResponse(response, key);
    }
  };
}

export async function readBoundedR2GetResponse(response: Record<string, unknown>, key: string): Promise<Buffer> {
  return readBoundedProviderBody({
    body: response.Body,
    contentLength: response.ContentLength,
    maximumBytes: maximumR2EnvelopeBytesForLocator(key),
    errorPrefix: "BACKUP_R2_GET"
  });
}

export function maximumR2EnvelopeBytesForLocator(key: string): number {
  if (!safeLocator(key) || !key.endsWith(".envelope.json")) throw new Error("BACKUP_R2_GET_KEY_INVALID");
  if (key.includes("/objects/")) return BACKUP_MAX_SOURCE_ENVELOPE_BYTES;
  if (key.endsWith("/database/index.envelope.json")) return BACKUP_MAX_DATABASE_INDEX_ENVELOPE_BYTES;
  if (/\/database\/part-\d{6}\.envelope\.json$/.test(key)) return BACKUP_MAX_DATABASE_PART_ENVELOPE_BYTES;
  throw new Error("BACKUP_R2_GET_KEY_INVALID");
}

async function createDefaultPrismaIo(databaseUrl: string, target: CloudTargetBinding): Promise<BackupPrismaIo> {
  const moduleName = "@prisma/client";
  const prismaModule = await import(moduleName) as unknown as { PrismaClient?: new (options: unknown) => Record<string, unknown> };
  if (!prismaModule.PrismaClient) throw new Error("BACKUP_PRISMA_MODULE_INVALID");
  const client = new prismaModule.PrismaClient({ datasourceUrl: databaseUrl }) as Record<string, unknown>;
  const query = async (sql: string, ...values: unknown[]) => {
    const execute = client.$queryRawUnsafe as ((sql: string, ...values: unknown[]) => Promise<unknown[]>) | undefined;
    if (!execute) throw new Error("BACKUP_PRISMA_CLIENT_INVALID");
    return execute.call(client, sql, ...values);
  };
  const delegateRows = async (delegateName: string, select: Record<string, boolean>) => {
    const delegate = client[delegateName] as { findMany?: (input: unknown) => Promise<Record<string, unknown>[]> } | undefined;
    if (!delegate?.findMany) throw new Error("BACKUP_PRISMA_MODEL_UNAVAILABLE");
    return delegate.findMany({ select });
  };
  const mappedRows = async () => {
    const output: Awaited<ReturnType<BackupPrismaIo["listReferenceRows"]>> = [];
    const uploadModels = [
      ["UploadBatch", "uploadBatch"], ["Cafe24UploadBatch", "cafe24UploadBatch"], ["CoupangUploadBatch", "coupangUploadBatch"]
    ] as const;
    for (const [model, delegate] of uploadModels) {
      const rows = await delegateRows(delegate, { id: true, storedFilePath: true, fileHashSha256: true, status: true });
      for (const row of rows) if (typeof row.storedFilePath === "string") output.push({
        model,
        recordId: String(row.id),
        field: "storedFilePath",
        key: row.storedFilePath,
        hashSha256: String(row.fileHashSha256),
        state: String(row.status)
      });
    }
    output.push(...mapReportExportReferences(
      await delegateRows("reportExport", { id: true, filePath: true, fileHashSha256: true, status: true })
    ));
    for (const row of await delegateRows("storageTombstone", {
      id: true, provider: true, originalKey: true, trashKey: true, hashSha256: true, byteSize: true, state: true
    })) {
      if (row.provider !== "supabase") throw new Error("BACKUP_SOURCE_PROVIDER_INVALID");
      for (const field of ["originalKey", "trashKey"] as const) output.push({
        model: "StorageTombstone", recordId: String(row.id), field, key: String(row[field]),
        hashSha256: String(row.hashSha256), byteSize: Number(row.byteSize), state: String(row.state)
      });
    }
    return output;
  };
  return {
    assertIdentity: async () => {
      const rows = await query(
        "SELECT current_user AS current_user, pg_has_role(current_user, $1, 'member') AS has_required_role, current_database() AS database_name, current_schema() AS schema_name",
        target.database.requiredRole
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row || row.current_user !== target.database.expectedCurrentUser || row.has_required_role !== true ||
          row.database_name !== target.database.name || row.schema_name !== target.database.schema) {
        throw new Error("BACKUP_DATABASE_RUNTIME_IDENTITY_MISMATCH");
      }
    },
    databaseState: async () => {
      const watermarkRows = await query("SELECT pg_current_wal_lsn()::text AS watermark");
      const migrationRows = await query("SELECT migration_name, checksum, finished_at FROM _prisma_migrations ORDER BY migration_name");
      const schema = `"${target.database.schema}"`;
      const kpiRows = await query([
        "SELECT",
        `(SELECT count(*)::text FROM ${schema}.upload_batches) AS meta_uploads,`,
        `(SELECT count(*)::text FROM ${schema}.cafe24_upload_batches) AS cafe24_uploads,`,
        `(SELECT count(*)::text FROM ${schema}.coupang_upload_batches) AS coupang_uploads,`,
        `(SELECT count(*)::text FROM ${schema}.report_exports) AS report_exports,`,
        `(SELECT count(*)::text FROM ${schema}.storage_tombstones) AS storage_tombstones`
      ].join(" "));
      const watermark = String((watermarkRows[0] as Record<string, unknown> | undefined)?.watermark ?? "");
      if (!watermark) throw new Error("BACKUP_DATABASE_WATERMARK_INVALID");
      return {
        watermark,
        migrationHistoryDigestSha256: canonicalSha256(migrationRows),
        kpiDigestSha256: canonicalSha256(kpiRows)
      };
    },
    listReferenceRows: mappedRows,
    disconnect: async () => {
      const disconnect = client.$disconnect as (() => Promise<void>) | undefined;
      if (disconnect) await disconnect.call(client);
    }
  };
}

export function mapReportExportReferences(
  rows: Record<string, unknown>[]
): Awaited<ReturnType<BackupPrismaIo["listReferenceRows"]>> {
  const output: Awaited<ReturnType<BackupPrismaIo["listReferenceRows"]>> = [];
  for (const row of rows) {
    const hasFilePath = row.filePath !== null && row.filePath !== undefined;
    const hasFileHash = row.fileHashSha256 !== null && row.fileHashSha256 !== undefined;
    if (!hasFilePath && !hasFileHash) continue;
    if (typeof row.id !== "string" || !UUID.test(row.id) ||
        typeof row.filePath !== "string" || !safeLocator(row.filePath) ||
        typeof row.fileHashSha256 !== "string" || !HASH.test(row.fileHashSha256) ||
        typeof row.status !== "string" || !row.status) {
      throw new Error("BACKUP_PRISMA_REPORT_EXPORT_REFERENCE_INVALID");
    }
    output.push({
      model: "ReportExport",
      recordId: row.id,
      field: "filePath",
      key: row.filePath,
      hashSha256: row.fileHashSha256,
      state: row.status
    });
  }
  return output;
}

type BoundedProviderBody = {
  getReader?: () => {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel?(reason?: unknown): Promise<unknown> | unknown;
    releaseLock?(): void;
  };
  cancel?(reason?: unknown): Promise<unknown> | unknown;
  destroy?(): void;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
};

export async function readBoundedProviderBody(input: {
  body: unknown;
  contentLength?: unknown;
  maximumBytes: number;
  errorPrefix: "BACKUP_SOURCE" | "BACKUP_R2_GET";
  allocateBuffer?: (bytes: number) => Buffer;
}): Promise<Buffer> {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1 ||
      input.maximumBytes > BACKUP_MAX_R2_ENVELOPE_BYTES) {
    throw new Error(`${input.errorPrefix}_BODY_LIMIT_INVALID`);
  }
  const body = providerBody(input.body);
  let expectedBytes: number | undefined;
  try {
    expectedBytes = parseOptionalContentLength(input.contentLength, input.errorPrefix);
  } catch (error) {
    cancelUnconsumedProviderBody(body, boundedReadError(error, input.errorPrefix));
    throw error;
  }
  if (expectedBytes !== undefined && expectedBytes > input.maximumBytes) {
    cancelUnconsumedProviderBody(body, new Error(`${input.errorPrefix}_BODY_TOO_LARGE`));
    throw new Error(`${input.errorPrefix}_BODY_TOO_LARGE`);
  }
  if (!body) throw new Error(`${input.errorPrefix}_BODY_STREAM_INVALID`);
  const capacity = expectedBytes ?? input.maximumBytes;
  let output: Buffer;
  try {
    output = (input.allocateBuffer ?? Buffer.allocUnsafe)(capacity);
  } catch {
    cancelUnconsumedProviderBody(body, new Error(`${input.errorPrefix}_BODY_ALLOCATION_FAILED`));
    throw new Error(`${input.errorPrefix}_BODY_ALLOCATION_FAILED`);
  }
  if (!Buffer.isBuffer(output) || output.byteLength !== capacity) {
    cancelUnconsumedProviderBody(body, new Error(`${input.errorPrefix}_BODY_ALLOCATION_INVALID`));
    throw new Error(`${input.errorPrefix}_BODY_ALLOCATION_INVALID`);
  }
  let totalBytes = 0;
  const accept = (value: unknown) => {
    if (!(value instanceof Uint8Array) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1) {
      throw new Error(`${input.errorPrefix}_BODY_CHUNK_INVALID`);
    }
    if (totalBytes > output.byteLength - value.byteLength) {
      throw new Error(expectedBytes === undefined
        ? `${input.errorPrefix}_BODY_TOO_LARGE`
        : `${input.errorPrefix}_CONTENT_LENGTH_MISMATCH`);
    }
    output.set(value, totalBytes);
    totalBytes += value.byteLength;
  };

  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    if (!reader || typeof reader.read !== "function") throw new Error(`${input.errorPrefix}_BODY_STREAM_INVALID`);
    try {
      while (true) {
        const result = await reader.read();
        if (!result || typeof result.done !== "boolean") throw new Error(`${input.errorPrefix}_BODY_CHUNK_INVALID`);
        if (result.done) break;
        accept(result.value);
      }
    } catch (error) {
      try {
        const cancellation = reader.cancel?.(error);
        if (cancellation) void Promise.resolve(cancellation).catch(() => undefined);
      } catch { /* Preserve the bounded read failure. */ }
      throw boundedReadError(error, input.errorPrefix);
    } finally {
      try { reader.releaseLock?.(); } catch { /* No further reads are permitted. */ }
    }
  } else if (typeof body[Symbol.asyncIterator] === "function") {
    const createIterator = body[Symbol.asyncIterator]!;
    const iterator = createIterator.call(body);
    if (!iterator || typeof iterator.next !== "function") throw new Error(`${input.errorPrefix}_BODY_STREAM_INVALID`);
    try {
      while (true) {
        const result = await iterator.next();
        if (!result || typeof result.done !== "boolean") throw new Error(`${input.errorPrefix}_BODY_CHUNK_INVALID`);
        if (result.done) break;
        accept(result.value);
      }
    } catch (error) {
      try {
        const cancellation = iterator.return?.();
        if (cancellation) void Promise.resolve(cancellation).catch(() => undefined);
      } catch { /* Preserve the bounded read failure. */ }
      try { body.destroy?.(); } catch { /* Preserve the bounded read failure. */ }
      throw boundedReadError(error, input.errorPrefix);
    }
  } else {
    cancelUnconsumedProviderBody(body, new Error(`${input.errorPrefix}_BODY_STREAM_INVALID`));
    throw new Error(`${input.errorPrefix}_BODY_STREAM_INVALID`);
  }

  if (expectedBytes !== undefined && totalBytes !== expectedBytes) {
    cancelUnconsumedProviderBody(body, new Error(`${input.errorPrefix}_CONTENT_LENGTH_MISMATCH`));
    throw new Error(`${input.errorPrefix}_CONTENT_LENGTH_MISMATCH`);
  }
  return expectedBytes === undefined ? Buffer.from(output.subarray(0, totalBytes)) : output;
}

export async function readDefaultSupabaseSourceBody(input: {
  target: CloudTargetBinding;
  bucket: string;
  key: string;
  token: string;
}, dependencies: { fetchImpl?: typeof fetch } = {}): Promise<Uint8Array> {
  const controller = new AbortController();
  const response = await (dependencies.fetchImpl ?? fetch)(sourceObjectUrl(input), {
    method: "GET",
    headers: { authorization: `Bearer ${input.token}`, apikey: input.token },
    signal: controller.signal
  });
  if (response.status !== 200) {
    controller.abort();
    cancelUnconsumedProviderBody(providerBody(response.body), new Error("BACKUP_SOURCE_READ_FAILED"));
    throw new Error("BACKUP_SOURCE_READ_FAILED");
  }
  try {
    return await readBoundedProviderBody({
      body: response.body,
      contentLength: response.headers.get("content-length"),
      maximumBytes: BACKUP_MAX_SOURCE_OBJECT_BYTES,
      errorPrefix: "BACKUP_SOURCE"
    });
  } catch (error) {
    controller.abort();
    throw error;
  }
}

function providerBody(value: unknown): BoundedProviderBody | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  return value as BoundedProviderBody;
}

function parseOptionalContentLength(value: unknown, prefix: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) parsed = Number(value);
  else if (typeof value === "string" && /^\d+$/.test(value)) parsed = Number(value);
  else throw new Error(`${prefix}_CONTENT_LENGTH_INVALID`);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${prefix}_CONTENT_LENGTH_INVALID`);
  return parsed;
}

function boundedReadError(error: unknown, prefix: string): Error {
  if (error instanceof Error && error.message.startsWith(`${prefix}_`)) return error;
  return new Error(`${prefix}_BODY_READ_FAILED`);
}

function cancelUnconsumedProviderBody(body: BoundedProviderBody | undefined, reason: Error) {
  if (!body) return;
  if (typeof body.cancel === "function") {
    try {
      const cancellation = body.cancel(reason);
      if (cancellation) void Promise.resolve(cancellation).catch(() => undefined);
    } catch { /* Cancellation is best effort after fail-closed rejection. */ }
    return;
  }
  if (typeof body.destroy === "function") {
    try { body.destroy(); } catch { /* Cancellation is best effort after fail-closed rejection. */ }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const createIterator = body[Symbol.asyncIterator]!;
    try {
      const cancellation = createIterator.call(body).return?.();
      if (cancellation) void Promise.resolve(cancellation).catch(() => undefined);
    } catch { /* Cancellation is best effort. */ }
  }
}

async function inspectDefaultSupabaseSourceObject(input: {
  target: CloudTargetBinding;
  bucket: string;
  key: string;
  token: string;
}): Promise<{ byteSize: number }> {
  const response = await fetch(sourceObjectUrl(input), {
    method: "HEAD",
    headers: { authorization: `Bearer ${input.token}`, apikey: input.token }
  });
  if (response.status !== 200) throw new Error("BACKUP_SOURCE_HEAD_FAILED");
  const raw = response.headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw)) throw new Error("BACKUP_SOURCE_SIZE_INVALID");
  const byteSize = Number(raw);
  assertSourceObjectSize(byteSize);
  return { byteSize };
}

function sourceObjectUrl(input: { target: CloudTargetBinding; bucket: string; key: string }) {
  if (!safeLocator(input.key) || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.bucket)) {
    throw new Error("BACKUP_SOURCE_KEY_INVALID");
  }
  const encoded = input.key.split("/").map(encodeURIComponent).join("/");
  return `${input.target.supabaseOrigin}/storage/v1/object/authenticated/${encodeURIComponent(input.bucket)}/${encoded}`;
}

function assertSourceObjectSize(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > BACKUP_MAX_SOURCE_OBJECT_BYTES) {
    throw new Error("BACKUP_SOURCE_BODY_TOO_LARGE");
  }
}

export async function runDefaultPgDump(input: {
  executable: string;
  target: CloudTargetBinding;
  password: string;
  outputFile: string;
}, supervisor: {
  spawnProcess?: typeof spawn;
  terminateProcessTree?: (child: ChildProcess) => void | (() => void);
  timeoutMs?: number;
  maximumDumpBytes?: number;
  pollIntervalMs?: number;
  platform?: NodeJS.Platform;
  availableFilesystemBytes?: (directory: string) => bigint;
} = {}): Promise<void> {
  const args = [
    "--host", input.target.database.host,
    "--port", String(input.target.database.port),
    "--username", input.target.database.loginUser,
    "--dbname", input.target.database.name,
    "--schema", input.target.database.schema,
    "--format", "custom",
    "--no-owner",
    "--no-acl",
    "--file", input.outputFile
  ];
  const timeoutMs = supervisor.timeoutMs ?? BACKUP_PG_DUMP_TIMEOUT_MS;
  const maximumDumpBytes = supervisor.maximumDumpBytes ?? BACKUP_MAX_DATABASE_DUMP_BYTES;
  const pollIntervalMs = supervisor.pollIntervalMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maximumDumpBytes) || maximumDumpBytes < 1 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error("BACKUP_PG_DUMP_SUPERVISOR_INVALID");
  let availableBytes: bigint;
  try {
    availableBytes = (supervisor.availableFilesystemBytes ?? readAvailableFilesystemBytes)(path.dirname(input.outputFile));
  } catch {
    throw new Error("BACKUP_PG_DUMP_FILESYSTEM_PREFLIGHT_FAILED");
  }
  if (typeof availableBytes !== "bigint" || availableBytes <
      BigInt(maximumDumpBytes) + BigInt(BACKUP_PG_DUMP_FREE_SPACE_RESERVE_BYTES)) {
    throw new Error("BACKUP_PG_DUMP_FREE_SPACE_INSUFFICIENT");
  }
  const platform = supervisor.platform ?? process.platform;
  const command = platform === "linux" ? BACKUP_PG_DUMP_LINUX_LIMIT_EXECUTABLE : input.executable;
  const commandArgs = platform === "linux"
    ? [`--fsize=${maximumDumpBytes}:${maximumDumpBytes}`, "--", input.executable, ...args]
    : args;
  await new Promise<void>((resolve, reject) => {
    const child = (supervisor.spawnProcess ?? spawn)(command, commandArgs, {
      shell: false,
      detached: platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: buildPgDumpEnvironment(input.password)
    });
    let stderr = "";
    let pendingFailure: Error | undefined;
    let settled = false;
    let forceReject: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let sizePoll: NodeJS.Timeout | undefined;
    let cancelTreeTermination: (() => void) | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (sizePoll) clearInterval(sizePoll);
      if (forceReject) clearTimeout(forceReject);
      cancelTreeTermination?.();
      cancelTreeTermination = undefined;
      if (error) reject(error); else resolve();
    };
    const failAndTerminate = (error: Error) => {
      if (pendingFailure || settled) return;
      pendingFailure = error;
      try {
        const cancel = (supervisor.terminateProcessTree ?? terminatePgDumpProcessTree)(child);
        if (typeof cancel === "function") {
          if (settled) cancel(); else cancelTreeTermination = cancel;
        }
      } catch { /* exit/error decides final result */ }
      if (settled) return;
      forceReject = setTimeout(() => finish(pendingFailure), 5_000);
      forceReject.unref?.();
    };
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const remaining = BACKUP_PG_DUMP_STDERR_MAX_BYTES - Buffer.byteLength(stderr);
      if (remaining > 0) stderr += Buffer.from(text).subarray(0, remaining).toString("utf8");
    });
    timeout = setTimeout(() => failAndTerminate(new Error("BACKUP_PG_DUMP_TIMEOUT")), timeoutMs);
    timeout.unref?.();
    sizePoll = setInterval(() => {
      try {
        if (statSync(input.outputFile).size > maximumDumpBytes) {
          failAndTerminate(new Error("BACKUP_PG_DUMP_SIZE_LIMIT"));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failAndTerminate(new Error("BACKUP_PG_DUMP_OUTPUT_INVALID"));
      }
    }, pollIntervalMs);
    sizePoll.unref?.();
    child.once("error", () => finish(pendingFailure ?? new Error("BACKUP_PG_DUMP_EXECUTION_FAILED")));
    child.once("exit", (code) => {
      if (pendingFailure) return finish(pendingFailure);
      if (code !== 0) return finish(new Error("BACKUP_PG_DUMP_FAILED"));
      let size: number;
      try { size = statSync(input.outputFile).size; } catch { return finish(new Error("BACKUP_PG_DUMP_OUTPUT_INVALID")); }
      if (size < 1) return finish(new Error("BACKUP_PG_DUMP_EMPTY"));
      if (size > maximumDumpBytes) return finish(new Error("BACKUP_PG_DUMP_SIZE_LIMIT"));
      finish();
    });
  });
}

function readAvailableFilesystemBytes(directory: string): bigint {
  const metadata = statfsSync(directory, { bigint: true });
  if (metadata.bavail < 0n || metadata.bsize < 1n) throw new Error("BACKUP_PG_DUMP_FILESYSTEM_PREFLIGHT_FAILED");
  return metadata.bavail * metadata.bsize;
}

export function buildPgDumpEnvironment(password: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!password || password.includes("\0")) throw new Error("BACKUP_PG_DUMP_PASSWORD_INVALID");
  const allowed = [
    "PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "SystemRoot", "WINDIR", "TEMP", "TMP"
  ] as const;
  const normalized = new Map(Object.entries(inherited).map(([key, value]) => [key.toLowerCase(), value]));
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = normalized.get(name.toLowerCase());
    if (typeof value === "string" && value && !value.includes("\0")) env[name] = value;
  }
  env.PGPASSWORD = password;
  env.PGSSLMODE = "verify-full";
  return env;
}

export function terminatePgDumpProcessTree(child: ChildProcess, dependencies: {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  killProcess?: (pid: number, signal: NodeJS.Signals) => boolean;
} = {}): () => void {
  let force: NodeJS.Timeout | undefined;
  let stopped = false;
  const onExit = () => cancel();
  const cancel = () => {
    if (stopped) return;
    stopped = true;
    if (force) clearTimeout(force);
    child.removeListener("exit", onExit);
  };
  child.once("exit", onExit);
  if (!child.pid) {
    child.kill("SIGKILL");
    return cancel;
  }
  const pid = child.pid;
  if ((dependencies.platform ?? process.platform) === "win32") {
    const killer = (dependencies.spawnProcess ?? spawn)("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false, windowsHide: true, stdio: "ignore"
    });
    killer.unref();
    return cancel;
  }
  const killProcess = dependencies.killProcess ?? process.kill.bind(process);
  try { killProcess(-pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  if (!stopped) {
    force = setTimeout(() => {
      if (stopped) return;
      try { killProcess(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
      cancel();
    }, 2_000);
    force.unref?.();
  }
  return cancel;
}

function parseBoundDatabaseUrl(value: string, target: CloudTargetBinding) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("BACKUP_DATABASE_URL_INVALID"); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== target.database.host ||
      Number(url.port || "5432") !== target.database.port || decodeURIComponent(url.pathname.slice(1)) !== target.database.name ||
      decodeURIComponent(url.username) !== target.database.loginUser || !url.password ||
      url.searchParams.get("sslmode") !== "verify-full" || url.searchParams.get("sslrootcert") === "") {
    throw new Error("BACKUP_DATABASE_TARGET_BINDING_MISMATCH");
  }
  return { password: decodeURIComponent(url.password) };
}

function validatePgDumpExecutable(value: string) {
  if (!path.isAbsolute(value) || !/^pg_dump(?:\.exe)?$/i.test(path.basename(value))) throw new Error("BACKUP_PG_DUMP_EXECUTABLE_INVALID");
  return value;
}

function validateOutputRoot(value: string) {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value) || resolved === path.parse(resolved).root) throw new Error("BACKUP_OUTPUT_ROOT_INVALID");
  const metadata = statSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("BACKUP_OUTPUT_ROOT_INVALID");
  return resolved;
}

function writeExclusiveJson(file: string, value: unknown) {
  writeFileSync(file, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600, encoding: "utf8" });
  const metadata = statSync(file);
  if (!metadata.isFile()) throw new Error("BACKUP_OUTPUT_FILE_INVALID");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("BACKUP_OUTPUT_FILE_MODE_INVALID");
}

function assertSameTarget(actual: CloudTargetBinding, expected: CloudTargetBinding) {
  if (targetBindingSha256(actual) !== targetBindingSha256(expected)) throw new Error("BACKUP_PROVIDER_TARGET_DRIFT");
}

function assertCredential(value: string, expectedSha256: string, code: string) {
  if (!value || value.length > 16_384 || value !== value.trim() || sha256Hex(value) !== expectedSha256) throw new Error(code);
}

function assertBoundedWindow(issuedAt: string, expiresAt: string, now: Date, maximum: number, prefix: string) {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (issued > now.getTime() + 5 * 60_000 || expires <= now.getTime()) throw new Error(`${prefix}_EXPIRED_OR_FUTURE`);
  if (expires <= issued || expires - issued > maximum) throw new Error(`${prefix}_LIFETIME_INVALID`);
}

function hash(value: unknown, code: string) {
  return asStrictString(value, code, HASH, 64);
}

function strictBase64(value: unknown, bytes: number, code: string) {
  const encoded = asStrictString(value, code, /^[A-Za-z0-9+/]+={0,2}$/, Math.ceil(bytes / 3) * 4);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== encoded) throw new Error(code);
  return decoded;
}

function safeLocator(value: string) {
  return value.length > 0 && value.length <= 2_048 && !value.startsWith("/") && !value.includes("\\") &&
    !value.includes("\0") && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}
