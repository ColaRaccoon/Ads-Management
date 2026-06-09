import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AdStage,
  ConflictPolicy,
  CreativeParseStatus,
  MatchSource,
  Prisma,
  RowValidationStatus,
  UploadLevel,
  UploadStatus
} from "@prisma/client";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeUploadedFilename } from "../common/encoding";
import { PrismaService } from "../common/prisma.service";
import { AdsetNameNormalizer } from "../domain/adset-name-normalizer";
import { CreativeNameParser, CreativeNameParts } from "../domain/creative-name-parser";
import { CsvHeaderValidator, hashRecord, MetaCsvParser, ParsedMetaAdsetRow } from "../domain/meta-csv";
import { DuplicatePolicyResolver } from "../domain/duplicate-policy";
import {
  dailyAdMetricKey,
  META_AD_DAILY_CSV_COLUMN_MAPPINGS,
  META_AD_DAILY_SCHEMA_VERSION,
  MetaAdDailyCsvParser,
  MetaAdDailyCsvValidator,
  ParsedMetaAdDailyRow
} from "../domain/meta-ad-daily-csv";
import { formatDateOnly } from "../domain/date-number";
import { ExchangeRatesService } from "../exchange-rates/exchange-rates.service";
import { MappingsService } from "../mappings/mappings.service";

@Injectable()
export class UploadsService {
  private readonly csvParser = new MetaCsvParser();
  private readonly adDailyCsvParser = new MetaAdDailyCsvParser();
  private readonly creativeNameParser = new CreativeNameParser();
  private readonly duplicatePolicyResolver = new DuplicatePolicyResolver();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mappingsService: MappingsService,
    private readonly exchangeRatesService: ExchangeRatesService
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
    const { headers, rows } = this.adDailyCsvParser.parseBuffer(file.buffer);
    const previewSummary = this.adDailyCsvParser.preview(file.buffer);
    const storedFilePath = await this.storeOriginalFile(file, batchFileHashSha256, originalFilename);
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
      parsed: this.adDailyCsvParser.parseRow(rawRow),
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

    await this.ensureExchangeRatesForAdRows(batch.id, parsedRows);

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
        const campaign = await this.upsertCampaign(parsedRow);
        const metaAdset = await this.upsertAdsetFromAdDaily(parsedRow, campaign.id);
        const creativeResult = await this.upsertCreativeFromAdDaily(parsedRow);
        const metaAd = await this.upsertAd(parsedRow, campaign.id, metaAdset.id, creativeResult.creative.id);
        await this.upsertCreativeAlias(creativeResult.creative.id, creativeResult.parsedName, parsedRow.metricDate);
        await this.upsertCreativePlacement({
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
        const result = await this.importAdDailyMetric({
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
        ? await this.deactivateMissingAdSnapshotMetrics({
            snapshotDates: Array.from(snapshotDatesByKey.values()),
            includedKeys: includedAdKeys
          })
        : 0;

    const importedAdsetMetricCount =
      errorCount === 0 && includedAdKeys.size > 0
        ? await this.refreshAdsetAggregatesFromAdMetrics(batch.id, Array.from(snapshotDatesByKey.values()))
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

  async importMetaAdsetCsv(file: Express.Multer.File | undefined, conflictPolicy: ConflictPolicy) {
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
        status: duplicated.status,
        rowCount: duplicated.rowCount,
        validRowCount: duplicated.validRowCount,
        warningCount: duplicated.warningCount,
        errorCount: duplicated.errorCount,
        importedMetricCount: await this.prisma.metaAdsetDailyMetric.count({ where: { uploadBatchId: duplicated.id } }),
        skippedDuplicateCount: 0,
        unmatchedCount: await this.prisma.uploadRow.count({
          where: { uploadBatchId: duplicated.id, validationStatus: RowValidationStatus.UNMATCHED }
        }),
        reportStart: duplicated.reportStart ? formatDateOnly(duplicated.reportStart) : null,
        reportEnd: duplicated.reportEnd ? formatDateOnly(duplicated.reportEnd) : null,
        snapshotHiddenMetricCount: 0
      };
    }
    const batchFileHashSha256 = duplicated ? duplicateBatchHash(fileHashSha256, conflictPolicy) : fileHashSha256;

    const originalFilename = normalizeUploadedFilename(file.originalname);
    const { headers, rows } = this.csvParser.parseBuffer(file.buffer);
    const storedFilePath = await this.storeOriginalFile(file, batchFileHashSha256, originalFilename);
    const batch = await this.prisma.uploadBatch.create({
      data: {
        originalFilename,
        storedFilePath,
        fileHashSha256: batchFileHashSha256,
        columnSchema: { columns: headers, count: headers.length, originalFileHashSha256: fileHashSha256 },
        rowCount: rows.length,
        conflictPolicy,
        status: UploadStatus.VALIDATING
      }
    });

    const headerValidation = CsvHeaderValidator.validate(headers);
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
        message: "필수 CSV 컬럼이 누락되었습니다.",
        details: { batchId: batch.id, missingColumns: headerValidation.missingColumns }
      });
    }

    let validRowCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    let importedMetricCount = 0;
    const snapshotDatesByKey = new Map<string, Date>();
    const includedSnapshotKeys = new Set<string>();
    let skippedDuplicateCount = 0;
    let reportStart: Date | null = null;
    let reportEnd: Date | null = null;
    const parsedRows = rows.map((rawRow, index) => ({
      rowNumber: index + 2,
      rawRow,
      parsed: this.csvParser.parseRow(rawRow),
      sourceRowHash: hashRecord(rawRow)
    }));

    await this.ensureExchangeRatesForParsedRows(batch.id, parsedRows);

    for (const { rowNumber, rawRow, parsed, sourceRowHash } of parsedRows) {
      const parsedRow = parsed.parsedRow;
      let metaAdsetId: string | null = null;
      let productId: string | null = null;
      let productMatchSource: MatchSource = MatchSource.UNMATCHED;
      let productMatchRuleId: string | null = null;
      let stage: AdStage = AdStage.UNKNOWN;
      let stageMatchSource: MatchSource = MatchSource.UNMATCHED;

      if (parsedRow) {
        reportStart = minDate(reportStart, parsedRow.dateStart);
        reportEnd = maxDate(reportEnd, parsedRow.dateEnd);
        const metaAdset = await this.upsertAdset(parsedRow);
        metaAdsetId = metaAdset.id;

        const productMatch = await this.mappingsService.matchProduct(metaAdset.id, parsedRow.adsetName, parsedRow.metricDate);
        productId = productMatch.productId;
        productMatchSource = productMatch.source as MatchSource;
        productMatchRuleId = productMatch.matchRuleId;

        const stageMatch = await this.mappingsService.matchStage(metaAdset.id, parsedRow.adsetName, parsedRow.metricDate);
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
          parsedRow: parsedRow ? (jsonSafeParsedRow(parsedRow) as Prisma.InputJsonObject) : undefined,
          dateStart: parsedRow?.dateStart,
          dateEnd: parsedRow?.dateEnd,
          adsetName: parsedRow?.adsetName,
          adsetNameKey: parsedRow?.adsetNameKey,
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

      if (parsedRow && metaAdsetId) {
        const result = await this.importMetric({
          batchId: batch.id,
          uploadRowId: uploadRow.id,
          parsedRow,
          rawRow,
          metaAdsetId,
          productId,
          productMatchSource,
          productMatchRuleId,
          stage,
          stageMatchSource,
          conflictPolicy
        });
        importedMetricCount += result.imported ? 1 : 0;
        skippedDuplicateCount += result.skipped ? 1 : 0;
        if (result.imported || result.skipped) {
          snapshotDatesByKey.set(formatDateOnly(parsedRow.metricDate), parsedRow.metricDate);
          includedSnapshotKeys.add(snapshotMetricKey(parsedRow.metricDate, metaAdsetId));
        }
      }
    }

    const snapshotHiddenMetricCount =
      errorCount === 0 && includedSnapshotKeys.size > 0
        ? await this.deactivateMissingSnapshotMetrics({ snapshotDates: Array.from(snapshotDatesByKey.values()), includedKeys: includedSnapshotKeys })
        : 0;

    const status =
      errorCount > 0 && importedMetricCount > 0
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
        importedAt: importedMetricCount > 0 ? new Date() : null
      }
    });

    return {
      batchId: updated.id,
      status: updated.status,
      rowCount: updated.rowCount,
      validRowCount,
      snapshotHiddenMetricCount,
      warningCount,
      errorCount,
      importedMetricCount,
      skippedDuplicateCount,
      unmatchedCount: warningCount,
      reportStart: reportStart ? formatDateOnly(reportStart) : null,
      reportEnd: reportEnd ? formatDateOnly(reportEnd) : null
    };
  }

  async listUploads(take = 50) {
    const uploads = await this.prisma.uploadBatch.findMany({
      take,
      orderBy: { uploadedAt: "desc" },
      include: { _count: { select: { rows: true, errors: true, metrics: true, adMetrics: true } } }
    });
    return uploads.map((upload) => ({
      ...upload,
      originalFilename: normalizeUploadedFilename(upload.originalFilename)
    }));
  }

  async previewUpload(id: string) {
    const [batch, rows, errors, unmatched] = await Promise.all([
      this.prisma.uploadBatch.findUnique({ where: { id } }),
      this.prisma.uploadRow.findMany({ where: { uploadBatchId: id }, orderBy: { rowNumber: "asc" }, take: 200 }),
      this.prisma.uploadRowError.findMany({ where: { uploadBatchId: id }, orderBy: { rowNumber: "asc" } }),
      this.prisma.uploadRow.findMany({
        where: { uploadBatchId: id, validationStatus: RowValidationStatus.UNMATCHED },
        orderBy: { rowNumber: "asc" }
      })
    ]);
    return {
      batch: batch ? { ...batch, originalFilename: normalizeUploadedFilename(batch.originalFilename) } : batch,
      rows,
      errors,
      unmatched,
      summary:
        typeof batch?.columnSchema === "object" && batch.columnSchema && "previewSummary" in batch.columnSchema
          ? (batch.columnSchema as { previewSummary?: unknown }).previewSummary
          : null
    };
  }

  uploadErrors(id: string) {
    return this.prisma.uploadRowError.findMany({
      where: { uploadBatchId: id },
      orderBy: [{ rowNumber: "asc" }, { columnName: "asc" }]
    });
  }

  async deleteUpload(id: string) {
    const batch = await this.prisma.uploadBatch.findUnique({
      where: { id },
      select: { id: true, originalFilename: true, storedFilePath: true }
    });
    if (!batch) {
      throw new NotFoundException({ code: "UPLOAD_NOT_FOUND", message: "Upload batch not found." });
    }

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
      await tx.uploadBatch.delete({ where: { id } });

      return {
        deletedAdMetricCount: deletedAdMetrics.count,
        deletedAdsetMetricCount: deletedAdsetMetrics.count,
        deletedRowCount: deletedRows.count,
        deletedErrorCount: deletedErrors.count,
        restoredAdCurrentCount,
        restoredAdsetCurrentCount,
        ...creativeCleanup
      };
    });

    const storedFileDeleted = await this.deleteStoredUploadFile(batch.storedFilePath);
    return {
      batchId: batch.id,
      originalFilename: normalizeUploadedFilename(batch.originalFilename),
      storedFileDeleted,
      ...deleted
    };
  }

  private async storeOriginalFile(file: Express.Multer.File, fileHash: string, originalFilename: string) {
    const now = new Date();
    const storageDir = this.config.get<string>("UPLOAD_STORAGE_DIR") ?? "./storage/uploads";
    const targetDir = path.resolve(process.cwd(), storageDir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"));
    await mkdir(targetDir, { recursive: true });
    const safeName = originalFilename.replace(/[^\w.\-가-힣]/g, "_");
    const targetPath = path.join(targetDir, `${fileHash.slice(0, 12)}-${safeName}`);
    await writeFile(targetPath, file.buffer);
    return path.relative(process.cwd(), targetPath).replace(/\\/g, "/");
  }

  private async deleteStoredUploadFile(storedFilePath: string | null) {
    if (!storedFilePath) {
      return false;
    }
    const storageDir = this.config.get<string>("UPLOAD_STORAGE_DIR") ?? "./storage/uploads";
    const storageRoot = path.resolve(process.cwd(), storageDir);
    const absolutePath = path.resolve(process.cwd(), storedFilePath);
    const relativeToStorage = path.relative(storageRoot, absolutePath);
    if (relativeToStorage.startsWith("..") || path.isAbsolute(relativeToStorage)) {
      return false;
    }
    try {
      await rm(absolutePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private async restoreCurrentAdMetrics(tx: Prisma.TransactionClient, metrics: DeletedAdMetricKey[]) {
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

  private async restoreCurrentAdsetMetrics(tx: Prisma.TransactionClient, metrics: DeletedAdsetMetricKey[]) {
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

  private async cleanupCreativeDataAfterMetricDelete(tx: Prisma.TransactionClient, metrics: DeletedAdMetricKey[]) {
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


  private async upsertAdset(parsedRow: ParsedMetaAdsetRow) {
    const existingCandidates = await this.prisma.metaAdset.findMany({
      where: { platform: "META", adsetNameKey: parsedRow.adsetNameKey },
      orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
    });
    const existing = existingCandidates.find((candidate) => candidate.externalAdsetId) ?? existingCandidates[0] ?? null;
    if (existing) {
      return this.prisma.metaAdset.update({
        where: { id: existing.id },
        data: {
          adsetName: parsedRow.adsetName,
          firstSeenOn: existing.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });
    }
    return this.prisma.metaAdset.create({
      data: {
        platform: "META",
        adsetName: parsedRow.adsetName,
        adsetNameKey: parsedRow.adsetNameKey,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }

  private async upsertCampaign(parsedRow: ParsedMetaAdDailyRow) {
    const existing = await this.prisma.metaCampaign.findUnique({
      where: {
        platform_externalCampaignId: {
          platform: "META",
          externalCampaignId: parsedRow.metaCampaignId
        }
      }
    });
    if (existing) {
      return this.prisma.metaCampaign.update({
        where: { id: existing.id },
        data: {
          campaignName: parsedRow.campaignName,
          firstSeenOn: existing.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });
    }
    return this.prisma.metaCampaign.create({
      data: {
        platform: "META",
        externalCampaignId: parsedRow.metaCampaignId,
        campaignName: parsedRow.campaignName,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }

  private async upsertAdsetFromAdDaily(parsedRow: ParsedMetaAdDailyRow, campaignRefId: string) {
    const adsetNameKey = AdsetNameNormalizer.toKey(parsedRow.adsetName);
    const existing = await this.prisma.metaAdset.findFirst({
      where: { platform: "META", externalAdsetId: parsedRow.metaAdsetExternalId }
    });
    if (existing) {
      return this.prisma.metaAdset.update({
        where: { id: existing.id },
        data: {
          campaignRefId,
          adsetName: parsedRow.adsetName,
          adsetNameKey,
          firstSeenOn: existing.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });
    }
    const legacyByName = await this.prisma.metaAdset.findFirst({
      where: { platform: "META", externalAdsetId: null, adsetNameKey },
      orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
    });
    if (legacyByName) {
      return this.prisma.metaAdset.update({
        where: { id: legacyByName.id },
        data: {
          externalAdsetId: parsedRow.metaAdsetExternalId,
          campaignRefId,
          adsetName: parsedRow.adsetName,
          adsetNameKey,
          firstSeenOn: legacyByName.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });
    }
    return this.prisma.metaAdset.create({
      data: {
        platform: "META",
        externalAdsetId: parsedRow.metaAdsetExternalId,
        campaignRefId,
        adsetName: parsedRow.adsetName,
        adsetNameKey,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }

  private async upsertCreativeFromAdDaily(parsedRow: ParsedMetaAdDailyRow) {
    const parsedName = this.creativeNameParser.parse(parsedRow.adName);
    const existing = await this.prisma.creative.findUnique({
      where: {
        platform_creativeKey: {
          platform: "META",
          creativeKey: parsedName.creativeKey
        }
      }
    });
    if (existing) {
      const creative = await this.prisma.creative.update({
        where: { id: existing.id },
        data: {
          displayName: parsedName.displayName,
          productName: parsedName.productName,
          materialNo: parsedName.materialNo,
          firstSeenOn: minDate(existing.firstSeenOn, parsedRow.metricDate),
          lastSeenOn: maxDate(existing.lastSeenOn, parsedRow.metricDate),
          isActive: true
        }
      });
      return { creative, parsedName };
    }
    const creative = await this.prisma.creative.create({
      data: {
        platform: "META",
        creativeKey: parsedName.creativeKey,
        displayName: parsedName.displayName,
        productName: parsedName.productName,
        materialNo: parsedName.materialNo,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate,
        isActive: true
      }
    });
    return { creative, parsedName };
  }

  private async upsertCreativeAlias(creativeId: string, parsedName: CreativeNameParts, seenOn: Date) {
    const originalKey = creativeOriginalKey(parsedName.originalName);
    const existing = await this.prisma.creativeAlias.findUnique({
      where: {
        creativeId_originalKey: {
          creativeId,
          originalKey
        }
      }
    });
    const data = {
      originalName: parsedName.originalName,
      dateCode: parsedName.dateCode,
      setting: parsedName.setting,
      parseStatus: parsedName.parseStatus as CreativeParseStatus,
      lastSeenOn: seenOn
    };
    if (existing) {
      return this.prisma.creativeAlias.update({
        where: { id: existing.id },
        data: {
          ...data,
          firstSeenOn: minDate(existing.firstSeenOn, seenOn),
          lastSeenOn: maxDate(existing.lastSeenOn, seenOn)
        }
      });
    }
    return this.prisma.creativeAlias.create({
      data: {
        creativeId,
        originalKey,
        firstSeenOn: seenOn,
        ...data
      }
    });
  }

  private async upsertCreativePlacement(input: {
    creativeId: string;
    parsedRow: ParsedMetaAdDailyRow;
    parsedName: CreativeNameParts;
    campaignRefId: string;
    metaAdsetRefId: string;
    metaAdRefId: string;
  }) {
    const existing = await this.prisma.creativePlacement.findUnique({
      where: {
        creativeId_metaCampaignId_metaAdsetId_originalAdName: {
          creativeId: input.creativeId,
          metaCampaignId: input.parsedRow.metaCampaignId,
          metaAdsetId: input.parsedRow.metaAdsetExternalId,
          originalAdName: input.parsedRow.adName
        }
      }
    });
    const data = {
      campaignRefId: input.campaignRefId,
      metaAdsetRefId: input.metaAdsetRefId,
      metaAdRefId: input.metaAdRefId,
      campaignName: input.parsedRow.campaignName,
      adsetName: input.parsedRow.adsetName,
      setting: input.parsedName.setting,
      lastSeenOn: input.parsedRow.metricDate,
      lastStatus: input.parsedRow.adDeliveryStatus
    };
    if (existing) {
      const isLatestObservation = !existing.lastSeenOn || input.parsedRow.metricDate >= existing.lastSeenOn;
      return this.prisma.creativePlacement.update({
        where: { id: existing.id },
        data: {
          ...(isLatestObservation ? data : {}),
          firstSeenOn: minDate(existing.firstSeenOn, input.parsedRow.metricDate),
          lastSeenOn: maxDate(existing.lastSeenOn, input.parsedRow.metricDate)
        }
      });
    }
    return this.prisma.creativePlacement.create({
      data: {
        creativeId: input.creativeId,
        metaCampaignId: input.parsedRow.metaCampaignId,
        metaAdsetId: input.parsedRow.metaAdsetExternalId,
        originalAdName: input.parsedRow.adName,
        firstSeenOn: input.parsedRow.metricDate,
        ...data
      }
    });
  }

  private async upsertAd(parsedRow: ParsedMetaAdDailyRow, campaignRefId: string, metaAdsetRefId: string, creativeId: string) {
    const existing = await this.prisma.metaAd.findUnique({
      where: {
        platform_metaCampaignId_metaAdsetId_adIdentityKey: {
          platform: "META",
          metaCampaignId: parsedRow.metaCampaignId,
          metaAdsetId: parsedRow.metaAdsetExternalId,
          adIdentityKey: parsedRow.adIdentityKey
        }
      }
    });
    if (existing) {
      return this.prisma.metaAd.update({
        where: { id: existing.id },
        data: {
          campaignRefId,
          metaAdsetRefId,
          creativeId,
          externalAdId: parsedRow.metaAdId,
          syntheticAdKey: parsedRow.syntheticAdKey,
          adName: parsedRow.adName,
          firstSeenOn: minDate(existing.firstSeenOn, parsedRow.metricDate),
          lastSeenOn: maxDate(existing.lastSeenOn, parsedRow.metricDate)
        }
      });
    }
    return this.prisma.metaAd.create({
      data: {
        platform: "META",
        campaignRefId,
        metaAdsetRefId,
        creativeId,
        metaCampaignId: parsedRow.metaCampaignId,
        metaAdsetId: parsedRow.metaAdsetExternalId,
        externalAdId: parsedRow.metaAdId,
        syntheticAdKey: parsedRow.syntheticAdKey,
        adIdentityKey: parsedRow.adIdentityKey,
        adName: parsedRow.adName,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }

  private async importAdDailyMetric(input: AdMetricImportInput) {
    let skipped = false;
    await this.prisma.$transaction(async (tx) => {
      const existingRows = await tx.metaAdDailyMetric.findMany({
        where: {
          metricDate: input.parsedRow.metricDate,
          metaCampaignId: input.parsedRow.metaCampaignId,
          metaAdsetId: input.parsedRow.metaAdsetExternalId,
          adIdentityKey: input.parsedRow.adIdentityKey
        },
        orderBy: { importVersion: "desc" },
        select: { id: true, importVersion: true, isCurrent: true }
      });
      const latest = existingRows[0] ?? null;
      const current = existingRows.find((row) => row.isCurrent) ?? null;
      const importVersion = nextImportVersion(latest?.importVersion);
      const duplicateDecision = this.duplicatePolicyResolver.resolve(input.conflictPolicy, Boolean(current));

      if (!duplicateDecision.importMetric) {
        skipped = true;
        return;
      }

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
      }

      const created = await tx.metaAdDailyMetric.create({
        data: {
          uploadBatchId: input.batchId,
          uploadRowId: input.uploadRowId,
          campaignRefId: input.campaignRefId,
          metaAdsetRefId: input.metaAdsetRefId,
          metaAdRefId: input.metaAdRefId,
          creativeId: input.creativeId,
          metricDate: input.parsedRow.metricDate,
          dateStart: input.parsedRow.dateStart,
          dateEnd: input.parsedRow.dateEnd,
          metaCampaignId: input.parsedRow.metaCampaignId,
          campaignNameSnapshot: input.parsedRow.campaignName,
          metaAdsetId: input.parsedRow.metaAdsetExternalId,
          adsetNameSnapshot: input.parsedRow.adsetName,
          metaAdId: input.parsedRow.metaAdId,
          syntheticAdKey: input.parsedRow.syntheticAdKey,
          adIdentityKey: input.parsedRow.adIdentityKey,
          adNameSnapshot: input.parsedRow.adName,
          adDeliveryStatus: input.parsedRow.adDeliveryStatus,
          attributionSetting: input.parsedRow.attributionSetting,
          resultIndicator: input.parsedRow.resultIndicator,
          resultCount: input.parsedRow.resultCount,
          purchaseCount: input.parsedRow.purchaseCount,
          reach: input.parsedRow.reach,
          frequency: decimalOrNull(input.parsedRow.frequency),
          costPerResultUsd: decimalOrNull(input.parsedRow.costPerResultUsd),
          adsetBudgetLabel: input.parsedRow.adsetBudgetLabel,
          adsetBudgetType: input.parsedRow.adsetBudgetType,
          spendUsd: new Prisma.Decimal(input.parsedRow.spendUsd),
          endStatus: input.parsedRow.endStatus,
          qualityRanking: input.parsedRow.qualityRanking,
          engagementRateRanking: input.parsedRow.engagementRateRanking,
          conversionRateRanking: input.parsedRow.conversionRateRanking,
          impressions: BigInt(input.parsedRow.impressions),
          cpmUsd: decimalOrNull(input.parsedRow.cpmUsd),
          linkClicks: input.parsedRow.linkClicks,
          shopClicks: input.parsedRow.shopClicks,
          cpcLinkUsd: decimalOrNull(input.parsedRow.cpcLinkUsd),
          ctrLinkPct: decimalOrNull(input.parsedRow.ctrLinkPct),
          clicksAll: input.parsedRow.clicksAll,
          ctrAllPct: decimalOrNull(input.parsedRow.ctrAllPct),
          cpcAllUsd: decimalOrNull(input.parsedRow.cpcAllUsd),
          landingPageViews: input.parsedRow.landingPageViews,
          costPerLandingPageViewUsd: decimalOrNull(input.parsedRow.costPerLandingPageViewUsd),
          productId: input.productId,
          stage: input.stage,
          productMatchSource: input.productMatchSource,
          stageMatchSource: input.stageMatchSource,
          productMatchRuleId: input.productMatchRuleId,
          importVersion,
          isCurrent: true,
          supersededByMetricId: null,
          rawRow: input.rawRow as Prisma.InputJsonObject
        }
      });

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdDailyMetric.update({
          where: { id: current.id },
          data: { supersededByMetricId: created.id }
        });
      }
    });

    return { imported: !skipped, skipped };
  }

  private async importMetric(input: MetricImportInput) {
    let skipped = false;
    await this.prisma.$transaction(async (tx) => {
      const existingRows = await tx.metaAdsetDailyMetric.findMany({
        where: {
          metricDate: input.parsedRow.metricDate,
          metaAdsetId: input.metaAdsetId
        },
        orderBy: { importVersion: "desc" },
        select: { id: true, importVersion: true, isCurrent: true }
      });
      const latest = existingRows[0] ?? null;
      const current = existingRows.find((row) => row.isCurrent) ?? null;
      const importVersion = nextImportVersion(latest?.importVersion);
      const duplicateDecision = this.duplicatePolicyResolver.resolve(input.conflictPolicy, Boolean(current));

      if (!duplicateDecision.importMetric) {
        skipped = true;
        return;
      }

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdsetDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
      }

      const created = await tx.metaAdsetDailyMetric.create({
        data: {
          uploadBatchId: input.batchId,
          uploadRowId: input.uploadRowId,
          metaAdsetId: input.metaAdsetId,
          metricDate: input.parsedRow.metricDate,
          dateStart: input.parsedRow.dateStart,
          dateEnd: input.parsedRow.dateEnd,
          adsetName: input.parsedRow.adsetName,
          adsetNameKey: input.parsedRow.adsetNameKey,
          deliveryStatus: input.parsedRow.deliveryStatus,
          attributionSetting: input.parsedRow.attributionSetting,
          resultCount: input.parsedRow.resultCount,
          resultIndicator: input.parsedRow.resultIndicator,
          reach: input.parsedRow.reach,
          frequency: decimalOrNull(input.parsedRow.frequency),
          costPerResultUsd: decimalOrNull(input.parsedRow.costPerResultUsd),
          adsetBudgetLabel: input.parsedRow.adsetBudgetLabel,
          adsetBudgetType: input.parsedRow.adsetBudgetType,
          spendUsd: new Prisma.Decimal(input.parsedRow.spendUsd),
          endStatus: input.parsedRow.endStatus,
          startDate: input.parsedRow.startDate,
          impressions: BigInt(input.parsedRow.impressions),
          cpmUsd: decimalOrNull(input.parsedRow.cpmUsd),
          linkClicks: input.parsedRow.linkClicks,
          shopClicks: input.parsedRow.shopClicks,
          cpcLinkUsd: decimalOrNull(input.parsedRow.cpcLinkUsd),
          ctrLinkPct: decimalOrNull(input.parsedRow.ctrLinkPct),
          clicksAll: input.parsedRow.clicksAll,
          ctrAllPct: decimalOrNull(input.parsedRow.ctrAllPct),
          cpcAllUsd: decimalOrNull(input.parsedRow.cpcAllUsd),
          landingPageViews: input.parsedRow.landingPageViews,
          costPerLandingPageViewUsd: decimalOrNull(input.parsedRow.costPerLandingPageViewUsd),
          productId: input.productId,
          stage: input.stage,
          productMatchSource: input.productMatchSource,
          stageMatchSource: input.stageMatchSource,
          productMatchRuleId: input.productMatchRuleId,
          importVersion,
          isCurrent: true,
          supersededByMetricId: null,
          rawRow: input.rawRow as Prisma.InputJsonObject
        }
      });

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdsetDailyMetric.update({
          where: { id: current.id },
          data: { supersededByMetricId: created.id }
        });
      }
    });

    return { imported: !skipped, skipped };
  }

  private async deactivateMissingSnapshotMetrics(input: { snapshotDates: Date[]; includedKeys: Set<string> }) {
    if (input.snapshotDates.length === 0 || input.includedKeys.size === 0) {
      return 0;
    }

    const currentMetrics = await this.prisma.metaAdsetDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { in: input.snapshotDates }
      },
      select: { id: true, metricDate: true, metaAdsetId: true }
    });
    const staleIds = findMissingSnapshotMetricIds(currentMetrics, input.includedKeys);

    if (staleIds.length === 0) {
      return 0;
    }

    const result = await this.prisma.metaAdsetDailyMetric.updateMany({
      where: { id: { in: staleIds } },
      data: { isCurrent: false }
    });
    return result.count;
  }

  private async deactivateMissingAdSnapshotMetrics(input: { snapshotDates: Date[]; includedKeys: Set<string> }) {
    if (input.snapshotDates.length === 0 || input.includedKeys.size === 0) {
      return 0;
    }

    const currentMetrics = await this.prisma.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { in: input.snapshotDates }
      },
      select: {
        id: true,
        metricDate: true,
        metaCampaignId: true,
        metaAdsetId: true,
        adIdentityKey: true
      }
    });
    const staleIds = currentMetrics
      .filter((metric) => !input.includedKeys.has(snapshotAdMetricKey(metric)))
      .map((metric) => metric.id);

    if (staleIds.length === 0) {
      return 0;
    }

    const result = await this.prisma.metaAdDailyMetric.updateMany({
      where: { id: { in: staleIds } },
      data: { isCurrent: false }
    });
    return result.count;
  }

  private async refreshAdsetAggregatesFromAdMetrics(batchId: string, snapshotDates: Date[]) {
    if (snapshotDates.length === 0) {
      return 0;
    }

    const metrics = await this.prisma.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { in: snapshotDates }
      },
      orderBy: [{ metricDate: "asc" }, { adsetNameSnapshot: "asc" }, { adNameSnapshot: "asc" }]
    });
    const groups = new Map<string, Prisma.MetaAdDailyMetricGetPayload<Record<string, never>>[]>();
    for (const metric of metrics) {
      const key = `${formatDateOnly(metric.metricDate)}:${metric.metaAdsetRefId}`;
      groups.set(key, [...(groups.get(key) ?? []), metric]);
    }

    let importedCount = 0;
    const includedAdsetKeys = new Set<string>();
    for (const rows of groups.values()) {
      const aggregate = aggregateAdRows(rows);
      const result = await this.importAdsetAggregateMetric(batchId, aggregate, ConflictPolicy.OVERWRITE);
      if (result.imported) {
        includedAdsetKeys.add(snapshotMetricKey(aggregate.metricDate, aggregate.metaAdsetId));
        importedCount += 1;
      }
    }

    if (includedAdsetKeys.size > 0) {
      await this.deactivateMissingSnapshotMetrics({ snapshotDates, includedKeys: includedAdsetKeys });
    }
    return importedCount;
  }

  private async importAdsetAggregateMetric(batchId: string, input: AdsetAggregateInput, conflictPolicy: ConflictPolicy) {
    let skipped = false;
    await this.prisma.$transaction(async (tx) => {
      const existingRows = await tx.metaAdsetDailyMetric.findMany({
        where: {
          metricDate: input.metricDate,
          metaAdsetId: input.metaAdsetId
        },
        orderBy: { importVersion: "desc" },
        select: { id: true, importVersion: true, isCurrent: true }
      });
      const latest = existingRows[0] ?? null;
      const current = existingRows.find((row) => row.isCurrent) ?? null;
      const importVersion = nextImportVersion(latest?.importVersion);
      const duplicateDecision = this.duplicatePolicyResolver.resolve(conflictPolicy, Boolean(current));

      if (!duplicateDecision.importMetric) {
        skipped = true;
        return;
      }

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdsetDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
      }

      const created = await tx.metaAdsetDailyMetric.create({
        data: {
          uploadBatchId: batchId,
          uploadRowId: null,
          metaAdsetId: input.metaAdsetId,
          metricDate: input.metricDate,
          dateStart: input.dateStart,
          dateEnd: input.dateEnd,
          adsetName: input.adsetName,
          adsetNameKey: input.adsetNameKey,
          deliveryStatus: input.deliveryStatus,
          attributionSetting: input.attributionSetting,
          resultCount: input.purchaseCount,
          resultIndicator: input.resultIndicator,
          reach: input.reach,
          frequency: decimalOrNull(input.frequency),
          costPerResultUsd: decimalOrNull(input.costPerResultUsd),
          adsetBudgetLabel: input.adsetBudgetLabel,
          adsetBudgetType: input.adsetBudgetType,
          spendUsd: new Prisma.Decimal(input.spendUsd),
          endStatus: input.endStatus,
          startDate: null,
          impressions: BigInt(input.impressions),
          cpmUsd: decimalOrNull(input.cpmUsd),
          linkClicks: input.linkClicks,
          shopClicks: input.shopClicks,
          cpcLinkUsd: decimalOrNull(input.cpcLinkUsd),
          ctrLinkPct: decimalOrNull(input.ctrLinkPct),
          clicksAll: input.clicksAll,
          ctrAllPct: decimalOrNull(input.ctrAllPct),
          cpcAllUsd: decimalOrNull(input.cpcAllUsd),
          landingPageViews: input.landingPageViews,
          costPerLandingPageViewUsd: decimalOrNull(input.costPerLandingPageViewUsd),
          productId: input.productId,
          stage: input.stage,
          productMatchSource: input.productMatchSource,
          stageMatchSource: input.stageMatchSource,
          productMatchRuleId: input.productMatchRuleId,
          importVersion,
          isCurrent: true,
          supersededByMetricId: null,
          rawRow: input.rawRow as Prisma.InputJsonObject
        }
      });

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdsetDailyMetric.update({
          where: { id: current.id },
          data: { supersededByMetricId: created.id }
        });
      }
    });
    return { imported: !skipped, skipped };
  }

  private async ensureExchangeRatesForParsedRows(batchId: string, parsedRows: ParsedUploadRow[]) {
    const metricDates = parsedRows
      .filter(({ parsed }) => parsed.parsedRow && parsed.issues.length === 0)
      .map(({ parsed }) => parsed.parsedRow?.metricDate)
      .filter((date): date is Date => Boolean(date));

    if (metricDates.length === 0) {
      return;
    }

    try {
      await this.exchangeRatesService.ensureUsdKrwRatesForDates(metricDates);
    } catch (error) {
      const message = errorMessage(error);
      await this.prisma.uploadRowError.create({
        data: {
          uploadBatchId: batchId,
          severity: "ERROR",
          errorCode: "EXCHANGE_RATE_SYNC_FAILED",
          message
        }
      });
      await this.prisma.uploadBatch.update({
        where: { id: batchId },
        data: { status: UploadStatus.FAILED, errorCount: 1, validatedAt: new Date() }
      });
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException({
        code: "EXCHANGE_RATE_SYNC_FAILED",
        message: "업로드 날짜의 USD/KRW 환율을 확보하지 못했습니다.",
        details: message
      });
    }
  }

  private async ensureExchangeRatesForAdRows(batchId: string, parsedRows: ParsedAdUploadRow[]) {
    const metricDates = parsedRows
      .filter(({ parsed }) => parsed.parsedRow && parsed.issues.length === 0)
      .map(({ parsed }) => parsed.parsedRow?.metricDate)
      .filter((date): date is Date => Boolean(date));

    if (metricDates.length === 0) {
      return;
    }

    try {
      await this.exchangeRatesService.ensureUsdKrwRatesForDates(metricDates);
    } catch (error) {
      const message = errorMessage(error);
      await this.prisma.uploadRowError.create({
        data: {
          uploadBatchId: batchId,
          severity: "ERROR",
          errorCode: "EXCHANGE_RATE_SYNC_FAILED",
          message
        }
      });
      await this.prisma.uploadBatch.update({
        where: { id: batchId },
        data: { status: UploadStatus.FAILED, errorCount: 1, validatedAt: new Date() }
      });
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException({
        code: "EXCHANGE_RATE_SYNC_FAILED",
        message: "업로드 날짜의 USD/KRW 환율을 확보하지 못했습니다.",
        details: message
      });
    }
  }
}

type ParsedUploadRow = {
  rowNumber: number;
  rawRow: Record<string, string>;
  sourceRowHash: string;
  parsed: ReturnType<MetaCsvParser["parseRow"]>;
};

type ParsedAdUploadRow = {
  rowNumber: number;
  rawRow: Record<string, string>;
  sourceRowHash: string;
  parsed: ReturnType<MetaAdDailyCsvParser["parseRow"]>;
};

type MetricImportInput = {
  batchId: string;
  uploadRowId: string;
  parsedRow: ParsedMetaAdsetRow;
  rawRow: Record<string, string>;
  metaAdsetId: string;
  productId: string | null;
  productMatchSource: MatchSource;
  productMatchRuleId: string | null;
  stage: AdStage;
  stageMatchSource: MatchSource;
  conflictPolicy: ConflictPolicy;
};

type AdMetricImportInput = {
  batchId: string;
  uploadRowId: string;
  parsedRow: ParsedMetaAdDailyRow;
  rawRow: Record<string, string>;
  campaignRefId: string;
  metaAdsetRefId: string;
  metaAdRefId: string;
  creativeId: string | null;
  productId: string | null;
  productMatchSource: MatchSource;
  productMatchRuleId: string | null;
  stage: AdStage;
  stageMatchSource: MatchSource;
  conflictPolicy: ConflictPolicy;
};

type AdsetAggregateInput = {
  metaAdsetId: string;
  metricDate: Date;
  dateStart: Date;
  dateEnd: Date;
  adsetName: string;
  adsetNameKey: string;
  deliveryStatus: string | null;
  attributionSetting: string | null;
  resultIndicator: string | null;
  purchaseCount: number;
  reach: number;
  frequency: number | null;
  costPerResultUsd: number | null;
  adsetBudgetLabel: string | null;
  adsetBudgetType: string | null;
  spendUsd: number;
  endStatus: string | null;
  impressions: number;
  cpmUsd: number | null;
  linkClicks: number;
  shopClicks: number;
  cpcLinkUsd: number | null;
  ctrLinkPct: number | null;
  clicksAll: number;
  ctrAllPct: number | null;
  cpcAllUsd: number | null;
  landingPageViews: number;
  costPerLandingPageViewUsd: number | null;
  productId: string | null;
  stage: AdStage;
  productMatchSource: MatchSource;
  stageMatchSource: MatchSource;
  productMatchRuleId: string | null;
  rawRow: Record<string, unknown>;
};

type DeletedAdMetricKey = {
  id: string;
  creativeId: string | null;
  metricDate: Date;
  metaCampaignId: string;
  metaAdsetId: string;
  adIdentityKey: string;
  adNameSnapshot: string;
};

type DeletedAdsetMetricKey = {
  id: string;
  metricDate: Date;
  metaAdsetId: string;
};

type CreativePlacementCleanupKey = {
  creativeId: string;
  metaCampaignId: string;
  metaAdsetId: string;
  originalAdName: string;
};

function minDate(current: Date | null, next: Date) {
  return current && current < next ? current : next;
}

function maxDate(current: Date | null, next: Date) {
  return current && current > next ? current : next;
}

function decimalOrNull(value: number | null) {
  return value === null ? null : new Prisma.Decimal(value);
}

function jsonSafeParsedRow(parsedRow: ParsedMetaAdsetRow) {
  return {
    ...parsedRow,
    dateStart: formatDateOnly(parsedRow.dateStart),
    dateEnd: formatDateOnly(parsedRow.dateEnd),
    metricDate: formatDateOnly(parsedRow.metricDate),
    startDate: parsedRow.startDate ? formatDateOnly(parsedRow.startDate) : null
  };
}

function jsonSafeAdParsedRow(parsedRow: ParsedMetaAdDailyRow) {
  return {
    ...parsedRow,
    dateStart: formatDateOnly(parsedRow.dateStart),
    dateEnd: formatDateOnly(parsedRow.dateEnd),
    metricDate: formatDateOnly(parsedRow.metricDate)
  };
}

function creativeOriginalKey(originalName: string) {
  return originalName.trim();
}

function creativePlacementCleanupKey(metric: {
  creativeId: string | null;
  metaCampaignId: string;
  metaAdsetId: string;
  adNameSnapshot: string;
}): CreativePlacementCleanupKey {
  return {
    creativeId: metric.creativeId ?? "",
    metaCampaignId: metric.metaCampaignId,
    metaAdsetId: metric.metaAdsetId,
    originalAdName: metric.adNameSnapshot
  };
}

function placementKeyToString(key: CreativePlacementCleanupKey) {
  return `${key.creativeId}:${key.metaCampaignId}:${key.metaAdsetId}:${key.originalAdName}`;
}

function creativePlacementWhere(key: CreativePlacementCleanupKey): Prisma.CreativePlacementWhereInput {
  return {
    creativeId: key.creativeId,
    metaCampaignId: key.metaCampaignId,
    metaAdsetId: key.metaAdsetId,
    originalAdName: key.originalAdName
  };
}

function emptyCreativeCleanup() {
  return {
    deletedCreativePlacementCount: 0,
    deletedCreativeAliasCount: 0,
    deletedCreativeLogCount: 0,
    deletedCreativeCount: 0,
    deactivatedCreativeCount: 0
  };
}

function errorMessage(error: unknown) {
  if (error instanceof BadRequestException) {
    const response = error.getResponse();
    if (typeof response === "object" && response && "message" in response) {
      return String((response as { message?: unknown }).message);
    }
  }
  return error instanceof Error ? error.message : "환율 확보 중 알 수 없는 오류가 발생했습니다.";
}

export function nextImportVersion(latestVersion?: number | null) {
  return (latestVersion ?? 0) + 1;
}

export function snapshotMetricKey(metricDate: Date, metaAdsetId: string) {
  return `${formatDateOnly(metricDate)}:${metaAdsetId}`;
}

export function snapshotAdMetricKey(metric: {
  metricDate: Date;
  metaCampaignId: string;
  metaAdsetId: string;
  adIdentityKey: string;
}) {
  return `${formatDateOnly(metric.metricDate)}:${metric.metaCampaignId}:${metric.metaAdsetId}:${metric.adIdentityKey}`;
}

export function findMissingSnapshotMetricIds(
  currentMetrics: Array<{ id: string; metricDate: Date; metaAdsetId: string }>,
  includedKeys: Set<string>
) {
  return currentMetrics
    .filter((metric) => !includedKeys.has(snapshotMetricKey(metric.metricDate, metric.metaAdsetId)))
    .map((metric) => metric.id);
}

function duplicatedValues(values: string[]) {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicated.add(value);
    }
    seen.add(value);
  }
  return Array.from(duplicated);
}

function uniqueAdMetricKeys(metrics: DeletedAdMetricKey[]) {
  const unique = new Map<string, DeletedAdMetricKey>();
  for (const metric of metrics) {
    unique.set(snapshotAdMetricKey(metric), metric);
  }
  return Array.from(unique.values());
}

function uniqueAdsetMetricKeys(metrics: DeletedAdsetMetricKey[]) {
  const unique = new Map<string, DeletedAdsetMetricKey>();
  for (const metric of metrics) {
    unique.set(snapshotMetricKey(metric.metricDate, metric.metaAdsetId), metric);
  }
  return Array.from(unique.values());
}

function duplicateBatchHash(fileHashSha256: string, conflictPolicy: ConflictPolicy) {
  return createHash("sha256").update(`${fileHashSha256}:${conflictPolicy}:${Date.now()}:${Math.random()}`).digest("hex");
}

function aggregateAdRows(rows: Prisma.MetaAdDailyMetricGetPayload<Record<string, never>>[]): AdsetAggregateInput {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const productAttribution = aggregateProductAttribution(rows);
  const spendUsd = sum(rows, (row) => decimalNumber(row.spendUsd));
  const purchaseCount = sum(rows, (row) => row.purchaseCount);
  const reach = sum(rows, (row) => row.reach);
  const impressions = sum(rows, (row) => bigintNumber(row.impressions));
  const linkClicks = sum(rows, (row) => row.linkClicks);
  const shopClicks = sum(rows, (row) => row.shopClicks);
  const clicksAll = sum(rows, (row) => row.clicksAll);
  const landingPageViews = sum(rows, (row) => row.landingPageViews);

  return {
    metaAdsetId: first.metaAdsetRefId,
    metricDate: first.metricDate,
    dateStart: rows.reduce<Date | null>((current, row) => minDate(current, row.dateStart), null) ?? first.dateStart,
    dateEnd: rows.reduce<Date | null>((current, row) => maxDate(current, row.dateEnd), null) ?? first.dateEnd,
    adsetName: last.adsetNameSnapshot,
    adsetNameKey: AdsetNameNormalizer.toKey(last.adsetNameSnapshot),
    deliveryStatus: chooseDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
    attributionSetting: firstNonNull(rows.map((row) => row.attributionSetting)),
    resultIndicator: firstNonNull(rows.map((row) => row.resultIndicator)),
    purchaseCount,
    reach,
    frequency: ratio(impressions, reach),
    costPerResultUsd: ratio(spendUsd, purchaseCount),
    adsetBudgetLabel: firstNonNull(rows.map((row) => row.adsetBudgetLabel)),
    adsetBudgetType: firstNonNull(rows.map((row) => row.adsetBudgetType)),
    spendUsd,
    endStatus: firstNonNull(rows.map((row) => row.endStatus)),
    impressions,
    cpmUsd: ratio(spendUsd * 1000, impressions),
    linkClicks,
    shopClicks,
    cpcLinkUsd: ratio(spendUsd, linkClicks),
    ctrLinkPct: ratio(linkClicks * 100, impressions),
    clicksAll,
    ctrAllPct: ratio(clicksAll * 100, impressions),
    cpcAllUsd: ratio(spendUsd, clicksAll),
    landingPageViews,
    costPerLandingPageViewUsd: ratio(spendUsd, landingPageViews),
    productId: productAttribution.productId,
    stage: last.stage,
    productMatchSource: productAttribution.productMatchSource,
    stageMatchSource: last.stageMatchSource,
    productMatchRuleId: productAttribution.productMatchRuleId,
    rawRow: {
      source: "meta_ad_daily_metrics",
      metricIds: rows.map((row) => row.id),
      metaCampaignId: first.metaCampaignId,
      metaAdsetId: first.metaAdsetId,
      adCount: rows.length
    }
  };
}

function aggregateProductAttribution(rows: Prisma.MetaAdDailyMetricGetPayload<Record<string, never>>[]) {
  if (rows.length === 0 || rows.some((row) => !row.productId)) {
    return unmatchedProductAttribution();
  }

  const productIds = Array.from(new Set(rows.map((row) => row.productId).filter((id): id is string => Boolean(id))));
  if (productIds.length !== 1) {
    return unmatchedProductAttribution();
  }

  const sources = new Set(rows.map((row) => row.productMatchSource).filter((source) => source !== MatchSource.UNMATCHED));
  const productMatchSource =
    sources.size === 1
      ? Array.from(sources)[0]
      : sources.has(MatchSource.MANUAL)
        ? MatchSource.MANUAL
        : sources.has(MatchSource.RULE)
          ? MatchSource.RULE
          : MatchSource.INFERRED;
  const ruleIds = Array.from(new Set(rows.map((row) => row.productMatchRuleId).filter((id): id is string => Boolean(id))));

  return {
    productId: productIds[0],
    productMatchSource,
    productMatchRuleId: productMatchSource === MatchSource.RULE && ruleIds.length === 1 ? ruleIds[0] : null
  };
}

function unmatchedProductAttribution() {
  return {
    productId: null,
    productMatchSource: MatchSource.UNMATCHED,
    productMatchRuleId: null
  };
}

function decimalNumber(value: Prisma.Decimal | number | null): number {
  if (value === null) {
    return 0;
  }
  return typeof value === "number" ? value : value.toNumber();
}

function bigintNumber(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function sum<T>(rows: T[], selector: (row: T) => number) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function ratio(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function firstNonNull<T>(values: Array<T | null>): T | null {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

function chooseDeliveryStatus(values: Array<string | null>) {
  const normalized = values.filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  if (normalized.includes("active")) {
    return "active";
  }
  if (normalized.includes("inactive")) {
    return "inactive";
  }
  return values.find((value): value is string => Boolean(value)) ?? null;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
