import { BadRequestException, Injectable } from "@nestjs/common";
import {
  AdStage,
  ConflictPolicy,
  MatchSource,
  Prisma,
  RowValidationStatus,
  UploadLevel,
  UploadStatus
} from "@prisma/client";
import { createHash } from "node:crypto";
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

  async importMetaAdDailyCsv(file: Express.Multer.File | undefined, conflictPolicy: ConflictPolicy) {
    if (!file?.buffer) {
      throw new BadRequestException({ code: "FILE_REQUIRED", message: "CSV 파일이 필요합니다." });
    }
    if (!(conflictPolicy in ConflictPolicy)) {
      throw new BadRequestException({ code: "INVALID_CONFLICT_POLICY", message: "중복 정책이 올바르지 않습니다." });
    }
    const fileHashSha256 = createHash("sha256").update(file.buffer).digest("hex");
    const duplicated = await this.prisma.uploadBatch.findUnique({ where: { fileHashSha256 } });
    if (duplicated && conflictPolicy === ConflictPolicy.SKIP) {
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
    const batchFileHashSha256 = duplicated ? duplicateBatchHash(fileHashSha256, conflictPolicy) : fileHashSha256;

    const originalFilename = normalizeUploadedFilename(file.originalname);
    const { headers, rows } = this.csvParser.parseBuffer(file.buffer);
    const previewSummary = this.csvParser.preview(file.buffer);
    const storedFilePath = await this.storageService.storeOriginalFile(file, batchFileHashSha256, originalFilename);
    const batch = await this.prisma.uploadBatch.create({
      data: {
        originalFilename,
        storedFilePath,
        fileHashSha256: batchFileHashSha256,
        level: UploadLevel.AD,
        columnSchema: {
          schemaVersion: META_AD_DAILY_SCHEMA_VERSION,
          sourceLevel: "ad",
          columns: headers,
          mappings: META_AD_DAILY_CSV_COLUMN_MAPPINGS,
          count: headers.length,
          previewSummary,
          originalFileHashSha256: fileHashSha256
        },
        rowCount: rows.length,
        conflictPolicy,
        status: UploadStatus.VALIDATING
      }
    });

    const headerValidation = MetaAdDailyCsvValidator.validate(headers);
    if (!headerValidation.valid) {
      await this.prisma.uploadRowError.createMany({
        data: headerValidation.missingColumns.map((columnName) => ({
          uploadBatchId: batch.id,
          columnName,
          severity: "ERROR",
          errorCode: "MISSING_REQUIRED_COLUMN",
          message: `필수 컬럼이 누락되었습니다: ${columnName}`
        }))
      });
      await this.prisma.uploadBatch.update({
        where: { id: batch.id },
        data: { status: UploadStatus.FAILED, errorCount: headerValidation.missingColumns.length, validatedAt: new Date() }
      });
      throw new BadRequestException({
        code: "CSV_HEADER_INVALID",
        message: "필수 광고 단위 CSV 컬럼이 누락되었습니다.",
        details: { batchId: batch.id, missingColumns: headerValidation.missingColumns, previewSummary }
      });
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
      await this.prisma.uploadRowError.createMany({
        data: duplicateKeys.map((key) => ({
          uploadBatchId: batch.id,
          severity: "ERROR",
          errorCode: "DUPLICATE_AD_DAILY_KEY",
          message: `같은 파일 안에 중복 광고 일별 키가 있습니다: ${key}`
        }))
      });
      await this.prisma.uploadBatch.update({
        where: { id: batch.id },
        data: { status: UploadStatus.FAILED, errorCount: duplicateKeys.length, validatedAt: new Date() }
      });
      throw new BadRequestException({
        code: "DUPLICATE_AD_DAILY_KEY",
        message: "같은 파일 안에 중복 광고 일별 키가 있습니다.",
        details: { batchId: batch.id, duplicateKeys }
      });
    }

    await this.uploadExchangeRateService.ensureUsdKrwRates(
      batch.id,
      parsedRows
        .filter(({ parsed }) => parsed.parsedRow && parsed.issues.length === 0)
        .map(({ parsed }) => parsed.parsedRow?.metricDate)
        .filter((date): date is Date => Boolean(date))
    );

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
      await this.prisma.uploadRowError.createMany({
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
        const campaign = await this.entityWriterService.upsertCampaign(parsedRow);
        const metaAdset = await this.entityWriterService.upsertAdsetFromAdDaily(parsedRow, campaign.id);
        const creativeResult = await this.entityWriterService.upsertCreativeFromAdDaily(parsedRow);
        const metaAd = await this.entityWriterService.upsertAd(parsedRow, campaign.id, metaAdset.id, creativeResult.creative.id);
        await this.entityWriterService.upsertCreativeAlias(creativeResult.creative.id, creativeResult.parsedName, parsedRow.metricDate);
        await this.entityWriterService.upsertCreativePlacement({
          creativeId: creativeResult.creative.id,
          parsedRow,
          parsedName: creativeResult.parsedName,
          campaignRefId: campaign.id,
          metaAdsetRefId: metaAdset.id,
          metaAdRefId: metaAd.id
        });
        campaignRefId = campaign.id;
        metaAdsetId = metaAdset.id;
        metaAdRefId = metaAd.id;
        creativeId = creativeResult.creative.id;

        const productMatch = await this.mappingsService.matchProduct(
          metaAdset.id,
          `${parsedRow.adName} ${parsedRow.adsetName} ${parsedRow.campaignName}`,
          parsedRow.metricDate
        );
        productId = productMatch.productId;
        productMatchSource = productMatch.source as MatchSource;
        productMatchRuleId = productMatch.matchRuleId;

        const stageMatch = await this.mappingsService.matchStage(
          metaAdset.id,
          `${parsedRow.campaignName} ${parsedRow.adsetName}`,
          parsedRow.metricDate
        );
        stage = stageMatch.stage as AdStage;
        stageMatchSource = stageMatch.source as MatchSource;

        await this.prisma.metaAdset.update({
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

      const uploadRow = await this.prisma.uploadRow.create({
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
        await this.prisma.uploadRowError.createMany({
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
        });
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
          })
        : 0;

    const importedAdsetMetricCount =
      errorCount === 0 && includedAdKeys.size > 0
        ? await this.adsetAggregateService.refreshAdsetAggregatesFromAdMetrics(batch.id, Array.from(snapshotDatesByKey.values()))
        : 0;

    const status =
      errorCount > 0 && importedAdMetricCount > 0
        ? UploadStatus.PARTIAL
        : errorCount > 0
          ? UploadStatus.FAILED
          : UploadStatus.IMPORTED;
    const updated = await this.prisma.uploadBatch.update({
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

    return {
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
    };
  }

}
