import { BadRequestException, Injectable } from "@nestjs/common";
import { AdStage, ConflictPolicy, MatchSource, Prisma, RowValidationStatus, UploadStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { normalizeUploadedFilename } from "../common/encoding";
import { PrismaService } from "../common/prisma.service";
import { formatDateOnly } from "../domain/date-number";
import { CsvHeaderValidator, hashRecord, MetaCsvParser } from "../domain/meta-csv";
import { MappingsService } from "../mappings/mappings.service";
import { MetaEntityWriterService } from "./meta-entity-writer.service";
import { MetaMetricVersionService } from "./meta-metric-version.service";
import {
  duplicateBatchHash,
  jsonSafeParsedRow,
  maxDate,
  minDate,
  snapshotMetricKey
} from "./upload-keys";
import { UploadStorageService } from "./upload-storage.service";
import { UploadExchangeRateService } from "./upload-exchange-rate.service";

@Injectable()
export class MetaAdsetImportService {
  private readonly csvParser = new MetaCsvParser();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: UploadStorageService,
    private readonly entityWriterService: MetaEntityWriterService,
    private readonly metricVersionService: MetaMetricVersionService,
    private readonly mappingsService: MappingsService,
    private readonly uploadExchangeRateService: UploadExchangeRateService
  ) {}

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
    const storedFilePath = await this.storageService.storeOriginalFile(file, batchFileHashSha256, originalFilename);
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

    await this.uploadExchangeRateService.ensureUsdKrwRates(
      batch.id,
      parsedRows
        .filter(({ parsed }) => parsed.parsedRow && parsed.issues.length === 0)
        .map(({ parsed }) => parsed.parsedRow?.metricDate)
        .filter((date): date is Date => Boolean(date))
    );

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
        const metaAdset = await this.entityWriterService.upsertAdset(parsedRow);
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
        const result = await this.metricVersionService.importMetric({
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
        ? await this.metricVersionService.deactivateMissingSnapshotMetrics({
            snapshotDates: Array.from(snapshotDatesByKey.values()),
            includedKeys: includedSnapshotKeys
          })
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

}
