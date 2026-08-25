import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  Prisma,
  SecurityAuditActorType,
  SecurityAuditResult,
  StorageTombstoneDomain,
  UploadStatus
} from "@prisma/client";
import { normalizeUploadedFilename } from "../common/encoding";
import { PrismaService } from "../common/prisma.service";
import { CreativeNameParser } from "../domain/creative-name-parser";
import { CreativePlacementCleanupKey, DeletedAdMetricKey, DeletedAdsetMetricKey } from "./upload-contracts";
import {
  creativeOriginalKey,
  creativePlacementCleanupKey,
  creativePlacementWhere,
  emptyCreativeCleanup,
  placementKeyToString,
  uniqueAdMetricKeys,
  uniqueAdsetMetricKeys,
  uniqueStrings
} from "./upload-keys";
import { securityAuditData, writeSecurityAudit } from "../security-audit/security-audit.types";
import { StorageTombstoneService } from "../storage/storage-tombstone.service";
import { metaOriginalFileHashSha256 } from "./meta-original-storage-state";

export const UPLOAD_DELETE_TRANSACTION_OPTIONS = {
  maxWait: 30_000,
  timeout: 300_000
};

@Injectable()
export class UploadLifecycleService {
  private readonly creativeNameParser = new CreativeNameParser();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tombstoneService: StorageTombstoneService
  ) {}

  async deleteUpload(id: string, actorId?: string) {
    const batch = await this.prisma.uploadBatch.findUnique({
      where: { id },
      select: {
        id: true,
        originalFilename: true,
        storedFilePath: true,
        fileHashSha256: true,
        columnSchema: true,
        status: true
      }
    });
    if (!batch) {
      throw new NotFoundException({ code: "UPLOAD_NOT_FOUND", message: "Upload batch not found." });
    }

    if (actorId && batch.storedFilePath) {
      await this.prisma.securityAuditEvent.create({
        data: securityAuditData({
          actorUserId: actorId,
          actorType: SecurityAuditActorType.USER,
          action: "META_UPLOAD_DELETE",
          targetType: "META_UPLOAD_BATCH",
          targetId: id,
          result: SecurityAuditResult.REQUESTED,
          beforeJson: { hasStoredFile: true },
          afterJson: { databaseReferencePreserved: true, retryable: true }
        })
      });
    }

    const originalFileHashSha256 = batch.storedFilePath
      ? metaOriginalFileHashSha256(batch.columnSchema, batch.fileHashSha256)
      : null;

    const deleted = await this.prisma.$transaction(async (tx) => {
      const adMetrics = await tx.metaAdDailyMetric.findMany({
        where: { uploadBatchId: id },
        select: {
          id: true,
          creativeId: true,
          metricDate: true,
          metaCampaignId: true,
          metaAdsetId: true,
          adIdentityKey: true,
          adNameSnapshot: true
        }
      });
      const adsetMetrics = await tx.metaAdsetDailyMetric.findMany({
        where: { uploadBatchId: id },
        select: { id: true, metricDate: true, metaAdsetId: true }
      });

      const deletedAdMetricIds = adMetrics.map((metric) => metric.id);
      const deletedAdsetMetricIds = adsetMetrics.map((metric) => metric.id);

      const deletedAdMetrics = await tx.metaAdDailyMetric.deleteMany({ where: { uploadBatchId: id } });
      const deletedAdsetMetrics = await tx.metaAdsetDailyMetric.deleteMany({ where: { uploadBatchId: id } });

      if (deletedAdMetricIds.length > 0) {
        await tx.metaAdDailyMetric.updateMany({
          where: { supersededByMetricId: { in: deletedAdMetricIds } },
          data: { supersededByMetricId: null }
        });
      }
      if (deletedAdsetMetricIds.length > 0) {
        await tx.metaAdsetDailyMetric.updateMany({
          where: { supersededByMetricId: { in: deletedAdsetMetricIds } },
          data: { supersededByMetricId: null }
        });
      }

      const restoredAdCurrentCount = await this.restoreCurrentAdMetrics(tx, adMetrics);
      const restoredAdsetCurrentCount = await this.restoreCurrentAdsetMetrics(tx, adsetMetrics);
      const creativeCleanup = await this.cleanupCreativeDataAfterMetricDelete(tx, adMetrics);
      const deletedErrors = await tx.uploadRowError.deleteMany({ where: { uploadBatchId: id } });
      const deletedRows = await tx.uploadRow.deleteMany({ where: { uploadBatchId: id } });
      await tx.uploadBatch.update({
        where: { id },
        data: { status: UploadStatus.CANCELLED }
      });

      const result = {
        deletedAdMetricCount: deletedAdMetrics.count,
        deletedAdsetMetricCount: deletedAdsetMetrics.count,
        deletedRowCount: deletedRows.count,
        deletedErrorCount: deletedErrors.count,
        restoredAdCurrentCount,
        restoredAdsetCurrentCount,
        ...creativeCleanup
      };
      return result;
    }, UPLOAD_DELETE_TRANSACTION_OPTIONS);

    let storedFileRetained = false;
    let tombstoneId: string | null = null;
    try {
      if (batch.storedFilePath) {
        const retained = await this.tombstoneService.retain({
          domain: StorageTombstoneDomain.META_UPLOAD,
          businessRecordId: batch.id,
          reference: batch.storedFilePath,
          expectedHashSha256: originalFileHashSha256!,
          actorUserId: actorId
        });
        storedFileRetained = retained.state === "RETAINED";
        tombstoneId = retained.tombstoneId;
      }
    } catch {
      if (actorId) {
        await this.prisma.securityAuditEvent.create({
          data: securityAuditData({
            actorUserId: actorId,
            actorType: SecurityAuditActorType.USER,
            action: "META_UPLOAD_DELETE",
            targetType: "META_UPLOAD_BATCH",
            targetId: id,
            result: SecurityAuditResult.PARTIAL,
            beforeJson: { hasStoredFile: true },
            afterJson: {
              databaseReferencePreserved: true,
              retryable: true,
              failureCode: "FILE_RETENTION_FAILED"
            }
          })
        });
      }
      throw new ConflictException({
        code: "UPLOAD_FILE_RETENTION_RETRY_REQUIRED",
        message: "The stored upload file could not be retained. The upload reference was preserved for retry."
      });
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.uploadBatch.delete({ where: { id } });
        if (actorId) {
          await writeSecurityAudit(tx, {
            actorUserId: actorId,
            actorType: SecurityAuditActorType.USER,
            action: "META_UPLOAD_DELETE",
            targetType: "META_UPLOAD_BATCH",
            targetId: id,
            result: SecurityAuditResult.SUCCESS,
            beforeJson: { hasStoredFile: Boolean(batch.storedFilePath) },
            afterJson: {
              deleted: true,
              storedFileRetained,
              deletedAdMetricCount: deleted.deletedAdMetricCount,
              deletedAdsetMetricCount: deleted.deletedAdsetMetricCount,
              deletedRowCount: deleted.deletedRowCount,
              deletedErrorCount: deleted.deletedErrorCount
            }
          });
        }
      }, UPLOAD_DELETE_TRANSACTION_OPTIONS);
    } catch (error) {
      if (actorId) {
        await this.prisma.securityAuditEvent.create({
          data: securityAuditData({
            actorUserId: actorId,
            actorType: SecurityAuditActorType.USER,
            action: "META_UPLOAD_DELETE",
            targetType: "META_UPLOAD_BATCH",
            targetId: id,
            result: SecurityAuditResult.PARTIAL,
            beforeJson: { hasStoredFile: Boolean(batch.storedFilePath) },
            afterJson: {
              databaseReferencePreserved: true,
              retryable: true,
              storedFileRetained,
              failureCode: "DATABASE_FINALIZE_FAILED"
            }
          })
        });
      }
      throw error;
    }

    return {
      batchId: batch.id,
      originalFilename: normalizeUploadedFilename(batch.originalFilename),
      storedFileRetained,
      tombstoneId,
      ...deleted
    };
  }

  restoreStoredObject(tombstoneId: string, actorId: string) {
    return this.tombstoneService.restore(tombstoneId, actorId);
  }

  purgeStoredObject(tombstoneId: string, actorId: string) {
    return this.tombstoneService.purge(tombstoneId, actorId, true);
  }

  async restoreCurrentAdMetrics(tx: Prisma.TransactionClient, metrics: DeletedAdMetricKey[]) {
    let restoredCount = 0;
    for (const metric of uniqueAdMetricKeys(metrics)) {
      await tx.metaAdDailyMetric.updateMany({
        where: {
          metricDate: metric.metricDate,
          metaCampaignId: metric.metaCampaignId,
          metaAdsetId: metric.metaAdsetId,
          adIdentityKey: metric.adIdentityKey
        },
        data: { isCurrent: false }
      });
      const replacement = await tx.metaAdDailyMetric.findFirst({
        where: {
          metricDate: metric.metricDate,
          metaCampaignId: metric.metaCampaignId,
          metaAdsetId: metric.metaAdsetId,
          adIdentityKey: metric.adIdentityKey
        },
        orderBy: [{ importVersion: "desc" }, { createdAt: "desc" }],
        select: { id: true }
      });
      if (replacement) {
        await tx.metaAdDailyMetric.update({
          where: { id: replacement.id },
          data: { isCurrent: true, supersededByMetricId: null }
        });
        restoredCount += 1;
      }
    }
    return restoredCount;
  }

  async restoreCurrentAdsetMetrics(tx: Prisma.TransactionClient, metrics: DeletedAdsetMetricKey[]) {
    let restoredCount = 0;
    for (const metric of uniqueAdsetMetricKeys(metrics)) {
      await tx.metaAdsetDailyMetric.updateMany({
        where: { metricDate: metric.metricDate, metaAdsetId: metric.metaAdsetId },
        data: { isCurrent: false }
      });
      const replacement = await tx.metaAdsetDailyMetric.findFirst({
        where: { metricDate: metric.metricDate, metaAdsetId: metric.metaAdsetId },
        orderBy: [{ importVersion: "desc" }, { createdAt: "desc" }],
        select: { id: true }
      });
      if (replacement) {
        await tx.metaAdsetDailyMetric.update({
          where: { id: replacement.id },
          data: { isCurrent: true, supersededByMetricId: null }
        });
        restoredCount += 1;
      }
    }
    return restoredCount;
  }

  async cleanupCreativeDataAfterMetricDelete(tx: Prisma.TransactionClient, metrics: DeletedAdMetricKey[]) {
    const deletedMetrics = metrics.filter((metric): metric is DeletedAdMetricKey & { creativeId: string } => Boolean(metric.creativeId));
    const creativeIds = uniqueStrings(deletedMetrics.map((metric) => metric.creativeId));
    if (creativeIds.length === 0) {
      return emptyCreativeCleanup();
    }

    const remainingMetrics = await tx.metaAdDailyMetric.findMany({
      where: { creativeId: { in: creativeIds } },
      select: {
        creativeId: true,
        metaCampaignId: true,
        metaAdsetId: true,
        adNameSnapshot: true,
        isCurrent: true
      }
    });
    const remainingCreativeIds = new Set(remainingMetrics.map((metric) => metric.creativeId).filter((id): id is string => Boolean(id)));
    const currentCreativeIds = new Set(
      remainingMetrics.filter((metric) => metric.isCurrent).map((metric) => metric.creativeId).filter((id): id is string => Boolean(id))
    );
    const orphanCreativeIds = creativeIds.filter((creativeId) => !remainingCreativeIds.has(creativeId));
    const survivingCreativeIds = creativeIds.filter((creativeId) => remainingCreativeIds.has(creativeId));

    const deletedOrphanLogs =
      orphanCreativeIds.length > 0
        ? await tx.creativeChangeLog.deleteMany({ where: { creativeId: { in: orphanCreativeIds } } })
        : { count: 0 };
    const deletedOrphanPlacements =
      orphanCreativeIds.length > 0
        ? await tx.creativePlacement.deleteMany({ where: { creativeId: { in: orphanCreativeIds } } })
        : { count: 0 };
    const deletedOrphanAliases =
      orphanCreativeIds.length > 0
        ? await tx.creativeAlias.deleteMany({ where: { creativeId: { in: orphanCreativeIds } } })
        : { count: 0 };
    const deletedOrphanCreatives =
      orphanCreativeIds.length > 0 ? await tx.creative.deleteMany({ where: { id: { in: orphanCreativeIds } } }) : { count: 0 };

    const deletedPlacementKeys = new Map<string, CreativePlacementCleanupKey>();
    const deletedAliasKeysByCreative = new Map<string, Set<string>>();
    for (const metric of deletedMetrics) {
      if (orphanCreativeIds.includes(metric.creativeId)) {
        continue;
      }
      const placementKey = creativePlacementCleanupKey(metric);
      deletedPlacementKeys.set(placementKeyToString(placementKey), placementKey);

      const aliasKey = creativeOriginalKey(this.creativeNameParser.parse(metric.adNameSnapshot).originalName);
      const aliasKeys = deletedAliasKeysByCreative.get(metric.creativeId) ?? new Set<string>();
      aliasKeys.add(aliasKey);
      deletedAliasKeysByCreative.set(metric.creativeId, aliasKeys);
    }

    const remainingPlacementKeys = new Set(remainingMetrics.map((metric) => placementKeyToString(creativePlacementCleanupKey(metric))));
    const obsoletePlacementWheres = Array.from(deletedPlacementKeys.values()).filter(
      (placementKey) => !remainingPlacementKeys.has(placementKeyToString(placementKey))
    );
    const deletedStalePlacements =
      obsoletePlacementWheres.length > 0
        ? await tx.creativePlacement.deleteMany({
            where: { OR: obsoletePlacementWheres.map((placementKey) => creativePlacementWhere(placementKey)) }
          })
        : { count: 0 };

    const remainingAliasKeysByCreative = new Map<string, Set<string>>();
    for (const metric of remainingMetrics) {
      if (!metric.creativeId) {
        continue;
      }
      const aliasKey = creativeOriginalKey(this.creativeNameParser.parse(metric.adNameSnapshot).originalName);
      const aliasKeys = remainingAliasKeysByCreative.get(metric.creativeId) ?? new Set<string>();
      aliasKeys.add(aliasKey);
      remainingAliasKeysByCreative.set(metric.creativeId, aliasKeys);
    }
    const obsoleteAliasWheres: Prisma.CreativeAliasWhereInput[] = [];
    for (const [creativeId, deletedAliasKeys] of deletedAliasKeysByCreative.entries()) {
      const remainingAliasKeys = remainingAliasKeysByCreative.get(creativeId) ?? new Set<string>();
      const obsoleteAliasKeys = Array.from(deletedAliasKeys).filter((aliasKey) => !remainingAliasKeys.has(aliasKey));
      if (obsoleteAliasKeys.length > 0) {
        obsoleteAliasWheres.push({ creativeId, originalKey: { in: obsoleteAliasKeys } });
      }
    }
    const deletedStaleAliases =
      obsoleteAliasWheres.length > 0 ? await tx.creativeAlias.deleteMany({ where: { OR: obsoleteAliasWheres } }) : { count: 0 };

    const deactivatedCreativeIds = survivingCreativeIds.filter((creativeId) => !currentCreativeIds.has(creativeId));
    const deactivatedCreatives =
      deactivatedCreativeIds.length > 0
        ? await tx.creative.updateMany({ where: { id: { in: deactivatedCreativeIds } }, data: { isActive: false } })
        : { count: 0 };

    return {
      deletedCreativePlacementCount: deletedOrphanPlacements.count + deletedStalePlacements.count,
      deletedCreativeAliasCount: deletedOrphanAliases.count + deletedStaleAliases.count,
      deletedCreativeLogCount: deletedOrphanLogs.count,
      deletedCreativeCount: deletedOrphanCreatives.count,
      deactivatedCreativeCount: deactivatedCreatives.count
    };
  }
}
