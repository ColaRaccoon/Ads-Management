import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ConflictPolicy,
  CoupangUploadSourceType,
  MatchSource,
  Prisma,
  RowValidationStatus,
  UploadStatus
} from "@prisma/client";
import { createHash } from "node:crypto";
import { normalizeUploadedFilename } from "../common/encoding";
import { asDateOnly, numberFrom, parseDateRange } from "../common/date-range";
import { PrismaService } from "../common/prisma.service";
import { CoupangAdsXlsxParser, coupangAdMetricKey, COUPANG_ADS_SCHEMA_VERSION } from "../domain/coupang-ads-xlsx";
import { CoupangMarginCsvParser, COUPANG_MARGIN_SCHEMA_VERSION, ParsedCoupangMarginRow } from "../domain/coupang-margin-csv";
import { isInactivePromotionStatus, resolveCoupangSalePrice } from "../domain/coupang-price-resolver";
import { CoupangProductMatcher, CoupangRuleInput } from "../domain/coupang-product-matcher";
import { CoupangPriceTextParser, COUPANG_PRICE_TEXT_SCHEMA_VERSION } from "../domain/coupang-price-text";
import { calculateCoupangProfit, CoupangCostInput } from "../domain/coupang-profit-calculator";
import { CoupangPromotionXlsxParser, COUPANG_PROMOTION_SCHEMA_VERSION } from "../domain/coupang-promotion-xlsx";
import {
  CoupangSalesXlsxParser,
  coupangSaleLineKey,
  COUPANG_SALES_SCHEMA_VERSION,
  ParsedCoupangSaleRow
} from "../domain/coupang-sales-xlsx";
import { formatDateOnly, ParseIssue, safeDivide, toDateOnly } from "../domain/date-number";

type RowIssue = Omit<ParseIssue, "columnName"> & {
  columnName: string | null;
  severity: "ERROR" | "WARNING";
  candidates?: string[];
};

type ExistingCurrentCoupangRow = {
  id: string;
  importVersion: number;
} | null;

type CoupangRowImportDecision = {
  importVersion: number;
  isCurrent: boolean;
  supersedeExisting: boolean;
  skippedDuplicate: boolean;
};

type CoupangCostRuleSnapshot = Pick<
  Prisma.CoupangCostRuleGetPayload<Record<string, never>>,
  | "salePriceKrw"
  | "supplyPriceKrw"
  | "productCostKrw"
  | "salesFeeRate"
  | "salesFeeKrw"
  | "sellerShippingFeeKrw"
  | "growthInboundFeeKrw"
  | "growthShippingFeeKrw"
  | "returnRate"
  | "returnCostPerUnitKrw"
  | "extraCostKrw"
  | "note"
>;

type ProductProfitRow = {
  productId: string;
  productName: string;
  saleMethod: string | null;
  matchedSalesLineCount: number;
  salesQuantity: number;
  orderCount: number;
  salesKrw: number;
  cancelAmountKrw: number;
  netSalesKrw: number;
  salePriceKrw: number | null;
  baseSalePriceKrw: number | null;
  promotionPriceKrw: number | null;
  priceSource: "PROMOTION" | "BASE" | "MISSING" | "CONFLICT";
  priceWarnings: string[];
  productCostKrw: number | null;
  salesFeeKrw: number | null;
  shippingCostKrw: number | null;
  returnCostKrw: number | null;
  extraCostKrw: number | null;
  adSpendKrw: number;
  adConversionSalesKrw: number;
  adConversionQuantity: number;
  organicSalesKrw: number;
  totalCostKrw: number | null;
  marginKrw: number | null;
  marginRate: number | null;
  roas: number | null;
  warnings: string[];
  ruleStatus: "OK" | "MISSING_COST_RULE" | "UNMATCHED";
};

@Injectable()
export class CoupangService {
  private readonly salesParser = new CoupangSalesXlsxParser();
  private readonly adsParser = new CoupangAdsXlsxParser();
  private readonly marginParser = new CoupangMarginCsvParser();
  private readonly priceTextParser = new CoupangPriceTextParser();
  private readonly promotionParser = new CoupangPromotionXlsxParser();
  private readonly matcher = new CoupangProductMatcher();

  constructor(private readonly prisma: PrismaService) {}

  async importSalesXlsx(file: Express.Multer.File | undefined, body: Record<string, unknown>) {
    const upload = this.assertFile(file, "Coupang sales XLSX file is required.");
    const originalFilename = normalizeUploadedFilename(upload.originalname);
    const fileHashSha256 = createHash("sha256").update(upload.buffer).digest("hex");
    const duplicate = await this.reusableDuplicate(fileHashSha256, CoupangUploadSourceType.SALES, body.conflictPolicy);
    if (duplicate) {
      return duplicate;
    }

    const parsed = await this.salesParser.parseBuffer(upload.buffer, {
      filename: originalFilename,
      reportDate: optionalString(body.reportDate),
      cancelAmountMode: optionalString(body.cancelAmountMode) === "POSITIVE_SUBTRACT" ? "POSITIVE_SUBTRACT" : "NEGATIVE_ADD"
    });
    const batch = await this.createBatch({
      sourceType: CoupangUploadSourceType.SALES,
      originalFilename,
      fileHashSha256,
      conflictPolicy: parseConflictPolicy(body.conflictPolicy),
      columnSchema: {
        schemaVersion: COUPANG_SALES_SCHEMA_VERSION,
        columns: parsed.headers,
        missingColumns: parsed.missingColumns
      },
      rowCount: parsed.rows.length
    });

    if (parsed.missingColumns.length > 0) {
      await this.failMissingColumns(batch.id, CoupangUploadSourceType.SALES, parsed.missingColumns);
    }

    const rules = await this.matcherRules();
    let validRowCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    let matchedCount = 0;
    let unmatchedCount = 0;
    let ambiguousCount = 0;
    let dataStart: Date | null = null;
    let dataEnd: Date | null = null;

    await this.prisma.$transaction(async (tx) => {
      for (const row of parsed.rows) {
        const issues = row.issues.map((issue) => rowIssue(issue, "ERROR"));
        const warnings: RowIssue[] = [];
        let productId: string | null = null;
        let ruleId: string | null = null;
        let matchSource: MatchSource = MatchSource.UNMATCHED;
        const parsedRow = row.parsedRow;

        if (parsedRow) {
          const match = this.matcher.matchText(`${parsedRow.productName} ${parsedRow.optionName}`, rules, parsedRow.saleDate);
          if (match.reason === "MATCHED") {
            productId = match.productId;
            ruleId = match.matchRuleId;
            matchSource = MatchSource.RULE;
            matchedCount += 1;
          } else {
            warnings.push(matchIssue(match.reason, match.candidates));
            unmatchedCount += match.reason === "NO_MATCH" || match.reason === "EXCLUDED_BY_KEYWORD" ? 1 : 0;
            ambiguousCount += match.reason === "AMBIGUOUS_MATCH" ? 1 : 0;
          }
          if (parsedRow.saleDate) {
            dataStart = minDate(dataStart, parsedRow.saleDate);
            dataEnd = maxDate(dataEnd, parsedRow.saleDate);
          }
        }

        const saleLineKey = parsedRow ? coupangSaleLineKey(parsedRow) : fallbackRowKey(row.rawRow);
        const existingRows = await tx.coupangSaleLine.findMany({
          where: { saleLineKey },
          orderBy: [{ importVersion: "desc" }, { createdAt: "desc" }],
          select: { id: true, importVersion: true, isCurrent: true }
        });
        const existingCurrentRows = existingRows.filter((line) => line.isCurrent);
        const decision = resolveCoupangRowImportDecision({
          conflictPolicy: batch.conflictPolicy,
          existingCurrent: existingCurrentRows[0] ?? null,
          latestImportVersion: existingRows[0]?.importVersion ?? null
        });
        if (decision.skippedDuplicate) {
          warnings.push(duplicateCurrentIssue("COUPANG_SALE_LINE_ALREADY_CURRENT", saleLineKey));
        }

        const validationStatus = validationStatusFor(issues, warnings, productId);
        const storedState = resolveCoupangRowStoredState({ validationStatus, decision });
        if (issues.length > 0) {
          errorCount += 1;
        } else {
          validRowCount += 1;
        }
        warningCount += warnings.length;

        if (storedState.supersedeExisting && existingCurrentRows.length > 0) {
          await tx.coupangSaleLine.updateMany({
            where: { id: { in: existingCurrentRows.map((line) => line.id) } },
            data: { isCurrent: false }
          });
        } else if (existingCurrentRows.length > 1) {
          await tx.coupangSaleLine.updateMany({
            where: { id: { in: existingCurrentRows.slice(1).map((line) => line.id) } },
            data: { isCurrent: false }
          });
        }

        const saved = await tx.coupangSaleLine.create({
          data: {
            uploadBatchId: batch.id,
            rowNumber: row.rowNumber,
            sourceRowHash: row.sourceRowHash,
            saleLineKey,
            saleDate: parsedRow?.saleDate,
            optionId: parsedRow?.optionId,
            optionName: parsedRow?.optionName ?? "",
            productName: parsedRow?.productName ?? "",
            registeredProductId: parsedRow?.registeredProductId,
            category: parsedRow?.category,
            saleMethod: parsedRow?.saleMethod,
            salesKrw: decimal(parsedRow?.salesKrw),
            orderCount: parsedRow?.orderCount ?? 0,
            salesQuantity: decimal(parsedRow?.salesQuantity),
            totalSalesKrw: decimal(parsedRow?.totalSalesKrw),
            totalSalesQuantity: decimal(parsedRow?.totalSalesQuantity),
            cancelAmountKrw: decimal(parsedRow?.cancelAmountKrw),
            cancelQuantity: decimal(parsedRow?.cancelQuantity),
            instantCancelQuantity: decimal(parsedRow?.instantCancelQuantity),
            netSalesKrw: decimal(parsedRow?.netSalesKrw),
            coupangProductId: productId,
            coupangProductRuleId: ruleId,
            matchSource,
            validationStatus,
            validationErrors: [...issues, ...warnings] as unknown as Prisma.InputJsonValue,
            importVersion: storedState.importVersion,
            isCurrent: storedState.isCurrent,
            rawRow: row.rawRow as Prisma.InputJsonObject
          }
        });
        await this.createRowErrors(tx, batch.id, CoupangUploadSourceType.SALES, saved.id, null, row.rowNumber, [
          ...issues,
          ...warnings
        ]);
      }

      await tx.coupangUploadBatch.update({
        where: { id: batch.id },
        data: {
          dataStart,
          dataEnd,
          validRowCount,
          warningCount,
          errorCount,
          status: statusFor(validRowCount, errorCount),
          validatedAt: new Date(),
          importedAt: validRowCount > 0 ? new Date() : null
        }
      });
    });

    return {
      batchId: batch.id,
      schemaVersion: COUPANG_SALES_SCHEMA_VERSION,
      rowCount: parsed.rows.length,
      validRowCount,
      warningCount,
      errorCount,
      matchedCount,
      unmatchedCount,
      ambiguousCount,
      dataStart: dataStart ? formatDateOnly(dataStart) : null,
      dataEnd: dataEnd ? formatDateOnly(dataEnd) : null
    };
  }

  async importAdsXlsx(file: Express.Multer.File | undefined, body: Record<string, unknown>) {
    const upload = this.assertFile(file, "Coupang ads XLSX file is required.");
    const originalFilename = normalizeUploadedFilename(upload.originalname);
    const fileHashSha256 = createHash("sha256").update(upload.buffer).digest("hex");
    const duplicate = await this.reusableDuplicate(fileHashSha256, CoupangUploadSourceType.ADS, body.conflictPolicy);
    if (duplicate) {
      return duplicate;
    }

    const parsed = await this.adsParser.parseBuffer(upload.buffer);
    const batch = await this.createBatch({
      sourceType: CoupangUploadSourceType.ADS,
      originalFilename,
      fileHashSha256,
      conflictPolicy: parseConflictPolicy(body.conflictPolicy),
      columnSchema: {
        schemaVersion: COUPANG_ADS_SCHEMA_VERSION,
        columns: parsed.headers,
        missingColumns: parsed.missingColumns
      },
      rowCount: parsed.rows.length
    });

    if (parsed.missingColumns.length > 0) {
      await this.failMissingColumns(batch.id, CoupangUploadSourceType.ADS, parsed.missingColumns);
    }

    const rules = await this.matcherRules();
    let validRowCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    let matchedSpendCount = 0;
    let matchedConversionCount = 0;
    let dataStart: Date | null = null;
    let dataEnd: Date | null = null;

    await this.prisma.$transaction(async (tx) => {
      for (const row of parsed.rows) {
        const issues = row.issues.map((issue) => rowIssue(issue, "ERROR"));
        const warnings: RowIssue[] = [];
        const parsedRow = row.parsedRow;
        let spendProductId: string | null = null;
        let spendRuleId: string | null = null;
        let conversionProductId: string | null = null;
        let conversionRuleId: string | null = null;
        let spendMatchSource: MatchSource = MatchSource.UNMATCHED;
        let conversionMatchSource: MatchSource = MatchSource.UNMATCHED;

        if (parsedRow) {
          const spendMatch = this.matcher.matchText(parsedRow.adExecutionProductName, rules, parsedRow.metricDate);
          if (spendMatch.reason === "MATCHED") {
            spendProductId = spendMatch.productId;
            spendRuleId = spendMatch.matchRuleId;
            spendMatchSource = MatchSource.RULE;
            matchedSpendCount += 1;
          } else {
            warnings.push(matchIssue(`SPEND_${spendMatch.reason}`, spendMatch.candidates));
          }

          const conversionMatch = this.matcher.matchText(parsedRow.conversionProductName, rules, parsedRow.metricDate);
          if (conversionMatch.reason === "MATCHED") {
            conversionProductId = conversionMatch.productId;
            conversionRuleId = conversionMatch.matchRuleId;
            conversionMatchSource = MatchSource.RULE;
            matchedConversionCount += 1;
          } else {
            warnings.push(matchIssue(`CONVERSION_${conversionMatch.reason}`, conversionMatch.candidates));
          }
          dataStart = minDate(dataStart, parsedRow.metricDate);
          dataEnd = maxDate(dataEnd, parsedRow.metricDate);
        }

        const adMetricKey = parsedRow ? coupangAdMetricKey(parsedRow) : fallbackRowKey(row.rawRow);
        const existingRows = await tx.coupangAdMetric.findMany({
          where: { adMetricKey },
          orderBy: [{ importVersion: "desc" }, { createdAt: "desc" }],
          select: { id: true, importVersion: true, isCurrent: true }
        });
        const existingCurrentRows = existingRows.filter((metric) => metric.isCurrent);
        const decision = resolveCoupangRowImportDecision({
          conflictPolicy: batch.conflictPolicy,
          existingCurrent: existingCurrentRows[0] ?? null,
          latestImportVersion: existingRows[0]?.importVersion ?? null
        });
        if (decision.skippedDuplicate) {
          warnings.push(duplicateCurrentIssue("COUPANG_AD_METRIC_ALREADY_CURRENT", adMetricKey));
        }

        const validationStatus = validationStatusFor(issues, warnings, spendProductId || conversionProductId);
        const storedState = resolveCoupangRowStoredState({ validationStatus, decision });
        if (issues.length > 0) {
          errorCount += 1;
        } else {
          validRowCount += 1;
        }
        warningCount += warnings.length;

        if (storedState.supersedeExisting && existingCurrentRows.length > 0) {
          await tx.coupangAdMetric.updateMany({
            where: { id: { in: existingCurrentRows.map((metric) => metric.id) } },
            data: { isCurrent: false }
          });
        } else if (existingCurrentRows.length > 1) {
          await tx.coupangAdMetric.updateMany({
            where: { id: { in: existingCurrentRows.slice(1).map((metric) => metric.id) } },
            data: { isCurrent: false }
          });
        }

        const saved = await tx.coupangAdMetric.create({
          data: {
            uploadBatchId: batch.id,
            rowNumber: row.rowNumber,
            sourceRowHash: row.sourceRowHash,
            adMetricKey,
            metricDate: parsedRow?.metricDate ?? new Date(0),
            campaignName: parsedRow?.campaignName,
            adGroupName: parsedRow?.adGroupName,
            adExecutionOptionId: parsedRow?.adExecutionOptionId,
            adExecutionProductName: parsedRow?.adExecutionProductName ?? "",
            conversionOptionId: parsedRow?.conversionOptionId,
            conversionProductName: parsedRow?.conversionProductName ?? "",
            impressions: BigInt(parsedRow?.impressions ?? 0),
            clicks: parsedRow?.clicks ?? 0,
            adSpendKrw: decimal(parsedRow?.adSpendKrw),
            totalOrders1d: parsedRow?.totalOrders1d ?? 0,
            directOrders1d: parsedRow?.directOrders1d ?? 0,
            indirectOrders1d: parsedRow?.indirectOrders1d ?? 0,
            totalConversionSales1dKrw: decimal(parsedRow?.totalConversionSales1dKrw),
            directConversionSales1dKrw: decimal(parsedRow?.directConversionSales1dKrw),
            indirectConversionSales1dKrw: decimal(parsedRow?.indirectConversionSales1dKrw),
            totalSalesQuantity1d: decimal(parsedRow?.totalSalesQuantity1d),
            directSalesQuantity1d: decimal(parsedRow?.directSalesQuantity1d),
            indirectSalesQuantity1d: decimal(parsedRow?.indirectSalesQuantity1d),
            spendProductId,
            spendProductRuleId: spendRuleId,
            conversionProductId,
            conversionProductRuleId: conversionRuleId,
            spendMatchSource,
            conversionMatchSource,
            validationStatus,
            validationErrors: [...issues, ...warnings] as unknown as Prisma.InputJsonValue,
            importVersion: storedState.importVersion,
            isCurrent: storedState.isCurrent,
            rawRow: row.rawRow as Prisma.InputJsonObject
          }
        });
        await this.createRowErrors(tx, batch.id, CoupangUploadSourceType.ADS, null, saved.id, row.rowNumber, [
          ...issues,
          ...warnings
        ]);
      }

      await tx.coupangUploadBatch.update({
        where: { id: batch.id },
        data: {
          dataStart,
          dataEnd,
          validRowCount,
          warningCount,
          errorCount,
          status: statusFor(validRowCount, errorCount),
          validatedAt: new Date(),
          importedAt: validRowCount > 0 ? new Date() : null
        }
      });
    });

    return {
      batchId: batch.id,
      schemaVersion: COUPANG_ADS_SCHEMA_VERSION,
      rowCount: parsed.rows.length,
      validRowCount,
      warningCount,
      errorCount,
      matchedSpendCount,
      matchedConversionCount,
      dataStart: dataStart ? formatDateOnly(dataStart) : null,
      dataEnd: dataEnd ? formatDateOnly(dataEnd) : null
    };
  }

  async importMarginCsv(file: Express.Multer.File | undefined, body: Record<string, unknown>) {
    const upload = this.assertFile(file, "Coupang margin CSV file is required.");
    const originalFilename = normalizeUploadedFilename(upload.originalname);
    const fileHashSha256 = createHash("sha256").update(upload.buffer).digest("hex");
    const duplicate = await this.reusableDuplicate(fileHashSha256, CoupangUploadSourceType.MARGIN, body.conflictPolicy);
    if (duplicate) {
      return duplicate;
    }
    const parsed = this.marginParser.parseBuffer(upload.buffer);
    const batch = await this.createBatch({
      sourceType: CoupangUploadSourceType.MARGIN,
      originalFilename,
      fileHashSha256,
      conflictPolicy: parseConflictPolicy(body.conflictPolicy),
      columnSchema: {
        schemaVersion: COUPANG_MARGIN_SCHEMA_VERSION,
        columns: parsed.headers,
        missingColumns: parsed.missingColumns
      },
      rowCount: parsed.rows.length
    });

    if (parsed.missingColumns.length > 0) {
      await this.failMissingColumns(batch.id, CoupangUploadSourceType.MARGIN, parsed.missingColumns);
    }

    const effectiveFrom = body.effectiveFrom ? asDateOnly(String(body.effectiveFrom)) : new Date();
    let validRowCount = 0;
    let errorCount = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const row of parsed.rows) {
        if (!row.parsedRow) {
          errorCount += 1;
          await this.createRowErrors(
            tx,
            batch.id,
            CoupangUploadSourceType.MARGIN,
            null,
            null,
            row.rowNumber,
            row.issues.map((issue) => rowIssue(issue, "ERROR"))
          );
          continue;
        }
        validRowCount += 1;
        const standardName = standardProductName(row.parsedRow.itemName);
        const product = await tx.coupangProduct.upsert({
          where: { standardName },
          create: {
            standardName,
            displayName: row.parsedRow.itemName
          },
          update: {
            displayName: row.parsedRow.itemName,
            isActive: true
          }
        });
        const existingRule = await tx.coupangProductRule.findFirst({
          where: { coupangProductId: product.id },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
        });
        if (existingRule) {
          await tx.coupangProductRule.update({
            where: { id: existingRule.id },
            data: {
              displayName: row.parsedRow.itemName,
              includeKeywords: [row.parsedRow.itemName],
              adEnabled: row.parsedRow.adEnabled,
              isActive: true
            }
          });
        } else {
          await tx.coupangProductRule.create({
            data: {
              coupangProductId: product.id,
              displayName: row.parsedRow.itemName,
              includeKeywords: [row.parsedRow.itemName],
              excludeKeywords: [],
              priority: 100,
              adEnabled: row.parsedRow.adEnabled,
              validFrom: effectiveFrom
            }
          });
        }
        const latestCostRule = await tx.coupangCostRule.findFirst({
          where: { coupangProductId: product.id },
          orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }]
        });
        await tx.coupangCostRule.create({
          data: buildCoupangMarginCostRuleData({
            coupangProductId: product.id,
            parsedRow: row.parsedRow,
            effectiveFrom,
            latestCostRule
          })
        });
      }
      await tx.coupangUploadBatch.update({
        where: { id: batch.id },
        data: {
          validRowCount,
          errorCount,
          status: statusFor(validRowCount, errorCount),
          validatedAt: new Date(),
          importedAt: validRowCount > 0 ? new Date() : null
        }
      });
    });

    return {
      batchId: batch.id,
      schemaVersion: COUPANG_MARGIN_SCHEMA_VERSION,
      rowCount: parsed.rows.length,
      validRowCount,
      errorCount
    };
  }

  async importPriceText(file: Express.Multer.File | undefined, body: Record<string, unknown>) {
    const upload = this.assertFile(file, "Coupang price text file is required.");
    const originalFilename = normalizeUploadedFilename(upload.originalname);
    const fileHashSha256 = createHash("sha256").update(upload.buffer).digest("hex");
    const duplicate = await this.reusableDuplicate(fileHashSha256, CoupangUploadSourceType.PRICE_TEXT, body.conflictPolicy);
    if (duplicate) {
      return duplicate;
    }
    const parsed = this.priceTextParser.parseBuffer(upload.buffer);
    const batch = await this.createBatch({
      sourceType: CoupangUploadSourceType.PRICE_TEXT,
      originalFilename,
      fileHashSha256,
      conflictPolicy: parseConflictPolicy(body.conflictPolicy),
      columnSchema: {
        schemaVersion: COUPANG_PRICE_TEXT_SCHEMA_VERSION,
        format: "name price"
      },
      rowCount: parsed.rows.length
    });
    const effectiveFrom = body.effectiveFrom ? asDateOnly(String(body.effectiveFrom)) : new Date();
    let validRowCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const row of parsed.rows) {
        if (!row.parsedRow) {
          errorCount += 1;
          await this.createRowErrors(
            tx,
            batch.id,
            CoupangUploadSourceType.PRICE_TEXT,
            null,
            null,
            row.rowNumber,
            row.issues.map((issue) => rowIssue(issue, "ERROR"))
          );
          continue;
        }
        validRowCount += 1;
        const standardName = standardProductName(row.parsedRow.itemName);
        const product = await tx.coupangProduct.upsert({
          where: { standardName },
          create: {
            standardName,
            displayName: row.parsedRow.itemName
          },
          update: { displayName: row.parsedRow.itemName, isActive: true }
        });
        const latestCostRule = await tx.coupangCostRule.findFirst({
          where: { coupangProductId: product.id },
          orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }]
        });
        const costRuleData = buildCoupangPriceTextCostRuleData({
          coupangProductId: product.id,
          salePriceKrw: row.parsedRow.salePriceKrw,
          effectiveFrom,
          latestCostRule
        });
        if (costRuleData) {
          await tx.coupangCostRule.create({ data: costRuleData });
        } else {
          warningCount += 1;
          await this.createRowErrors(tx, batch.id, CoupangUploadSourceType.PRICE_TEXT, null, null, row.rowNumber, [
            {
              columnName: "price",
              errorCode: "COUPANG_PRICE_TEXT_MISSING_COST_RULE",
              message: "Price text updated the product, but no cost rule was created because no existing Coupang cost rule could be copied.",
              rawValue: row.rawLine,
              severity: "WARNING"
            }
          ]);
        }
      }
      await tx.coupangUploadBatch.update({
        where: { id: batch.id },
        data: {
          validRowCount,
          warningCount,
          errorCount,
          status: statusFor(validRowCount, errorCount),
          validatedAt: new Date(),
          importedAt: validRowCount > 0 ? new Date() : null
        }
      });
    });
    return {
      batchId: batch.id,
      schemaVersion: COUPANG_PRICE_TEXT_SCHEMA_VERSION,
      rowCount: parsed.rows.length,
      validRowCount,
      warningCount,
      errorCount
    };
  }

  async importPromotionXlsx(file: Express.Multer.File | undefined, body: Record<string, unknown>) {
    const upload = this.assertFile(file, "Coupang promotion XLSX file is required.");
    const originalFilename = normalizeUploadedFilename(upload.originalname);
    const fileHashSha256 = createHash("sha256").update(upload.buffer).digest("hex");
    const duplicate = await this.reusableDuplicate(fileHashSha256, CoupangUploadSourceType.PROMOTION, body.conflictPolicy);
    if (duplicate) {
      return duplicate;
    }

    const parsed = await this.promotionParser.parseBuffer(upload.buffer);
    const batch = await this.createBatch({
      sourceType: CoupangUploadSourceType.PROMOTION,
      originalFilename,
      fileHashSha256,
      conflictPolicy: parseConflictPolicy(body.conflictPolicy),
      columnSchema: {
        schemaVersion: COUPANG_PROMOTION_SCHEMA_VERSION,
        columns: parsed.headers,
        missingColumns: parsed.missingColumns
      },
      rowCount: parsed.rows.length
    });

    if (parsed.missingColumns.length > 0) {
      await this.failMissingColumns(batch.id, CoupangUploadSourceType.PROMOTION, parsed.missingColumns);
    }

    const rules = await this.matcherRules();
    let validRowCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    let matchedCount = 0;
    let unmatchedCount = 0;
    let ambiguousCount = 0;
    let dataStart: Date | null = null;
    let dataEnd: Date | null = null;

    await this.prisma.$transaction(async (tx) => {
      for (const row of parsed.rows) {
        const issues = row.issues.map((issue) => rowIssue(issue, "ERROR"));
        const warnings: RowIssue[] = [];
        const parsedRow = row.parsedRow;
        let productId: string | null = null;
        let ruleId: string | null = null;
        let matchSource: MatchSource = MatchSource.UNMATCHED;

        if (parsedRow) {
          const match = this.matcher.matchText(parsedRow.productText, rules, parsedRow.promotionStartDate);
          if (match.reason === "MATCHED") {
            productId = match.productId;
            ruleId = match.matchRuleId;
            matchSource = MatchSource.RULE;
            matchedCount += 1;
          } else {
            warnings.push(matchIssue(match.reason, match.candidates));
            unmatchedCount += match.reason === "NO_MATCH" || match.reason === "EXCLUDED_BY_KEYWORD" ? 1 : 0;
            ambiguousCount += match.reason === "AMBIGUOUS_MATCH" ? 1 : 0;
          }
          if (isInactivePromotionStatus(parsedRow.promotionStatus)) {
            warnings.push(invalidPromotionStatusIssue(parsedRow.promotionStatus));
          }
          dataStart = minDate(dataStart, parsedRow.promotionStartDate);
          dataEnd = maxDate(dataEnd, parsedRow.promotionEndDate);
        }

        if (issues.length > 0) {
          errorCount += 1;
        } else {
          validRowCount += 1;
        }
        warningCount += warnings.length;
        const validationStatus = validationStatusFor(issues, warnings, productId);
        const fallbackDate = new Date(0);
        const saved = await tx.coupangPromotionPrice.create({
          data: {
            uploadBatchId: batch.id,
            rowNumber: row.rowNumber,
            sourceRowHash: row.sourceRowHash,
            sourcePromotionId: parsedRow?.sourcePromotionId,
            optionId: parsedRow?.optionId,
            productText: parsedRow?.productText ?? promotionFallbackText(row.rawRow),
            rawProductName: parsedRow?.rawProductName,
            rawOptionName: parsedRow?.rawOptionName,
            originalSalePriceKrw: decimal(parsedRow?.originalSalePriceKrw),
            promotionPriceKrw: decimal(parsedRow?.promotionPriceKrw),
            promotionQuantity: decimal(parsedRow?.promotionQuantity),
            promotionStatus: parsedRow?.promotionStatus,
            shippingType: parsedRow?.shippingType,
            exposureArea: parsedRow?.exposureArea,
            saleMethod: parsedRow?.saleMethod,
            salesAmountKrw: decimal(parsedRow?.salesAmountKrw),
            impressions: BigInt(parsedRow?.impressions ?? 0),
            orderQuantity: decimal(parsedRow?.orderQuantity),
            promotionStartDate: parsedRow?.promotionStartDate ?? fallbackDate,
            promotionEndDate: parsedRow?.promotionEndDate ?? fallbackDate,
            requestedAt: parsedRow?.requestedAt,
            rawStartAt: parsedRow?.rawStartAt,
            rawEndAt: parsedRow?.rawEndAt,
            coupangProductId: productId,
            coupangProductRuleId: ruleId,
            matchSource,
            validationStatus,
            validationErrors: [...issues, ...warnings] as unknown as Prisma.InputJsonValue,
            rawRow: row.rawRow as Prisma.InputJsonObject
          }
        });
        await this.createRowErrors(tx, batch.id, CoupangUploadSourceType.PROMOTION, null, null, row.rowNumber, [
          ...issues,
          ...warnings
        ], saved.id);
      }

      await tx.coupangUploadBatch.update({
        where: { id: batch.id },
        data: {
          dataStart,
          dataEnd,
          validRowCount,
          warningCount,
          errorCount,
          status: statusFor(validRowCount, errorCount),
          validatedAt: new Date(),
          importedAt: validRowCount > 0 ? new Date() : null
        }
      });
    });

    return {
      batchId: batch.id,
      schemaVersion: COUPANG_PROMOTION_SCHEMA_VERSION,
      rowCount: parsed.rows.length,
      validRowCount,
      warningCount,
      errorCount,
      matchedCount,
      unmatchedCount,
      ambiguousCount,
      dataStart: dataStart ? formatDateOnly(dataStart) : null,
      dataEnd: dataEnd ? formatDateOnly(dataEnd) : null
    };
  }

  async importBundle(files: { sales?: Express.Multer.File[]; ads?: Express.Multer.File[]; margin?: Express.Multer.File[] }, body: Record<string, unknown>) {
    const results: Record<string, unknown> = {};
    if (files.margin?.[0]) {
      results.margin = await this.importMarginCsv(files.margin[0], body);
    }
    if (files.sales?.[0]) {
      results.sales = await this.importSalesXlsx(files.sales[0], body);
    }
    if (files.ads?.[0]) {
      results.ads = await this.importAdsXlsx(files.ads[0], body);
    }
    return results;
  }

  listUploads(take = 50) {
    return this.prisma.coupangUploadBatch.findMany({
      take,
      orderBy: { uploadedAt: "desc" },
      include: { _count: { select: { saleLines: true, adMetrics: true, promotionPrices: true, errors: true } } }
    });
  }

  async previewUpload(id: string, take = 50) {
    const upload = await this.assertUpload(id);
    if (upload.sourceType === CoupangUploadSourceType.SALES) {
      return this.prisma.coupangSaleLine.findMany({
        where: { uploadBatchId: id },
        take,
        orderBy: { rowNumber: "asc" },
        include: { product: true, matchRule: true }
      });
    }
    if (upload.sourceType === CoupangUploadSourceType.ADS) {
      return this.prisma.coupangAdMetric.findMany({
        where: { uploadBatchId: id },
        take,
        orderBy: { rowNumber: "asc" },
        include: { spendProduct: true, conversionProduct: true, spendRule: true, conversionRule: true }
      });
    }
    if (upload.sourceType === CoupangUploadSourceType.PROMOTION) {
      return this.prisma.coupangPromotionPrice.findMany({
        where: { uploadBatchId: id },
        take,
        orderBy: { rowNumber: "asc" },
        include: { product: true, productRule: true }
      });
    }
    return { upload };
  }

  async uploadErrors(id: string) {
    await this.assertUpload(id);
    return this.prisma.coupangUploadRowError.findMany({
      where: { uploadBatchId: id },
      orderBy: [{ rowNumber: "asc" }, { createdAt: "asc" }]
    });
  }

  async deleteUpload(id: string) {
    await this.assertUpload(id);
    return this.prisma.$transaction(async (tx) => {
      const [deletingSaleLines, deletingAdMetrics] = await Promise.all([
        tx.coupangSaleLine.findMany({
          where: { uploadBatchId: id },
          select: { saleLineKey: true }
        }),
        tx.coupangAdMetric.findMany({
          where: { uploadBatchId: id },
          select: { adMetricKey: true }
        })
      ]);
      const saleLineKeys = uniqueNonEmpty(deletingSaleLines.map((line) => line.saleLineKey));
      const adMetricKeys = uniqueNonEmpty(deletingAdMetrics.map((metric) => metric.adMetricKey));

      await tx.coupangUploadRowError.deleteMany({ where: { uploadBatchId: id } });
      await tx.coupangSaleLine.deleteMany({ where: { uploadBatchId: id } });
      await tx.coupangAdMetric.deleteMany({ where: { uploadBatchId: id } });
      await this.restoreCurrentCoupangSaleLines(tx, saleLineKeys);
      await this.restoreCurrentCoupangAdMetrics(tx, adMetricKeys);
      return tx.coupangUploadBatch.delete({ where: { id } });
    });
  }

  listProductSettings(includeInactive = false) {
    return this.prisma.coupangProduct.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }],
      include: {
        productRules: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }] },
        costRules: { orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] }
      }
    });
  }

  async createProductSetting(body: Record<string, unknown>) {
    const displayName = requiredString(body.displayName ?? body.standardName, "displayName");
    const standardName = standardProductName(requiredString(body.standardName ?? displayName, "standardName"));
    return this.prisma.coupangProduct.create({
      data: {
        standardName,
        displayName,
        sortOrder: numberOrDefault(body.sortOrder, 100),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        productRules: {
          create: {
            displayName,
            includeKeywords: stringArray(body.includeKeywords) ?? [displayName],
            excludeKeywords: stringArray(body.excludeKeywords) ?? [],
            priority: numberOrDefault(body.priority, 100),
            saleMethod: optionalString(body.saleMethod),
            adEnabled: body.adEnabled === undefined ? true : Boolean(body.adEnabled),
            validFrom: body.validFrom ? asDateOnly(String(body.validFrom)) : undefined
          }
        },
        costRules: maybeCostRuleCreate(body)
      },
      include: { productRules: true, costRules: true }
    });
  }

  async updateProductSetting(id: string, body: Record<string, unknown>) {
    await this.assertProduct(id);
    const productData: Prisma.CoupangProductUpdateInput = {};
    if (body.displayName !== undefined) {
      productData.displayName = requiredString(body.displayName, "displayName");
    }
    if (body.standardName !== undefined) {
      productData.standardName = standardProductName(requiredString(body.standardName, "standardName"));
    }
    if (body.sortOrder !== undefined) {
      productData.sortOrder = numberOrDefault(body.sortOrder, 100);
    }
    if (body.isActive !== undefined) {
      productData.isActive = Boolean(body.isActive);
    }
    if (Object.keys(productData).length > 0) {
      await this.prisma.coupangProduct.update({ where: { id }, data: productData });
    }

    const ruleData = maybeRuleUpdate(body);
    if (ruleData) {
      const rule = await this.prisma.coupangProductRule.findFirst({
        where: { coupangProductId: id },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
      });
      if (rule) {
        await this.prisma.coupangProductRule.update({ where: { id: rule.id }, data: ruleData });
      } else {
        await this.prisma.coupangProductRule.create({
          data: {
            coupangProductId: id,
            displayName: optionalString(body.displayName) ?? "Coupang Rule",
            includeKeywords: stringArray(body.includeKeywords) ?? [],
            excludeKeywords: stringArray(body.excludeKeywords) ?? [],
            priority: numberOrDefault(body.priority, 100)
          }
        });
      }
    }

    const costRule = maybeCostRuleCreate(body);
    if (costRule?.create) {
      await this.prisma.coupangCostRule.create({
        data: {
          ...costRule.create,
          coupangProductId: id
        }
      });
    }
    return this.prisma.coupangProduct.findUnique({
      where: { id },
      include: { productRules: true, costRules: { orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] } }
    });
  }

  async deleteProductSetting(id: string) {
    await this.assertProduct(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.coupangProductRule.updateMany({ where: { coupangProductId: id }, data: { isActive: false } });
      return tx.coupangProduct.update({ where: { id }, data: { isActive: false } });
    });
  }

  async rematch(query: { from?: string; to?: string; take?: string }) {
    const range = parseDateRange(query.from, query.to);
    const take = Math.min(Math.max(Number(query.take ?? 1000) || 1000, 1), 5000);
    const rules = await this.matcherRules();
    const saleLines = await this.prisma.coupangSaleLine.findMany({
      where: {
        isCurrent: true,
        saleDate: { gte: range.fromDate, lte: range.toDate },
        validationStatus: { not: RowValidationStatus.ERROR }
      },
      take,
      orderBy: [{ saleDate: "asc" }, { rowNumber: "asc" }]
    });
    let matchedSalesCount = 0;
    for (const line of saleLines) {
      const match = this.matcher.matchText(`${line.productName} ${line.optionName}`, rules, line.saleDate);
      const matched = match.reason === "MATCHED";
      const warnings = matched ? [] : [matchIssue(match.reason, match.candidates)];
      const validationStatus = validationStatusFor([], warnings, matched ? match.productId : null);
      await this.prisma.coupangSaleLine.update({
        where: { id: line.id },
        data: {
          coupangProductId: matched ? match.productId : null,
          coupangProductRuleId: matched ? match.matchRuleId : null,
          matchSource: matched ? MatchSource.RULE : MatchSource.UNMATCHED,
          validationStatus,
          validationErrors: warnings as unknown as Prisma.InputJsonValue
        }
      });
      await this.replaceCoupangRowWarnings({
        uploadBatchId: line.uploadBatchId,
        sourceType: CoupangUploadSourceType.SALES,
        saleLineId: line.id,
        adMetricId: null,
        rowNumber: line.rowNumber,
        warnings
      });
      matchedSalesCount += matched ? 1 : 0;
    }

    const adMetrics = await this.prisma.coupangAdMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        validationStatus: { not: RowValidationStatus.ERROR }
      },
      take,
      orderBy: [{ metricDate: "asc" }, { rowNumber: "asc" }]
    });
    let matchedSpendCount = 0;
    let matchedConversionCount = 0;
    for (const metric of adMetrics) {
      const spendMatch = this.matcher.matchText(metric.adExecutionProductName, rules, metric.metricDate);
      const conversionMatch = this.matcher.matchText(metric.conversionProductName, rules, metric.metricDate);
      const spendMatched = spendMatch.reason === "MATCHED";
      const conversionMatched = conversionMatch.reason === "MATCHED";
      const warnings = [
        ...(spendMatched ? [] : [matchIssue(`SPEND_${spendMatch.reason}`, spendMatch.candidates)]),
        ...(conversionMatched ? [] : [matchIssue(`CONVERSION_${conversionMatch.reason}`, conversionMatch.candidates)])
      ];
      const spendProductId = spendMatched ? spendMatch.productId : null;
      const conversionProductId = conversionMatched ? conversionMatch.productId : null;
      const validationStatus = validationStatusFor([], warnings, spendProductId || conversionProductId);
      await this.prisma.coupangAdMetric.update({
        where: { id: metric.id },
        data: {
          spendProductId,
          spendProductRuleId: spendMatched ? spendMatch.matchRuleId : null,
          conversionProductId,
          conversionProductRuleId: conversionMatched ? conversionMatch.matchRuleId : null,
          spendMatchSource: spendMatched ? MatchSource.RULE : MatchSource.UNMATCHED,
          conversionMatchSource: conversionMatched ? MatchSource.RULE : MatchSource.UNMATCHED,
          validationStatus,
          validationErrors: warnings as unknown as Prisma.InputJsonValue
        }
      });
      await this.replaceCoupangRowWarnings({
        uploadBatchId: metric.uploadBatchId,
        sourceType: CoupangUploadSourceType.ADS,
        saleLineId: null,
        adMetricId: metric.id,
        rowNumber: metric.rowNumber,
        warnings
      });
      matchedSpendCount += spendMatched ? 1 : 0;
      matchedConversionCount += conversionMatched ? 1 : 0;
    }

    const promotionPrices = await this.prisma.coupangPromotionPrice.findMany({
      where: {
        promotionStartDate: { lte: range.toDate },
        promotionEndDate: { gte: range.fromDate },
        validationStatus: { not: RowValidationStatus.ERROR }
      },
      take,
      orderBy: [{ promotionStartDate: "asc" }, { rowNumber: "asc" }]
    });
    let matchedPromotionCount = 0;
    for (const promotion of promotionPrices) {
      const match = this.matcher.matchText(promotion.productText, rules, promotion.promotionStartDate);
      const matched = match.reason === "MATCHED";
      const warnings = [
        ...(matched ? [] : [matchIssue(match.reason, match.candidates)]),
        ...(isInactivePromotionStatus(promotion.promotionStatus) ? [invalidPromotionStatusIssue(promotion.promotionStatus)] : [])
      ];
      const validationStatus = validationStatusFor([], warnings, matched ? match.productId : null);
      await this.prisma.coupangPromotionPrice.update({
        where: { id: promotion.id },
        data: {
          coupangProductId: matched ? match.productId : null,
          coupangProductRuleId: matched ? match.matchRuleId : null,
          matchSource: matched ? MatchSource.RULE : MatchSource.UNMATCHED,
          validationStatus,
          validationErrors: warnings as unknown as Prisma.InputJsonValue
        }
      });
      await this.replaceCoupangRowWarnings({
        uploadBatchId: promotion.uploadBatchId,
        sourceType: CoupangUploadSourceType.PROMOTION,
        saleLineId: null,
        adMetricId: null,
        promotionPriceId: promotion.id,
        rowNumber: promotion.rowNumber,
        warnings
      });
      matchedPromotionCount += matched ? 1 : 0;
    }
    return {
      period: { from: range.from, to: range.to },
      scannedSalesCount: saleLines.length,
      matchedSalesCount,
      scannedAdsCount: adMetrics.length,
      matchedSpendCount,
      matchedConversionCount,
      scannedPromotionCount: promotionPrices.length,
      matchedPromotionCount
    };
  }

  async dashboard(query: { from?: string; to?: string }) {
    const rows = await this.productProfit(query);
    const totals = rows.rows.reduce(
      (accumulator, row) => ({
        netSalesKrw: accumulator.netSalesKrw + row.netSalesKrw,
        salesQuantity: accumulator.salesQuantity + row.salesQuantity,
        totalCostKrw: accumulator.totalCostKrw + (row.totalCostKrw ?? 0),
        marginKrw: accumulator.marginKrw + (row.marginKrw ?? 0),
        adSpendKrw: accumulator.adSpendKrw + row.adSpendKrw,
        adConversionSalesKrw: accumulator.adConversionSalesKrw + row.adConversionSalesKrw,
        organicSalesKrw: accumulator.organicSalesKrw + row.organicSalesKrw,
        returnCostKrw: accumulator.returnCostKrw + (row.returnCostKrw ?? 0),
        missingCostRuleCount: accumulator.missingCostRuleCount + (row.ruleStatus === "MISSING_COST_RULE" ? 1 : 0),
        warningCount: accumulator.warningCount + row.warnings.length
      }),
      {
        netSalesKrw: 0,
        salesQuantity: 0,
        totalCostKrw: 0,
        marginKrw: 0,
        adSpendKrw: 0,
        adConversionSalesKrw: 0,
        organicSalesKrw: 0,
        returnCostKrw: 0,
        missingCostRuleCount: 0,
        warningCount: 0
      }
    );
    return {
      period: rows.period,
      summary: {
        ...totals,
        marginRate: safeDivide(totals.marginKrw, totals.netSalesKrw),
        roas: safeDivide(totals.adConversionSalesKrw, totals.adSpendKrw),
        adSpendRatio: safeDivide(totals.adSpendKrw, totals.netSalesKrw)
      },
      rows: rows.rows.slice(0, 20)
    };
  }

  async productProfit(query: { from?: string; to?: string }) {
    const range = parseDateRange(query.from, query.to);
    const rows = await this.buildProductProfitRows(range);
    return { period: { from: range.from, to: range.to }, rows };
  }

  async adsAnalysis(query: { from?: string; to?: string }) {
    const range = parseDateRange(query.from, query.to);
    const metrics = await this.prisma.coupangAdMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        validationStatus: { not: RowValidationStatus.ERROR }
      },
      include: { spendProduct: true, conversionProduct: true },
      orderBy: [{ metricDate: "asc" }, { campaignName: "asc" }, { adGroupName: "asc" }]
    });
    const groups = new Map<string, AdsAccumulator>();
    for (const metric of metrics) {
      const key = [metric.spendProductId ?? "unmatched", metric.campaignName ?? "", metric.adGroupName ?? ""].join(":");
      const current =
        groups.get(key) ??
        ({
          productId: metric.spendProductId,
          productName: metric.spendProduct?.displayName ?? "Unmatched",
          campaignName: metric.campaignName,
          adGroupName: metric.adGroupName,
          impressions: 0,
          clicks: 0,
          adSpendKrw: 0,
          totalOrders1d: 0,
          directOrders1d: 0,
          indirectOrders1d: 0,
          totalConversionSales1dKrw: 0,
          directConversionSales1dKrw: 0,
          indirectConversionSales1dKrw: 0
        } satisfies AdsAccumulator);
      current.impressions += numberFrom(metric.impressions);
      current.clicks += metric.clicks;
      current.adSpendKrw += numberFrom(metric.adSpendKrw);
      current.totalOrders1d += metric.totalOrders1d;
      current.directOrders1d += metric.directOrders1d;
      current.indirectOrders1d += metric.indirectOrders1d;
      current.totalConversionSales1dKrw += numberFrom(metric.totalConversionSales1dKrw);
      current.directConversionSales1dKrw += numberFrom(metric.directConversionSales1dKrw);
      current.indirectConversionSales1dKrw += numberFrom(metric.indirectConversionSales1dKrw);
      groups.set(key, current);
    }
    const rows = Array.from(groups.values()).map((row) => ({
      ...row,
      roas: safeDivide(row.totalConversionSales1dKrw, row.adSpendKrw)
    }));
    return { period: { from: range.from, to: range.to }, rows };
  }

  async unmatched(query: { from?: string; to?: string; take?: string }) {
    const range = parseDateRange(query.from, query.to);
    const take = Math.min(Math.max(Number(query.take ?? 200) || 200, 1), 1000);
    const [sales, ads, promotions, errors] = await Promise.all([
      this.prisma.coupangSaleLine.findMany({
        where: {
          isCurrent: true,
          saleDate: { gte: range.fromDate, lte: range.toDate },
          OR: [{ coupangProductId: null }, { validationStatus: { in: [RowValidationStatus.WARNING, RowValidationStatus.UNMATCHED] } }]
        },
        take,
        orderBy: [{ saleDate: "desc" }, { rowNumber: "asc" }],
        include: { batch: true }
      }),
      this.prisma.coupangAdMetric.findMany({
        where: {
          isCurrent: true,
          metricDate: { gte: range.fromDate, lte: range.toDate },
          OR: [{ spendProductId: null }, { conversionProductId: null }, { validationStatus: RowValidationStatus.WARNING }]
        },
        take,
        orderBy: [{ metricDate: "desc" }, { rowNumber: "asc" }],
        include: { batch: true }
      }),
      this.prisma.coupangPromotionPrice.findMany({
        where: {
          promotionStartDate: { lte: range.toDate },
          promotionEndDate: { gte: range.fromDate },
          OR: [{ coupangProductId: null }, { validationStatus: { in: [RowValidationStatus.WARNING, RowValidationStatus.UNMATCHED] } }]
        },
        take,
        orderBy: [{ promotionStartDate: "desc" }, { rowNumber: "asc" }],
        include: { batch: true }
      }),
      this.prisma.coupangUploadRowError.findMany({
        where: {
          severity: "ERROR",
          OR: [
            { saleLine: { is: { saleDate: { gte: range.fromDate, lte: range.toDate } } } },
            { adMetric: { is: { metricDate: { gte: range.fromDate, lte: range.toDate } } } },
            { promotionPrice: { is: { promotionStartDate: { lte: range.toDate }, promotionEndDate: { gte: range.fromDate } } } },
            { batch: { dataStart: { lte: range.toDate }, dataEnd: { gte: range.fromDate } } }
          ]
        },
        take,
        orderBy: [{ createdAt: "desc" }],
        include: { batch: true }
      })
    ]);
    return {
      period: { from: range.from, to: range.to },
      rows: [
        ...sales.map((line) => ({
          sourceType: "SALES",
          rowNumber: line.rowNumber,
          sourceName: line.batch.originalFilename,
          productText: `${line.productName} ${line.optionName}`.trim(),
          amountKrw: numberFrom(line.netSalesKrw),
          reason: line.coupangProductId ? "WARNING" : "NO_MATCH",
          candidates: issueCandidates(line.validationErrors)
        })),
        ...ads.map((metric) => ({
          sourceType: "ADS",
          rowNumber: metric.rowNumber,
          sourceName: metric.batch.originalFilename,
          productText: `${metric.adExecutionProductName} / ${metric.conversionProductName}`,
          amountKrw: numberFrom(metric.adSpendKrw),
          reason: !metric.spendProductId ? "SPEND_NO_MATCH" : !metric.conversionProductId ? "CONVERSION_NO_MATCH" : "WARNING",
          candidates: issueCandidates(metric.validationErrors)
        })),
        ...promotions.map((promotion) => ({
          sourceType: "PROMOTION",
          rowNumber: promotion.rowNumber,
          sourceName: promotion.batch.originalFilename,
          productText: promotion.productText,
          amountKrw: numberFrom(promotion.promotionPriceKrw),
          reason: promotion.coupangProductId ? "WARNING" : "NO_MATCH",
          candidates: issueCandidates(promotion.validationErrors)
        })),
        ...errors.map((error) => ({
          sourceType: error.sourceType,
          rowNumber: error.rowNumber,
          sourceName: error.batch.originalFilename,
          productText: error.rawValue ?? "",
          amountKrw: null,
          reason: error.errorCode,
          candidates: jsonStringArray(error.candidates)
        }))
      ].slice(0, take)
    };
  }

  async dailyReport(query: { date?: string }) {
    if (!query.date) {
      throw new BadRequestException({ code: "DATE_REQUIRED", message: "date is required." });
    }
    const date = toDateOnly(query.date);
    if (!date) {
      throw new BadRequestException({ code: "INVALID_DATE", message: "date must be YYYY-MM-DD." });
    }
    const rows = await this.buildProductProfitRows({ from: query.date, to: query.date, fromDate: date, toDate: date });
    return {
      date: query.date,
      rows: rows.map((row) => ({
        productName: row.productName,
        salePriceKrw: row.salePriceKrw,
        baseSalePriceKrw: row.baseSalePriceKrw,
        promotionPriceKrw: row.promotionPriceKrw,
        priceSource: row.priceSource,
        priceWarnings: row.priceWarnings,
        adSpendKrw: row.adSpendKrw,
        totalCostKrw: row.totalCostKrw,
        organicSalesKrw: row.organicSalesKrw,
        marginKrw: row.marginKrw,
        roas: row.roas
      }))
    };
  }

  private async buildProductProfitRows(range: ReturnType<typeof parseDateRange>): Promise<ProductProfitRow[]> {
    const [saleLines, adMetrics] = await Promise.all([
      this.prisma.coupangSaleLine.findMany({
        where: {
          isCurrent: true,
          saleDate: { gte: range.fromDate, lte: range.toDate },
          validationStatus: { not: RowValidationStatus.ERROR }
        },
        include: { product: true },
        orderBy: [{ saleDate: "asc" }, { rowNumber: "asc" }]
      }),
      this.prisma.coupangAdMetric.findMany({
        where: {
          isCurrent: true,
          metricDate: { gte: range.fromDate, lte: range.toDate },
          validationStatus: { not: RowValidationStatus.ERROR }
        },
        include: { spendProduct: true, conversionProduct: true }
      })
    ]);

    const productIds = uniqueNonEmpty([
      ...saleLines.map((line) => line.coupangProductId),
      ...adMetrics.map((metric) => metric.spendProductId),
      ...adMetrics.map((metric) => metric.conversionProductId)
    ]);
    const costRules =
      productIds.length > 0
        ? await this.prisma.coupangCostRule.findMany({
            where: { coupangProductId: { in: productIds } },
            orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }]
          })
        : [];
    const products =
      productIds.length > 0
        ? await this.prisma.coupangProduct.findMany({ where: { id: { in: productIds } } })
        : [];
    const promotionPrices =
      productIds.length > 0
        ? await this.prisma.coupangPromotionPrice.findMany({
            where: {
              coupangProductId: { in: productIds },
              promotionStartDate: { lte: range.toDate },
              promotionEndDate: { gte: range.toDate },
              validationStatus: { not: RowValidationStatus.ERROR }
            },
            include: { batch: { select: { uploadedAt: true } } },
            orderBy: [{ promotionStartDate: "desc" }, { createdAt: "desc" }]
          })
        : [];
    const productById = new Map(products.map((product) => [product.id, product]));
    const costRulesByProductId = groupBy(costRules, (rule) => rule.coupangProductId);
    const promotionPricesByProductId = groupBy(promotionPrices, (promotion) => promotion.coupangProductId ?? "");
    const salesByProductId = new Map<string, SalesAccumulator>();
    for (const line of saleLines) {
      if (!line.coupangProductId) {
        continue;
      }
      const current = salesByProductId.get(line.coupangProductId) ?? emptySalesAccumulator(line.product?.displayName ?? line.productName);
      current.salesKrw += numberFrom(line.salesKrw);
      current.cancelAmountKrw += numberFrom(line.cancelAmountKrw);
      current.netSalesKrw += numberFrom(line.netSalesKrw);
      current.salesQuantity += numberFrom(line.salesQuantity);
      current.orderCount += line.orderCount;
      current.lineCount += 1;
      if (line.saleMethod) {
        current.saleMethods.add(line.saleMethod);
      }
      salesByProductId.set(line.coupangProductId, current);
    }

    const spendByProductId = new Map<string, number>();
    const conversionByProductId = new Map<string, { salesKrw: number; quantity: number }>();
    for (const metric of adMetrics) {
      if (metric.spendProductId) {
        spendByProductId.set(metric.spendProductId, (spendByProductId.get(metric.spendProductId) ?? 0) + numberFrom(metric.adSpendKrw));
      }
      if (metric.conversionProductId) {
        const current = conversionByProductId.get(metric.conversionProductId) ?? { salesKrw: 0, quantity: 0 };
        current.salesKrw += numberFrom(metric.totalConversionSales1dKrw);
        current.quantity += numberFrom(metric.totalSalesQuantity1d);
        conversionByProductId.set(metric.conversionProductId, current);
      }
    }

    const allProductIds = Array.from(new Set([...salesByProductId.keys(), ...spendByProductId.keys(), ...conversionByProductId.keys()]));
    return allProductIds
      .map((productId) => {
        const sales = salesByProductId.get(productId) ?? emptySalesAccumulator(productById.get(productId)?.displayName ?? "Coupang Product");
        const conversion = conversionByProductId.get(productId) ?? { salesKrw: 0, quantity: 0 };
        const costRule = findRuleForDate(costRulesByProductId.get(productId) ?? [], range.toDate);
        const adSpendKrw = spendByProductId.get(productId) ?? 0;
        const productName = productById.get(productId)?.displayName ?? sales.productName;
        const resolvedPrice = resolveCoupangSalePrice({
          baseSalePriceKrw: costRule ? numberFrom(costRule.salePriceKrw) : null,
          promotions: (promotionPricesByProductId.get(productId) ?? []).map((promotion) => ({
            promotionPriceKrw: numberFrom(promotion.promotionPriceKrw),
            promotionStartDate: promotion.promotionStartDate,
            promotionEndDate: promotion.promotionEndDate,
            promotionStatus: promotion.promotionStatus,
            validationErrors: promotion.validationErrors
          })),
          date: range.toDate
        });
        if (!costRule) {
          const organicSalesKrw = sales.netSalesKrw - conversion.salesKrw;
          return {
            productId,
            productName,
            saleMethod: firstSetValue(sales.saleMethods),
            matchedSalesLineCount: sales.lineCount,
            salesQuantity: sales.salesQuantity,
            orderCount: sales.orderCount,
            salesKrw: sales.salesKrw,
            cancelAmountKrw: sales.cancelAmountKrw,
            netSalesKrw: sales.netSalesKrw,
            salePriceKrw: resolvedPrice.salePriceKrw,
            baseSalePriceKrw: resolvedPrice.baseSalePriceKrw,
            promotionPriceKrw: resolvedPrice.promotionPriceKrw,
            priceSource: resolvedPrice.priceSource,
            priceWarnings: resolvedPrice.priceWarnings,
            productCostKrw: null,
            salesFeeKrw: null,
            shippingCostKrw: null,
            returnCostKrw: null,
            extraCostKrw: null,
            adSpendKrw,
            adConversionSalesKrw: conversion.salesKrw,
            adConversionQuantity: conversion.quantity,
            organicSalesKrw,
            totalCostKrw: null,
            marginKrw: null,
            marginRate: null,
            roas: safeDivide(conversion.salesKrw, adSpendKrw),
            warnings: [...(organicSalesKrw < 0 ? ["AD_CONVERSION_EXCEEDS_NET_SALES"] : []), ...resolvedPrice.priceWarnings],
            ruleStatus: "MISSING_COST_RULE" as const
          };
        }
        const feeMode = numberFrom(costRule.salesFeeRate) > 0 ? "RATE" : "PER_UNIT";
        const calculated = calculateCoupangProfit(
          {
            saleMethod: firstSetValue(sales.saleMethods),
            netSalesKrw: sales.netSalesKrw,
            salesQuantity: sales.salesQuantity
          },
          costInput(costRule),
          {
            adSpendKrw,
            adConversionSalesKrw: conversion.salesKrw,
            adConversionQuantity: conversion.quantity
          },
          {
            feeMode,
            includeReturnCost: true,
            useGrowthCost: true
          }
        );
        return {
          productId,
          productName,
          saleMethod: firstSetValue(sales.saleMethods),
          matchedSalesLineCount: sales.lineCount,
          salesQuantity: sales.salesQuantity,
          orderCount: sales.orderCount,
          salesKrw: sales.salesKrw,
          cancelAmountKrw: sales.cancelAmountKrw,
          netSalesKrw: sales.netSalesKrw,
          salePriceKrw: resolvedPrice.salePriceKrw,
          baseSalePriceKrw: resolvedPrice.baseSalePriceKrw,
          promotionPriceKrw: resolvedPrice.promotionPriceKrw,
          priceSource: resolvedPrice.priceSource,
          priceWarnings: resolvedPrice.priceWarnings,
          productCostKrw: calculated.productCostKrw,
          salesFeeKrw: calculated.salesFeeKrw,
          shippingCostKrw: calculated.shippingCostKrw,
          returnCostKrw: calculated.returnCostKrw,
          extraCostKrw: calculated.extraCostKrw,
          adSpendKrw,
          adConversionSalesKrw: conversion.salesKrw,
          adConversionQuantity: conversion.quantity,
          organicSalesKrw: calculated.organicSalesKrw,
          totalCostKrw: calculated.totalCostKrw,
          marginKrw: calculated.marginKrw,
          marginRate: calculated.marginRate,
          roas: calculated.roas,
          warnings: [...calculated.warnings, ...resolvedPrice.priceWarnings],
          ruleStatus: "OK" as const
        };
      })
      .sort((a, b) => b.netSalesKrw - a.netSalesKrw || a.productName.localeCompare(b.productName));
  }

  private async matcherRules(): Promise<CoupangRuleInput[]> {
    const rules = await this.prisma.coupangProductRule.findMany({
      where: { isActive: true, product: { is: { isActive: true } } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
    });
    return rules.map((rule) => ({
      id: rule.id,
      productId: rule.coupangProductId,
      displayName: rule.displayName,
      includeKeywords: jsonStringArray(rule.includeKeywords),
      excludeKeywords: jsonStringArray(rule.excludeKeywords),
      priority: rule.priority,
      validFrom: formatDateOnly(rule.validFrom),
      validTo: rule.validTo ? formatDateOnly(rule.validTo) : null,
      isActive: rule.isActive
    }));
  }

  private assertFile(file: Express.Multer.File | undefined, message: string): Express.Multer.File {
    if (!file?.buffer) {
      throw new BadRequestException({ code: "FILE_REQUIRED", message });
    }
    return file;
  }

  private async createBatch(input: {
    sourceType: CoupangUploadSourceType;
    originalFilename: string;
    fileHashSha256: string;
    conflictPolicy: ConflictPolicy;
    columnSchema: Prisma.InputJsonValue;
    rowCount: number;
  }) {
    return this.prisma.coupangUploadBatch.create({
      data: {
        sourceType: input.sourceType,
        originalFilename: input.originalFilename,
        storedFilePath: null,
        fileHashSha256:
          input.conflictPolicy === ConflictPolicy.SKIP ? input.fileHashSha256 : duplicateBatchHash(input.fileHashSha256, input.conflictPolicy),
        columnSchema: input.columnSchema,
        rowCount: input.rowCount,
        conflictPolicy: input.conflictPolicy,
        status: UploadStatus.VALIDATING
      }
    });
  }

  private async reusableDuplicate(fileHashSha256: string, sourceType: CoupangUploadSourceType, rawPolicy: unknown) {
    const conflictPolicy = parseConflictPolicy(rawPolicy);
    if (conflictPolicy !== ConflictPolicy.SKIP) {
      return null;
    }
    const duplicate = await this.prisma.coupangUploadBatch.findFirst({
      where: { fileHashSha256, sourceType, status: { in: [UploadStatus.IMPORTED, UploadStatus.PARTIAL] } },
      orderBy: { uploadedAt: "desc" }
    });
    return duplicate
      ? {
          duplicate: true,
          batchId: duplicate.id,
          sourceType: duplicate.sourceType,
          status: duplicate.status,
          rowCount: duplicate.rowCount,
          validRowCount: duplicate.validRowCount,
          warningCount: duplicate.warningCount,
          errorCount: duplicate.errorCount
        }
      : null;
  }

  private async failMissingColumns(batchId: string, sourceType: CoupangUploadSourceType, missingColumns: string[]) {
    await this.prisma.coupangUploadRowError.createMany({
      data: missingColumns.map((columnName) => ({
        uploadBatchId: batchId,
        sourceType,
        columnName,
        severity: "ERROR",
        errorCode: "MISSING_REQUIRED_COLUMN",
        message: `Required Coupang column is missing: ${columnName}`
      }))
    });
    await this.prisma.coupangUploadBatch.update({
      where: { id: batchId },
      data: { status: UploadStatus.FAILED, errorCount: missingColumns.length, validatedAt: new Date() }
    });
    throw new BadRequestException({
      code: "COUPANG_HEADER_INVALID",
      message: "Required Coupang columns are missing.",
      details: { batchId, missingColumns }
    });
  }

  private async createRowErrors(
    tx: Prisma.TransactionClient,
    uploadBatchId: string,
    sourceType: CoupangUploadSourceType,
    saleLineId: string | null,
    adMetricId: string | null,
    rowNumber: number,
    issues: RowIssue[],
    promotionPriceId: string | null = null
  ) {
    if (issues.length === 0) {
      return;
    }
    await tx.coupangUploadRowError.createMany({
      data: issues.map((issue) => ({
        uploadBatchId,
        sourceType,
        saleLineId,
        adMetricId,
        promotionPriceId,
        rowNumber,
        columnName: issue.columnName,
        severity: issue.severity,
        errorCode: issue.errorCode,
        message: issue.message,
        rawValue: issue.rawValue,
        candidates: issue.candidates ?? []
      }))
    });
  }

  private async replaceCoupangRowWarnings(input: {
    uploadBatchId: string;
    sourceType: CoupangUploadSourceType;
    saleLineId: string | null;
    adMetricId: string | null;
    promotionPriceId?: string | null;
    rowNumber: number;
    warnings: RowIssue[];
  }) {
    await this.prisma.coupangUploadRowError.deleteMany({
      where: {
        saleLineId: input.saleLineId ?? undefined,
        adMetricId: input.adMetricId ?? undefined,
        promotionPriceId: input.promotionPriceId ?? undefined,
        severity: "WARNING"
      }
    });
    await this.createRowErrors(
      this.prisma as unknown as Prisma.TransactionClient,
      input.uploadBatchId,
      input.sourceType,
      input.saleLineId,
      input.adMetricId,
      input.rowNumber,
      input.warnings,
      input.promotionPriceId ?? null
    );
  }

  private async restoreCurrentCoupangSaleLines(tx: Prisma.TransactionClient, saleLineKeys: string[]) {
    for (const saleLineKey of saleLineKeys) {
      await tx.coupangSaleLine.updateMany({
        where: { saleLineKey },
        data: { isCurrent: false }
      });
      const latest = await tx.coupangSaleLine.findFirst({
        where: { saleLineKey, validationStatus: { not: RowValidationStatus.ERROR } },
        orderBy: [{ importVersion: "desc" }, { createdAt: "desc" }],
        select: { id: true }
      });
      if (latest) {
        await tx.coupangSaleLine.update({
          where: { id: latest.id },
          data: { isCurrent: true }
        });
      }
    }
  }

  private async restoreCurrentCoupangAdMetrics(tx: Prisma.TransactionClient, adMetricKeys: string[]) {
    for (const adMetricKey of adMetricKeys) {
      await tx.coupangAdMetric.updateMany({
        where: { adMetricKey },
        data: { isCurrent: false }
      });
      const latest = await tx.coupangAdMetric.findFirst({
        where: { adMetricKey, validationStatus: { not: RowValidationStatus.ERROR } },
        orderBy: [{ importVersion: "desc" }, { createdAt: "desc" }],
        select: { id: true }
      });
      if (latest) {
        await tx.coupangAdMetric.update({
          where: { id: latest.id },
          data: { isCurrent: true }
        });
      }
    }
  }

  private async assertUpload(id: string) {
    const upload = await this.prisma.coupangUploadBatch.findUnique({ where: { id } });
    if (!upload) {
      throw new NotFoundException({ code: "COUPANG_UPLOAD_NOT_FOUND", message: "Coupang upload was not found." });
    }
    return upload;
  }

  private async assertProduct(id: string) {
    const product = await this.prisma.coupangProduct.findUnique({ where: { id } });
    if (!product) {
      throw new NotFoundException({ code: "COUPANG_PRODUCT_NOT_FOUND", message: "Coupang product was not found." });
    }
    return product;
  }
}

type SalesAccumulator = {
  productName: string;
  salesKrw: number;
  cancelAmountKrw: number;
  netSalesKrw: number;
  salesQuantity: number;
  orderCount: number;
  lineCount: number;
  saleMethods: Set<string>;
};

type AdsAccumulator = {
  productId: string | null;
  productName: string;
  campaignName: string | null;
  adGroupName: string | null;
  impressions: number;
  clicks: number;
  adSpendKrw: number;
  totalOrders1d: number;
  directOrders1d: number;
  indirectOrders1d: number;
  totalConversionSales1dKrw: number;
  directConversionSales1dKrw: number;
  indirectConversionSales1dKrw: number;
};

function rowIssue(issue: ParseIssue, severity: RowIssue["severity"]): RowIssue {
  return { ...issue, columnName: issue.columnName ?? null, severity };
}

function matchIssue(errorCode: string, candidates: string[]): RowIssue {
  return {
    columnName: null,
    severity: "WARNING",
    errorCode,
    message: "Coupang product did not resolve to exactly one active rule.",
    rawValue: candidates.join(", "),
    candidates
  };
}

function duplicateCurrentIssue(errorCode: string, logicalKey: string): RowIssue {
  return {
    columnName: null,
    severity: "WARNING",
    errorCode,
    message: "Coupang row already has a current logical key; this imported row was kept as non-current.",
    rawValue: logicalKey
  };
}

function invalidPromotionStatusIssue(status: string | null): RowIssue {
  return {
    columnName: "promotionStatus",
    severity: "WARNING",
    errorCode: "INVALID_PROMOTION_STATUS",
    message: "Promotion status is inactive and will be excluded from price resolution.",
    rawValue: status ?? undefined
  };
}

function validationStatusFor(issues: RowIssue[], warnings: RowIssue[], productId: string | null) {
  if (issues.length > 0) {
    return RowValidationStatus.ERROR;
  }
  if (!productId) {
    return RowValidationStatus.UNMATCHED;
  }
  return warnings.length > 0 ? RowValidationStatus.WARNING : RowValidationStatus.VALID;
}

function statusFor(validRowCount: number, errorCount: number) {
  if (errorCount > 0 && validRowCount > 0) {
    return UploadStatus.PARTIAL;
  }
  if (errorCount > 0) {
    return UploadStatus.FAILED;
  }
  return UploadStatus.IMPORTED;
}

export function resolveCoupangRowImportDecision(input: {
  conflictPolicy: ConflictPolicy;
  existingCurrent: ExistingCurrentCoupangRow;
  latestImportVersion?: number | null;
}): CoupangRowImportDecision {
  const latestImportVersion = input.latestImportVersion ?? input.existingCurrent?.importVersion ?? 0;
  if (!input.existingCurrent) {
    return {
      importVersion: latestImportVersion > 0 ? latestImportVersion + 1 : 1,
      isCurrent: true,
      supersedeExisting: false,
      skippedDuplicate: false
    };
  }

  if (input.conflictPolicy === ConflictPolicy.SKIP) {
    return {
      importVersion: input.existingCurrent.importVersion,
      isCurrent: false,
      supersedeExisting: false,
      skippedDuplicate: true
    };
  }

  return {
    importVersion:
      input.conflictPolicy === ConflictPolicy.NEW_VERSION ? latestImportVersion + 1 : input.existingCurrent.importVersion,
    isCurrent: true,
    supersedeExisting: true,
    skippedDuplicate: false
  };
}

export function resolveCoupangRowStoredState(input: {
  validationStatus: RowValidationStatus;
  decision: CoupangRowImportDecision;
}): CoupangRowImportDecision {
  if (input.validationStatus === RowValidationStatus.ERROR) {
    return {
      ...input.decision,
      isCurrent: false,
      supersedeExisting: false
    };
  }
  return input.decision;
}

export function buildCoupangPriceTextCostRuleData(input: {
  coupangProductId: string;
  salePriceKrw: number;
  effectiveFrom: Date;
  latestCostRule: CoupangCostRuleSnapshot | null;
}): Prisma.CoupangCostRuleUncheckedCreateInput | null {
  if (!input.latestCostRule) {
    return null;
  }
  return {
    coupangProductId: input.coupangProductId,
    salePriceKrw: decimal(input.salePriceKrw),
    supplyPriceKrw: input.latestCostRule.supplyPriceKrw,
    productCostKrw: input.latestCostRule.productCostKrw,
    salesFeeRate: input.latestCostRule.salesFeeRate,
    salesFeeKrw: input.latestCostRule.salesFeeKrw,
    sellerShippingFeeKrw: input.latestCostRule.sellerShippingFeeKrw,
    growthInboundFeeKrw: input.latestCostRule.growthInboundFeeKrw,
    growthShippingFeeKrw: input.latestCostRule.growthShippingFeeKrw,
    returnRate: input.latestCostRule.returnRate,
    returnCostPerUnitKrw: input.latestCostRule.returnCostPerUnitKrw,
    extraCostKrw: input.latestCostRule.extraCostKrw,
    effectiveFrom: input.effectiveFrom,
    note: input.latestCostRule.note
  };
}

export function buildCoupangMarginCostRuleData(input: {
  coupangProductId: string;
  parsedRow: ParsedCoupangMarginRow;
  effectiveFrom: Date;
  latestCostRule: Pick<Prisma.CoupangCostRuleGetPayload<Record<string, never>>, "salePriceKrw"> | null;
}): Prisma.CoupangCostRuleUncheckedCreateInput {
  return {
    coupangProductId: input.coupangProductId,
    salePriceKrw: input.latestCostRule?.salePriceKrw ?? decimal(0),
    supplyPriceKrw: decimal(input.parsedRow.supplyPriceKrw),
    productCostKrw: decimal(input.parsedRow.productCostKrw),
    salesFeeRate: decimal(input.parsedRow.salesFeeRate),
    salesFeeKrw: decimal(input.parsedRow.salesFeeKrw),
    sellerShippingFeeKrw: decimal(input.parsedRow.sellerShippingFeeKrw),
    growthInboundFeeKrw: decimal(input.parsedRow.growthInboundFeeKrw),
    growthShippingFeeKrw: decimal(input.parsedRow.growthShippingFeeKrw),
    returnRate: decimal(input.parsedRow.returnRate),
    returnCostPerUnitKrw: decimal(input.parsedRow.returnCostPerUnitKrw),
    effectiveFrom: input.effectiveFrom
  };
}

function decimal(value: number | null | undefined) {
  return new Prisma.Decimal(Number.isFinite(value) ? Number(value) : 0);
}

function fallbackRowKey(rawRow: Record<string, string>) {
  return createHash("sha256").update(JSON.stringify(rawRow)).digest("hex");
}

function promotionFallbackText(rawRow: Record<string, string>) {
  return Object.values(rawRow)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
}

function minDate(current: Date | null, next: Date) {
  return current && current < next ? current : next;
}

function maxDate(current: Date | null, next: Date) {
  return current && current > next ? current : next;
}

function parseConflictPolicy(value: unknown) {
  const text = String(value ?? ConflictPolicy.SKIP);
  if (text in ConflictPolicy) {
    return text as ConflictPolicy;
  }
  throw new BadRequestException({ code: "INVALID_CONFLICT_POLICY", message: "Invalid conflict policy." });
}

function duplicateBatchHash(fileHashSha256: string, conflictPolicy: ConflictPolicy) {
  return createHash("sha256").update(`${fileHashSha256}:${conflictPolicy}:${Date.now()}:${Math.random()}`).digest("hex");
}

function standardProductName(value: string) {
  return value.trim().split(/\s+/).join(" ").toLowerCase();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException({ code: "FIELD_REQUIRED", message: `${field} is required.` });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text ? text : undefined;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return uniqueNonEmpty(value.map((item) => String(item)));
  }
  if (typeof value === "string") {
    return uniqueNonEmpty(value.split(","));
  }
  throw new BadRequestException({ code: "INVALID_ARRAY", message: "Expected an array of strings or comma-separated text." });
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueNonEmpty(value.map((item) => String(item)));
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function issueCandidates(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !("candidates" in item) || !Array.isArray(item.candidates)) {
      return [];
    }
    return item.candidates.map((candidate) => String(candidate));
  });
}

function maybeRuleUpdate(body: Record<string, unknown>): Prisma.CoupangProductRuleUpdateInput | null {
  const data: Prisma.CoupangProductRuleUpdateInput = {};
  if (body.displayName !== undefined) {
    data.displayName = requiredString(body.displayName, "displayName");
  }
  if (body.includeKeywords !== undefined) {
    data.includeKeywords = stringArray(body.includeKeywords) ?? [];
  }
  if (body.excludeKeywords !== undefined) {
    data.excludeKeywords = stringArray(body.excludeKeywords) ?? [];
  }
  if (body.priority !== undefined) {
    data.priority = numberOrDefault(body.priority, 100);
  }
  if (body.saleMethod !== undefined) {
    data.saleMethod = optionalString(body.saleMethod);
  }
  if (body.adEnabled !== undefined) {
    data.adEnabled = Boolean(body.adEnabled);
  }
  if (body.isActive !== undefined) {
    data.isActive = Boolean(body.isActive);
  }
  return Object.keys(data).length > 0 ? data : null;
}

function maybeCostRuleCreate(body: Record<string, unknown>): Prisma.CoupangCostRuleCreateNestedManyWithoutProductInput | undefined {
  const hasCostField = [
    "salePriceKrw",
    "supplyPriceKrw",
    "productCostKrw",
    "salesFeeRate",
    "salesFeeKrw",
    "sellerShippingFeeKrw",
    "growthInboundFeeKrw",
    "growthShippingFeeKrw",
    "returnRate",
    "returnCostPerUnitKrw",
    "extraCostKrw"
  ].some((key) => body[key] !== undefined);
  if (!hasCostField) {
    return undefined;
  }
  return {
    create: {
      salePriceKrw: decimalFromBody(body.salePriceKrw),
      supplyPriceKrw: decimalFromBody(body.supplyPriceKrw),
      productCostKrw: decimalFromBody(body.productCostKrw),
      salesFeeRate: decimalFromBody(body.salesFeeRate),
      salesFeeKrw: decimalFromBody(body.salesFeeKrw),
      sellerShippingFeeKrw: decimalFromBody(body.sellerShippingFeeKrw),
      growthInboundFeeKrw: decimalFromBody(body.growthInboundFeeKrw),
      growthShippingFeeKrw: decimalFromBody(body.growthShippingFeeKrw),
      returnRate: decimalFromBody(body.returnRate),
      returnCostPerUnitKrw: decimalFromBody(body.returnCostPerUnitKrw),
      extraCostKrw: decimalFromBody(body.extraCostKrw),
      effectiveFrom: body.effectiveFrom ? asDateOnly(String(body.effectiveFrom)) : undefined,
      effectiveTo: body.effectiveTo ? asDateOnly(String(body.effectiveTo)) : undefined,
      note: optionalString(body.note)
    }
  };
}

function decimalFromBody(value: unknown) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException({ code: "INVALID_NUMBER", message: "Expected numeric cost field." });
  }
  return new Prisma.Decimal(parsed);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function findRuleForDate<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(rules: T[], date: Date): T | null {
  return (
    rules
      .filter((rule) => rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date))
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null
  );
}

function emptySalesAccumulator(productName: string): SalesAccumulator {
  return {
    productName,
    salesKrw: 0,
    cancelAmountKrw: 0,
    netSalesKrw: 0,
    salesQuantity: 0,
    orderCount: 0,
    lineCount: 0,
    saleMethods: new Set<string>()
  };
}

function firstSetValue(values: Set<string>) {
  return values.values().next().value ?? null;
}

function costInput(rule: Prisma.CoupangCostRuleGetPayload<Record<string, never>>): CoupangCostInput {
  return {
    salePriceKrw: numberFrom(rule.salePriceKrw),
    supplyPriceKrw: numberFrom(rule.supplyPriceKrw),
    productCostKrw: numberFrom(rule.productCostKrw),
    salesFeeRate: numberFrom(rule.salesFeeRate),
    salesFeeKrw: numberFrom(rule.salesFeeKrw),
    sellerShippingFeeKrw: numberFrom(rule.sellerShippingFeeKrw),
    growthInboundFeeKrw: numberFrom(rule.growthInboundFeeKrw),
    growthShippingFeeKrw: numberFrom(rule.growthShippingFeeKrw),
    returnRate: numberFrom(rule.returnRate),
    returnCostPerUnitKrw: numberFrom(rule.returnCostPerUnitKrw),
    extraCostKrw: numberFrom(rule.extraCostKrw)
  };
}
