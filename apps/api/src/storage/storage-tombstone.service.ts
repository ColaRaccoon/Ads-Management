import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  SecurityAuditActorType,
  SecurityAuditResult,
  StorageTombstoneDomain,
  StorageTombstoneState
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../common/prisma.service";
import { securityAuditData, writeSecurityAudit } from "../security-audit/security-audit.types";
import {
  configuredFileStorageForProvider,
  StorageDomain
} from "./configured-file-storage";
import { FileStorage, StorageIntegrityError, StorageObjectNotFoundError } from "./file-storage";
import {
  legacyLocalPathToKey,
  normalizeStorageKey,
  parseStorageReference
} from "./storage-reference";

export type RetainStorageObjectInput = {
  domain: StorageTombstoneDomain;
  businessRecordId: string;
  reference: string;
  expectedHashSha256: string;
  actorUserId?: string;
};

type ResolvedObject = { provider: string; key: string; storage: FileStorage };

const STORAGE_TRANSITION_TRANSACTION_OPTIONS = {
  maxWait: 30_000,
  timeout: 300_000
};

@Injectable()
export class StorageTombstoneService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService
  ) {}

  async retain(input: RetainStorageObjectInput) {
    const expectedHash = normalizedHash(input.expectedHashSha256);
    const resolved = this.resolveReference(input.domain, input.reference);
    if (resolved.key.startsWith("trash/")) throw new StorageIntegrityError();

    let tombstone = await this.prisma.storageTombstone.findUnique({
      where: {
        domain_businessRecordId: {
          domain: input.domain,
          businessRecordId: input.businessRecordId
        }
      }
    });
    if (tombstone) {
      if (
        tombstone.provider !== resolved.provider ||
        tombstone.originalKey !== resolved.key ||
        tombstone.hashSha256 !== expectedHash
      ) {
        throw new ConflictException({
          code: "STORAGE_TOMBSTONE_CONFLICT",
          message: "The retained object does not match the existing storage tombstone."
        });
      }
    } else {
      const source = await inspectObject(resolved.storage, resolved.key, expectedHash);
      const id = randomUUID();
      const deletedAt = new Date();
      try {
        tombstone = await this.prisma.storageTombstone.create({
          data: {
            id,
            domain: input.domain,
            provider: resolved.provider,
            originalKey: resolved.key,
            trashKey: `trash/${id}`,
            hashSha256: expectedHash,
            byteSize: BigInt(source.size),
            businessRecordId: input.businessRecordId,
            state: StorageTombstoneState.PENDING,
            deletedAt,
            purgeAfter: new Date(deletedAt.getTime() + this.retentionDays() * 86_400_000),
            actorUserId: input.actorUserId
          }
        });
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
        tombstone = await this.prisma.storageTombstone.findUnique({
          where: {
            domain_businessRecordId: {
              domain: input.domain,
              businessRecordId: input.businessRecordId
            }
          }
        });
        if (!tombstone) throw error;
        if (
          tombstone.provider !== resolved.provider ||
          tombstone.originalKey !== resolved.key ||
          tombstone.hashSha256 !== expectedHash ||
          tombstone.byteSize !== BigInt(source.size)
        ) {
          throw new ConflictException({
            code: "STORAGE_TOMBSTONE_CONFLICT",
            message: "The retained object does not match the existing storage tombstone."
          });
        }
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await acquireTombstoneTransitionFence(tx, tombstone.id);
        const current = await requireTombstone(tx, tombstone.id);
        if (
          current.provider !== resolved.provider ||
          current.originalKey !== resolved.key ||
          current.hashSha256 !== expectedHash
        ) {
          throw new ConflictException({
            code: "STORAGE_TOMBSTONE_CONFLICT",
            message: "The retained object does not match the existing storage tombstone."
          });
        }
        if (current.state === StorageTombstoneState.RETAINED) return safeResult(current);
        if (current.state === StorageTombstoneState.RESTORED || current.state === StorageTombstoneState.PURGED) {
          throw new ConflictException({
            code: "STORAGE_TOMBSTONE_STATE_CONFLICT",
            message: "The storage tombstone cannot be retained from its current state."
          });
        }
        await this.completeRetention(resolved.storage, current);
        const retained = await tx.storageTombstone.update({
          where: { id: current.id },
          data: { state: StorageTombstoneState.RETAINED, failureCode: null }
        });
        return safeResult(retained);
      }, STORAGE_TRANSITION_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      await this.prisma.storageTombstone.updateMany({
        where: {
          id: tombstone.id,
          state: { in: [StorageTombstoneState.PENDING, StorageTombstoneState.FAILED] }
        },
        data: { state: StorageTombstoneState.FAILED, failureCode: "RETENTION_TRANSITION_FAILED" }
      }).catch(() => undefined);
      throw new ServiceUnavailableException({
        code: "STORAGE_RETENTION_RETRY_REQUIRED",
        message: "The object could not be retained. Its database reference remains available for retry."
      });
    }
  }

  async restore(id: string, actorUserId?: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await acquireTombstoneTransitionFence(tx, id);
        const tombstone = await requireTombstone(tx, id);
        if (tombstone.state === StorageTombstoneState.RESTORED) return safeResult(tombstone);
        if (tombstone.state !== StorageTombstoneState.RETAINED) {
          throw new ConflictException({
            code: "STORAGE_RESTORE_STATE_CONFLICT",
            message: "Only a retained object can be restored."
          });
        }
        if (tombstone.purgeAfter.getTime() <= Date.now()) {
          throw new ConflictException({
            code: "STORAGE_RESTORE_EXPIRED",
            message: "The object retention period has expired."
          });
        }
        const storage = this.storageForRow(tombstone.domain, tombstone.provider);
        const activeExists = await storage.exists(tombstone.originalKey);
        if (activeExists) {
          await inspectObject(storage, tombstone.originalKey, tombstone.hashSha256, tombstone.byteSize);
        } else {
          const trash = await storage.getStream(tombstone.trashKey);
          assertExpectedSize(trash.size, tombstone.byteSize);
          const restored = await storage.put({
            key: tombstone.originalKey,
            body: trash.stream,
            expectedHashSha256: tombstone.hashSha256,
            maxBytes: toSafeNumber(tombstone.byteSize)
          });
          assertExpectedSize(restored.size, tombstone.byteSize);
        }
        await inspectObject(storage, tombstone.originalKey, tombstone.hashSha256, tombstone.byteSize);
        await storage.delete(tombstone.trashKey);
        const restoredAt = new Date();
        const updated = await tx.storageTombstone.update({
          where: { id: tombstone.id },
          data: {
            state: StorageTombstoneState.RESTORED,
            restoredAt,
            failureCode: null,
            ...(actorUserId ? { actorUserId } : {})
          }
        });
        await writeSecurityAudit(tx, {
          actorUserId,
          actorType: actorUserId ? SecurityAuditActorType.USER : SecurityAuditActorType.SYSTEM,
          action: "STORAGE_OBJECT_RESTORE",
          targetType: "STORAGE_TOMBSTONE",
          targetId: tombstone.id,
          result: SecurityAuditResult.SUCCESS,
          beforeJson: { state: StorageTombstoneState.RETAINED },
          afterJson: { state: StorageTombstoneState.RESTORED, hashVerified: true }
        });
        return safeResult(updated);
      }, STORAGE_TRANSITION_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      await this.recordFailure(id, actorUserId, "RESTORE_TRANSITION_FAILED");
      throw new ServiceUnavailableException({
        code: "STORAGE_RESTORE_RETRY_REQUIRED",
        message: "The retained object could not be restored safely."
      });
    }
  }

  async purge(id: string, actorUserId: string | undefined, force = false) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await acquireTombstoneTransitionFence(tx, id);
        const tombstone = await requireTombstone(tx, id);
        if (tombstone.state === StorageTombstoneState.PURGED) return safeResult(tombstone);
        if (tombstone.state !== StorageTombstoneState.RETAINED) {
          throw new ConflictException({
            code: "STORAGE_PURGE_STATE_CONFLICT",
            message: "Only a retained object can be permanently deleted."
          });
        }
        if (!force && tombstone.purgeAfter.getTime() > Date.now()) {
          throw new ConflictException({
            code: "STORAGE_PURGE_NOT_DUE",
            message: "The object retention period has not expired."
          });
        }
        const storage = this.storageForRow(tombstone.domain, tombstone.provider);
        const activeExists = await storage.exists(tombstone.originalKey);
        const trashExists = await storage.exists(tombstone.trashKey);
        if (activeExists) {
          await inspectObject(storage, tombstone.originalKey, tombstone.hashSha256, tombstone.byteSize);
        }
        if (trashExists) {
          await inspectObject(storage, tombstone.trashKey, tombstone.hashSha256, tombstone.byteSize);
        }
        if (activeExists) await storage.delete(tombstone.originalKey);
        if (trashExists) await storage.delete(tombstone.trashKey);
        if (await storage.exists(tombstone.originalKey) || await storage.exists(tombstone.trashKey)) {
          throw new Error("storage object purge did not complete");
        }
        const purgedAt = new Date();
        const updated = await tx.storageTombstone.update({
          where: { id: tombstone.id },
          data: {
            state: StorageTombstoneState.PURGED,
            purgedAt,
            failureCode: null,
            ...(actorUserId ? { actorUserId } : {})
          }
        });
        await writeSecurityAudit(tx, {
          actorUserId,
          actorType: actorUserId ? SecurityAuditActorType.USER : SecurityAuditActorType.SYSTEM,
          action: "STORAGE_OBJECT_PURGE",
          targetType: "STORAGE_TOMBSTONE",
          targetId: tombstone.id,
          result: SecurityAuditResult.SUCCESS,
          beforeJson: { state: StorageTombstoneState.RETAINED },
          afterJson: { state: StorageTombstoneState.PURGED, explicit: force }
        });
        return safeResult(updated);
      }, STORAGE_TRANSITION_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      await this.recordFailure(id, actorUserId, "PURGE_TRANSITION_FAILED");
      throw new ServiceUnavailableException({
        code: "STORAGE_PURGE_RETRY_REQUIRED",
        message: "The retained object could not be permanently deleted safely."
      });
    }
  }

  async purgeExpired(options: { execute: boolean; limit?: number }) {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const due = await this.prisma.storageTombstone.findMany({
      where: { state: StorageTombstoneState.RETAINED, purgeAfter: { lte: new Date() } },
      select: { id: true },
      orderBy: [{ purgeAfter: "asc" }, { id: "asc" }],
      take: limit
    });
    if (!options.execute) return { candidateCount: due.length, purgedCount: 0, dryRun: true };
    let purgedCount = 0;
    for (const tombstone of due) {
      await this.purge(tombstone.id, undefined, false);
      purgedCount += 1;
    }
    return { candidateCount: due.length, purgedCount, dryRun: false };
  }

  private async completeRetention(storage: FileStorage, tombstone: {
    originalKey: string;
    trashKey: string;
    hashSha256: string;
    byteSize: bigint;
  }) {
    const trashExists = await storage.exists(tombstone.trashKey);
    if (trashExists) {
      await inspectObject(storage, tombstone.trashKey, tombstone.hashSha256, tombstone.byteSize);
    } else {
      const active = await storage.getStream(tombstone.originalKey);
      assertExpectedSize(active.size, tombstone.byteSize);
      const retained = await storage.put({
        key: tombstone.trashKey,
        body: active.stream,
        expectedHashSha256: tombstone.hashSha256,
        maxBytes: toSafeNumber(tombstone.byteSize)
      });
      assertExpectedSize(retained.size, tombstone.byteSize);
    }
    await inspectObject(storage, tombstone.trashKey, tombstone.hashSha256, tombstone.byteSize);
    const activeDeleted = await storage.delete(tombstone.originalKey);
    if (!activeDeleted && await storage.exists(tombstone.originalKey)) {
      throw new Error("active object delete did not complete");
    }
  }

  private resolveReference(domain: StorageTombstoneDomain, reference: string): ResolvedObject {
    const storageDomain = toStorageDomain(domain);
    const parsed = parseStorageReference(reference);
    if (parsed) {
      return {
        provider: parsed.provider,
        key: parsed.key,
        storage: configuredFileStorageForProvider(this.config, storageDomain, parsed.provider)
      };
    }
    const storage = configuredFileStorageForProvider(this.config, storageDomain, "local");
    if (!("rootPath" in storage) || typeof storage.rootPath !== "string") {
      throw new StorageIntegrityError();
    }
    return {
      provider: "local",
      key: legacyLocalPathToKey(reference, storage.rootPath),
      storage
    };
  }

  private storageForRow(domain: StorageTombstoneDomain, provider: string) {
    return configuredFileStorageForProvider(this.config, toStorageDomain(domain), provider);
  }

  private retentionDays() {
    const value = Number(this.config.get<string>("SUPABASE_STORAGE_RETENTION_DAYS") ?? "30");
    if (!Number.isSafeInteger(value) || value < 1 || value > 365) {
      throw new Error("SUPABASE_STORAGE_RETENTION_DAYS is outside the allowed range.");
    }
    return value;
  }

  private async recordFailure(id: string, actorUserId: string | undefined, failureCode: string) {
    await Promise.all([
      this.prisma.storageTombstone.updateMany({
        where: { id, state: StorageTombstoneState.RETAINED },
        data: { failureCode }
      }).catch(() => undefined),
      this.prisma.securityAuditEvent.create({
        data: securityAuditData({
          actorUserId,
          actorType: actorUserId ? SecurityAuditActorType.USER : SecurityAuditActorType.SYSTEM,
          action: "STORAGE_OBJECT_TRANSITION",
          targetType: "STORAGE_TOMBSTONE",
          targetId: id,
          result: SecurityAuditResult.PARTIAL,
          afterJson: { retryable: true, failureCode }
        })
      }).catch(() => undefined)
    ]);
  }
}

async function inspectObject(
  storage: FileStorage,
  key: string,
  expectedHash: string,
  expectedSize?: bigint
) {
  let stored;
  try {
    stored = await storage.getStream(normalizeStorageKey(key));
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) throw error;
    throw error;
  }
  if (expectedSize !== undefined) assertExpectedSize(stored.size, expectedSize);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of stored.stream) {
    size += chunk.length;
    if (size > stored.size) throw new StorageIntegrityError();
    hash.update(chunk);
  }
  if (size !== stored.size || hash.digest("hex") !== normalizedHash(expectedHash)) {
    throw new StorageIntegrityError();
  }
  return { size };
}

async function acquireTombstoneTransitionFence(tx: Prisma.TransactionClient, id: string) {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 0");
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`storage-tombstone:${id}`}, 0))::text AS lock_result
  `);
}

async function requireTombstone(tx: Prisma.TransactionClient, id: string) {
  const tombstone = await tx.storageTombstone.findUnique({ where: { id } });
  if (!tombstone) {
    throw new NotFoundException({
      code: "STORAGE_TOMBSTONE_NOT_FOUND",
      message: "The storage tombstone does not exist."
    });
  }
  return tombstone;
}

function normalizedHash(value: string) {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new StorageIntegrityError();
  return normalized;
}

function assertExpectedSize(size: number, expected: bigint) {
  if (BigInt(size) !== expected) throw new StorageIntegrityError();
}

function toSafeNumber(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new StorageIntegrityError();
  return number;
}

function toStorageDomain(domain: StorageTombstoneDomain): StorageDomain {
  return domain === StorageTombstoneDomain.META_UPLOAD ? "uploads" : "reports";
}

function safeResult(tombstone: {
  id: string;
  state: StorageTombstoneState;
  purgeAfter: Date;
  restoredAt: Date | null;
  purgedAt: Date | null;
}) {
  return {
    tombstoneId: tombstone.id,
    state: tombstone.state,
    purgeAfter: tombstone.purgeAfter,
    restoredAt: tombstone.restoredAt,
    purgedAt: tombstone.purgedAt
  };
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
