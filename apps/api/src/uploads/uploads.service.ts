import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AdStage,
  ConflictPolicy,
  MatchSource,
  Prisma,
  RowValidationStatus,
  UploadStatus
} from "@prisma/client";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeUploadedFilename } from "../common/encoding";
import { PrismaService } from "../common/prisma.service";
import { AdsetNameNormalizer } from "../domain/adset-name-normalizer";
import { CsvHeaderValidator, hashRecord, MetaCsvParser, ParsedMetaAdsetRow } from "../domain/meta-csv";
import { DuplicatePolicyResolver } from "../domain/duplicate-policy";
import { formatDateOnly } from "../domain/date-number";
import { ExchangeRatesService } from "../exchange-rates/exchange-rates.service";
import { MappingsService } from "../mappings/mappings.service";

@Injectable()
export class UploadsService {
  private readonly csvParser = new MetaCsvParser();
  private readonly duplicatePolicyResolver = new DuplicatePolicyResolver();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mappingsService: MappingsService,
    private readonly exchangeRatesService: ExchangeRatesService
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
    if (duplicated) {
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
        reportEnd: duplicated.reportEnd ? formatDateOnly(duplicated.reportEnd) : null
      };
    }

    const originalFilename = normalizeUploadedFilename(file.originalname);
    const { headers, rows } = this.csvParser.parseBuffer(file.buffer);
    const storedFilePath = await this.storeOriginalFile(file, fileHashSha256, originalFilename);
    const batch = await this.prisma.uploadBatch.create({
      data: {
        originalFilename,
        storedFilePath,
        fileHashSha256,
        columnSchema: { columns: headers, count: headers.length },
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
      }
    }

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
      include: { _count: { select: { rows: true, errors: true, metrics: true } } }
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
      unmatched
    };
  }

  uploadErrors(id: string) {
    return this.prisma.uploadRowError.findMany({
      where: { uploadBatchId: id },
      orderBy: [{ rowNumber: "asc" }, { columnName: "asc" }]
    });
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

  private async upsertAdset(parsedRow: ParsedMetaAdsetRow) {
    const existing = await this.prisma.metaAdset.findFirst({
      where: { platform: "META", externalAdsetId: null, adsetNameKey: parsedRow.adsetNameKey }
    });
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

  private async importMetric(input: MetricImportInput) {
    const current = await this.prisma.metaAdsetDailyMetric.findFirst({
      where: {
        metricDate: input.parsedRow.metricDate,
        metaAdsetId: input.metaAdsetId,
        isCurrent: true
      },
      orderBy: { importVersion: "desc" }
    });
    const duplicateDecision = this.duplicatePolicyResolver.resolve(input.conflictPolicy, Boolean(current));
    if (!duplicateDecision.importMetric) {
      return { imported: false, skipped: true };
    }

    let importVersion = 1;
    if (current && duplicateDecision.supersedeExisting) {
      importVersion = current.importVersion + 1;
      await this.prisma.metaAdsetDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
    }

    const created = await this.prisma.metaAdsetDailyMetric.create({
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
      await this.prisma.metaAdsetDailyMetric.update({
        where: { id: current.id },
        data: { supersededByMetricId: created.id }
      });
    }

    return { imported: true, skipped: false };
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
}

type ParsedUploadRow = {
  rowNumber: number;
  rawRow: Record<string, string>;
  sourceRowHash: string;
  parsed: ReturnType<MetaCsvParser["parseRow"]>;
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

function errorMessage(error: unknown) {
  if (error instanceof BadRequestException) {
    const response = error.getResponse();
    if (typeof response === "object" && response && "message" in response) {
      return String((response as { message?: unknown }).message);
    }
  }
  return error instanceof Error ? error.message : "환율 확보 중 알 수 없는 오류가 발생했습니다.";
}
