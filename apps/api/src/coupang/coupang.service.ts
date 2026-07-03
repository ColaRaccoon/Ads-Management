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
import {
  CoupangAdsXlsxParser,
  coupangAdMetricKey,
  COUPANG_ADS_SCHEMA_VERSION,
  ParsedCoupangAdRow,
  ParsedCoupangAdsRowResult
} from "../domain/coupang-ads-xlsx";
import { CoupangMarginCsvParser, COUPANG_MARGIN_SCHEMA_VERSION, ParsedCoupangMarginRow } from "../domain/coupang-margin-csv";
import { isInactivePromotionStatus, resolveCoupangSalePrice } from "../domain/coupang-price-resolver";
import { CoupangProductMatcher, CoupangRuleInput } from "../domain/coupang-product-matcher";
import {
  CoupangPriceTextParser,
  COUPANG_PRICE_TEXT_SCHEMA_VERSION,
  legacyCoupangPriceTextItemName
} from "../domain/coupang-price-text";
import { calculateCoupangProfit, CoupangCostInput } from "../domain/coupang-profit-calculator";
import { CoupangPromotionXlsxParser, COUPANG_PROMOTION_SCHEMA_VERSION } from "../domain/coupang-promotion-xlsx";
import {
  CoupangSalesXlsxParser,
  coupangSaleLineKey,
  COUPANG_SALES_SCHEMA_VERSION,
  CoupangCancelAmountMode,
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

const COUPANG_TRANSACTION_OPTIONS = {
  maxWait: 30_000,
  timeout: 300_000
};

type CoupangPriceTextAppliedRow = {
  rowNumber: number;
  itemName: string;
  standardName: string;
  productId: string;
  costRuleId: string;
  salePriceKrw: number;
};

type CoupangMarginAppliedRow = {
  rowNumber: number;
  itemName: string;
  standardName: string;
  productId: string;
  productRuleId: string | null;
  productRuleCreated: boolean;
  costRuleId: string;
  salePriceKrw: number;
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

type CoupangGroupBy = "product" | "group";

export type ProductProfitRow = {
  rowType?: "PRODUCT" | "GROUP";
  productId: string;
  productName: string;
  groupId?: string | null;
  groupName?: string | null;
  childProductCount?: number;
  children?: ProductProfitRow[];
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
  priceSource: "PROMOTION" | "BASE" | "MISSING" | "CONFLICT" | "MIXED";
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

type CoupangMappingIssueRow = {
  issueType: "UNMATCHED" | "AMBIGUOUS" | "EXCLUDED";
  sourceType: "SALES" | "ADS" | "PROMOTION";
  targetKind: "SALES_PRODUCT" | "ADS_SPEND_PRODUCT" | "ADS_CONVERSION_PRODUCT" | "PROMOTION_PRODUCT";
  rowNumber: number | null;
  sourceName: string;
  productText: string;
  amountKrw: number | null;
  reason: string;
  candidates: string[];
  date: string | null;
  rowId: string;
};

type ParsedValidationIssue = {
  errorCode: string;
  message: string;
  rawValue: string | null;
  candidates: string[];
};

type CoupangSaleLineWithBatch = Prisma.CoupangSaleLineGetPayload<{ include: { batch: true } }>;
type CoupangAdMetricWithBatch = Prisma.CoupangAdMetricGetPayload<{ include: { batch: true } }>;
type CoupangPromotionPriceWithBatch = Prisma.CoupangPromotionPriceGetPayload<{ include: { batch: true } }>;

type CoupangAdProductMatchResolution = {
  spendProductId: string | null;
  spendRuleId: string | null;
  conversionProductId: string | null;
  conversionRuleId: string | null;
  spendMatchSource: MatchSource;
  conversionMatchSource: MatchSource;
  warnings: RowIssue[];
  spendMatched: boolean;
  conversionMatched: boolean;
};

type CoupangSpendMatchInput = {
  matcher: CoupangProductMatcher;
  rules: CoupangRuleInput[];
  metricDate: Date;
  adExecutionProductName: string;
  adName?: string | null;
};

type CoupangSpendMatchResolution = {
  productId: string | null;
  ruleId: string | null;
  matchSource: MatchSource;
  warning: RowIssue | null;
  matched: boolean;
};

type CoupangAdsImportRow = Omit<ParsedCoupangAdsRowResult, "rawRow"> & {
  rawRow: Prisma.InputJsonObject;
};

type CoupangAdsNumericMetricKey =
  | "impressions"
  | "clicks"
  | "adSpendKrw"
  | "totalOrders1d"
  | "directOrders1d"
  | "indirectOrders1d"
  | "totalConversionSales1dKrw"
  | "directConversionSales1dKrw"
  | "indirectConversionSales1dKrw"
  | "totalSalesQuantity1d"
  | "directSalesQuantity1d"
  | "indirectSalesQuantity1d";

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
      cancelAmountMode: parseCoupangCancelAmountMode(optionalString(body.cancelAmountMode))
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
    }, COUPANG_TRANSACTION_OPTIONS);

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
    const importRows = aggregateCoupangAdsImportRows(parsed.rows);
    const batch = await this.createBatch({
      sourceType: CoupangUploadSourceType.ADS,
      originalFilename,
      fileHashSha256,
      conflictPolicy: parseConflictPolicy(body.conflictPolicy),
      columnSchema: {
        schemaVersion: COUPANG_ADS_SCHEMA_VERSION,
        columns: parsed.headers,
        missingColumns: parsed.missingColumns,
        sourceRowCount: parsed.rows.length,
        aggregatedRowCount: importRows.length,
        aggregatedDuplicateCount: Math.max(parsed.rows.length - importRows.length, 0)
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
      for (const row of importRows) {
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
          const productMatches = resolveCoupangAdProductMatches({
            matcher: this.matcher,
            rules,
            metricDate: parsedRow.metricDate,
            adExecutionProductName: parsedRow.adExecutionProductName,
            adName: parsedRow.adName,
            conversionProductName: parsedRow.conversionProductName
          });
          spendProductId = productMatches.spendProductId;
          spendRuleId = productMatches.spendRuleId;
          conversionProductId = productMatches.conversionProductId;
          conversionRuleId = productMatches.conversionRuleId;
          spendMatchSource = productMatches.spendMatchSource;
          conversionMatchSource = productMatches.conversionMatchSource;
          warnings.push(...productMatches.warnings);
          matchedSpendCount += productMatches.spendMatched ? 1 : 0;
          matchedConversionCount += productMatches.conversionMatched ? 1 : 0;
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
            adName: parsedRow?.adName,
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
    }, COUPANG_TRANSACTION_OPTIONS);

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
    const appliedRows: CoupangMarginAppliedRow[] = [];
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
        let productRuleId: string | null = null;
        let productRuleCreated = false;
        const existingRule = await tx.coupangProductRule.findFirst({
          where: { coupangProductId: product.id },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
        });
        if (existingRule) {
          const productRule = await tx.coupangProductRule.update({
            where: { id: existingRule.id },
            data: {
              displayName: row.parsedRow.itemName,
              adEnabled: row.parsedRow.adEnabled,
              isActive: true
            }
          });
          productRuleId = productRule.id;
        } else {
          const productRule = await tx.coupangProductRule.create({
            data: {
              coupangProductId: product.id,
              displayName: row.parsedRow.itemName,
              includeKeywords: [row.parsedRow.itemName],
              excludeKeywords: [],
              priority: 100,
              adEnabled: row.parsedRow.adEnabled,
              validFrom: effectiveFrom,
              note: "마진 TSV 업로드로 생성된 기본 매핑 규칙"
            }
          });
          productRuleId = productRule.id;
          productRuleCreated = true;
        }
        const costRule = await tx.coupangCostRule.create({
          data: buildCoupangMarginCostRuleData({
            coupangProductId: product.id,
            parsedRow: row.parsedRow,
            effectiveFrom
          })
        });
        appliedRows.push({
          rowNumber: row.rowNumber,
          itemName: row.parsedRow.itemName,
          standardName,
          productId: product.id,
          productRuleId,
          productRuleCreated,
          costRuleId: costRule.id,
          salePriceKrw: row.parsedRow.salePriceKrw
        });
      }
      await tx.coupangUploadBatch.update({
        where: { id: batch.id },
        data: {
          validRowCount,
          errorCount,
          status: statusFor(validRowCount, errorCount),
          columnSchema: {
            schemaVersion: COUPANG_MARGIN_SCHEMA_VERSION,
            columns: parsed.headers,
            missingColumns: parsed.missingColumns,
            effectiveFrom: formatDateOnly(effectiveFrom),
            appliedRows
          },
          validatedAt: new Date(),
          importedAt: validRowCount > 0 ? new Date() : null
        }
      });
    }, COUPANG_TRANSACTION_OPTIONS);

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
    const conflictPolicy = parseConflictPolicy(body.conflictPolicy);
    const parsed = this.priceTextParser.parseBuffer(upload.buffer);
    const batch = await this.createBatch({
      sourceType: CoupangUploadSourceType.PRICE_TEXT,
      originalFilename,
      fileHashSha256,
      conflictPolicy,
      allowDuplicateFileHash: true,
      columnSchema: {
        schemaVersion: COUPANG_PRICE_TEXT_SCHEMA_VERSION,
        format: "name price"
      },
      rowCount: parsed.rows.length
    });
    const effectiveFrom = body.effectiveFrom ? asDateOnly(String(body.effectiveFrom)) : new Date();
    const appliedRows: CoupangPriceTextAppliedRow[] = [];
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
        const latestCostRule =
          (await this.findLatestCoupangCostRule(tx, product.id)) ??
          (await this.findLegacyPriceTextCostRule(tx, {
            rawLine: row.rawLine,
            itemName: row.parsedRow.itemName,
            productId: product.id
          }));
        const costRuleData = buildCoupangPriceTextCostRuleData({
          coupangProductId: product.id,
          salePriceKrw: row.parsedRow.salePriceKrw,
          effectiveFrom,
          latestCostRule
        });
        const costRule = await tx.coupangCostRule.create({ data: costRuleData });
        appliedRows.push({
          rowNumber: row.rowNumber,
          itemName: row.parsedRow.itemName,
          standardName,
          productId: product.id,
          costRuleId: costRule.id,
          salePriceKrw: row.parsedRow.salePriceKrw
        });
        await this.deleteLegacyPriceTextProductIfUnused(tx, {
          rawLine: row.rawLine,
          itemName: row.parsedRow.itemName,
          productId: product.id
        });
      }
      await tx.coupangUploadBatch.update({
        where: { id: batch.id },
        data: {
          validRowCount,
          warningCount,
          errorCount,
          status: statusFor(validRowCount, errorCount),
          columnSchema: {
            schemaVersion: COUPANG_PRICE_TEXT_SCHEMA_VERSION,
            format: "name price",
            effectiveFrom: formatDateOnly(effectiveFrom),
            appliedRows
          },
          validatedAt: new Date(),
          importedAt: validRowCount > 0 ? new Date() : null
        }
      });
    }, COUPANG_TRANSACTION_OPTIONS);
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
    }, COUPANG_TRANSACTION_OPTIONS);

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
      const rows = await this.prisma.coupangAdMetric.findMany({
        where: { uploadBatchId: id },
        take,
        orderBy: { rowNumber: "asc" },
        include: { spendProduct: true, conversionProduct: true, spendRule: true, conversionRule: true }
      });
      return rows.map((row) => ({ ...row, impressions: row.impressions.toString() }));
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
    const upload = await this.assertUpload(id);
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
      if (upload.sourceType === CoupangUploadSourceType.PRICE_TEXT) {
        await this.deletePriceTextUploadEffects(tx, upload.columnSchema);
      }
      if (upload.sourceType === CoupangUploadSourceType.MARGIN) {
        await this.deleteMarginUploadEffects(tx, upload.columnSchema);
      }
      await this.restoreCurrentCoupangSaleLines(tx, saleLineKeys);
      await this.restoreCurrentCoupangAdMetrics(tx, adMetricKeys);
      return tx.coupangUploadBatch.delete({ where: { id } });
    }, COUPANG_TRANSACTION_OPTIONS);
  }

  async listProductSettings(includeInactive = false) {
    const products = await this.prisma.coupangProduct.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }],
      include: {
        group: true,
        productRules: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }] },
        costRules: { orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] }
      }
    });
    return products.map((product) => ({
      ...product,
      costRules: sortCoupangCostRulesForSettings(product.costRules)
    }));
  }

  async listProductGroups(includeInactive = false) {
    return this.prisma.coupangProductGroup.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }],
      include: { products: { orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }] } }
    });
  }

  async createProductGroup(body: Record<string, unknown>) {
    const displayName = requiredString(body.displayName ?? body.standardName, "displayName");
    const standardName = standardProductName(requiredString(body.standardName ?? displayName, "standardName"));
    return this.prisma.coupangProductGroup.create({
      data: {
        standardName,
        displayName,
        sortOrder: numberOrDefault(body.sortOrder, 100),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive)
      },
      include: { products: true }
    });
  }

  async updateProductGroup(id: string, body: Record<string, unknown>) {
    await this.assertProductGroup(id);
    const data: Prisma.CoupangProductGroupUpdateInput = {};
    if (body.displayName !== undefined) {
      data.displayName = requiredString(body.displayName, "displayName");
    }
    if (body.standardName !== undefined) {
      data.standardName = standardProductName(requiredString(body.standardName, "standardName"));
    }
    if (body.sortOrder !== undefined) {
      data.sortOrder = numberOrDefault(body.sortOrder, 100);
    }
    if (body.isActive !== undefined) {
      data.isActive = Boolean(body.isActive);
    }
    return this.prisma.coupangProductGroup.update({
      where: { id },
      data,
      include: { products: true }
    });
  }

  async deleteProductGroup(id: string) {
    await this.assertProductGroup(id);
    return this.prisma.coupangProductGroup.update({
      where: { id },
      data: { isActive: false },
      include: { products: true }
    });
  }

  async listMappingRules(includeInactive = false) {
    return this.prisma.coupangProductRule.findMany({
      where: includeInactive ? {} : { isActive: true, product: { is: { isActive: true } } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      include: { product: true }
    });
  }

  async createMappingRule(body: Record<string, unknown>) {
    const coupangProductId = requiredString(body.coupangProductId ?? body.productId, "coupangProductId");
    const product = await this.assertProduct(coupangProductId);
    const includeKeywords = requiredStringArray(body.includeKeywords, "includeKeywords");
    return this.prisma.coupangProductRule.create({
      data: {
        coupangProductId,
        displayName: optionalString(body.displayName) ?? product.displayName,
        includeKeywords,
        excludeKeywords: stringArray(body.excludeKeywords) ?? [],
        priority: numberOrDefault(body.priority, 100),
        saleMethod: optionalNullableString(body.saleMethod),
        adEnabled: body.adEnabled === undefined ? true : Boolean(body.adEnabled),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        validFrom: body.validFrom ? asDateOnly(String(body.validFrom)) : undefined,
        validTo: dateOrNullFromBody(body.validTo),
        note: optionalNullableString(body.note)
      },
      include: { product: true }
    });
  }

  async updateMappingRule(id: string, body: Record<string, unknown>) {
    await this.assertMappingRule(id);
    const data: Prisma.CoupangProductRuleUncheckedUpdateInput = {};
    const nextProductId = body.coupangProductId ?? body.productId;
    if (nextProductId !== undefined) {
      const coupangProductId = requiredString(nextProductId, "coupangProductId");
      await this.assertProduct(coupangProductId);
      data.coupangProductId = coupangProductId;
    }
    if (body.displayName !== undefined) {
      data.displayName = requiredString(body.displayName, "displayName");
    }
    if (body.includeKeywords !== undefined) {
      data.includeKeywords = requiredStringArray(body.includeKeywords, "includeKeywords");
    }
    if (body.excludeKeywords !== undefined) {
      data.excludeKeywords = stringArray(body.excludeKeywords) ?? [];
    }
    if (body.priority !== undefined) {
      data.priority = numberOrDefault(body.priority, 100);
    }
    if (body.saleMethod !== undefined) {
      data.saleMethod = optionalNullableString(body.saleMethod);
    }
    if (body.adEnabled !== undefined) {
      data.adEnabled = Boolean(body.adEnabled);
    }
    if (body.isActive !== undefined) {
      data.isActive = Boolean(body.isActive);
    }
    if (body.validFrom !== undefined) {
      data.validFrom = asDateOnly(String(body.validFrom));
    }
    if (body.validTo !== undefined) {
      data.validTo = dateOrNullFromBody(body.validTo);
    }
    if (body.note !== undefined) {
      data.note = optionalNullableString(body.note);
    }
    return this.prisma.coupangProductRule.update({
      where: { id },
      data,
      include: { product: true }
    });
  }

  async deleteMappingRule(id: string) {
    await this.assertMappingRule(id);
    return this.prisma.coupangProductRule.update({
      where: { id },
      data: { isActive: false },
      include: { product: true }
    });
  }

  async createProductSetting(body: Record<string, unknown>) {
    const displayName = requiredString(body.displayName ?? body.standardName, "displayName");
    const standardName = standardProductName(requiredString(body.standardName ?? displayName, "standardName"));
    const groupId = optionalNullableString(body.groupId);
    if (groupId) {
      await this.assertProductGroup(groupId);
    }
    return this.prisma.coupangProduct.create({
      data: {
        standardName,
        displayName,
        sortOrder: numberOrDefault(body.sortOrder, 100),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        group: groupId ? { connect: { id: groupId } } : undefined,
        costRules: maybeCostRuleCreate(body)
      },
      include: { group: true, productRules: true, costRules: true }
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
    if (body.groupId !== undefined) {
      const groupId = optionalNullableString(body.groupId);
      if (groupId) {
        await this.assertProductGroup(groupId);
        productData.group = { connect: { id: groupId } };
      } else {
        productData.group = { disconnect: true };
      }
    }
    if (Object.keys(productData).length > 0) {
      await this.prisma.coupangProduct.update({ where: { id }, data: productData });
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
      include: { group: true, productRules: true, costRules: { orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] } }
    });
  }

  async deleteProductSetting(id: string) {
    await this.assertProduct(id);
    return this.prisma.coupangProduct.update({ where: { id }, data: { isActive: false } });
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
      const productMatches = resolveCoupangAdProductMatches({
        matcher: this.matcher,
        rules,
        metricDate: metric.metricDate,
        adExecutionProductName: metric.adExecutionProductName,
        adName: metric.adName,
        conversionProductName: metric.conversionProductName
      });
      const warnings = productMatches.warnings;
      const validationStatus = validationStatusFor(
        [],
        warnings,
        productMatches.spendProductId || productMatches.conversionProductId
      );
      await this.prisma.coupangAdMetric.update({
        where: { id: metric.id },
        data: {
          spendProductId: productMatches.spendProductId,
          spendProductRuleId: productMatches.spendRuleId,
          conversionProductId: productMatches.conversionProductId,
          conversionProductRuleId: productMatches.conversionRuleId,
          spendMatchSource: productMatches.spendMatchSource,
          conversionMatchSource: productMatches.conversionMatchSource,
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
      matchedSpendCount += productMatches.spendMatched ? 1 : 0;
      matchedConversionCount += productMatches.conversionMatched ? 1 : 0;
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

  async dashboard(query: { from?: string; to?: string; groupBy?: string }) {
    const range = parseDateRange(query.from, query.to);
    const groupBy = parseCoupangGroupBy(query.groupBy);
    const productRows = await this.buildProductProfitRows(range);
    const rows = groupBy === "group" ? await this.groupProductProfitRows(productRows) : productRows;
    const totals = productRows.reduce(
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
      period: { from: range.from, to: range.to },
      groupBy,
      summary: {
        ...totals,
        marginRate: safeDivide(totals.marginKrw, totals.netSalesKrw),
        roas: safeDivide(totals.adConversionSalesKrw, totals.adSpendKrw),
        adSpendRatio: safeDivide(totals.adSpendKrw, totals.netSalesKrw)
      },
      rows: rows.slice(0, 20)
    };
  }

  async productProfit(query: { from?: string; to?: string; groupBy?: string }) {
    const range = parseDateRange(query.from, query.to);
    const groupBy = parseCoupangGroupBy(query.groupBy);
    const productRows = await this.buildProductProfitRows(range);
    const rows = groupBy === "group" ? await this.groupProductProfitRows(productRows) : productRows;
    return { period: { from: range.from, to: range.to }, groupBy, rows };
  }

  async adsAnalysis(query: { from?: string; to?: string; groupBy?: string }) {
    const range = parseDateRange(query.from, query.to);
    const groupBy = parseCoupangGroupBy(query.groupBy);
    const metrics = await this.prisma.coupangAdMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        validationStatus: { not: RowValidationStatus.ERROR }
      },
      include: { spendProduct: { include: { group: true } }, conversionProduct: true },
      orderBy: [{ metricDate: "asc" }, { campaignName: "asc" }, { adGroupName: "asc" }]
    });
    const groups = new Map<string, AdsAccumulator>();
    for (const metric of metrics) {
      const spendGroup = groupBy === "group" ? metric.spendProduct?.group : null;
      const productKey = spendGroup ? `group:${spendGroup.id}` : `product:${metric.spendProductId ?? "unmatched"}`;
      const key = [productKey, metric.campaignName ?? "", metric.adGroupName ?? ""].join(":");
      const current =
        groups.get(key) ??
        ({
          productId: spendGroup?.id ?? metric.spendProductId,
          groupId: spendGroup?.id ?? null,
          groupName: spendGroup?.displayName ?? null,
          rowType: spendGroup ? "GROUP" : "PRODUCT",
          productName: spendGroup?.displayName ?? metric.spendProduct?.displayName ?? "Unmatched",
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
    return { period: { from: range.from, to: range.to }, groupBy, rows };
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
        orderBy: [{ saleDate: "desc" }, { rowNumber: "asc" }],
        include: { batch: true }
      }),
      this.prisma.coupangAdMetric.findMany({
        where: {
          isCurrent: true,
          metricDate: { gte: range.fromDate, lte: range.toDate },
          OR: [{ spendProductId: null }, { conversionProductId: null }, { validationStatus: RowValidationStatus.WARNING }]
        },
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
          reason:
            !metric.spendProductId
              ? "SPEND_NO_MATCH"
              : !metric.conversionProductId && !isPlaceholderCoupangProductText(metric.conversionProductName)
                ? "CONVERSION_NO_MATCH"
                : "WARNING",
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

  async mappingIssues(query: { from?: string; to?: string; take?: string }) {
    const range = parseDateRange(query.from, query.to);
    const take = Math.min(Math.max(Number(query.take ?? 500) || 500, 1), 2000);
    const [sales, ads, promotions] = await Promise.all([
      this.prisma.coupangSaleLine.findMany({
        where: {
          isCurrent: true,
          saleDate: { gte: range.fromDate, lte: range.toDate },
          validationStatus: { not: RowValidationStatus.ERROR },
          OR: [{ coupangProductId: null }, { validationStatus: { in: [RowValidationStatus.WARNING, RowValidationStatus.UNMATCHED] } }]
        },
        orderBy: [{ saleDate: "desc" }, { rowNumber: "asc" }],
        include: { batch: true }
      }),
      this.prisma.coupangAdMetric.findMany({
        where: {
          isCurrent: true,
          metricDate: { gte: range.fromDate, lte: range.toDate },
          validationStatus: { not: RowValidationStatus.ERROR },
          OR: [
            { spendProductId: null },
            { conversionProductId: null },
            { validationStatus: { in: [RowValidationStatus.WARNING, RowValidationStatus.UNMATCHED] } }
          ]
        },
        orderBy: [{ metricDate: "desc" }, { rowNumber: "asc" }],
        include: { batch: true }
      }),
      this.prisma.coupangPromotionPrice.findMany({
        where: {
          promotionStartDate: { lte: range.toDate },
          promotionEndDate: { gte: range.fromDate },
          validationStatus: { not: RowValidationStatus.ERROR },
          OR: [{ coupangProductId: null }, { validationStatus: { in: [RowValidationStatus.WARNING, RowValidationStatus.UNMATCHED] } }]
        },
        orderBy: [{ promotionStartDate: "desc" }, { rowNumber: "asc" }],
        include: { batch: true }
      })
    ]);
    const allRows = [
      ...sales.flatMap((line) => salesMappingIssueRows(line)),
      ...ads.flatMap((metric) => adsMappingIssueRows(metric)),
      ...promotions.flatMap((promotion) => promotionMappingIssueRows(promotion))
    ].sort(compareMappingIssues);
    return {
      period: { from: range.from, to: range.to },
      summary: mappingIssueSummary(allRows),
      rows: allRows.slice(0, take)
    };
  }

  async dailyReport(query: { date?: string; groupBy?: string }) {
    if (!query.date) {
      throw new BadRequestException({ code: "DATE_REQUIRED", message: "date is required." });
    }
    const date = toDateOnly(query.date);
    if (!date) {
      throw new BadRequestException({ code: "INVALID_DATE", message: "date must be YYYY-MM-DD." });
    }
    const groupBy = parseCoupangGroupBy(query.groupBy);
    const productRows = await this.buildProductProfitRows({ from: query.date, to: query.date, fromDate: date, toDate: date });
    const rows = groupBy === "group" ? await this.groupProductProfitRows(productRows) : productRows;
    return {
      date: query.date,
      groupBy,
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

  private async groupProductProfitRows(rows: ProductProfitRow[]): Promise<ProductProfitRow[]> {
    const productIds = uniqueNonEmpty(rows.map((row) => row.productId));
    const products =
      productIds.length > 0
        ? await this.prisma.coupangProduct.findMany({
            where: { id: { in: productIds } },
            include: { group: true }
          })
        : [];
    return aggregateCoupangProductProfitRowsByGroup(rows, products);
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
    allowDuplicateFileHash?: boolean;
    columnSchema: Prisma.InputJsonValue;
    rowCount: number;
  }) {
    return this.prisma.coupangUploadBatch.create({
      data: {
        sourceType: input.sourceType,
        originalFilename: input.originalFilename,
        storedFilePath: null,
        fileHashSha256:
          input.conflictPolicy === ConflictPolicy.SKIP && !input.allowDuplicateFileHash
            ? input.fileHashSha256
            : duplicateBatchHash(input.fileHashSha256, input.conflictPolicy),
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

  private async findLatestCoupangCostRule(tx: Prisma.TransactionClient, coupangProductId: string): Promise<CoupangCostRuleSnapshot | null> {
    return tx.coupangCostRule.findFirst({
      where: { coupangProductId },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }]
    });
  }

  private async findLegacyPriceTextCostRule(
    tx: Prisma.TransactionClient,
    input: { rawLine: string; itemName: string; productId: string }
  ): Promise<CoupangCostRuleSnapshot | null> {
    const legacyItemName = legacyCoupangPriceTextItemName(input.rawLine, input.itemName);
    if (!legacyItemName) {
      return null;
    }

    const legacyStandardName = standardProductName(legacyItemName);
    if (legacyStandardName === standardProductName(input.itemName)) {
      return null;
    }

    const legacyProduct = await tx.coupangProduct.findUnique({
      where: { standardName: legacyStandardName },
      select: { id: true }
    });
    if (!legacyProduct || legacyProduct.id === input.productId) {
      return null;
    }

    return this.findLatestCoupangCostRule(tx, legacyProduct.id);
  }

  private async deletePriceTextUploadEffects(tx: Prisma.TransactionClient, columnSchema: Prisma.JsonValue) {
    const appliedRows = priceTextAppliedRows(columnSchema);
    const costRuleIds = uniqueNonEmpty(appliedRows.map((row) => row.costRuleId));
    const productIds = uniqueNonEmpty(appliedRows.map((row) => row.productId));

    if (costRuleIds.length > 0) {
      await tx.coupangCostRule.deleteMany({ where: { id: { in: costRuleIds } } });
    }

    for (const productId of productIds) {
      await this.deleteCoupangProductIfUnused(tx, productId);
    }
  }

  private async deleteMarginUploadEffects(tx: Prisma.TransactionClient, columnSchema: Prisma.JsonValue) {
    const appliedRows = marginAppliedRows(columnSchema);
    const costRuleIds = uniqueNonEmpty(appliedRows.map((row) => row.costRuleId));
    const createdProductRuleIds = uniqueNonEmpty(
      appliedRows.filter((row) => row.productRuleCreated).map((row) => row.productRuleId)
    );
    const productIds = uniqueNonEmpty(appliedRows.map((row) => row.productId));

    if (costRuleIds.length > 0) {
      await tx.coupangCostRule.deleteMany({ where: { id: { in: costRuleIds } } });
    }
    if (createdProductRuleIds.length > 0) {
      await tx.coupangProductRule.deleteMany({ where: { id: { in: createdProductRuleIds } } });
    }

    for (const productId of productIds) {
      await this.deleteCoupangProductIfUnused(tx, productId);
    }
  }

  private async deleteLegacyPriceTextProductIfUnused(
    tx: Prisma.TransactionClient,
    input: { rawLine: string; itemName: string; productId: string }
  ) {
    const legacyItemName = legacyCoupangPriceTextItemName(input.rawLine, input.itemName);
    if (!legacyItemName) {
      return;
    }

    const legacyStandardName = standardProductName(legacyItemName);
    if (legacyStandardName === standardProductName(input.itemName)) {
      return;
    }

    const legacyProduct = await tx.coupangProduct.findUnique({
      where: { standardName: legacyStandardName },
      select: { id: true }
    });
    if (!legacyProduct || legacyProduct.id === input.productId) {
      return;
    }

    await this.deleteCoupangProductIfUnused(tx, legacyProduct.id);
  }

  private async deleteCoupangProductIfUnused(tx: Prisma.TransactionClient, productId: string) {
    const product = await tx.coupangProduct.findUnique({
      where: { id: productId },
      select: {
        id: true,
        _count: {
          select: {
            costRules: true,
            productRules: true,
            saleLines: true,
            promotionPrices: true,
            spendAdMetrics: true,
            conversionAdMetrics: true
          }
        }
      }
    });
    if (!product) {
      return;
    }

    const usageCount = Object.values(product._count).reduce((sum, count) => sum + count, 0);
    if (usageCount === 0) {
      await tx.coupangProduct.delete({ where: { id: product.id } });
    }
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

  private async assertProductGroup(id: string) {
    const group = await this.prisma.coupangProductGroup.findUnique({ where: { id } });
    if (!group) {
      throw new NotFoundException({ code: "COUPANG_PRODUCT_GROUP_NOT_FOUND", message: "Coupang product group was not found." });
    }
    return group;
  }

  private async assertMappingRule(id: string) {
    const rule = await this.prisma.coupangProductRule.findUnique({ where: { id } });
    if (!rule) {
      throw new NotFoundException({ code: "COUPANG_MAPPING_RULE_NOT_FOUND", message: "Coupang mapping rule was not found." });
    }
    return rule;
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
  rowType: "PRODUCT" | "GROUP";
  productId: string | null;
  productName: string;
  groupId: string | null;
  groupName: string | null;
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

export type CoupangProductProfitGroupProduct = {
  id: string;
  groupId?: string | null;
  group?: { id: string; displayName: string } | null;
};

export function aggregateCoupangProductProfitRowsByGroup(
  rows: ProductProfitRow[],
  products: CoupangProductProfitGroupProduct[]
): ProductProfitRow[] {
  const productById = new Map(products.map((product) => [product.id, product]));
  const buckets = new Map<string, { group: { id: string; displayName: string } | null; rows: ProductProfitRow[] }>();

  for (const row of rows) {
    const group = productById.get(row.productId)?.group ?? null;
    const key = group ? `group:${group.id}` : `product:${row.productId}`;
    const bucket = buckets.get(key) ?? { group, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .map((bucket) => {
      if (!bucket.group) {
        const row = bucket.rows[0];
        return { ...row, rowType: "PRODUCT" as const, childProductCount: 1 };
      }
      return aggregateCoupangProductProfitGroup(bucket.group, bucket.rows);
    })
    .sort((a, b) => b.netSalesKrw - a.netSalesKrw || a.productName.localeCompare(b.productName));
}

function aggregateCoupangProductProfitGroup(
  group: { id: string; displayName: string },
  rows: ProductProfitRow[]
): ProductProfitRow {
  const children = rows.map(({ children: _children, ...row }) => ({ ...row, rowType: "PRODUCT" as const }));
  const matchedSalesLineCount = sumNumbers(rows.map((row) => row.matchedSalesLineCount));
  const salesQuantity = sumNumbers(rows.map((row) => row.salesQuantity));
  const orderCount = sumNumbers(rows.map((row) => row.orderCount));
  const salesKrw = sumNumbers(rows.map((row) => row.salesKrw));
  const cancelAmountKrw = sumNumbers(rows.map((row) => row.cancelAmountKrw));
  const netSalesKrw = sumNumbers(rows.map((row) => row.netSalesKrw));
  const productCostKrw = sumNullable(rows.map((row) => row.productCostKrw));
  const salesFeeKrw = sumNullable(rows.map((row) => row.salesFeeKrw));
  const shippingCostKrw = sumNullable(rows.map((row) => row.shippingCostKrw));
  const returnCostKrw = sumNullable(rows.map((row) => row.returnCostKrw));
  const extraCostKrw = sumNullable(rows.map((row) => row.extraCostKrw));
  const adSpendKrw = sumNumbers(rows.map((row) => row.adSpendKrw));
  const adConversionSalesKrw = sumNumbers(rows.map((row) => row.adConversionSalesKrw));
  const adConversionQuantity = sumNumbers(rows.map((row) => row.adConversionQuantity));
  const organicSalesKrw = sumNumbers(rows.map((row) => row.organicSalesKrw));
  const totalCostKrw = sumNullable(rows.map((row) => row.totalCostKrw));
  const marginKrw = sumNullable(rows.map((row) => row.marginKrw));
  const salePriceKrw = commonNullableNumber(rows.map((row) => row.salePriceKrw));
  const baseSalePriceKrw = commonNullableNumber(rows.map((row) => row.baseSalePriceKrw));
  const promotionPriceKrw = commonNullableNumber(rows.map((row) => row.promotionPriceKrw));
  const priceSources = uniqueNonEmpty(rows.map((row) => row.priceSource));
  const priceMixed =
    salePriceKrw === undefined ||
    baseSalePriceKrw === undefined ||
    promotionPriceKrw === undefined ||
    priceSources.length > 1;
  const saleMethods = uniqueNonEmpty(rows.map((row) => row.saleMethod));
  const saleMethodMixed = saleMethods.length > 1;
  const hasMissingCostRule = rows.some((row) => row.ruleStatus === "MISSING_COST_RULE");
  const hasUnmatched = rows.some((row) => row.ruleStatus === "UNMATCHED");
  const groupWarnings = [
    ...(priceMixed ? ["GROUP_MIXED_PRICE"] : []),
    ...(saleMethodMixed ? ["GROUP_MIXED_SALE_METHOD"] : []),
    ...(hasMissingCostRule ? ["GROUP_HAS_MISSING_COST_RULE"] : [])
  ];

  return {
    rowType: "GROUP",
    productId: group.id,
    productName: group.displayName,
    groupId: group.id,
    groupName: group.displayName,
    childProductCount: rows.length,
    children,
    saleMethod: saleMethodMixed ? "MIXED" : saleMethods[0] ?? null,
    matchedSalesLineCount,
    salesQuantity,
    orderCount,
    salesKrw,
    cancelAmountKrw,
    netSalesKrw,
    salePriceKrw: priceMixed ? null : salePriceKrw ?? null,
    baseSalePriceKrw: priceMixed ? null : baseSalePriceKrw ?? null,
    promotionPriceKrw: priceMixed ? null : promotionPriceKrw ?? null,
    priceSource: (priceMixed ? "MIXED" : priceSources[0] ?? "MISSING") as ProductProfitRow["priceSource"],
    priceWarnings: uniqueNonEmpty([...rows.flatMap((row) => row.priceWarnings), ...(priceMixed ? ["GROUP_MIXED_PRICE"] : [])]),
    productCostKrw,
    salesFeeKrw,
    shippingCostKrw,
    returnCostKrw,
    extraCostKrw,
    adSpendKrw,
    adConversionSalesKrw,
    adConversionQuantity,
    organicSalesKrw,
    totalCostKrw,
    marginKrw,
    marginRate: marginKrw === null ? null : safeDivide(marginKrw, netSalesKrw),
    roas: safeDivide(adConversionSalesKrw, adSpendKrw),
    warnings: uniqueNonEmpty([...rows.flatMap((row) => row.warnings), ...groupWarnings]),
    ruleStatus: hasUnmatched ? "UNMATCHED" : hasMissingCostRule ? "MISSING_COST_RULE" : "OK"
  };
}

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

function aggregateCoupangAdsImportRows(rows: ParsedCoupangAdsRowResult[]): CoupangAdsImportRow[] {
  const passthroughRows: CoupangAdsImportRow[] = [];
  const groups = new Map<string, ParsedCoupangAdsRowResult[]>();

  for (const row of rows) {
    if (!row.parsedRow || row.issues.length > 0) {
      passthroughRows.push({ ...row, rawRow: row.rawRow as Prisma.InputJsonObject });
      continue;
    }

    const adMetricKey = coupangAdMetricKey(row.parsedRow);
    const group = groups.get(adMetricKey) ?? [];
    group.push(row);
    groups.set(adMetricKey, group);
  }

  return [...passthroughRows, ...Array.from(groups, ([adMetricKey, group]) => aggregateCoupangAdsGroup(adMetricKey, group))].sort(
    (left, right) => left.rowNumber - right.rowNumber
  );
}

function aggregateCoupangAdsGroup(adMetricKey: string, rows: ParsedCoupangAdsRowResult[]): CoupangAdsImportRow {
  const sourceRows = [...rows].sort((left, right) => left.rowNumber - right.rowNumber);
  const first = sourceRows[0];
  if (!first?.parsedRow) {
    throw new Error("Cannot aggregate Coupang Ads rows without a parsed row.");
  }
  const parsedRow = first.parsedRow;
  const sourceRowNumbers = sourceRows.map((row) => row.rowNumber);
  const sourceRowHashes = sourceRows.map((row) => row.sourceRowHash);

  return {
    rowNumber: first.rowNumber,
    sourceRowHash: hashCoupangAdsAggregateRow(adMetricKey, sourceRowHashes),
    rawRow: {
      aggregated: sourceRows.length > 1,
      adMetricKey,
      sourceRowNumbers,
      sourceRowCount: sourceRows.length,
      sourceRowHashes
    },
    parsedRow: {
      metricDate: parsedRow.metricDate,
      campaignName: parsedRow.campaignName,
      adGroupName: parsedRow.adGroupName,
      adName: parsedRow.adName,
      adExecutionOptionId: parsedRow.adExecutionOptionId,
      adExecutionProductName: parsedRow.adExecutionProductName,
      conversionOptionId: parsedRow.conversionOptionId,
      conversionProductName: parsedRow.conversionProductName,
      impressions: sumCoupangAdsMetric(sourceRows, "impressions"),
      clicks: sumCoupangAdsMetric(sourceRows, "clicks"),
      adSpendKrw: sumCoupangAdsMetric(sourceRows, "adSpendKrw"),
      totalOrders1d: sumCoupangAdsMetric(sourceRows, "totalOrders1d"),
      directOrders1d: sumCoupangAdsMetric(sourceRows, "directOrders1d"),
      indirectOrders1d: sumCoupangAdsMetric(sourceRows, "indirectOrders1d"),
      totalConversionSales1dKrw: sumCoupangAdsMetric(sourceRows, "totalConversionSales1dKrw"),
      directConversionSales1dKrw: sumCoupangAdsMetric(sourceRows, "directConversionSales1dKrw"),
      indirectConversionSales1dKrw: sumCoupangAdsMetric(sourceRows, "indirectConversionSales1dKrw"),
      totalSalesQuantity1d: sumCoupangAdsMetric(sourceRows, "totalSalesQuantity1d"),
      directSalesQuantity1d: sumCoupangAdsMetric(sourceRows, "directSalesQuantity1d"),
      indirectSalesQuantity1d: sumCoupangAdsMetric(sourceRows, "indirectSalesQuantity1d")
    },
    issues: []
  };
}

function sumCoupangAdsMetric(rows: ParsedCoupangAdsRowResult[], field: CoupangAdsNumericMetricKey) {
  return rows.reduce((sum, row) => sum + Number(row.parsedRow?.[field] ?? 0), 0);
}

function hashCoupangAdsAggregateRow(adMetricKey: string, sourceRowHashes: string[]) {
  return createHash("sha256")
    .update(JSON.stringify({ adMetricKey, sourceRowHashes: [...sourceRowHashes].sort() }))
    .digest("hex");
}

function resolveCoupangAdProductMatches(input: {
  matcher: CoupangProductMatcher;
  rules: CoupangRuleInput[];
  metricDate: Date;
  adExecutionProductName: string;
  adName?: string | null;
  conversionProductName: string;
}): CoupangAdProductMatchResolution {
  const warnings: RowIssue[] = [];
  const conversionIsPlaceholder = isPlaceholderCoupangProductText(input.conversionProductName);
  const spendMatch = resolveCoupangAdSpendProductMatch(input);
  let spendProductId: string | null = spendMatch.productId;
  let spendRuleId: string | null = spendMatch.ruleId;
  let conversionProductId: string | null = null;
  let conversionRuleId: string | null = null;
  let spendMatchSource: MatchSource = spendMatch.matchSource;
  let conversionMatchSource: MatchSource = MatchSource.UNMATCHED;
  let spendMatched = spendMatch.matched;
  let conversionMatched = false;

  if (spendMatch.warning) {
    warnings.push(spendMatch.warning);
  }

  if (conversionIsPlaceholder && spendProductId) {
    conversionProductId = spendProductId;
    conversionRuleId = spendRuleId;
    conversionMatchSource = MatchSource.INFERRED;
    conversionMatched = true;
  } else if (!conversionIsPlaceholder) {
    const conversionMatch = input.matcher.matchText(input.conversionProductName, input.rules, input.metricDate);
    if (conversionMatch.reason === "MATCHED") {
      conversionProductId = conversionMatch.productId;
      conversionRuleId = conversionMatch.matchRuleId;
      conversionMatchSource = MatchSource.RULE;
      conversionMatched = true;
    } else {
      warnings.push(matchIssue(`CONVERSION_${conversionMatch.reason}`, conversionMatch.candidates));
    }
  }

  return {
    spendProductId,
    spendRuleId,
    conversionProductId,
    conversionRuleId,
    spendMatchSource,
    conversionMatchSource,
    warnings,
    spendMatched,
    conversionMatched
  };
}

function resolveCoupangAdSpendProductMatch(input: CoupangSpendMatchInput): CoupangSpendMatchResolution {
  if (!isPlaceholderCoupangProductText(input.adExecutionProductName)) {
    return matchCoupangAdSpendText(input.adExecutionProductName, input);
  }

  if (!isPlaceholderCoupangProductText(input.adName)) {
    return matchCoupangAdSpendText(input.adName!, input);
  }

  return {
    productId: null,
    ruleId: null,
    matchSource: MatchSource.UNMATCHED,
    warning: matchIssue("SPEND_NO_MATCH", []),
    matched: false
  };
}

function matchCoupangAdSpendText(text: string, input: CoupangSpendMatchInput): CoupangSpendMatchResolution {
  const match = input.matcher.matchText(text, input.rules, input.metricDate);
  if (match.reason === "MATCHED") {
    return {
      productId: match.productId,
      ruleId: match.matchRuleId,
      matchSource: MatchSource.RULE,
      warning: null,
      matched: true
    };
  }

  return {
    productId: null,
    ruleId: null,
    matchSource: MatchSource.UNMATCHED,
    warning: matchIssue(`SPEND_${match.reason}`, match.candidates),
    matched: false
  };
}

function isPlaceholderCoupangProductText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return !text || text === "-";
}

function coupangAdSpendDisplayText(metric: {
  adExecutionProductName: string;
  adName?: string | null;
  adGroupName?: string | null;
  campaignName?: string | null;
}) {
  return (
    [metric.adExecutionProductName, metric.adName, metric.adGroupName, metric.campaignName].find(
      (value) => !isPlaceholderCoupangProductText(value)
    ) ?? "-"
  );
}

function salesMappingIssueRows(line: CoupangSaleLineWithBatch): CoupangMappingIssueRow[] {
  const issues = mappingIssuesForTarget(parseValidationIssues(line.validationErrors), "SALES_PRODUCT");
  const selectedIssues = issues.length > 0 ? issues : line.coupangProductId ? [] : [syntheticMappingIssue("NO_MATCH")];
  return selectedIssues.flatMap((issue) =>
    buildMappingIssueRow(issue, {
      sourceType: "SALES",
      targetKind: "SALES_PRODUCT",
      rowId: line.id,
      rowNumber: line.rowNumber,
      sourceName: line.batch.originalFilename,
      productText: `${line.productName} ${line.optionName}`.trim(),
      amountKrw: numberFrom(line.netSalesKrw),
      date: line.saleDate ? formatDateOnly(line.saleDate) : null
    })
  );
}

function adsMappingIssueRows(metric: CoupangAdMetricWithBatch): CoupangMappingIssueRow[] {
  const issues = parseValidationIssues(metric.validationErrors);
  const conversionIsPlaceholder = isPlaceholderCoupangProductText(metric.conversionProductName);
  const spendIssues = mappingIssuesForTarget(issues, "ADS_SPEND_PRODUCT");
  const conversionIssues = conversionIsPlaceholder ? [] : mappingIssuesForTarget(issues, "ADS_CONVERSION_PRODUCT");
  const selectedSpendIssues =
    spendIssues.length > 0 ? spendIssues : metric.spendProductId ? [] : [syntheticMappingIssue("SPEND_NO_MATCH")];
  const selectedConversionIssues =
    conversionIsPlaceholder
      ? []
      : conversionIssues.length > 0
      ? conversionIssues
      : metric.conversionProductId
        ? []
        : [syntheticMappingIssue("CONVERSION_NO_MATCH")];

  return [
    ...selectedSpendIssues.flatMap((issue) =>
      buildMappingIssueRow(issue, {
        sourceType: "ADS",
        targetKind: "ADS_SPEND_PRODUCT",
        rowId: `${metric.id}:spend`,
        rowNumber: metric.rowNumber,
        sourceName: metric.batch.originalFilename,
        productText: coupangAdSpendDisplayText(metric),
        amountKrw: numberFrom(metric.adSpendKrw),
        date: formatDateOnly(metric.metricDate)
      })
    ),
    ...selectedConversionIssues.flatMap((issue) =>
      buildMappingIssueRow(issue, {
        sourceType: "ADS",
        targetKind: "ADS_CONVERSION_PRODUCT",
        rowId: `${metric.id}:conversion`,
        rowNumber: metric.rowNumber,
        sourceName: metric.batch.originalFilename,
        productText: metric.conversionProductName,
        amountKrw: numberFrom(metric.totalConversionSales1dKrw),
        date: formatDateOnly(metric.metricDate)
      })
    )
  ];
}

function promotionMappingIssueRows(promotion: CoupangPromotionPriceWithBatch): CoupangMappingIssueRow[] {
  const issues = mappingIssuesForTarget(parseValidationIssues(promotion.validationErrors), "PROMOTION_PRODUCT");
  const selectedIssues = issues.length > 0 ? issues : promotion.coupangProductId ? [] : [syntheticMappingIssue("NO_MATCH")];
  return selectedIssues.flatMap((issue) =>
    buildMappingIssueRow(issue, {
      sourceType: "PROMOTION",
      targetKind: "PROMOTION_PRODUCT",
      rowId: promotion.id,
      rowNumber: promotion.rowNumber,
      sourceName: promotion.batch.originalFilename,
      productText: promotion.productText,
      amountKrw: numberFrom(promotion.promotionPriceKrw),
      date: formatDateOnly(promotion.promotionStartDate)
    })
  );
}

function buildMappingIssueRow(
  issue: ParsedValidationIssue,
  base: Omit<CoupangMappingIssueRow, "issueType" | "reason" | "candidates">
): CoupangMappingIssueRow[] {
  const issueType = mappingIssueType(issue.errorCode);
  if (!issueType) {
    return [];
  }
  return [
    {
      ...base,
      issueType,
      reason: issue.errorCode,
      candidates: issue.candidates
    }
  ];
}

function mappingIssuesForTarget(issues: ParsedValidationIssue[], targetKind: CoupangMappingIssueRow["targetKind"]) {
  return issues.filter((issue) => {
    const code = issue.errorCode;
    if (!mappingIssueType(code)) {
      return false;
    }
    if (targetKind === "ADS_SPEND_PRODUCT") {
      return code.startsWith("SPEND_");
    }
    if (targetKind === "ADS_CONVERSION_PRODUCT") {
      return code.startsWith("CONVERSION_");
    }
    return !code.startsWith("SPEND_") && !code.startsWith("CONVERSION_");
  });
}

function mappingIssueType(errorCode: string): CoupangMappingIssueRow["issueType"] | null {
  const code = errorCode.replace(/^SPEND_/, "").replace(/^CONVERSION_/, "");
  if (code === "NO_MATCH") {
    return "UNMATCHED";
  }
  if (code === "AMBIGUOUS_MATCH") {
    return "AMBIGUOUS";
  }
  if (code === "EXCLUDED_BY_KEYWORD") {
    return "EXCLUDED";
  }
  return null;
}

function syntheticMappingIssue(errorCode: string): ParsedValidationIssue {
  return {
    errorCode,
    message: "Coupang product did not resolve to exactly one active rule.",
    rawValue: null,
    candidates: []
  };
}

function parseValidationIssues(value: Prisma.JsonValue): ParsedValidationIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isJsonObject(item)) {
      return [];
    }
    const errorCode = typeof item.errorCode === "string" ? item.errorCode : "";
    if (!errorCode) {
      return [];
    }
    return [
      {
        errorCode,
        message: typeof item.message === "string" ? item.message : "",
        rawValue: typeof item.rawValue === "string" ? item.rawValue : null,
        candidates: Array.isArray(item.candidates) ? uniqueNonEmpty(item.candidates.map((candidate) => String(candidate))) : []
      }
    ];
  });
}

function compareMappingIssues(left: CoupangMappingIssueRow, right: CoupangMappingIssueRow) {
  return (
    (right.date ?? "").localeCompare(left.date ?? "") ||
    left.sourceType.localeCompare(right.sourceType) ||
    left.targetKind.localeCompare(right.targetKind) ||
    (left.rowNumber ?? 0) - (right.rowNumber ?? 0)
  );
}

function mappingIssueSummary(rows: CoupangMappingIssueRow[]) {
  return {
    totalCount: rows.length,
    unmatchedCount: rows.filter((row) => row.issueType === "UNMATCHED").length,
    ambiguousCount: rows.filter((row) => row.issueType === "AMBIGUOUS").length,
    excludedCount: rows.filter((row) => row.issueType === "EXCLUDED").length,
    salesCount: rows.filter((row) => row.sourceType === "SALES").length,
    adsCount: rows.filter((row) => row.sourceType === "ADS").length,
    promotionCount: rows.filter((row) => row.sourceType === "PROMOTION").length
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
}): Prisma.CoupangCostRuleUncheckedCreateInput {
  const latestCostRule = input.latestCostRule;
  return {
    coupangProductId: input.coupangProductId,
    salePriceKrw: decimal(input.salePriceKrw),
    supplyPriceKrw: latestCostRule?.supplyPriceKrw ?? decimal(0),
    productCostKrw: latestCostRule?.productCostKrw ?? decimal(0),
    salesFeeRate: latestCostRule?.salesFeeRate ?? decimal(0),
    salesFeeKrw: latestCostRule?.salesFeeKrw ?? decimal(0),
    sellerShippingFeeKrw: latestCostRule?.sellerShippingFeeKrw ?? decimal(0),
    growthInboundFeeKrw: latestCostRule?.growthInboundFeeKrw ?? decimal(0),
    growthShippingFeeKrw: latestCostRule?.growthShippingFeeKrw ?? decimal(0),
    returnRate: latestCostRule?.returnRate ?? decimal(0),
    returnCostPerUnitKrw: latestCostRule?.returnCostPerUnitKrw ?? decimal(0),
    extraCostKrw: latestCostRule?.extraCostKrw ?? decimal(0),
    effectiveFrom: input.effectiveFrom,
    note: latestCostRule?.note
  };
}

export function buildCoupangMarginCostRuleData(input: {
  coupangProductId: string;
  parsedRow: ParsedCoupangMarginRow;
  effectiveFrom: Date;
}): Prisma.CoupangCostRuleUncheckedCreateInput {
  return {
    coupangProductId: input.coupangProductId,
    salePriceKrw: decimal(input.parsedRow.salePriceKrw),
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

function fallbackRowKey(rawRow: unknown) {
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

function parseCoupangCancelAmountMode(value: string | undefined): CoupangCancelAmountMode {
  if (value === "SALES_IS_NET" || value === "NEGATIVE_ADD" || value === "POSITIVE_SUBTRACT") {
    return value;
  }
  return "NEGATIVE_ADD";
}

function parseCoupangGroupBy(value: unknown): CoupangGroupBy {
  return value === "group" ? "group" : "product";
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

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
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

function requiredStringArray(value: unknown, field: string): string[] {
  const values = stringArray(value);
  if (!values || values.length === 0) {
    throw new BadRequestException({ code: "FIELD_REQUIRED", message: `${field} is required.` });
  }
  return values;
}

function dateOrNullFromBody(value: unknown): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || String(value).trim() === "") {
    return null;
  }
  return asDateOnly(String(value));
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueNonEmpty(value.map((item) => String(item)));
}

function priceTextAppliedRows(value: Prisma.JsonValue): CoupangPriceTextAppliedRow[] {
  if (!isJsonObject(value) || !Array.isArray(value.appliedRows)) {
    return [];
  }
  return value.appliedRows.flatMap((item) => {
    if (!isJsonObject(item)) {
      return [];
    }
    const productId = typeof item.productId === "string" ? item.productId : "";
    const costRuleId = typeof item.costRuleId === "string" ? item.costRuleId : "";
    if (!productId || !costRuleId) {
      return [];
    }
    return [
      {
        rowNumber: Number(item.rowNumber) || 0,
        itemName: typeof item.itemName === "string" ? item.itemName : "",
        standardName: typeof item.standardName === "string" ? item.standardName : "",
        productId,
        costRuleId,
        salePriceKrw: Number(item.salePriceKrw) || 0
      }
    ];
  });
}

function marginAppliedRows(value: Prisma.JsonValue): CoupangMarginAppliedRow[] {
  if (!isJsonObject(value) || !Array.isArray(value.appliedRows)) {
    return [];
  }
  return value.appliedRows.flatMap((item) => {
    if (!isJsonObject(item)) {
      return [];
    }
    const productId = typeof item.productId === "string" ? item.productId : "";
    const costRuleId = typeof item.costRuleId === "string" ? item.costRuleId : "";
    if (!productId || !costRuleId) {
      return [];
    }
    return [
      {
        rowNumber: Number(item.rowNumber) || 0,
        itemName: typeof item.itemName === "string" ? item.itemName : "",
        standardName: typeof item.standardName === "string" ? item.standardName : "",
        productId,
        productRuleId: typeof item.productRuleId === "string" ? item.productRuleId : null,
        productRuleCreated: item.productRuleCreated === true,
        costRuleId,
        salePriceKrw: Number(item.salePriceKrw) || 0
      }
    ];
  });
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function sumNumbers(values: number[]) {
  return values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function sumNullable(values: Array<number | null | undefined>) {
  const numbers = values.filter((value): value is number => Number.isFinite(value));
  return numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

function commonNullableNumber(values: Array<number | null | undefined>): number | null | undefined {
  if (values.every((value) => value === null || value === undefined)) {
    return null;
  }
  const numbers = values.filter((value): value is number => Number.isFinite(value));
  if (numbers.length !== values.length) {
    return undefined;
  }
  const [first] = numbers;
  return numbers.every((value) => value === first) ? first : undefined;
}

type CoupangCostRuleForSelection = Pick<
  Prisma.CoupangCostRuleGetPayload<Record<string, never>>,
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
  | "effectiveFrom"
  | "effectiveTo"
  | "createdAt"
>;

function findRuleForDate<T extends CoupangCostRuleForSelection>(rules: T[], date: Date): T | null {
  return (
    rules
      .filter((rule) => rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date))
      .sort(compareCoupangCostRuleForSelection)[0] ?? null
  );
}

function sortCoupangCostRulesForSettings<T extends CoupangCostRuleForSelection>(rules: T[]): T[] {
  return [...rules].sort(compareCoupangCostRuleForSelection);
}

function compareCoupangCostRuleForSelection(a: CoupangCostRuleForSelection, b: CoupangCostRuleForSelection) {
  const aHasMarginCosts = hasCoupangMarginCostFields(a);
  const bHasMarginCosts = hasCoupangMarginCostFields(b);
  if (aHasMarginCosts !== bHasMarginCosts) {
    return aHasMarginCosts ? -1 : 1;
  }
  return b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.createdAt.getTime() - a.createdAt.getTime();
}

function hasCoupangMarginCostFields(rule: CoupangCostRuleForSelection) {
  return [
    rule.supplyPriceKrw,
    rule.productCostKrw,
    rule.salesFeeRate,
    rule.salesFeeKrw,
    rule.sellerShippingFeeKrw,
    rule.growthInboundFeeKrw,
    rule.growthShippingFeeKrw,
    rule.returnRate,
    rule.returnCostPerUnitKrw,
    rule.extraCostKrw
  ].some((value) => numberFrom(value) !== 0);
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
