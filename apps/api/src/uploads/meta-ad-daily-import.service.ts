import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  AdStage,
  ConflictPolicy,
  MatchSource,
  Prisma,
  RowValidationStatus,
  UploadLevel,
  UploadBatch,
  UploadStatus
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { normalizeUploadedFilename } from "../common/encoding";
import { PrismaService } from "../common/prisma.service";
import { AdsetNameNormalizer } from "../domain/adset-name-normalizer";
import { formatDateOnly } from "../domain/date-number";
import {
  dailyAdMetricKey,
  META_AD_DAILY_CSV_COLUMN_MAPPINGS,
  META_AD_DAILY_SCHEMA_VERSION,
  MetaAdDailyCsvParser,
  MetaAdDailyCsvValidator,
  ParsedMetaAdDailyRow
} from "../domain/meta-ad-daily-csv";
import { hashRecord } from "../domain/meta-csv";
import { MappingsService } from "../mappings/mappings.service";
import { MetaAdsetAggregateService } from "./meta-adset-aggregate.service";
import { MetaEntityWriterService } from "./meta-entity-writer.service";
import { MetaMetricVersionService } from "./meta-metric-version.service";
import {
  duplicateBatchHash,
  duplicatedValues,
  jsonSafeAdParsedRow,
  maxDate,
  minDate,
  snapshotAdMetricKey
} from "./upload-keys";
import { UploadStorageService } from "./upload-storage.service";
import { UploadExchangeRateService } from "./upload-exchange-rate.service";
import {
  acquireMetaUploadMutationFence,
  isRetryableMetaOriginalStoragePending,
  META_UPLOAD_MUTATION_TRANSACTION_OPTIONS,
  pendingMetaOriginalStorageSchema,
  storedMetaOriginalStorageSchema
} from "./meta-original-storage-state";

const STORAGE_DOMAIN = "META_AD_DAILY" as const;

@Injectable()
export class MetaAdDailyImportService {
  private readonly csvParser = new MetaAdDailyCsvParser();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: UploadStorageService,
    private readonly entityWriterService: MetaEntityWriterService,
    private readonly metricVersionService: MetaMetricVersionService,
    private readonly adsetAggregateService: MetaAdsetAggregateService,
    private readonly mappingsService: MappingsService,
    private readonly uploadExchangeRateService: UploadExchangeRateService
  ) {}

  async importMetaAdDailyCsv(file: Express.Multer.File | undefined, conflictPolicy: ConflictPolicy, actorId: string) {
    if (!file?.buffer) {
      throw new BadRequestException({ code: "FILE_REQUIRED", message: "CSV 파일이 필요합니다." });
    }
    if (!(conflictPolicy in ConflictPolicy)) {
      throw new BadRequestException({ code: "INVALID_CONFLICT_POLICY", message: "중복 정책이 올바르지 않습니다." });
    }
    const fileHashSha256 = createHash("sha256").update(file.buffer).digest("hex");
    const duplicated = await this.prisma.uploadBatch.findUnique({ where: { fileHashSha256 } });
    const originalFilename = normalizeUploadedFilename(file.originalname);
    const { headers, rows } = this.csvParser.parseBuffer(file.buffer);
    const previewSummary = this.csvParser.preview(file.buffer);
    let reservedBatch: UploadBatch | null = duplicated && conflictPolicy === ConflictPolicy.SKIP
      ? await this.claimStoragePendingBatch(duplicated)
      : null;
    if (duplicated && conflictPolicy === ConflictPolicy.SKIP && !reservedBatch) {
      return this.duplicateResult(duplicated);
    }
    if (!reservedBatch) {
      const batchFileHashSha256 = duplicated ? duplicateBatchHash(fileHashSha256, conflictPolicy) : fileHashSha256;
      const batchId = randomUUID();
      const storedFilePath = this.storageService.prepareOriginalFileReference(batchFileHashSha256, new Date(), batchId);
      const columnSchema = pendingMetaOriginalStorageSchema({
        schemaVersion: META_AD_DAILY_SCHEMA_VERSION,
        sourceLevel: "ad",
        columns: headers,
        mappings: META_AD_DAILY_CSV_COLUMN_MAPPINGS,
        count: headers.length,
        previewSummary,
        originalFileHashSha256: fileHashSha256
      }, STORAGE_DOMAIN);
      try { reservedBatch = await this.prisma.uploadBatch.create({
        data: {
          id: batchId,
          originalFilename,
          storedFilePath,
          fileHashSha256: batchFileHashSha256,
          level: UploadLevel.AD,
          columnSchema,
          rowCount: rows.length,
          conflictPolicy,
          status: UploadStatus.VALIDATING,
          uploadedBy: actorId
        }
      }); } catch(error) {
        if(conflictPolicy!==ConflictPolicy.SKIP||!isPrismaUniqueConflict(error))throw error;
        const raced=await this.prisma.uploadBatch.findUnique({where:{fileHashSha256}});if(!raced)throw error;
        reservedBatch=await this.claimStoragePendingBatch(raced);
        if(!reservedBatch)return this.duplicateResult(raced);
      }
    }
    if (!reservedBatch) throw new Error("Upload batch reservation failed.");
    let batch: UploadBatch = reservedBatch;
    const prepared = await this.prepareBatchWithFence(batch, file, headers, rows, previewSummary);
    if (prepared.kind === "error") throw prepared.error;
    if (prepared.kind === "lost") return this.currentDuplicateResult(batch.id);
    batch = prepared.batch;
    const { headerValidation, parsedRows } = prepared;

    const outcome = await this.prisma.$transaction(async (tx) => {
      await acquireMetaUploadMutationFence(tx, batch.id);
      const current = await tx.uploadBatch.findUnique({ where: { id: batch.id } });
      if (!current || !sameStorageOwnership(current, batch)) return { kind: "lost" as const };
      batch = current;
      try {
        await this.uploadExchangeRateService.ensureUsdKrwRates(
          batch.id,
          parsedRows
            .filter(({ parsed }) => parsed.parsedRow && parsed.issues.length === 0)
            .map(({ parsed }) => parsed.parsedRow?.metricDate)
            .filter((date): date is Date => Boolean(date)),
          tx
        );
      } catch (error) {
        return { kind: "error" as const, error };
      }

    let validRowCount = 0;
    let warningCount = headerValidation.warnings.length;
    let errorCount = 0;
    let importedAdMetricCount = 0;
    let skippedDuplicateCount = 0;
    let reportStart: Date | null = null;
    let reportEnd: Date | null = null;
    const snapshotDatesByKey = new Map<string, Date>();
    const includedAdKeys = new Set<string>();

    if (headerValidation.warnings.length > 0) {
      await tx.uploadRowError.createMany({
        data: headerValidation.warnings.map((message) => ({
          uploadBatchId: batch.id,
          severity: "WARNING",
          errorCode: "CSV_SCHEMA_WARNING",
          message
        }))
      });
    }

    for (const { rowNumber, rawRow, parsed, sourceRowHash } of parsedRows) {
      const parsedRow = parsed.parsedRow;
      let campaignRefId: string | null = null;
      let metaAdsetId: string | null = null;
      let metaAdRefId: string | null = null;
      let creativeId: string | null = null;
      let productId: string | null = null;
      let productMatchSource: MatchSource = MatchSource.UNMATCHED;
      let productMatchRuleId: string | null = null;
      let stage: AdStage = AdStage.UNKNOWN;
      let stageMatchSource: MatchSource = MatchSource.UNMATCHED;

      if (parsedRow) {
        reportStart = minDate(reportStart, parsedRow.dateStart);
        reportEnd = maxDate(reportEnd, parsedRow.dateEnd);
        const campaign = await this.entityWriterService.upsertCampaign(parsedRow, tx);
        const metaAdset = await this.entityWriterService.upsertAdsetFromAdDaily(parsedRow, campaign.id, tx);
        const creativeResult = await this.entityWriterService.upsertCreativeFromAdDaily(parsedRow, tx);
        const metaAd = await this.entityWriterService.upsertAd(
          parsedRow, campaign.id, metaAdset.id, creativeResult.creative.id, tx
        );
        await this.entityWriterService.upsertCreativeAlias(
          creativeResult.creative.id, creativeResult.parsedName, parsedRow.metricDate, tx
        );
        await this.entityWriterService.upsertCreativePlacement({
          creativeId: creativeResult.creative.id,
          parsedRow,
          parsedName: creativeResult.parsedName,
          campaignRefId: campaign.id,
          metaAdsetRefId: metaAdset.id,
          metaAdRefId: metaAd.id
        }, tx);
        campaignRefId = campaign.id;
        metaAdsetId = metaAdset.id;
        metaAdRefId = metaAd.id;
        creativeId = creativeResult.creative.id;

        const productMatch = await this.mappingsService.matchProduct(
          metaAdset.id,
          `${parsedRow.adName} ${parsedRow.adsetName} ${parsedRow.campaignName}`,
          parsedRow.metricDate,
          tx
        );
        productId = productMatch.productId;
        productMatchSource = productMatch.source as MatchSource;
        productMatchRuleId = productMatch.matchRuleId;

        const stageMatch = await this.mappingsService.matchStage(
          metaAdset.id,
          `${parsedRow.campaignName} ${parsedRow.adsetName}`,
          parsedRow.metricDate,
          tx
        );
        stage = stageMatch.stage as AdStage;
        stageMatchSource = stageMatch.source as MatchSource;

        await tx.metaAdset.update({
          where: { id: metaAdset.id },
          data: {
            currentProductId: productId,
            currentStage: stage,
            firstSeenOn: metaAdset.firstSeenOn ?? parsedRow.metricDate,
            lastSeenOn: parsedRow.metricDate
          }
        });
      }

      const validationStatus =
        parsed.issues.length > 0
          ? RowValidationStatus.ERROR
          : productId
            ? RowValidationStatus.VALID
            : RowValidationStatus.UNMATCHED;

      if (validationStatus === RowValidationStatus.ERROR) {
        errorCount += 1;
      } else if (validationStatus === RowValidationStatus.UNMATCHED) {
        warningCount += 1;
        validRowCount += 1;
      } else {
        validRowCount += 1;
      }

      const uploadRow = await tx.uploadRow.create({
        data: {
          uploadBatchId: batch.id,
          rowNumber,
          sourceRowHash,
          rawRow: rawRow as Prisma.InputJsonObject,
          parsedRow: parsedRow ? (jsonSafeAdParsedRow(parsedRow) as Prisma.InputJsonObject) : undefined,
          dateStart: parsedRow?.dateStart,
          dateEnd: parsedRow?.dateEnd,
          adsetName: parsedRow?.adsetName,
          adsetNameKey: parsedRow ? AdsetNameNormalizer.toKey(parsedRow.adsetName) : undefined,
          metaAdsetId,
          productId,
          stage,
          productMatchSource,
          productMatchRuleId,
          validationStatus,
          validationErrors: parsed.issues as unknown as Prisma.InputJsonValue
        }
      });

      if (parsed.issues.length > 0) {
        await tx.uploadRowError.createMany({
          data: parsed.issues.map((issue) => ({
            uploadBatchId: batch.id,
            uploadRowId: uploadRow.id,
            rowNumber,
            columnName: issue.columnName,
            severity: "ERROR",
            errorCode: issue.errorCode,
            message: issue.message,
            rawValue: issue.rawValue
          }))
        });
        continue;
      }

      if (parsedRow && campaignRefId && metaAdsetId && metaAdRefId) {
        const result = await this.metricVersionService.importAdDailyMetric({
          batchId: batch.id,
          uploadRowId: uploadRow.id,
          parsedRow,
          rawRow,
          campaignRefId,
          metaAdRefId,
          metaAdsetRefId: metaAdsetId,
          creativeId,
          productId,
          productMatchSource,
          productMatchRuleId,
          stage,
          stageMatchSource,
          conflictPolicy
        }, tx);
        importedAdMetricCount += result.imported ? 1 : 0;
        skippedDuplicateCount += result.skipped ? 1 : 0;
        if (result.imported || result.skipped) {
          snapshotDatesByKey.set(formatDateOnly(parsedRow.metricDate), parsedRow.metricDate);
          includedAdKeys.add(
            snapshotAdMetricKey({
              metricDate: parsedRow.metricDate,
              metaCampaignId: parsedRow.metaCampaignId,
              metaAdsetId: parsedRow.metaAdsetExternalId,
              adIdentityKey: parsedRow.adIdentityKey
            })
          );
        }
      }
    }

    const snapshotHiddenAdMetricCount =
      errorCount === 0 && includedAdKeys.size > 0
        ? await this.metricVersionService.deactivateMissingAdSnapshotMetrics({
            snapshotDates: Array.from(snapshotDatesByKey.values()),
            includedKeys: includedAdKeys
          }, tx)
        : 0;

    const importedAdsetMetricCount =
      errorCount === 0 && includedAdKeys.size > 0
        ? await this.adsetAggregateService.refreshAdsetAggregatesFromAdMetrics(
            batch.id,
            Array.from(snapshotDatesByKey.values()),
            tx
          )
        : 0;

    const status =
      errorCount > 0 && importedAdMetricCount > 0
        ? UploadStatus.PARTIAL
        : errorCount > 0
          ? UploadStatus.FAILED
          : UploadStatus.IMPORTED;
    const updated = await tx.uploadBatch.update({
      where: { id: batch.id },
      data: {
        status,
        validRowCount,
        warningCount,
        errorCount,
        reportStart,
        reportEnd,
        validatedAt: new Date(),
        importedAt: importedAdMetricCount > 0 ? new Date() : null
      }
    });

    return { kind: "success" as const, value: {
      batchId: updated.id,
      sourceLevel: updated.level,
      schemaVersion: META_AD_DAILY_SCHEMA_VERSION,
      status: updated.status,
      rowCount: updated.rowCount,
      validRowCount,
      warningCount,
      errorCount,
      importedAdMetricCount,
      importedAdsetMetricCount,
      snapshotHiddenAdMetricCount,
      skippedDuplicateCount,
      unmatchedCount: Math.max(0, warningCount - headerValidation.warnings.length),
      reportStart: reportStart ? formatDateOnly(reportStart) : null,
      reportEnd: reportEnd ? formatDateOnly(reportEnd) : null,
      previewSummary
    } };
    }, META_UPLOAD_MUTATION_TRANSACTION_OPTIONS);
    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind === "lost") return this.currentDuplicateResult(batch.id);
    return outcome.value;
  }

  private prepareBatchWithFence(
    batch: UploadBatch,
    file: Express.Multer.File,
    headers: string[],
    rows: Array<Record<string, string>>,
    previewSummary: ReturnType<MetaAdDailyCsvParser["preview"]>
  ) {
    return this.prisma.$transaction(async (tx) => {
      await acquireMetaUploadMutationFence(tx, batch.id);
      let current = await tx.uploadBatch.findUnique({ where: { id: batch.id } });
      if (!current || !sameStorageOwnership(current, batch)) return { kind: "lost" as const };
      try {
        await this.storageService.putOriginalFile(file, current.storedFilePath!);
      } catch {
        await tx.uploadBatch.updateMany({
          where: {
            id: current.id,
            columnSchema: { equals: current.columnSchema as Prisma.InputJsonValue }
          },
          data: { status: UploadStatus.FAILED, validatedAt: new Date() }
        });
        return {
          kind: "error" as const,
          error: new ServiceUnavailableException({
            code: "UPLOAD_STORAGE_UNAVAILABLE",
            message: "The upload could not be stored. The failed batch was preserved for a safe retry."
          })
        };
      }
      const storedSchema = storedMetaOriginalStorageSchema(current.columnSchema, STORAGE_DOMAIN);
      const finalized = await tx.uploadBatch.updateMany({
        where: {
          id: current.id,
          status: UploadStatus.VALIDATING,
          columnSchema: { equals: current.columnSchema as Prisma.InputJsonValue }
        },
        data: { columnSchema: storedSchema }
      });
      if (finalized.count !== 1) return { kind: "lost" as const };
      current = { ...current, columnSchema: storedSchema };

      const headerValidation = MetaAdDailyCsvValidator.validate(headers);
      if (!headerValidation.valid) {
        await tx.uploadRowError.createMany({
          data: headerValidation.missingColumns.map((columnName) => ({
            uploadBatchId: current.id,
            columnName,
            severity: "ERROR",
            errorCode: "MISSING_REQUIRED_COLUMN",
            message: `필수 컬럼이 누락되었습니다: ${columnName}`
          }))
        });
        await tx.uploadBatch.update({
          where: { id: current.id },
          data: {
            status: UploadStatus.FAILED,
            errorCount: headerValidation.missingColumns.length,
            validatedAt: new Date()
          }
        });
        return {
          kind: "error" as const,
          error: new BadRequestException({
            code: "CSV_HEADER_INVALID",
            message: "필수 광고 단위 CSV 컬럼이 누락되었습니다.",
            details: { batchId: current.id, missingColumns: headerValidation.missingColumns, previewSummary }
          })
        };
      }

      const parsedRows = rows.map((rawRow, index) => ({
        rowNumber: index + 2,
        rawRow,
        parsed: this.csvParser.parseRow(rawRow),
        sourceRowHash: hashRecord(rawRow)
      }));
      const duplicateKeys = duplicatedValues(
        parsedRows
          .map(({ parsed }) => parsed.parsedRow)
          .filter((row): row is ParsedMetaAdDailyRow => Boolean(row))
          .map(dailyAdMetricKey)
      );
      if (duplicateKeys.length > 0) {
        await tx.uploadRowError.createMany({
          data: duplicateKeys.map((key) => ({
            uploadBatchId: current.id,
            severity: "ERROR",
            errorCode: "DUPLICATE_AD_DAILY_KEY",
            message: `같은 파일 안에 중복 광고 일별 키가 있습니다: ${key}`
          }))
        });
        await tx.uploadBatch.update({
          where: { id: current.id },
          data: { status: UploadStatus.FAILED, errorCount: duplicateKeys.length, validatedAt: new Date() }
        });
        return {
          kind: "error" as const,
          error: new BadRequestException({
            code: "DUPLICATE_AD_DAILY_KEY",
            message: "같은 파일 안에 중복 광고 일별 키가 있습니다.",
            details: { batchId: current.id, duplicateKeys }
          })
        };
      }
      return { kind: "ready" as const, batch: current, headerValidation, parsedRows };
    }, META_UPLOAD_MUTATION_TRANSACTION_OPTIONS);
  }

  private async claimStoragePendingBatch(batch: UploadBatch) {
    return this.prisma.$transaction(async (tx) => {
      await acquireMetaUploadMutationFence(tx, batch.id);
      const current = await tx.uploadBatch.findUnique({ where: { id: batch.id } });
      if (
        !current || current.level !== UploadLevel.AD || !current.storedFilePath ||
        !isRetryableMetaOriginalStoragePending(current.columnSchema, STORAGE_DOMAIN, current.status)
      ) return null;
      const [rowCount, errorCount, adMetricCount, adsetMetricCount] = await Promise.all([
        tx.uploadRow.count({ where: { uploadBatchId: current.id } }),
        tx.uploadRowError.count({ where: { uploadBatchId: current.id } }),
        tx.metaAdDailyMetric.count({ where: { uploadBatchId: current.id } }),
        tx.metaAdsetDailyMetric.count({ where: { uploadBatchId: current.id } })
      ]);
      if (
        rowCount > 0 || errorCount > 0 || adMetricCount > 0 || adsetMetricCount > 0 ||
        current.validRowCount > 0 || current.warningCount > 0 || current.errorCount > 0 || current.importedAt
      ) return null;
      const claimedSchema = pendingMetaOriginalStorageSchema(current.columnSchema, STORAGE_DOMAIN);
      const claimed = await tx.uploadBatch.updateMany({
        where: {
          id: current.id,
          status: current.status,
          columnSchema: { equals: current.columnSchema as Prisma.InputJsonValue }
        },
        data: { status: UploadStatus.VALIDATING, validatedAt: null, columnSchema: claimedSchema }
      });
      return claimed.count === 1
        ? { ...current, status: UploadStatus.VALIDATING, validatedAt: null, columnSchema: claimedSchema }
        : null;
    }, META_UPLOAD_MUTATION_TRANSACTION_OPTIONS);
  }

  private async currentDuplicateResult(batchId: string) {
    const current = await this.prisma.uploadBatch.findUnique({ where: { id: batchId } });
    if (!current) throw new ServiceUnavailableException({ code: "UPLOAD_RETRY_UNAVAILABLE", message: "Upload retry state is unavailable." });
    return this.duplicateResult(current);
  }

  private async duplicateResult(duplicated: UploadBatch) {
    return {
      duplicate: true,
      batchId: duplicated.id,
      sourceLevel: duplicated.level,
      status: duplicated.status,
      rowCount: duplicated.rowCount,
      validRowCount: duplicated.validRowCount,
      warningCount: duplicated.warningCount,
      errorCount: duplicated.errorCount,
      importedAdMetricCount: await this.prisma.metaAdDailyMetric.count({ where: { uploadBatchId: duplicated.id } }),
      importedAdsetMetricCount: await this.prisma.metaAdsetDailyMetric.count({ where: { uploadBatchId: duplicated.id } }),
      unmatchedCount: await this.prisma.uploadRow.count({
        where: { uploadBatchId: duplicated.id, validationStatus: RowValidationStatus.UNMATCHED }
      }),
      reportStart: duplicated.reportStart ? formatDateOnly(duplicated.reportStart) : null,
      reportEnd: duplicated.reportEnd ? formatDateOnly(duplicated.reportEnd) : null
    };
  }

}

function sameStorageOwnership(current: UploadBatch, expected: UploadBatch) {
  return current.status === UploadStatus.VALIDATING &&
    JSON.stringify(current.columnSchema) === JSON.stringify(expected.columnSchema);
}
function isPrismaUniqueConflict(error:unknown){return error instanceof Prisma.PrismaClientKnownRequestError&&error.code==="P2002";}
