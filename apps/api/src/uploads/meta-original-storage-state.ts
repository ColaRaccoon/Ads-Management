import { Prisma, UploadStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { StorageIntegrityError } from "../storage/file-storage";

export type MetaOriginalStorageDomain = "META_AD_DAILY" | "META_ADSET_DAILY";

const MARKER_KEY = "originalStorage";
const MARKER_VERSION = 1;
export const META_ORIGINAL_STORAGE_LEASE_MS = 5 * 60 * 1000;
export const META_UPLOAD_MUTATION_TRANSACTION_OPTIONS = {
  maxWait: 86_400_000,
  timeout: 86_400_000
};

type PendingMarker = {
  version: number;
  domain: MetaOriginalStorageDomain;
  state: "PENDING";
  attemptId: string;
  leaseExpiresAt: string;
};

type StoredMarker = {
  version: number;
  domain: MetaOriginalStorageDomain;
  state: "STORED";
  attemptId: string;
  leaseExpiresAt: string;
};

export function pendingMetaOriginalStorageSchema(
  schema: Prisma.JsonValue | Prisma.InputJsonObject,
  domain: MetaOriginalStorageDomain,
  now = new Date(),
  attemptId: string = randomUUID()
): Prisma.JsonObject {
  const base = jsonObject(schema);
  if (!base) throw new Error("Meta upload column schema must be a JSON object.");
  return {
    ...base,
    [MARKER_KEY]: {
      version: MARKER_VERSION,
      domain,
      state: "PENDING",
      attemptId,
      leaseExpiresAt: new Date(now.getTime() + META_ORIGINAL_STORAGE_LEASE_MS).toISOString()
    } satisfies PendingMarker
  } as Prisma.JsonObject;
}

export function storedMetaOriginalStorageSchema(
  schema: Prisma.JsonValue | Prisma.InputJsonObject,
  domain: MetaOriginalStorageDomain
): Prisma.JsonObject {
  const base = jsonObject(schema);
  if (!base) throw new Error("Meta upload column schema must be a JSON object.");
  const current = storageMarker(schema);
  if (
    !current ||
    current.version !== MARKER_VERSION ||
    current.domain !== domain ||
    current.state !== "PENDING" ||
    typeof current.attemptId !== "string" ||
    typeof current.leaseExpiresAt !== "string"
  ) {
    throw new Error("Meta upload storage reservation is invalid.");
  }
  return {
    ...base,
    [MARKER_KEY]: {
      version: MARKER_VERSION,
      domain,
      state: "STORED",
      attemptId: current.attemptId,
      leaseExpiresAt: current.leaseExpiresAt
    } satisfies StoredMarker
  } as Prisma.JsonObject;
}

export function isRetryableMetaOriginalStoragePending(
  schema: Prisma.JsonValue,
  domain: MetaOriginalStorageDomain,
  status: UploadStatus,
  now = new Date()
) {
  const marker = storageMarker(schema);
  if (
    !marker ||
    marker.version !== MARKER_VERSION ||
    marker.domain !== domain ||
    (marker.state !== "PENDING" && marker.state !== "STORED") ||
    typeof marker.attemptId !== "string" ||
    typeof marker.leaseExpiresAt !== "string"
  ) {
    return false;
  }
  if (status === UploadStatus.FAILED) return marker.state === "PENDING";
  if (status !== UploadStatus.VALIDATING) return false;
  const leaseExpiresAt = Date.parse(marker.leaseExpiresAt);
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= now.getTime();
}

export async function acquireMetaUploadMutationFence(tx: Prisma.TransactionClient, batchId: string) {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 0");
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`meta-upload-batch:${batchId}`}, 0))::text AS lock_result
  `);
}

export function metaOriginalFileHashSha256(
  schema: Prisma.JsonValue | Prisma.InputJsonObject,
  legacyBatchHashSha256: string
) {
  const object = jsonObject(schema);
  const originalHash = object?.originalFileHashSha256;
  if (originalHash === undefined) return normalizedHash(legacyBatchHashSha256);
  if (typeof originalHash !== "string") throw new StorageIntegrityError();
  return normalizedHash(originalHash);
}

function storageMarker(schema: Prisma.JsonValue | Prisma.InputJsonObject) {
  const object = jsonObject(schema);
  const marker = object?.[MARKER_KEY];
  return jsonObject(marker ?? null);
}

function jsonObject(value: Prisma.JsonValue | Prisma.InputJsonObject) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, Prisma.JsonValue>;
}

function normalizedHash(value: string) {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new StorageIntegrityError();
  return normalized;
}
