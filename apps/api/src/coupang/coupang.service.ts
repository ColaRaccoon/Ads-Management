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
import {
  calculateCoupangManualPurchaseCost,
  CoupangCostInput
} from "../domain/coupang-profit-calculator";
import {
  adjustReportedSalesForManualPurchase,
  aggregateManualPurchasesByProductDate,
  aggregateReportedSalesByProductDate,
  calculateManualPurchaseProfitAdjustment,
  calculateNormalCoupangProfit,
  combineCoupangProfitParts,
  emptyReportedSalesFacts,
  hasCoupangSalesSegmentActivity,
  productDateKey,
  resolveManualPurchaseSalesAmount,
  type CoupangCalculationPartStatus
} from "../domain/coupang-profit-pipeline";
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
const COUPANG_MANUAL_PURCHASE_VENDOR_FEE_SETTING_KEY = "coupang_manual_purchase_vendor_fee_per_unit_krw";
const DEFAULT_COUPANG_MANUAL_PURCHASE_VENDOR_FEE_KRW = 3182;
const MAX_COUPANG_MANUAL_PURCHASE_MONEY_KRW = 999_999_999_999.99;
const MAX_COUPANG_COST_INTEGER_KRW = 999_999_999_999;

type CoupangPriceTextAppliedRow = {
  rowNumber: number;
  itemName: string;
  standardName: string;
  productId: string;
  costRuleId: string;
  salePriceKrw: number;
  costRuleOperation: "CREATED" | "UPDATED_SAME_DATE";
  costRuleBefore: CoupangCostRuleRollbackSnapshot | null;
  costRuleAfter: CoupangCostRuleRollbackSnapshot;
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
  costRuleOperation: "CREATED" | "UPDATED_SAME_DATE";
  costRuleBefore: CoupangCostRuleRollbackSnapshot | null;
  costRuleAfter: CoupangCostRuleRollbackSnapshot;
};

type CoupangCostRuleRollbackSnapshot = {
  salePriceKrw: string;
  supplyPriceKrw: string;
  productCostKrw: string;
  salesFeeRate: string;
  salesFeeKrw: string;
  sellerShippingFeeKrw: string | null;
  hanaroShippingFeeKrw: string | null;
  growthInboundFeeKrw: string;
  growthShippingFeeKrw: string;
  returnRate: string;
  returnCostPerUnitKrw: string;
  extraCostKrw: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
};

type CoupangCostRuleSnapshot = Pick<
  Prisma.CoupangCostRuleGetPayload<Record<string, never>>,
  | "salePriceKrw"
  | "supplyPriceKrw"
  | "productCostKrw"
  | "salesFeeRate"
  | "salesFeeKrw"
  | "sellerShippingFeeKrw"
  | "hanaroShippingFeeKrw"
  | "growthInboundFeeKrw"
  | "growthShippingFeeKrw"
  | "returnRate"
  | "returnCostPerUnitKrw"
  | "extraCostKrw"
  | "note"
>;

type ManualPurchaseEntryInput = {
  coupangProductId: string;
  coupangProductRuleId?: string | null;
  quantity: number;
  memo?: string;
};

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
  reportedSalesQuantity: number;
  reportedOrderCount: number;
  reportedSalesKrw: number;
  reportedNetSalesKrw: number;
  salesQuantity: number | null;
  orderCount: number;
  salesKrw: number | null;
  cancelAmountKrw: number;
  netSalesKrw: number | null;
  salePriceKrw: number | null;
  baseSalePriceKrw: number | null;
  promotionPriceKrw: number | null;
  priceSource: "PROMOTION" | "BASE" | "MISSING" | "CONFLICT" | "MIXED";
  priceWarnings: string[];
  productCostKrw: number | null;
  salesFeeKrw: number | null;
  shippingCostKrw: number | null;
  sellerSalesQuantity: number;
  growthSalesQuantity: number;
  sellerShippingCostKrw: number | null;
  hanaroShippingCostKrw: number | null;
  growthInboundCostKrw: number | null;
  growthShippingCostKrw: number | null;
  totalLogisticsCostKrw: number | null;
  returnCostKrw: number | null;
  extraCostKrw: number | null;
  vatKrw: number | null;
  manualPurchaseSalesKrw: number | null;
  manualPurchaseQuantity: number;
  manualPurchaseProductCostKrw: number | null;
  manualPurchaseVendorFeeKrw: number | null;
  manualPurchaseCoupangSalesFeeKrw: number | null;
  manualPurchaseShippingCostKrw: number | null;
  manualPurchaseOtherCostKrw: number | null;
  manualPurchaseTotalCostKrw: number | null;
  actualSalesKrw: number | null;
  actualNetSalesKrw: number | null;
  actualSalesQuantity: number | null;
  normalCalculationStatus: CoupangCalculationPartStatus;
  manualCalculationStatus: CoupangCalculationPartStatus;
  calculationStatus: "COMPLETE" | "INCOMPLETE";
  adSpendKrw: number;
  adConversionSalesKrw: number;
  adConversionQuantity: number;
  organicSalesKrw: number | null;
  reportedOrganicSalesKrw: number;
  actualOrganicSalesKrw: number | null;
  normalMarginKrw: number | null;
  totalCostKrw: number | null;
  marginKrw: number | null;
  knownTotalCostKrw: number;
  knownMarginKrw: number;
  completeProductCount: number;
  incompleteProductCount: number;
  excludedNetSalesKrw: number;
  excludedSalesQuantity: number;
  incompleteNormalCount: number;
  incompleteManualCount: number;
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
        missingColumns: parsed.missingColumns,
        ignoredColumns: parsed.ignoredColumns
      },
      rowCount: parsed.rows.length
    });

    if (parsed.missingColumns.length > 0) {
      await this.failMissingColumns(batch.id, CoupangUploadSourceType.MARGIN, parsed.missingColumns);
    }

    const effectiveFrom = body.effectiveFrom
      ? requiredDateFromBody(body.effectiveFrom, "effectiveFrom")
      : currentKoreaDateOnly();
    const appliedRows: CoupangMarginAppliedRow[] = [];
    let validRowCount = 0;
    const warningCount = parsed.ignoredColumns.length > 0 ? 1 : 0;
    let errorCount = 0;
    await this.prisma.$transaction(async (tx) => {
      await this.lockCoupangCostRuleBulkWrites(tx);
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
        const parsedRow = row.parsedRow;
        validRowCount += 1;
        const standardName = standardProductName(parsedRow.itemName);
        const product = await tx.coupangProduct.upsert({
          where: { standardName },
          create: {
            standardName,
            displayName: parsedRow.itemName
          },
          update: {
            displayName: parsedRow.itemName,
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
              displayName: parsedRow.itemName,
              adEnabled: parsedRow.adEnabled,
              isActive: true
            }
          });
          productRuleId = productRule.id;
        } else {
          const productRule = await tx.coupangProductRule.create({
            data: {
              coupangProductId: product.id,
              displayName: parsedRow.itemName,
              includeKeywords: [parsedRow.itemName],
              excludeKeywords: [],
              priority: 100,
              adEnabled: parsedRow.adEnabled,
              validFrom: effectiveFrom,
              note: "마진 TSV 업로드로 생성된 기본 매핑 규칙"
            }
          });
          productRuleId = productRule.id;
          productRuleCreated = true;
        }
        const savedCostRule = await this.upsertImportedCoupangCostRule(tx, product.id, effectiveFrom,
          (baseCostRule) => buildCoupangMarginCostRuleData({
            coupangProductId: product.id,
            parsedRow,
            effectiveFrom,
            latestCostRule: baseCostRule
          }));
        appliedRows.push({
          rowNumber: row.rowNumber,
          itemName: parsedRow.itemName,
          standardName,
          productId: product.id,
          productRuleId,
          productRuleCreated,
          costRuleId: savedCostRule.rule.id,
          salePriceKrw: parsedRow.salePriceKrw,
          costRuleOperation: savedCostRule.operation,
          costRuleBefore: savedCostRule.before,
          costRuleAfter: savedCostRule.after
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
            schemaVersion: COUPANG_MARGIN_SCHEMA_VERSION,
            columns: parsed.headers,
            missingColumns: parsed.missingColumns,
            ignoredColumns: parsed.ignoredColumns,
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
      warningCount,
      errorCount,
      warnings: parsed.ignoredColumns.length > 0
        ? ["판매수수료율/판매수수료 컬럼은 공통 설정으로 대체되어 무시됨"]
        : []
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
    const effectiveFrom = body.effectiveFrom
      ? requiredDateFromBody(body.effectiveFrom, "effectiveFrom")
      : currentKoreaDateOnly();
    const appliedRows: CoupangPriceTextAppliedRow[] = [];
    let validRowCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    await this.prisma.$transaction(async (tx) => {
      await this.lockCoupangCostRuleBulkWrites(tx);
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
        const parsedRow = row.parsedRow;
        validRowCount += 1;
        const standardName = standardProductName(parsedRow.itemName);
        const product = await tx.coupangProduct.upsert({
          where: { standardName },
          create: {
            standardName,
            displayName: parsedRow.itemName
          },
          update: { displayName: parsedRow.itemName, isActive: true }
        });
        const savedCostRule = await this.upsertImportedCoupangCostRule(tx, product.id, effectiveFrom, async (baseCostRule) => {
          const latestCostRule = baseCostRule ?? await this.findLegacyPriceTextCostRule(tx, {
            rawLine: row.rawLine,
            itemName: parsedRow.itemName,
            productId: product.id,
            effectiveFrom
          });
          return buildCoupangPriceTextCostRuleData({
            coupangProductId: product.id,
            salePriceKrw: parsedRow.salePriceKrw,
            effectiveFrom,
            latestCostRule
          });
        });
        appliedRows.push({
          rowNumber: row.rowNumber,
          itemName: parsedRow.itemName,
          standardName,
          productId: product.id,
          costRuleId: savedCostRule.rule.id,
          salePriceKrw: parsedRow.salePriceKrw,
          costRuleOperation: savedCostRule.operation,
          costRuleBefore: savedCostRule.before,
          costRuleAfter: savedCostRule.after
        });
        await this.deleteLegacyPriceTextProductIfUnused(tx, {
          rawLine: row.rawLine,
          itemName: parsedRow.itemName,
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
    const priceTextRows = upload.sourceType === CoupangUploadSourceType.PRICE_TEXT
      ? priceTextAppliedRows(upload.columnSchema, upload.validRowCount)
      : null;
    const marginRows = upload.sourceType === CoupangUploadSourceType.MARGIN
      ? marginAppliedRows(upload.columnSchema, upload.validRowCount)
      : null;
    return this.prisma.$transaction(async (tx) => {
      if (upload.sourceType === CoupangUploadSourceType.PRICE_TEXT || upload.sourceType === CoupangUploadSourceType.MARGIN) {
        await this.lockCoupangCostRuleBulkWrites(tx);
      }
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
      if (priceTextRows) {
        await this.deletePriceTextUploadEffects(tx, priceTextRows);
      }
      if (marginRows) {
        await this.deleteMarginUploadEffects(tx, marginRows);
      }
      await this.restoreCurrentCoupangSaleLines(tx, saleLineKeys);
      await this.restoreCurrentCoupangAdMetrics(tx, adMetricKeys);
      return tx.coupangUploadBatch.delete({ where: { id } });
    }, COUPANG_TRANSACTION_OPTIONS);
  }

  async listProductSettings(includeInactive = false, dateText?: string) {
    const date = dateText ? requiredDateFromBody(dateText, "date") : currentKoreaDateOnly();
    const products = await this.prisma.coupangProduct.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }],
      include: {
        group: true,
        productRules: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }] },
        costRules: { orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }] }
      }
    });
    return products.map((product) => {
      const costRules = sortCoupangCostRulesForSettings(product.costRules);
      return { ...product, costRules, currentCostRule: findRuleForDate(costRules, date) };
    });
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
    assertGlobalSalesFeeFieldsNotPresent(body);
    assertCoupangCostEffectiveToNotPresent(body);
    const displayName = requiredString(body.displayName ?? body.standardName, "displayName");
    const standardName = standardProductName(requiredString(body.standardName ?? displayName, "standardName"));
    const groupId = optionalNullableString(body.groupId);
    const costRuleBody = hasCoupangCostFields(body)
      ? {
          ...body,
          effectiveFrom: formatDateOnly(Object.prototype.hasOwnProperty.call(body, "effectiveFrom")
            ? requiredDateFromBody(body.effectiveFrom, "effectiveFrom")
            : currentKoreaDateOnly())
        }
      : body;
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
        costRules: maybeCostRuleCreate(costRuleBody)
      },
      include: { group: true, productRules: true, costRules: true }
    });
  }

  async updateProductSetting(id: string, body: Record<string, unknown>) {
    assertGlobalSalesFeeFieldsNotPresent(body);
    assertCoupangCostEffectiveToNotPresent(body);
    if (hasCoupangCostFields(body)) {
      const configurationBody = { ...body };
      for (const field of ["mappingRuleId", "includeKeywords", "excludeKeywords", "priority"] as const) {
        delete configurationBody[field];
      }
      const result = await this.updateProductConfiguration(id, {
        ...configurationBody,
        effectiveFrom: body.effectiveFrom ?? formatDateOnly(currentKoreaDateOnly())
      });
      return result.product;
    }
    await this.assertProduct(id);
    const productData = await this.buildCoupangProductSettingUpdateData(this.prisma, body);
    if (Object.keys(productData).length > 0) {
      await this.prisma.coupangProduct.update({ where: { id }, data: productData });
    }

    return this.prisma.coupangProduct.findUnique({
      where: { id },
      include: { group: true, productRules: true, costRules: { orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] } }
    });
  }

  async updateProductConfiguration(id: string, body: Record<string, unknown>) {
    assertGlobalSalesFeeFieldsNotPresent(body);
    assertCoupangCostEffectiveToNotPresent(body);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const product = await tx.coupangProduct.findUnique({ where: { id } });
        if (!product) {
          throw new NotFoundException({ code: "COUPANG_PRODUCT_NOT_FOUND", message: "Coupang product was not found." });
        }

        const productData = await this.buildCoupangProductSettingUpdateData(tx, body);
        if (Object.keys(productData).length > 0) {
          await tx.coupangProduct.update({ where: { id }, data: productData });
        }

        let costRuleChange: null | {
          operation: "CREATED" | "UPDATED_SAME_DATE";
          rule: Prisma.CoupangCostRuleGetPayload<Record<string, never>>;
          effectiveFrom: string;
          effectiveTo: string | null;
          nextRuleEffectiveFrom: string | null;
        } = null;
        if (hasCoupangCostFields(body)) {
          const effectiveFrom = requiredDateFromBody(body.effectiveFrom, "effectiveFrom");
          await this.lockCoupangCostRuleWrites(tx, id);
          const sameDateRule = await this.findCoupangCostRuleStartingOnDate(tx, id, effectiveFrom);
          const baseRule = sameDateRule ?? await this.findCoupangCostRuleAtOrBeforeDate(tx, id, effectiveFrom);
          const costRule = maybeCostRuleCreate(body, baseRule);
          if (!costRule?.create) {
            throw new BadRequestException({ code: "COST_RULE_EMPTY", message: "At least one cost field is required." });
          }
          const snapshotData = costRule.create as Prisma.CoupangCostRuleUncheckedCreateWithoutProductInput;
          if (sameDateRule) {
            snapshotData.salesFeeRate = sameDateRule.salesFeeRate;
            snapshotData.salesFeeKrw = sameDateRule.salesFeeKrw;
          }
          const saved = sameDateRule
            ? await tx.coupangCostRule.update({ where: { id: sameDateRule.id }, data: snapshotData })
            : await tx.coupangCostRule.create({ data: { ...snapshotData, coupangProductId: id } });
          await this.normalizeCoupangCostRuleRanges(tx, id);
          const [rule, nextRule] = await Promise.all([
            tx.coupangCostRule.findUniqueOrThrow({ where: { id: saved.id } }),
            tx.coupangCostRule.findFirst({
              where: { coupangProductId: id, effectiveFrom: { gt: effectiveFrom } },
              orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }]
            })
          ]);
          costRuleChange = {
            operation: sameDateRule ? "UPDATED_SAME_DATE" : "CREATED",
            rule,
            effectiveFrom: formatDateOnly(rule.effectiveFrom),
            effectiveTo: rule.effectiveTo ? formatDateOnly(rule.effectiveTo) : null,
            nextRuleEffectiveFrom: nextRule ? formatDateOnly(nextRule.effectiveFrom) : null
          };
        }

        await this.upsertPrimaryCoupangProductRule(tx, id, body);

        const updated = await tx.coupangProduct.findUnique({
          where: { id },
          include: {
            group: true,
            productRules: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }] },
            costRules: { orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }] }
          }
        });
        if (!updated) {
          throw new NotFoundException({ code: "COUPANG_PRODUCT_NOT_FOUND", message: "Coupang product was not found." });
        }
        const costRules = sortCoupangCostRulesForSettings(updated.costRules);
        const productResult = { ...updated, costRules, currentCostRule: findRuleForDate(costRules, currentKoreaDateOnly()) };
        return { product: productResult, costRuleChange };
      }, COUPANG_TRANSACTION_OPTIONS);
    } catch (error) {
      rethrowCoupangCostRuleWriteError(error);
    }
  }

  async correctProductCostRule(productId: string, costRuleId: string, body: Record<string, unknown>) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const product = await tx.coupangProduct.findUnique({ where: { id: productId } });
        if (!product) throw new NotFoundException({ code: "COUPANG_PRODUCT_NOT_FOUND", message: "Coupang product was not found." });
        await this.lockCoupangCostRuleWrites(tx, productId);
        const existing = await tx.coupangCostRule.findUnique({ where: { id: costRuleId } });
        if (!existing) throw new NotFoundException({ code: "COUPANG_COST_RULE_NOT_FOUND", message: "Coupang cost rule was not found." });
        if (existing.coupangProductId !== productId) {
          throw new BadRequestException({ code: "COUPANG_COST_RULE_PRODUCT_MISMATCH", message: "Cost rule belongs to another Coupang product." });
        }

        const data: Prisma.CoupangCostRuleUpdateInput = {};
        const nonNegativeMoneyFields = [
          "salePriceKrw",
          "supplyPriceKrw",
          "productCostKrw",
          "salesFeeKrw",
          "growthInboundFeeKrw",
          "growthShippingFeeKrw",
          "returnCostPerUnitKrw",
          "extraCostKrw"
        ] as const;
        for (const field of nonNegativeMoneyFields) {
          if (Object.prototype.hasOwnProperty.call(body, field)) {
            data[field] = nonNegativeCostDecimalFromBody(body[field], field);
          }
        }
        for (const field of ["sellerShippingFeeKrw", "hanaroShippingFeeKrw"] as const) {
          if (Object.prototype.hasOwnProperty.call(body, field)) {
            data[field] = nullableNonNegativeCostDecimalFromBody(body[field], field);
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, "salesFeeRate")) {
          data.salesFeeRate = rateDecimalFromBody(body.salesFeeRate, "salesFeeRate");
        }
        if (Object.prototype.hasOwnProperty.call(body, "returnRate")) {
          data.returnRate = rateDecimalFromBody(body.returnRate, "returnRate");
        }
        if (Object.prototype.hasOwnProperty.call(body, "effectiveFrom")) {
          data.effectiveFrom = requiredDateFromBody(body.effectiveFrom, "effectiveFrom");
        }
        assertCoupangCostEffectiveToNotPresent(body);
        if (Object.prototype.hasOwnProperty.call(body, "note")) {
          data.note = optionalNullableString(body.note);
        }
        const nextFrom = data.effectiveFrom instanceof Date ? data.effectiveFrom : existing.effectiveFrom;
        const duplicate = await tx.coupangCostRule.findFirst({
          where: { coupangProductId: productId, effectiveFrom: nextFrom, NOT: { id: costRuleId } }
        });
        if (duplicate) throw new BadRequestException({
          code: "COUPANG_COST_RULE_DATE_EXISTS",
          message: "A cost rule already starts on this date; correct that history row instead."
        });
        if (Object.keys(data).length === 0) throw new BadRequestException({ code: "COST_RULE_CORRECTION_EMPTY", message: "At least one correction field is required." });
        const changedFields = Object.keys(data);
        if (data.effectiveFrom instanceof Date) {
          const followingRule = await tx.coupangCostRule.findFirst({
            where: { coupangProductId: productId, effectiveFrom: { gt: nextFrom }, NOT: { id: costRuleId } },
            orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }]
          });
          data.effectiveTo = followingRule ? previousDate(followingRule.effectiveFrom) : null;
        }

        await tx.coupangCostRule.update({ where: { id: costRuleId }, data });
        await this.normalizeCoupangCostRuleRanges(tx, productId);
        const normalized = await tx.coupangCostRule.findUniqueOrThrow({ where: { id: costRuleId } });
        console.info("COUPANG_COST_RULE_CORRECTED", { productId, costRuleId, effectiveFrom: formatDateOnly(normalized.effectiveFrom), changedFields });
        return normalized;
      }, COUPANG_TRANSACTION_OPTIONS);
    } catch (error) {
      rethrowCoupangCostRuleWriteError(error);
    }
  }

  async currentSalesFeeRule(dateText?: string) {
    const date = dateText ? requiredDateFromBody(dateText, "date") : currentKoreaDateOnly();
    const rule = await this.prisma.coupangSalesFeeRule.findFirst({
      where: { effectiveFrom: { lte: date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }]
    });
    if (!rule) {
      throw new NotFoundException({
        code: "COUPANG_GLOBAL_SALES_FEE_RATE_MISSING",
        message: `No global Coupang sales fee rate applies on ${formatDateOnly(date)}.`
      });
    }
    return serializeSalesFeeRule(rule);
  }

  async listSalesFeeRules() {
    const rules = await this.prisma.coupangSalesFeeRule.findMany({
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }]
    });
    return rules.map(serializeSalesFeeRule);
  }

  async createSalesFeeRule(body: Record<string, unknown>) {
    const salesFeeRate = salesFeeRateFromPercentBody(body.salesFeePercent);
    const effectiveFrom = requiredDateFromBody(body.effectiveFrom, "effectiveFrom");
    const note = optionalNullableString(body.note);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockSalesFeeRuleWrites(tx);
        const duplicate = await tx.coupangSalesFeeRule.findFirst({ where: { effectiveFrom } });
        if (duplicate) {
          throw new BadRequestException({
            code: "COUPANG_SALES_FEE_RULE_DATE_EXISTS",
            message: "A global sales fee rule already starts on this date; correct that history row instead."
          });
        }
        const created = await tx.coupangSalesFeeRule.create({ data: { salesFeeRate, effectiveFrom, note } });
        await this.normalizeSalesFeeRuleRanges(tx);
        const rule = await tx.coupangSalesFeeRule.findUniqueOrThrow({ where: { id: created.id } });
        return { rule: serializeSalesFeeRule(rule) };
      }, COUPANG_TRANSACTION_OPTIONS);
    } catch (error) {
      rethrowSalesFeeRuleWriteError(error);
    }
  }

  async correctSalesFeeRule(id: string, body: Record<string, unknown>) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockSalesFeeRuleWrites(tx);
        const existing = await tx.coupangSalesFeeRule.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException({ code: "COUPANG_SALES_FEE_RULE_NOT_FOUND", message: "Global sales fee rule was not found." });
        }
        const data: Prisma.CoupangSalesFeeRuleUpdateInput = {};
        if (Object.prototype.hasOwnProperty.call(body, "salesFeePercent")) {
          data.salesFeeRate = salesFeeRateFromPercentBody(body.salesFeePercent);
        }
        if (Object.prototype.hasOwnProperty.call(body, "effectiveFrom")) {
          data.effectiveFrom = requiredDateFromBody(body.effectiveFrom, "effectiveFrom");
        }
        if (Object.prototype.hasOwnProperty.call(body, "note")) {
          data.note = optionalNullableString(body.note);
        }
        if (Object.keys(data).length === 0) {
          throw new BadRequestException({ code: "SALES_FEE_RULE_CORRECTION_EMPTY", message: "At least one correction field is required." });
        }
        const nextFrom = data.effectiveFrom instanceof Date ? data.effectiveFrom : existing.effectiveFrom;
        const duplicate = await tx.coupangSalesFeeRule.findFirst({ where: { effectiveFrom: nextFrom, NOT: { id } } });
        if (duplicate) {
          throw new BadRequestException({
            code: "COUPANG_SALES_FEE_RULE_DATE_EXISTS",
            message: "Another global sales fee rule already starts on this date."
          });
        }
        if (data.effectiveFrom instanceof Date) {
          const followingRule = await tx.coupangSalesFeeRule.findFirst({
            where: { effectiveFrom: { gt: nextFrom }, NOT: { id } },
            orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }]
          });
          data.effectiveTo = followingRule ? previousDate(followingRule.effectiveFrom) : null;
        }
        await tx.coupangSalesFeeRule.update({ where: { id }, data });
        await this.normalizeSalesFeeRuleRanges(tx);
        const rule = await tx.coupangSalesFeeRule.findUniqueOrThrow({ where: { id } });
        return { rule: serializeSalesFeeRule(rule) };
      }, COUPANG_TRANSACTION_OPTIONS);
    } catch (error) {
      rethrowSalesFeeRuleWriteError(error);
    }
  }

  async deleteProductSetting(id: string) {
    await this.assertProduct(id);
    return this.prisma.coupangProduct.update({ where: { id }, data: { isActive: false } });
  }

  async manualPurchaseOptions(query: { date?: string }) {
    const date = query.date ? asDateOnly(query.date) : currentKoreaDateOnly();
    const dateText = formatDateOnly(date);
    const [vendorFeePerUnitKrw, activeProducts, existingRows] = await Promise.all([
      this.manualPurchaseVendorFeePerUnitKrw(),
      this.prisma.coupangProduct.findMany({
        where: { isActive: true },
        include: {
          group: true,
          productRules: {
            where: {
              isActive: true,
              validFrom: { lte: date },
              OR: [{ validTo: null }, { validTo: { gte: date } }]
            },
            orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
          }
        },
        orderBy: [{ displayName: "asc" }]
      }),
      this.prisma.coupangManualPurchase.findMany({
        where: { purchaseDate: date },
        include: { product: { include: { group: true } }, productRule: true },
        orderBy: [{ productDisplayName: "asc" }]
      })
    ]);

    const activeProductById = new Map(activeProducts.map((product) => [product.id, product]));
    const existingByProductId = new Map(existingRows.map((row) => [row.coupangProductId, row]));
    const productIds = uniqueNonEmpty([...activeProducts.map((product) => product.id), ...existingRows.map((row) => row.coupangProductId)]);
    const costRules = productIds.length
      ? await this.prisma.coupangCostRule.findMany({
          where: { coupangProductId: { in: productIds } },
          orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }]
        })
      : [];
    const costRulesByProductId = groupBy(costRules, (rule) => rule.coupangProductId);

    const options = productIds
      .map((productId) => {
        const activeProduct = activeProductById.get(productId);
        const rules = activeProduct?.productRules ?? [];
        const existing = existingByProductId.get(productId) ?? null;
        const representativeRule = rules[0] ?? existing?.productRule ?? null;
        const product = activeProduct ?? existing?.product ?? null;
        const productName = product?.displayName ?? existing?.productDisplayName ?? "Coupang Product";
        const groupId = product?.group?.id ?? null;
        const groupName = product?.group?.displayName ?? null;
        const saleMethod = representativeRule?.saleMethod ?? existing?.saleMethod ?? null;
        const costRule = findRuleForDate(costRulesByProductId.get(productId) ?? [], date);
        const baseSalePriceKrw = costRule ? numberFrom(costRule.salePriceKrw) : null;
        const warnings: string[] = [];
        let unitSalesAmountKrw: number | null = null;
        let unitTotalCostKrw: number | null = null;
        let isCalculable = true;
        if (!costRule) {
          warnings.push("COUPANG_COST_RULE_MISSING");
          isCalculable = false;
        } else if (baseSalePriceKrw === null || baseSalePriceKrw <= 0) {
          warnings.push("COUPANG_BASE_SALE_PRICE_REQUIRED");
          isCalculable = false;
        } else {
          const calculated = calculateCoupangManualPurchaseCost({
            quantity: 1,
            vendorFeePerUnitKrw
          });
          unitSalesAmountKrw = baseSalePriceKrw;
          unitTotalCostKrw = calculated.totalCostKrw;
        }
        const searchText = uniqueNonEmpty([
          productName,
          product?.standardName,
          groupName,
          ...rules.flatMap((rule) => [
            rule.displayName,
            ...jsonStringArray(rule.includeKeywords),
            ...jsonStringArray(rule.excludeKeywords)
          ]),
          representativeRule?.displayName,
          existing?.ruleDisplayName ?? undefined
        ]).join(" ");

        return {
          coupangProductId: productId,
          coupangProductRuleId: representativeRule?.id ?? existing?.coupangProductRuleId ?? null,
          productName,
          ruleDisplayName: representativeRule?.displayName ?? existing?.ruleDisplayName ?? null,
          groupId,
          groupName,
          saleMethod,
          searchText,
          salePriceKrw: baseSalePriceKrw,
          baseSalePriceKrw,
          promotionPriceKrw: null,
          priceSource: "BASE",
          priceWarnings: [],
          unitSalesAmountKrw,
          unitVendorFeeKrw: vendorFeePerUnitKrw,
          unitProductCostKrw: 0,
          unitCoupangSalesFeeKrw: 0,
          unitShippingCostKrw: 0,
          unitOtherCostKrw: 0,
          unitTotalCostKrw,
          existingId: existing?.id ?? null,
          existingQuantity: existing?.quantity ?? 0,
          existingMemo: existing?.memo ?? "",
          isCalculable,
          warnings
        };
      })
      .sort((a, b) => (a.groupName ?? "").localeCompare(b.groupName ?? "") || a.productName.localeCompare(b.productName));

    const groups = Array.from(
      new Map(
        options
          .filter((option) => option.groupId)
          .map((option) => [option.groupId, { id: option.groupId, displayName: option.groupName ?? "Product Group" }])
      ).values()
    ).sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
      date: dateText,
      vendorFeePerUnitKrw,
      groups,
      options
    };
  }

  async listManualPurchases(query: { from?: string; to?: string }) {
    const range = parseDateRange(query.from, query.to);
    const rows = await this.prisma.coupangManualPurchase.findMany({
      where: { purchaseDate: { gte: range.fromDate, lte: range.toDate } },
      include: { product: { include: { group: true } }, productRule: true },
      orderBy: [{ purchaseDate: "desc" }, { productDisplayName: "asc" }]
    });
    return { period: { from: range.from, to: range.to }, rows: rows.map((row) => serializeManualPurchaseRow(row)) };
  }

  async replaceManualPurchasesForDate(dateText: string, body: Record<string, unknown>) {
    const purchaseDate = asDateOnly(dateText);
    const normalizedDate = formatDateOnly(purchaseDate);
    const entries = parseManualPurchaseEntries(body.entries);
    const productIds = uniqueNonEmpty(entries.map((entry) => entry.coupangProductId));

    return this.prisma.$transaction(async (tx) => {
      const vendorFeePerUnitKrw = manualPurchaseVendorFeeFromBody(body.vendorFeePerUnitKrw)
        ?? (await this.manualPurchaseVendorFeePerUnitKrw(tx));

      if (entries.length === 0) {
        await tx.coupangManualPurchase.deleteMany({ where: { purchaseDate } });
        return { date: normalizedDate, selectedOptionCount: 0, totalQuantity: 0, totalSalesAmountKrw: 0, totalCostKrw: 0, rows: [] };
      }

      const requestedRuleIds = uniqueNonEmpty(entries.map((entry) => entry.coupangProductRuleId ?? undefined));
      const [products, requestedRules, costRules] = await Promise.all([
        tx.coupangProduct.findMany({
          where: { id: { in: productIds } },
          include: {
            group: true,
            productRules: {
              where: {
                isActive: true,
                validFrom: { lte: purchaseDate },
                OR: [{ validTo: null }, { validTo: { gte: purchaseDate } }]
              },
              orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
            }
          }
        }),
        requestedRuleIds.length > 0
          ? tx.coupangProductRule.findMany({ where: { id: { in: requestedRuleIds } } })
          : [],
        tx.coupangCostRule.findMany({
          where: { coupangProductId: { in: productIds } },
          orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }]
        })
      ]);
      const productById = new Map(products.map((product) => [product.id, product]));
      const requestedRuleById = new Map(requestedRules.map((rule) => [rule.id, rule]));
      const costRulesByProductId = groupBy(costRules, (rule) => rule.coupangProductId);
      const data: Prisma.CoupangManualPurchaseCreateManyInput[] = [];

      for (const entry of entries) {
        const product = productById.get(entry.coupangProductId);
        if (!product) {
          throw new BadRequestException({ code: "COUPANG_PRODUCT_NOT_FOUND", message: "Coupang product was not found." });
        }
        const requestedRule = entry.coupangProductRuleId ? requestedRuleById.get(entry.coupangProductRuleId) : null;
        if (entry.coupangProductRuleId && !requestedRule) {
          throw new BadRequestException({ code: "COUPANG_PRODUCT_RULE_NOT_FOUND", message: "Coupang product rule was not found." });
        }
        if (requestedRule && requestedRule.coupangProductId !== product.id) {
          throw new BadRequestException({ code: "COUPANG_RULE_PRODUCT_MISMATCH", message: "Mapping rule belongs to another product." });
        }
        const representativeRule = requestedRule ?? product.productRules[0] ?? null;
        const costRule = findRuleForDate(costRulesByProductId.get(product.id) ?? [], purchaseDate);
        if (!costRule) {
          throw new BadRequestException({ code: "COUPANG_COST_RULE_MISSING", message: `${product.displayName} cost rule is required.` });
        }
        const baseSalePriceKrw = numberFrom(costRule.salePriceKrw);
        if (baseSalePriceKrw <= 0) {
          throw new BadRequestException({ code: "COUPANG_BASE_SALE_PRICE_REQUIRED", message: `${product.displayName} base sale price is required.` });
        }
        const calculated = calculateCoupangManualPurchaseCost({
          quantity: entry.quantity,
          vendorFeePerUnitKrw
        });
        const salesAmountKrw = baseSalePriceKrw * entry.quantity;
        for (const [field, amount] of [
          ["salesAmountKrw", salesAmountKrw],
          ["productCostKrw", calculated.productCostKrw],
          ["vendorFeePerUnitKrw", vendorFeePerUnitKrw],
          ["vendorFeeTotalKrw", calculated.vendorFeeTotalKrw],
          ["coupangSalesFeeKrw", calculated.coupangSalesFeeKrw],
          ["shippingCostKrw", calculated.shippingCostKrw],
          ["otherCostKrw", calculated.otherCostKrw],
          ["totalCostKrw", calculated.totalCostKrw]
        ] as const) {
          assertManualPurchaseStoredAmount(amount, product.id, field);
        }
        data.push({
          purchaseDate,
          coupangProductId: product.id,
          coupangProductRuleId: representativeRule?.id ?? null,
          productDisplayName: product.displayName,
          ruleDisplayName: representativeRule?.displayName ?? null,
          saleMethod: representativeRule?.saleMethod ?? null,
          quantity: entry.quantity,
          salesAmountKrw: decimal(salesAmountKrw),
          productCostKrw: decimal(calculated.productCostKrw),
          vendorFeePerUnitKrw: decimal(vendorFeePerUnitKrw),
          vendorFeeTotalKrw: decimal(calculated.vendorFeeTotalKrw),
          salePriceKrw: decimal(baseSalePriceKrw),
          baseSalePriceKrw: decimal(baseSalePriceKrw),
          promotionPriceKrw: null,
          priceSource: "BASE",
          coupangSalesFeeKrw: decimal(0),
          salesFeeRateApplied: decimal(0),
          shippingCostKrw: decimal(0),
          otherCostKrw: decimal(0),
          totalCostKrw: decimal(calculated.totalCostKrw),
          memo: entry.memo
        });
      }

      await tx.coupangManualPurchase.deleteMany({ where: { purchaseDate } });
      if (data.length > 0) {
        await tx.coupangManualPurchase.createMany({ data });
      }
      const rows = await tx.coupangManualPurchase.findMany({
        where: { purchaseDate },
        include: { product: { include: { group: true } }, productRule: true },
        orderBy: [{ productDisplayName: "asc" }]
      });
      const serializedRows = rows.map((row) => serializeManualPurchaseRow(row));
      return {
        date: normalizedDate,
        selectedOptionCount: rows.length,
        totalQuantity: rows.reduce((sum, row) => sum + row.quantity, 0),
        totalSalesAmountKrw: rows.reduce((sum, row) => sum + numberFrom(row.salesAmountKrw), 0),
        totalCostKrw: roundManualPurchaseMoney(serializedRows.reduce((sum, row) => sum + row.totalCostKrw, 0)),
        rows: serializedRows
      };
    }, COUPANG_TRANSACTION_OPTIONS);
  }

  async deleteManualPurchase(id: string) {
    const row = await this.prisma.coupangManualPurchase.findUnique({ where: { id }, select: { id: true, purchaseDate: true } });
    if (!row) {
      throw new NotFoundException({ code: "COUPANG_MANUAL_PURCHASE_NOT_FOUND", message: "Manual purchase row was not found." });
    }
    await this.prisma.coupangManualPurchase.delete({ where: { id } });
    return { id, date: formatDateOnly(row.purchaseDate), deleted: true };
  }

  private async manualPurchaseVendorFeePerUnitKrw(client: Pick<Prisma.TransactionClient, "appSetting"> = this.prisma) {
    const setting = await client.appSetting.findUnique({ where: { key: COUPANG_MANUAL_PURCHASE_VENDOR_FEE_SETTING_KEY } });
    const parsed = Number(setting?.valueJson);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COUPANG_MANUAL_PURCHASE_VENDOR_FEE_KRW;
  }

  private async normalizeSalesFeeRuleRanges(tx: Prisma.TransactionClient) {
    const rules = await tx.coupangSalesFeeRule.findMany({
      orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }]
    });
    for (let index = 0; index < rules.length; index += 1) {
      const current = rules[index];
      const next = rules[index + 1];
      if (next && next.effectiveFrom.getTime() === current.effectiveFrom.getTime()) {
        throw new BadRequestException({
          code: "COUPANG_SALES_FEE_RULE_DATE_EXISTS",
          message: "Global sales fee rules cannot share an effective start date."
        });
      }
      const effectiveTo = next ? previousDate(next.effectiveFrom) : null;
      if (dateTimesDiffer(current.effectiveTo, effectiveTo)) {
        await tx.coupangSalesFeeRule.update({ where: { id: current.id }, data: { effectiveTo } });
      }
    }
  }

  private async lockSalesFeeRuleWrites(tx: Prisma.TransactionClient) {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(7426894320158627)::text AS lock_result
    `);
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
    return {
      period: { from: range.from, to: range.to },
      groupBy,
      summary: summarizeCoupangProductProfitRows(productRows),
      rows
    };
  }

  async productProfit(query: { from?: string; to?: string; groupBy?: string }) {
    const range = parseDateRange(query.from, query.to);
    const groupBy = parseCoupangGroupBy(query.groupBy);
    const productRows = await this.buildProductProfitRows(range);
    const rows = groupBy === "group" ? await this.groupProductProfitRows(productRows) : productRows;
    return { period: { from: range.from, to: range.to }, groupBy, summary: summarizeCoupangProductProfitRows(productRows), rows };
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
    const reportRows = rows.filter(hasDailyReportActivity);
    return {
      date: query.date,
      groupBy,
      summary: summarizeCoupangProductProfitRows(productRows),
      rows: reportRows.map((row) => ({
        productName: row.productName,
        reportedSalesKrw: row.reportedSalesKrw,
        reportedNetSalesKrw: row.reportedNetSalesKrw,
        reportedSalesQuantity: row.reportedSalesQuantity,
        reportedOrderCount: row.reportedOrderCount,
        cancelAmountKrw: row.cancelAmountKrw,
        manualPurchaseSalesKrw: row.manualPurchaseSalesKrw,
        manualPurchaseQuantity: row.manualPurchaseQuantity,
        manualPurchaseProductCostKrw: row.manualPurchaseProductCostKrw,
        manualPurchaseVendorFeeKrw: row.manualPurchaseVendorFeeKrw,
        manualPurchaseCoupangSalesFeeKrw: row.manualPurchaseCoupangSalesFeeKrw,
        manualPurchaseShippingCostKrw: row.manualPurchaseShippingCostKrw,
        manualPurchaseOtherCostKrw: row.manualPurchaseOtherCostKrw,
        manualPurchaseTotalCostKrw: row.manualPurchaseTotalCostKrw,
        actualSalesKrw: row.actualSalesKrw,
        actualNetSalesKrw: row.actualNetSalesKrw,
        actualSalesQuantity: row.actualSalesQuantity,
        salePriceKrw: row.salePriceKrw,
        baseSalePriceKrw: row.baseSalePriceKrw,
        promotionPriceKrw: row.promotionPriceKrw,
        priceSource: row.priceSource,
        priceWarnings: row.priceWarnings,
        adSpendKrw: row.adSpendKrw,
        productCostKrw: row.productCostKrw,
        salesFeeKrw: row.salesFeeKrw,
        shippingCostKrw: row.shippingCostKrw,
        sellerSalesQuantity: row.sellerSalesQuantity,
        growthSalesQuantity: row.growthSalesQuantity,
        sellerShippingCostKrw: row.sellerShippingCostKrw,
        hanaroShippingCostKrw: row.hanaroShippingCostKrw,
        growthInboundCostKrw: row.growthInboundCostKrw,
        growthShippingCostKrw: row.growthShippingCostKrw,
        totalLogisticsCostKrw: row.totalLogisticsCostKrw,
        returnCostKrw: row.returnCostKrw,
        extraCostKrw: row.extraCostKrw,
        vatKrw: row.vatKrw,
        totalCostKrw: row.totalCostKrw,
        organicSalesKrw: row.organicSalesKrw,
        reportedOrganicSalesKrw: row.reportedOrganicSalesKrw,
        actualOrganicSalesKrw: row.actualOrganicSalesKrw,
        normalMarginKrw: row.normalMarginKrw,
        marginKrw: row.marginKrw,
        marginRate: row.marginRate,
        roas: row.roas,
        normalCalculationStatus: row.normalCalculationStatus,
        manualCalculationStatus: row.manualCalculationStatus,
        calculationStatus: row.calculationStatus,
        incompleteProductNames: (row.children ?? [])
          .filter((child) => child.calculationStatus === "INCOMPLETE")
          .map((child) => child.productName),
        warnings: row.warnings
      }))
    };
  }

  private async buildProductProfitRows(range: ReturnType<typeof parseDateRange>): Promise<ProductProfitRow[]> {
    const [saleLines, adMetrics, manualPurchases, salesFeeRules] = await Promise.all([
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
      }),
      this.prisma.coupangManualPurchase.findMany({
        where: {
          purchaseDate: { gte: range.fromDate, lte: range.toDate }
        },
        include: { product: true }
      }),
      this.prisma.coupangSalesFeeRule.findMany({
        where: {
          effectiveFrom: { lte: range.toDate },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: range.fromDate } }]
        },
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }]
      })
    ]);

    const productIds = uniqueNonEmpty([
      ...saleLines.map((line) => line.coupangProductId),
      ...adMetrics.map((metric) => metric.spendProductId),
      ...adMetrics.map((metric) => metric.conversionProductId),
      ...manualPurchases.map((row) => row.coupangProductId)
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
              promotionEndDate: { gte: range.fromDate },
              validationStatus: { not: RowValidationStatus.ERROR }
            },
            include: { batch: { select: { uploadedAt: true } } },
            orderBy: [{ promotionStartDate: "desc" }, { createdAt: "desc" }]
          })
        : [];
    const productById = new Map(products.map((product) => [product.id, product]));
    const costRulesByProductId = groupBy(costRules, (rule) => rule.coupangProductId);
    const promotionPricesByProductId = groupBy(promotionPrices, (promotion) => promotion.coupangProductId ?? "");
    const reportedByProductDate = aggregateReportedSalesByProductDate(
      saleLines.flatMap((line) => line.coupangProductId ? [{
        productId: line.coupangProductId,
        productName: line.product?.displayName ?? line.productName,
        date: formatDateOnly(line.saleDate ?? range.toDate),
        salesKrw: numberFrom(line.salesKrw),
        cancelAmountKrw: numberFrom(line.cancelAmountKrw),
        netSalesKrw: numberFrom(line.netSalesKrw),
        salesQuantity: numberFrom(line.salesQuantity),
        orderCount: line.orderCount,
        saleMethod: line.saleMethod,
        lineCount: 1
      }] : [])
    );
    const manualByProductDate = aggregateManualPurchasesByProductDate(
      manualPurchases.map((row) => ({
        productId: row.coupangProductId,
        date: formatDateOnly(row.purchaseDate ?? range.toDate),
        quantity: row.quantity,
        salesAmountKrw: nullableNumberFrom(row.salesAmountKrw),
        salePriceKrw: nullableNumberFrom(row.salePriceKrw),
        promotionPriceKrw: nullableNumberFrom(row.promotionPriceKrw),
        baseSalePriceKrw: nullableNumberFrom(row.baseSalePriceKrw),
        productCostKrw: nullableNumberFrom(row.productCostKrw),
        vendorFeeKrw: nullableNumberFrom(row.vendorFeeTotalKrw),
        coupangSalesFeeKrw: nullableNumberFrom(row.coupangSalesFeeKrw),
        shippingCostKrw: nullableNumberFrom(row.shippingCostKrw),
        otherCostKrw: nullableNumberFrom(row.otherCostKrw),
        totalCostKrw: nullableNumberFrom(row.totalCostKrw),
        saleMethod: row.saleMethod
      }))
    );

    const spendByProductDate = new Map<string, { productId: string; date: string; amount: number }>();
    const conversionByProductDate = new Map<string, { productId: string; date: string; salesKrw: number; quantity: number }>();
    for (const metric of adMetrics) {
      const date = formatDateOnly(metric.metricDate ?? range.toDate);
      if (metric.spendProductId) {
        const key = productDateKey(metric.spendProductId, date);
        const current = spendByProductDate.get(key) ?? { productId: metric.spendProductId, date, amount: 0 };
        current.amount += numberFrom(metric.adSpendKrw);
        spendByProductDate.set(key, current);
      }
      if (metric.conversionProductId) {
        const key = productDateKey(metric.conversionProductId, date);
        const current = conversionByProductDate.get(key) ?? { productId: metric.conversionProductId, date, salesKrw: 0, quantity: 0 };
        current.salesKrw += numberFrom(metric.totalConversionSales1dKrw);
        current.quantity += numberFrom(metric.totalSalesQuantity1d);
        conversionByProductDate.set(key, current);
      }
    }

    const allProductDateKeys = new Set([
      ...reportedByProductDate.keys(),
      ...manualByProductDate.keys(),
      ...spendByProductDate.keys(),
      ...conversionByProductDate.keys()
    ]);
    const dailyRows: ProductProfitRow[] = Array.from(allProductDateKeys).map((key) => {
        const reportedEntry = reportedByProductDate.get(key);
        const manual = manualByProductDate.get(key) ?? null;
        const spendEntry = spendByProductDate.get(key);
        const conversionEntry = conversionByProductDate.get(key);
        const productId = reportedEntry?.productId ?? manual?.productId ?? spendEntry?.productId ?? conversionEntry?.productId ?? "";
        const dateText = reportedEntry?.date ?? manual?.date ?? spendEntry?.date ?? conversionEntry?.date ?? range.to;
        const date = asDateOnly(dateText);
        const productName = productById.get(productId)?.displayName ?? reportedEntry?.productName ?? "Coupang Product";
        const reported = reportedEntry ?? emptyReportedSalesFacts(productId, dateText, productName);
        const conversion = conversionEntry ?? { productId, date: dateText, salesKrw: 0, quantity: 0 };
        const adSpendKrw = spendEntry?.amount ?? 0;
        const costRule = findRuleForDate(costRulesByProductId.get(productId) ?? [], date);
        const salesFeeRule = findSalesFeeRuleForDate(salesFeeRules, date);
        const resolvedPrice = resolveCoupangSalePrice({
          baseSalePriceKrw: costRule ? numberFrom(costRule.salePriceKrw) : null,
          promotions: (promotionPricesByProductId.get(productId) ?? []).map((promotion) => ({
            promotionPriceKrw: numberFrom(promotion.promotionPriceKrw),
            promotionStartDate: promotion.promotionStartDate,
            promotionEndDate: promotion.promotionEndDate,
            promotionStatus: promotion.promotionStatus,
            validationErrors: promotion.validationErrors
          })),
          date
        });
        const actual = adjustReportedSalesForManualPurchase(reported, manual);
        const normalAttempt = calculateNormalCoupangProfit({
          reported,
          actual,
          cost: costRule ? costInput(costRule) : null,
          ads: {
            adSpendKrw,
            adConversionSalesKrw: conversion.salesKrw,
            adConversionQuantity: conversion.quantity
          },
          salesFeeRate: salesFeeRule ? numberFrom(salesFeeRule.salesFeeRate) : null
        });
        const normalReference = actual.isValid
          ? normalAttempt
          : calculateNormalCoupangProfit({
              reported,
              actual: {
                salesKrw: reported.salesKrw,
                netSalesKrw: reported.netSalesKrw,
                salesQuantity: reported.salesQuantity,
                orderCount: reported.orderCount,
                segments: reported.segments,
                warnings: [],
                isValid: true,
                isManualOnly: false
              },
              cost: costRule ? costInput(costRule) : null,
              ads: {
                adSpendKrw,
                adConversionSalesKrw: conversion.salesKrw,
                adConversionQuantity: conversion.quantity
              },
              salesFeeRate: salesFeeRule ? numberFrom(salesFeeRule.salesFeeRate) : null
            });
        const normal = actual.isValid
          ? normalAttempt
          : { ...normalReference, calculated: null };
        const initialManualPart = calculateManualPurchaseProfitAdjustment(manual);
        const manualPart = manual && !actual.isValid
          ? { ...initialManualPart, status: "INCOMPLETE" as const, marginAdjustmentKrw: null }
          : initialManualPart;
        const combined = combineCoupangProfitParts({ normal, manual: manualPart });
        const actualOrganicSalesKrw = actual.netSalesKrw === null ? null : actual.netSalesKrw - conversion.salesKrw;
        const reportedOrganicSalesKrw = reported.netSalesKrw - conversion.salesKrw;
        const displaySaleMethods = uniqueNonEmpty([...reported.saleMethods, ...(manual?.saleMethods ?? [])]);
        const requiresNormalCostRule = hasCoupangSalesSegmentActivity(actual.segments);
        const dailyComplete = combined.calculationStatus === "COMPLETE";
        return {
          productId,
          productName,
          saleMethod: displaySaleMethods.length > 1 ? "MIXED" : displaySaleMethods[0] ?? null,
          matchedSalesLineCount: reported.lineCount,
          reportedSalesQuantity: reported.salesQuantity,
          reportedOrderCount: reported.orderCount,
          reportedSalesKrw: reported.salesKrw,
          reportedNetSalesKrw: reported.netSalesKrw,
          salesQuantity: actual.salesQuantity,
          orderCount: actual.orderCount,
          salesKrw: actual.salesKrw,
          cancelAmountKrw: reported.cancelAmountKrw,
          netSalesKrw: actual.netSalesKrw,
          salePriceKrw: resolvedPrice.salePriceKrw,
          baseSalePriceKrw: resolvedPrice.baseSalePriceKrw,
          promotionPriceKrw: resolvedPrice.promotionPriceKrw,
          priceSource: resolvedPrice.priceSource,
          priceWarnings: resolvedPrice.priceWarnings,
          productCostKrw: normal.calculated?.productCostKrw ?? null,
          salesFeeKrw: normal.calculated?.salesFeeKrw ?? null,
          shippingCostKrw: normal.calculated?.shippingCostKrw ?? null,
          sellerSalesQuantity: actual.segments.find((segment) => segment.fulfillmentMethod === "SELLER")?.salesQuantity ?? 0,
          growthSalesQuantity: actual.segments.find((segment) => segment.fulfillmentMethod === "GROWTH")?.salesQuantity ?? 0,
          sellerShippingCostKrw: normal.calculated?.sellerShippingCostKrw ?? null,
          hanaroShippingCostKrw: normal.calculated?.hanaroShippingCostKrw ?? null,
          growthInboundCostKrw: normal.calculated?.growthInboundCostKrw ?? null,
          growthShippingCostKrw: normal.calculated?.growthShippingCostKrw ?? null,
          totalLogisticsCostKrw: normal.calculated?.totalLogisticsCostKrw ?? null,
          returnCostKrw: normal.calculated?.returnCostKrw ?? null,
          extraCostKrw: normal.calculated?.extraCostKrw ?? null,
          vatKrw: normal.calculated?.vatKrw ?? null,
          manualPurchaseSalesKrw: manual ? manual.salesAmountKrw : 0,
          manualPurchaseQuantity: manual?.quantity ?? 0,
          manualPurchaseProductCostKrw: manual ? manual.productCostKrw : 0,
          manualPurchaseVendorFeeKrw: manual ? manual.vendorFeeKrw : 0,
          manualPurchaseCoupangSalesFeeKrw: manual ? manual.coupangSalesFeeKrw : 0,
          manualPurchaseShippingCostKrw: manual ? manual.shippingCostKrw : 0,
          manualPurchaseOtherCostKrw: manual ? manual.otherCostKrw : 0,
          manualPurchaseTotalCostKrw: manual ? manual.totalCostKrw : 0,
          actualSalesKrw: actual.salesKrw,
          actualNetSalesKrw: actual.netSalesKrw,
          actualSalesQuantity: actual.salesQuantity,
          normalCalculationStatus: normal.status,
          manualCalculationStatus: manualPart.status,
          calculationStatus: combined.calculationStatus,
          adSpendKrw,
          adConversionSalesKrw: conversion.salesKrw,
          adConversionQuantity: conversion.quantity,
          organicSalesKrw: actualOrganicSalesKrw,
          reportedOrganicSalesKrw,
          actualOrganicSalesKrw,
          normalMarginKrw: normalAttempt.calculated?.marginKrw ?? normalReference.calculated?.marginKrw ?? null,
          totalCostKrw: combined.totalCostKrw,
          marginKrw: combined.marginKrw,
          knownTotalCostKrw: dailyComplete ? combined.totalCostKrw ?? 0 : 0,
          knownMarginKrw: dailyComplete ? combined.marginKrw ?? 0 : 0,
          completeProductCount: dailyComplete ? 1 : 0,
          incompleteProductCount: dailyComplete ? 0 : 1,
          excludedNetSalesKrw: dailyComplete
            ? 0
            : (actual.isValid ? actual.netSalesKrw ?? reported.netSalesKrw : reported.netSalesKrw),
          excludedSalesQuantity: dailyComplete
            ? 0
            : (actual.isValid ? actual.salesQuantity ?? reported.salesQuantity : reported.salesQuantity),
          incompleteNormalCount: normal.status === "INCOMPLETE" ? 1 : 0,
          incompleteManualCount: manualPart.status === "INCOMPLETE" ? 1 : 0,
          marginRate: combined.marginKrw === null || actual.netSalesKrw === null ? null : safeDivide(combined.marginKrw, actual.netSalesKrw),
          roas: safeDivide(conversion.salesKrw, adSpendKrw),
          warnings: uniqueNonEmpty([
            ...actual.warnings,
            ...normal.warnings,
            ...manualPart.warnings,
            ...resolvedPrice.priceWarnings,
            ...(actualOrganicSalesKrw !== null && actualOrganicSalesKrw < 0 ? ["AD_CONVERSION_EXCEEDS_NET_SALES"] : [])
          ]),
          ruleStatus: !costRule && requiresNormalCostRule ? "MISSING_COST_RULE" as const : "OK" as const
        };
      });
    const dailyRowsByProductId = groupBy(dailyRows, (row) => row.productId);
    return Array.from(dailyRowsByProductId.values())
      .map(aggregateCoupangProductDateRows)
      .sort((a, b) => compareNullableNumbersDesc(a.actualNetSalesKrw, b.actualNetSalesKrw) || a.productName.localeCompare(b.productName));
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

  private async findCoupangCostRuleAtOrBeforeDate(tx: Prisma.TransactionClient, coupangProductId: string, date: Date) {
    return tx.coupangCostRule.findFirst({
      where: { coupangProductId, effectiveFrom: { lte: date } },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }]
    });
  }

  private async findCoupangCostRuleStartingOnDate(tx: Prisma.TransactionClient, coupangProductId: string, date: Date) {
    return tx.coupangCostRule.findFirst({
      where: { coupangProductId, effectiveFrom: date },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
  }

  private async lockCoupangCostRuleWrites(tx: Prisma.TransactionClient, coupangProductId: string) {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`coupang-cost-rule:${coupangProductId}`}, 0)
      )::text AS lock_result
    `);
  }

  private async lockCoupangCostRuleBulkWrites(tx: Prisma.TransactionClient) {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(7426894320158628)::text AS lock_result
    `);
  }

  private async normalizeCoupangCostRuleRanges(tx: Prisma.TransactionClient, coupangProductId: string) {
    const rules = await tx.coupangCostRule.findMany({
      where: { coupangProductId },
      orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }]
    });
    for (let index = 0; index < rules.length; index += 1) {
      const current = rules[index];
      const next = rules[index + 1];
      if (next && next.effectiveFrom.getTime() === current.effectiveFrom.getTime()) {
        throw new BadRequestException({
          code: "COUPANG_COST_RULE_DATE_EXISTS",
          message: "Cost rules for a product cannot share an effective start date."
        });
      }
      const effectiveTo = next ? previousDate(next.effectiveFrom) : null;
      if (dateTimesDiffer(current.effectiveTo, effectiveTo)) {
        await tx.coupangCostRule.update({ where: { id: current.id }, data: { effectiveTo } });
      }
    }
  }

  private async upsertImportedCoupangCostRule(
    tx: Prisma.TransactionClient,
    coupangProductId: string,
    effectiveFrom: Date,
    buildData: (baseRule: CoupangCostRuleSnapshot | null) =>
      Prisma.CoupangCostRuleUncheckedCreateInput | Promise<Prisma.CoupangCostRuleUncheckedCreateInput>
  ) {
    await this.lockCoupangCostRuleWrites(tx, coupangProductId);
    const existing = await this.findCoupangCostRuleStartingOnDate(tx, coupangProductId, effectiveFrom);
    const baseRule = existing ?? await this.findCoupangCostRuleAtOrBeforeDate(tx, coupangProductId, effectiveFrom);
    const data = await buildData(baseRule);
    const before = existing ? serializeCoupangCostRuleRollbackSnapshot(existing) : null;
    const saved = existing
      ? await tx.coupangCostRule.update({ where: { id: existing.id }, data })
      : await tx.coupangCostRule.create({ data });
    await this.normalizeCoupangCostRuleRanges(tx, coupangProductId);
    const rule = await tx.coupangCostRule.findUniqueOrThrow({ where: { id: saved.id } });
    return {
      operation: existing ? "UPDATED_SAME_DATE" as const : "CREATED" as const,
      rule,
      before,
      after: serializeCoupangCostRuleRollbackSnapshot(rule)
    };
  }

  private async rollbackImportedCoupangCostRules(
    tx: Prisma.TransactionClient,
    appliedRows: Array<CoupangPriceTextAppliedRow | CoupangMarginAppliedRow>
  ) {
    const productIds = uniqueNonEmpty(appliedRows.map((row) => row.productId)).sort();
    for (const productId of productIds) await this.lockCoupangCostRuleWrites(tx, productId);
    for (const applied of [...appliedRows].reverse()) {
      const current = await tx.coupangCostRule.findUnique({ where: { id: applied.costRuleId } });
      if (!current || current.coupangProductId !== applied.productId
        || !sameCoupangCostRuleRollbackSnapshot(current, applied.costRuleAfter)) {
        throw new BadRequestException({
          code: "COUPANG_UPLOAD_ROLLBACK_ORDER_CONFLICT",
          message: "A newer cost change exists. Delete newer uploads or corrections before deleting this upload."
        });
      }
      if (applied.costRuleOperation === "UPDATED_SAME_DATE") {
        if (!current || !applied.costRuleBefore) throw new BadRequestException({
          code: "COUPANG_UPLOAD_ROLLBACK_SNAPSHOT_MISSING",
          message: "The previous cost snapshot required for rollback is missing."
        });
        await tx.coupangCostRule.update({
          where: { id: applied.costRuleId },
          data: deserializeCoupangCostRuleRollbackSnapshot(applied.costRuleBefore)
        });
      } else if (current) {
        await tx.coupangCostRule.delete({ where: { id: applied.costRuleId } });
      }
    }
    for (const productId of productIds) await this.normalizeCoupangCostRuleRanges(tx, productId);
  }

  private async findLegacyPriceTextCostRule(
    tx: Prisma.TransactionClient,
    input: { rawLine: string; itemName: string; productId: string; effectiveFrom: Date }
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

    return this.findCoupangCostRuleAtOrBeforeDate(tx, legacyProduct.id, input.effectiveFrom);
  }

  private async deletePriceTextUploadEffects(
    tx: Prisma.TransactionClient,
    appliedRows: CoupangPriceTextAppliedRow[]
  ) {
    const productIds = uniqueNonEmpty(appliedRows.map((row) => row.productId));

    await this.rollbackImportedCoupangCostRules(tx, appliedRows);

    for (const productId of productIds) {
      await this.deleteCoupangProductIfUnused(tx, productId);
    }
  }

  private async deleteMarginUploadEffects(
    tx: Prisma.TransactionClient,
    appliedRows: CoupangMarginAppliedRow[]
  ) {
    const createdProductRuleIds = uniqueNonEmpty(
      appliedRows.filter((row) => row.productRuleCreated).map((row) => row.productRuleId)
    );
    const productIds = uniqueNonEmpty(appliedRows.map((row) => row.productId));

    await this.rollbackImportedCoupangCostRules(tx, appliedRows);
    if (createdProductRuleIds.length > 0) {
      const referencedManualPurchaseRules = await tx.coupangManualPurchase.findMany({
        where: { coupangProductRuleId: { in: createdProductRuleIds } },
        select: { coupangProductRuleId: true }
      });
      const referencedRuleIds = new Set(uniqueNonEmpty(referencedManualPurchaseRules.map((row) => row.coupangProductRuleId)));
      const deleteRuleIds = createdProductRuleIds.filter((id) => !referencedRuleIds.has(id));
      const deactivateRuleIds = createdProductRuleIds.filter((id) => referencedRuleIds.has(id));
      if (deleteRuleIds.length > 0) {
        await tx.coupangProductRule.deleteMany({ where: { id: { in: deleteRuleIds } } });
      }
      if (deactivateRuleIds.length > 0) {
        await tx.coupangProductRule.updateMany({ where: { id: { in: deactivateRuleIds } }, data: { isActive: false } });
      }
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
            manualPurchases: true,
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

  private async buildCoupangProductSettingUpdateData(
    client: Pick<Prisma.TransactionClient, "coupangProductGroup">,
    body: Record<string, unknown>
  ): Promise<Prisma.CoupangProductUpdateInput> {
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
        const group = await client.coupangProductGroup.findUnique({ where: { id: groupId } });
        if (!group) {
          throw new NotFoundException({ code: "COUPANG_PRODUCT_GROUP_NOT_FOUND", message: "Coupang product group was not found." });
        }
        productData.group = { connect: { id: groupId } };
      } else {
        productData.group = { disconnect: true };
      }
    }
    return productData;
  }

  private async upsertPrimaryCoupangProductRule(tx: Prisma.TransactionClient, productId: string, body: Record<string, unknown>) {
    const hasRuleFields =
      body.mappingRuleId !== undefined ||
      body.includeKeywords !== undefined ||
      body.excludeKeywords !== undefined ||
      body.priority !== undefined;
    if (!hasRuleFields) {
      return;
    }

    const includeKeywords =
      body.includeKeywords !== undefined ? requiredStringArray(body.includeKeywords, "includeKeywords") : undefined;
    const ruleId = optionalString(body.mappingRuleId);
    const existing = ruleId
      ? await tx.coupangProductRule.findUnique({ where: { id: ruleId } })
      : await tx.coupangProductRule.findFirst({
          where: { coupangProductId: productId, isActive: true },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
        });

    if (ruleId && !existing) {
      throw new NotFoundException({ code: "COUPANG_MAPPING_RULE_NOT_FOUND", message: "Coupang mapping rule was not found." });
    }
    if (existing && existing.coupangProductId !== productId) {
      throw new BadRequestException({
        code: "COUPANG_RULE_PRODUCT_MISMATCH",
        message: "Mapping rule belongs to another product."
      });
    }

    if (existing) {
      await tx.coupangProductRule.update({
        where: { id: existing.id },
        data: {
          displayName: body.displayName !== undefined ? requiredString(body.displayName, "displayName") : undefined,
          includeKeywords,
          excludeKeywords: body.excludeKeywords !== undefined ? stringArray(body.excludeKeywords) ?? [] : undefined,
          priority: body.priority !== undefined ? numberOrDefault(body.priority, 100) : undefined,
          isActive: true
        }
      });
      return;
    }

    if (!includeKeywords || includeKeywords.length === 0) {
      return;
    }

    await tx.coupangProductRule.create({
      data: {
        coupangProductId: productId,
        displayName: optionalString(body.displayName) ?? "매칭 규칙",
        includeKeywords,
        excludeKeywords: stringArray(body.excludeKeywords) ?? [],
        priority: numberOrDefault(body.priority, 100),
        adEnabled: true,
        isActive: true
      }
    });
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
    .sort((a, b) => compareNullableNumbersDesc(a.actualNetSalesKrw, b.actualNetSalesKrw) || a.productName.localeCompare(b.productName));
}

export function hasDailyReportActivity(row: ProductProfitRow) {
  return (
    row.reportedSalesKrw !== 0 ||
    row.reportedNetSalesKrw !== 0 ||
    row.reportedSalesQuantity !== 0 ||
    row.reportedOrderCount !== 0 ||
    row.cancelAmountKrw !== 0 ||
    (row.actualSalesKrw !== null && row.actualSalesKrw !== 0) ||
    (row.actualNetSalesKrw !== null && row.actualNetSalesKrw !== 0) ||
    row.actualSalesQuantity !== 0 ||
    row.salesQuantity !== 0 ||
    row.orderCount !== 0 ||
    row.adSpendKrw !== 0 ||
    row.adConversionSalesKrw !== 0 ||
    row.adConversionQuantity !== 0 ||
    row.manualPurchaseQuantity !== 0 ||
    row.manualPurchaseSalesKrw !== 0 ||
    row.manualPurchaseTotalCostKrw !== 0 ||
    row.calculationStatus === "INCOMPLETE" ||
    row.warnings.length > 0
  );
}

function aggregateCoupangProductProfitGroup(
  group: { id: string; displayName: string },
  rows: ProductProfitRow[]
): ProductProfitRow {
  const children = rows.map(({ children: _children, ...row }) => ({ ...row, rowType: "PRODUCT" as const }));
  const matchedSalesLineCount = sumNumbers(rows.map((row) => row.matchedSalesLineCount));
  const reportedSalesQuantity = sumNumbers(rows.map((row) => row.reportedSalesQuantity));
  const reportedOrderCount = sumNumbers(rows.map((row) => row.reportedOrderCount));
  const reportedSalesKrw = sumNumbers(rows.map((row) => row.reportedSalesKrw));
  const reportedNetSalesKrw = sumNumbers(rows.map((row) => row.reportedNetSalesKrw));
  const actualSalesQuantity = strictSumNullable(rows.map((row) => row.actualSalesQuantity));
  const actualSalesKrw = strictSumNullable(rows.map((row) => row.actualSalesKrw));
  const actualNetSalesKrw = strictSumNullable(rows.map((row) => row.actualNetSalesKrw));
  const orderCount = sumNumbers(rows.map((row) => row.orderCount));
  const cancelAmountKrw = sumNumbers(rows.map((row) => row.cancelAmountKrw));
  const productCostKrw = strictSumNullable(rows.map((row) => row.productCostKrw));
  const salesFeeKrw = strictSumNullable(rows.map((row) => row.salesFeeKrw));
  const shippingCostKrw = strictSumNullable(rows.map((row) => row.shippingCostKrw));
  const sellerSalesQuantity = sumNumbers(rows.map((row) => row.sellerSalesQuantity));
  const growthSalesQuantity = sumNumbers(rows.map((row) => row.growthSalesQuantity));
  const sellerShippingCostKrw = strictSumNullable(rows.map((row) => row.sellerShippingCostKrw));
  const hanaroShippingCostKrw = strictSumNullable(rows.map((row) => row.hanaroShippingCostKrw));
  const growthInboundCostKrw = strictSumNullable(rows.map((row) => row.growthInboundCostKrw));
  const growthShippingCostKrw = strictSumNullable(rows.map((row) => row.growthShippingCostKrw));
  const totalLogisticsCostKrw = strictSumNullable(rows.map((row) => row.totalLogisticsCostKrw));
  const returnCostKrw = strictSumNullable(rows.map((row) => row.returnCostKrw));
  const extraCostKrw = strictSumNullable(rows.map((row) => row.extraCostKrw));
  const vatKrw = strictSumNullable(rows.map((row) => row.vatKrw));
  const manualPurchaseSalesKrw = strictSumNullable(rows.map((row) => row.manualPurchaseSalesKrw));
  const manualPurchaseQuantity = sumNumbers(rows.map((row) => row.manualPurchaseQuantity));
  const manualPurchaseProductCostKrw = strictSumNullable(rows.map((row) => row.manualPurchaseProductCostKrw));
  const manualPurchaseVendorFeeKrw = strictSumNullable(rows.map((row) => row.manualPurchaseVendorFeeKrw));
  const manualPurchaseCoupangSalesFeeKrw = strictSumNullable(rows.map((row) => row.manualPurchaseCoupangSalesFeeKrw));
  const manualPurchaseShippingCostKrw = strictSumNullable(rows.map((row) => row.manualPurchaseShippingCostKrw));
  const manualPurchaseOtherCostKrw = strictSumNullable(rows.map((row) => row.manualPurchaseOtherCostKrw));
  const manualPurchaseTotalCostKrw = strictSumNullable(rows.map((row) => row.manualPurchaseTotalCostKrw));
  const adSpendKrw = sumNumbers(rows.map((row) => row.adSpendKrw));
  const adConversionSalesKrw = sumNumbers(rows.map((row) => row.adConversionSalesKrw));
  const adConversionQuantity = sumNumbers(rows.map((row) => row.adConversionQuantity));
  const organicSalesKrw = strictSumNullable(rows.map((row) => row.organicSalesKrw));
  const reportedOrganicSalesKrw = sumNumbers(rows.map((row) => row.reportedOrganicSalesKrw));
  const actualOrganicSalesKrw = strictSumNullable(rows.map((row) => row.actualOrganicSalesKrw));
  const normalMarginKrw = strictSumNullable(rows.map((row) => row.normalMarginKrw));
  const totalCostKrw = strictSumNullable(rows.map((row) => row.totalCostKrw));
  const marginKrw = strictSumNullable(rows.map((row) => row.marginKrw));
  const calculationStatus = rows.every((row) => row.calculationStatus === "COMPLETE") ? "COMPLETE" as const : "INCOMPLETE" as const;
  const normalCalculationStatus = aggregateCalculationPartStatus(rows.map((row) => row.normalCalculationStatus));
  const manualCalculationStatus = aggregateCalculationPartStatus(rows.map((row) => row.manualCalculationStatus));
  const knownTotalCostKrw = sumNumbers(rows.map((row) => row.knownTotalCostKrw));
  const knownMarginKrw = sumNumbers(rows.map((row) => row.knownMarginKrw));
  const completeProductCount = sumNumbers(rows.map((row) => row.completeProductCount));
  const incompleteProductCount = sumNumbers(rows.map((row) => row.incompleteProductCount));
  const excludedNetSalesKrw = sumNumbers(rows.map((row) => row.excludedNetSalesKrw));
  const excludedSalesQuantity = sumNumbers(rows.map((row) => row.excludedSalesQuantity));
  const incompleteNormalCount = sumNumbers(rows.map((row) => row.incompleteNormalCount));
  const incompleteManualCount = sumNumbers(rows.map((row) => row.incompleteManualCount));
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
    reportedSalesQuantity,
    reportedOrderCount,
    reportedSalesKrw,
    reportedNetSalesKrw,
    salesQuantity: actualSalesQuantity,
    orderCount,
    salesKrw: actualSalesKrw,
    cancelAmountKrw,
    netSalesKrw: actualNetSalesKrw,
    salePriceKrw: priceMixed ? null : salePriceKrw ?? null,
    baseSalePriceKrw: priceMixed ? null : baseSalePriceKrw ?? null,
    promotionPriceKrw: priceMixed ? null : promotionPriceKrw ?? null,
    priceSource: (priceMixed ? "MIXED" : priceSources[0] ?? "MISSING") as ProductProfitRow["priceSource"],
    priceWarnings: uniqueNonEmpty([...rows.flatMap((row) => row.priceWarnings), ...(priceMixed ? ["GROUP_MIXED_PRICE"] : [])]),
    productCostKrw,
    salesFeeKrw,
    shippingCostKrw,
    sellerSalesQuantity,
    growthSalesQuantity,
    sellerShippingCostKrw,
    hanaroShippingCostKrw,
    growthInboundCostKrw,
    growthShippingCostKrw,
    totalLogisticsCostKrw,
    returnCostKrw,
    extraCostKrw,
    vatKrw,
    manualPurchaseSalesKrw,
    manualPurchaseQuantity,
    manualPurchaseProductCostKrw,
    manualPurchaseVendorFeeKrw,
    manualPurchaseCoupangSalesFeeKrw,
    manualPurchaseShippingCostKrw,
    manualPurchaseOtherCostKrw,
    manualPurchaseTotalCostKrw,
    actualSalesKrw,
    actualNetSalesKrw,
    actualSalesQuantity,
    normalCalculationStatus,
    manualCalculationStatus,
    calculationStatus,
    adSpendKrw,
    adConversionSalesKrw,
    adConversionQuantity,
    organicSalesKrw,
    reportedOrganicSalesKrw,
    actualOrganicSalesKrw,
    normalMarginKrw,
    totalCostKrw,
    marginKrw,
    knownTotalCostKrw,
    knownMarginKrw,
    completeProductCount,
    incompleteProductCount,
    excludedNetSalesKrw,
    excludedSalesQuantity,
    incompleteNormalCount,
    incompleteManualCount,
    marginRate: marginKrw === null || actualNetSalesKrw === null ? null : safeDivide(marginKrw, actualNetSalesKrw),
    roas: safeDivide(adConversionSalesKrw, adSpendKrw),
    warnings: uniqueNonEmpty([...rows.flatMap((row) => row.warnings), ...groupWarnings]),
    ruleStatus: hasUnmatched ? "UNMATCHED" : hasMissingCostRule ? "MISSING_COST_RULE" : "OK"
  };
}

function aggregateCoupangProductDateRows(rows: ProductProfitRow[]): ProductProfitRow {
  if (rows.length === 1) return rows[0];
  const first = rows[0];
  const aggregated = aggregateCoupangProductProfitGroup({ id: first.productId, displayName: first.productName }, rows);
  const isComplete = aggregated.calculationStatus === "COMPLETE";
  const priceMixed = aggregated.priceSource === "MIXED";
  return {
    ...aggregated,
    rowType: "PRODUCT",
    productId: first.productId,
    productName: first.productName,
    groupId: undefined,
    groupName: undefined,
    childProductCount: undefined,
    children: undefined,
    priceWarnings: uniqueNonEmpty([
      ...rows.flatMap((row) => row.priceWarnings),
      ...(priceMixed ? ["RANGE_MIXED_PRICE"] : [])
    ]),
    warnings: uniqueNonEmpty(rows.flatMap((row) => row.warnings)),
    knownTotalCostKrw: isComplete ? aggregated.totalCostKrw ?? 0 : 0,
    knownMarginKrw: isComplete ? aggregated.marginKrw ?? 0 : 0,
    completeProductCount: isComplete ? 1 : 0,
    incompleteProductCount: isComplete ? 0 : 1,
    excludedNetSalesKrw: isComplete ? 0 : sumNumbers(rows.map((row) =>
      row.calculationStatus === "INCOMPLETE"
        ? row.excludedNetSalesKrw
        : row.actualNetSalesKrw ?? row.reportedNetSalesKrw
    )),
    excludedSalesQuantity: isComplete ? 0 : sumNumbers(rows.map((row) =>
      row.calculationStatus === "INCOMPLETE"
        ? row.excludedSalesQuantity
        : row.actualSalesQuantity ?? row.reportedSalesQuantity
    )),
    incompleteNormalCount: aggregated.normalCalculationStatus === "INCOMPLETE" ? 1 : 0,
    incompleteManualCount: aggregated.manualCalculationStatus === "INCOMPLETE" ? 1 : 0
  };
}

function aggregateCalculationPartStatus(statuses: CoupangCalculationPartStatus[]): CoupangCalculationPartStatus {
  if (statuses.some((status) => status === "INCOMPLETE")) return "INCOMPLETE";
  if (statuses.some((status) => status === "COMPLETE")) return "COMPLETE";
  return "NOT_APPLICABLE";
}

export function summarizeCoupangProductProfitRows(rows: ProductProfitRow[]) {
  const reportedSalesKrw = sumNumbers(rows.map((row) => row.reportedSalesKrw));
  const reportedNetSalesKrw = sumNumbers(rows.map((row) => row.reportedNetSalesKrw));
  const reportedSalesQuantity = sumNumbers(rows.map((row) => row.reportedSalesQuantity));
  const reportedOrderCount = sumNumbers(rows.map((row) => row.reportedOrderCount));
  const cancelAmountKrw = sumNumbers(rows.map((row) => row.cancelAmountKrw));
  const actualSalesKrw = strictSumNullable(rows.map((row) => row.actualSalesKrw));
  const actualNetSalesKrw = strictSumNullable(rows.map((row) => row.actualNetSalesKrw));
  const actualSalesQuantity = strictSumNullable(rows.map((row) => row.actualSalesQuantity));
  const manualPurchaseSalesKrw = strictSumNullable(rows.map((row) => row.manualPurchaseSalesKrw));
  const productCostKrw = strictSumNullable(rows.map((row) => row.productCostKrw));
  const salesFeeKrw = strictSumNullable(rows.map((row) => row.salesFeeKrw));
  const shippingCostKrw = strictSumNullable(rows.map((row) => row.shippingCostKrw));
  const sellerSalesQuantity = sumNumbers(rows.map((row) => row.sellerSalesQuantity));
  const growthSalesQuantity = sumNumbers(rows.map((row) => row.growthSalesQuantity));
  const sellerShippingCostKrw = strictSumNullable(rows.map((row) => row.sellerShippingCostKrw));
  const hanaroShippingCostKrw = strictSumNullable(rows.map((row) => row.hanaroShippingCostKrw));
  const growthInboundCostKrw = strictSumNullable(rows.map((row) => row.growthInboundCostKrw));
  const growthShippingCostKrw = strictSumNullable(rows.map((row) => row.growthShippingCostKrw));
  const totalLogisticsCostKrw = strictSumNullable(rows.map((row) => row.totalLogisticsCostKrw));
  const returnCostKrw = strictSumNullable(rows.map((row) => row.returnCostKrw));
  const extraCostKrw = strictSumNullable(rows.map((row) => row.extraCostKrw));
  const vatKrw = strictSumNullable(rows.map((row) => row.vatKrw));
  const organicSalesKrw = strictSumNullable(rows.map((row) => row.organicSalesKrw));
  const reportedOrganicSalesKrw = sumNumbers(rows.map((row) => row.reportedOrganicSalesKrw));
  const actualOrganicSalesKrw = strictSumNullable(rows.map((row) => row.actualOrganicSalesKrw));
  const normalMarginKrw = strictSumNullable(rows.map((row) => row.normalMarginKrw));
  const totalCostKrw = strictSumNullable(rows.map((row) => row.totalCostKrw));
  const marginKrw = strictSumNullable(rows.map((row) => row.marginKrw));
  const adSpendKrw = sumNumbers(rows.map((row) => row.adSpendKrw));
  const adConversionSalesKrw = sumNumbers(rows.map((row) => row.adConversionSalesKrw));
  const completeRows = rows.filter((row) =>
    row.calculationStatus === "COMPLETE" && Number.isFinite(row.marginKrw) && Number.isFinite(row.totalCostKrw)
  );
  const completeRowSet = new Set(completeRows);
  const incompleteRows = rows.filter((row) => !completeRowSet.has(row));
  const incompleteCalculationCount = incompleteRows.length;
  const isComplete = incompleteCalculationCount === 0;
  const knownMarginKrw = sumNumbers(completeRows.map((row) => Number(row.marginKrw)));
  const knownTotalCostKrw = sumNumbers(completeRows.map((row) => Number(row.totalCostKrw)));
  const excludedNetSalesKrw = sumNumbers(incompleteRows.map((row) => row.excludedNetSalesKrw));
  const excludedSalesQuantity = sumNumbers(incompleteRows.map((row) => row.excludedSalesQuantity));

  return {
    isComplete,
    reportedSalesKrw,
    reportedNetSalesKrw,
    reportedSalesQuantity,
    reportedOrderCount,
    cancelAmountKrw,
    manualPurchaseSalesKrw,
    manualPurchaseQuantity: sumNumbers(rows.map((row) => row.manualPurchaseQuantity)),
    manualPurchaseProductCostKrw: strictSumNullable(rows.map((row) => row.manualPurchaseProductCostKrw)),
    manualPurchaseVendorFeeKrw: strictSumNullable(rows.map((row) => row.manualPurchaseVendorFeeKrw)),
    manualPurchaseCoupangSalesFeeKrw: strictSumNullable(rows.map((row) => row.manualPurchaseCoupangSalesFeeKrw)),
    manualPurchaseShippingCostKrw: strictSumNullable(rows.map((row) => row.manualPurchaseShippingCostKrw)),
    manualPurchaseOtherCostKrw: strictSumNullable(rows.map((row) => row.manualPurchaseOtherCostKrw)),
    manualPurchaseTotalCostKrw: strictSumNullable(rows.map((row) => row.manualPurchaseTotalCostKrw)),
    actualSalesKrw,
    actualNetSalesKrw,
    actualSalesQuantity,
    salesKrw: actualSalesKrw,
    netSalesKrw: actualNetSalesKrw,
    salesQuantity: actualSalesQuantity,
    productCostKrw,
    salesFeeKrw,
    shippingCostKrw,
    sellerSalesQuantity,
    growthSalesQuantity,
    sellerShippingCostKrw,
    hanaroShippingCostKrw,
    growthInboundCostKrw,
    growthShippingCostKrw,
    totalLogisticsCostKrw,
    returnCostKrw,
    extraCostKrw,
    vatKrw,
    adSpendKrw,
    adConversionSalesKrw,
    organicSalesKrw,
    reportedOrganicSalesKrw,
    actualOrganicSalesKrw,
    normalMarginKrw,
    totalCostKrw,
    marginKrw,
    knownMarginKrw,
    knownTotalCostKrw,
    completeProductCount: completeRows.length,
    incompleteProductCount: incompleteRows.length,
    excludedNetSalesKrw,
    excludedSalesQuantity,
    incompleteNormalCount: rows.filter((row) => row.normalCalculationStatus === "INCOMPLETE").length,
    incompleteManualCount: rows.filter((row) => row.manualCalculationStatus === "INCOMPLETE").length,
    marginRate: marginKrw === null || actualNetSalesKrw === null ? null : safeDivide(marginKrw, actualNetSalesKrw),
    roas: safeDivide(adConversionSalesKrw, adSpendKrw),
    adSpendRatio: actualNetSalesKrw === null ? null : safeDivide(adSpendKrw, actualNetSalesKrw),
    incompleteCalculationCount,
    missingCostRuleCount: rows.filter((row) => row.ruleStatus === "MISSING_COST_RULE").length,
    warningCount: sumNumbers(rows.map((row) => row.warnings.length))
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
    salesFeeRate: decimal(0),
    salesFeeKrw: decimal(0),
    sellerShippingFeeKrw: latestCostRule?.sellerShippingFeeKrw ?? null,
    hanaroShippingFeeKrw: latestCostRule?.hanaroShippingFeeKrw ?? null,
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
  latestCostRule?: CoupangCostRuleSnapshot | null;
}): Prisma.CoupangCostRuleUncheckedCreateInput {
  return {
    coupangProductId: input.coupangProductId,
    salePriceKrw: decimal(input.parsedRow.salePriceKrw),
    supplyPriceKrw: decimal(input.parsedRow.supplyPriceKrw),
    productCostKrw: decimal(input.parsedRow.productCostKrw),
    salesFeeRate: decimal(0),
    salesFeeKrw: decimal(0),
    sellerShippingFeeKrw: input.parsedRow.sellerShippingFeeKrw === undefined
      ? input.latestCostRule?.sellerShippingFeeKrw ?? null
      : decimal(input.parsedRow.sellerShippingFeeKrw),
    hanaroShippingFeeKrw: nullableDecimal(input.parsedRow.hanaroShippingFeeKrw),
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

function nullableDecimal(value: number | null | undefined) {
  return value === null || value === undefined ? null : decimal(value);
}

function nullableNumberFrom(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function manualPurchaseVendorFeeFromBody(value: unknown) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequestException({ code: "INVALID_VENDOR_FEE", message: "vendorFeePerUnitKrw must be a positive number." });
  }
  return parsed;
}

function parseManualPurchaseEntries(value: unknown): ManualPurchaseEntryInput[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException({ code: "INVALID_MANUAL_PURCHASE_ENTRIES", message: "entries must be an array." });
  }
  const entries = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BadRequestException({ code: "INVALID_MANUAL_PURCHASE_ENTRY", message: "Each entry must be an object." });
    }
    const entry = item as Record<string, unknown>;
    const productId = typeof entry.coupangProductId === "string" ? entry.coupangProductId.trim() : "";
    if (!productId) {
      throw new BadRequestException({ code: "FIELD_REQUIRED", message: "coupangProductId is required." });
    }
    const quantityNumber = Number(entry.quantity);
    if (!Number.isInteger(quantityNumber) || quantityNumber < 1 || quantityNumber > 2_147_483_647) {
      throw manualPurchaseFieldError(productId, "quantity", "must be an integer between 1 and 2147483647");
    }
    return {
      coupangProductId: productId,
      coupangProductRuleId: optionalNullableString(entry.coupangProductRuleId),
      quantity: quantityNumber,
      memo: optionalString(entry.memo)
    };
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.coupangProductId)) {
      throw new BadRequestException({
        code: "DUPLICATE_MANUAL_PURCHASE_PRODUCT",
        message: `Duplicate manual purchase product: ${entry.coupangProductId}.`,
        productId: entry.coupangProductId
      });
    }
    seen.add(entry.coupangProductId);
  }
  return entries;
}

function assertManualPurchaseStoredAmount(amount: number, productId: string, field: string) {
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_COUPANG_MANUAL_PURCHASE_MONEY_KRW) {
    throw new BadRequestException({
      code: "MANUAL_PURCHASE_AMOUNT_OUT_OF_RANGE",
      message: `${field} exceeds Decimal(14,2) range for ${productId}.`,
      productId,
      field
    });
  }
}

function manualPurchaseFieldError(productId: string, field: string, expectation: string) {
  return new BadRequestException({
    code: "INVALID_MANUAL_PURCHASE_FIELD",
    message: `${field} ${expectation} for ${productId}.`,
    productId,
    field
  });
}

function serializeManualPurchaseRow(row: {
  id: string;
  purchaseDate: Date;
  coupangProductId: string;
  coupangProductRuleId: string | null;
  productDisplayName: string;
  ruleDisplayName: string | null;
  saleMethod: string | null;
  quantity: number;
  salesAmountKrw: unknown;
  productCostKrw: unknown;
  vendorFeePerUnitKrw: unknown;
  vendorFeeTotalKrw: unknown;
  salePriceKrw: unknown;
  baseSalePriceKrw: unknown;
  promotionPriceKrw: unknown;
  priceSource: string | null;
  coupangSalesFeeKrw: unknown;
  salesFeeRateApplied: unknown;
  shippingCostKrw: unknown;
  otherCostKrw: unknown;
  totalCostKrw: unknown;
  memo: string | null;
  product?: { group?: { id: string; displayName: string } | null } | null;
}) {
  const resolvedSales = resolveManualPurchaseSalesAmount({
    quantity: row.quantity,
    salesAmountKrw: nullableNumberFrom(row.salesAmountKrw),
    salePriceKrw: nullableNumberFrom(row.salePriceKrw),
    promotionPriceKrw: nullableNumberFrom(row.promotionPriceKrw),
    baseSalePriceKrw: nullableNumberFrom(row.baseSalePriceKrw)
  });
  const salesAmountKrw = resolvedSales.salesAmountKrw;
  const vendorFeeTotalKrw = numberFrom(row.vendorFeeTotalKrw);
  const totalCostKrw = roundManualPurchaseMoney(vendorFeeTotalKrw);
  const costWarnings = roundManualPurchaseMoney(numberFrom(row.totalCostKrw)) === totalCostKrw
    ? []
    : ["MANUAL_PURCHASE_TOTAL_COST_MISMATCH"];
  return {
    id: row.id,
    date: formatDateOnly(row.purchaseDate),
    coupangProductId: row.coupangProductId,
    coupangProductRuleId: row.coupangProductRuleId,
    productName: row.productDisplayName,
    ruleDisplayName: row.ruleDisplayName,
    groupId: row.product?.group?.id ?? null,
    groupName: row.product?.group?.displayName ?? null,
    saleMethod: row.saleMethod,
    quantity: row.quantity,
    salesAmountKrw,
    salesAmountSource: resolvedSales.source,
    actualUnitPriceKrw: salesAmountKrw === null || row.quantity <= 0 ? null : salesAmountKrw / row.quantity,
    productCostKrw: 0,
    vendorFeePerUnitKrw: numberFrom(row.vendorFeePerUnitKrw),
    vendorFeeTotalKrw,
    salePriceKrw: row.salePriceKrw === null ? null : numberFrom(row.salePriceKrw),
    baseSalePriceKrw: row.baseSalePriceKrw === null ? null : numberFrom(row.baseSalePriceKrw),
    promotionPriceKrw: row.promotionPriceKrw === null ? null : numberFrom(row.promotionPriceKrw),
    priceSource: row.priceSource,
    coupangSalesFeeKrw: 0,
    salesFeeRateApplied: 0,
    shippingCostKrw: 0,
    otherCostKrw: 0,
    totalCostKrw,
    memo: row.memo ?? "",
    warnings: uniqueNonEmpty([...resolvedSales.warnings, ...costWarnings])
  };
}

function roundManualPurchaseMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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
  return "SALES_IS_NET";
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

function requiredDateFromBody(value: unknown, field: string) {
  const text = typeof value === "string" ? value.trim() : "";
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? toDateOnly(text) : null;
  if (!parsed) {
    throw new BadRequestException({ code: "INVALID_DATE", message: `${field} must be YYYY-MM-DD.` });
  }
  return parsed;
}

function assertGlobalSalesFeeFieldsNotPresent(body: Record<string, unknown>) {
  if (["salesFeeRate", "salesFeeKrw", "salesFeePercent"].some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    throw new BadRequestException({
      code: "COUPANG_SALES_FEE_IS_GLOBAL",
      message: "Sales fee rate is managed by the global Coupang sales fee setting."
    });
  }
}

function assertCoupangCostEffectiveToNotPresent(body: Record<string, unknown>) {
  if (Object.prototype.hasOwnProperty.call(body, "effectiveTo")) {
    throw new BadRequestException({
      code: "COUPANG_COST_RULE_EFFECTIVE_TO_MANAGED",
      message: "effectiveTo is derived from the next history row and cannot be written directly."
    });
  }
}

function rateDecimalFromBody(value: unknown, field: string) {
  const parsed = Number(value);
  if (value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    const code = field === "salesFeeRate" ? "INVALID_SALES_FEE_RATE" : "INVALID_RETURN_RATE";
    throw new BadRequestException({ code, message: `${field} must be a finite number between 0 and 1.` });
  }
  return new Prisma.Decimal(Math.round(parsed * 1_000_000) / 1_000_000);
}

export function salesFeeRateFromPercentBody(value: unknown) {
  const parsed = Number(value);
  if (value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new BadRequestException({
      code: "INVALID_SALES_FEE_PERCENT",
      message: "salesFeePercent must be a finite number between 0 and 100."
    });
  }
  return new Prisma.Decimal(Math.round((parsed / 100) * 1_000_000) / 1_000_000);
}

function rethrowSalesFeeRuleWriteError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
    throw new BadRequestException({
      code: "COUPANG_SALES_FEE_RULE_DATE_EXISTS",
      message: "A global sales fee rule already starts on this date; correct that history row instead."
    });
  }
  throw error;
}

function previousDate(date: Date) {
  const previous = new Date(date);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous;
}

function dateTimesDiffer(left: Date | null, right: Date | null) {
  return left?.getTime() !== right?.getTime();
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueNonEmpty(value.map((item) => String(item)));
}

function priceTextAppliedRows(value: Prisma.JsonValue, expectedRowCount: number): CoupangPriceTextAppliedRow[] {
  return rollbackAppliedRows(value, expectedRowCount, (item, provenance) => ({
    rowNumber: Number(item.rowNumber) || 0,
    itemName: typeof item.itemName === "string" ? item.itemName : "",
    standardName: typeof item.standardName === "string" ? item.standardName : "",
    productId: provenance.productId,
    costRuleId: provenance.costRuleId,
    salePriceKrw: Number(item.salePriceKrw) || 0,
    costRuleOperation: provenance.operation,
    costRuleBefore: provenance.before,
    costRuleAfter: provenance.after
  }));
}

function marginAppliedRows(value: Prisma.JsonValue, expectedRowCount: number): CoupangMarginAppliedRow[] {
  return rollbackAppliedRows(value, expectedRowCount, (item, provenance) => ({
    rowNumber: Number(item.rowNumber) || 0,
    itemName: typeof item.itemName === "string" ? item.itemName : "",
    standardName: typeof item.standardName === "string" ? item.standardName : "",
    productId: provenance.productId,
    productRuleId: typeof item.productRuleId === "string" ? item.productRuleId : null,
    productRuleCreated: item.productRuleCreated === true,
    costRuleId: provenance.costRuleId,
    salePriceKrw: Number(item.salePriceKrw) || 0,
    costRuleOperation: provenance.operation,
    costRuleBefore: provenance.before,
    costRuleAfter: provenance.after
  }));
}

function rollbackAppliedRows<T>(
  value: Prisma.JsonValue,
  expectedRowCount: number,
  mapRow: (
    item: Prisma.JsonObject,
    provenance: {
      productId: string;
      costRuleId: string;
      operation: "CREATED" | "UPDATED_SAME_DATE";
      before: CoupangCostRuleRollbackSnapshot | null;
      after: CoupangCostRuleRollbackSnapshot;
    }
  ) => T
): T[] {
  if (!Number.isInteger(expectedRowCount) || expectedRowCount < 0
    || !isJsonObject(value) || !Array.isArray(value.appliedRows)
    || value.appliedRows.length !== expectedRowCount) {
    throw missingCoupangUploadRollbackProvenance();
  }
  return value.appliedRows.map((item) => {
    if (!isJsonObject(item)) {
      throw missingCoupangUploadRollbackProvenance();
    }
    const productId = typeof item.productId === "string" ? item.productId.trim() : "";
    const costRuleId = typeof item.costRuleId === "string" ? item.costRuleId.trim() : "";
    const operation = item.costRuleOperation === "CREATED" || item.costRuleOperation === "UPDATED_SAME_DATE"
      ? item.costRuleOperation
      : null;
    const after = parseCoupangCostRuleRollbackSnapshot(item.costRuleAfter);
    const before = parseCoupangCostRuleRollbackSnapshot(item.costRuleBefore);
    if (!productId || !costRuleId || !operation || !after
      || (operation === "UPDATED_SAME_DATE" && !before)
      || (operation === "CREATED" && item.costRuleBefore !== null)) {
      throw missingCoupangUploadRollbackProvenance();
    }
    return mapRow(item, { productId, costRuleId, operation, before, after });
  });
}

function missingCoupangUploadRollbackProvenance() {
  return new BadRequestException({
    code: "COUPANG_UPLOAD_ROLLBACK_PROVENANCE_MISSING",
    message: "This upload has incomplete cost-rule rollback provenance, so its effects cannot be deleted safely."
  });
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function serializeCoupangCostRuleRollbackSnapshot(rule: Prisma.CoupangCostRuleGetPayload<Record<string, never>>): CoupangCostRuleRollbackSnapshot {
  return {
    salePriceKrw: String(rule.salePriceKrw),
    supplyPriceKrw: String(rule.supplyPriceKrw),
    productCostKrw: String(rule.productCostKrw),
    salesFeeRate: String(rule.salesFeeRate),
    salesFeeKrw: String(rule.salesFeeKrw),
    sellerShippingFeeKrw: rule.sellerShippingFeeKrw === null ? null : String(rule.sellerShippingFeeKrw),
    hanaroShippingFeeKrw: rule.hanaroShippingFeeKrw === null ? null : String(rule.hanaroShippingFeeKrw),
    growthInboundFeeKrw: String(rule.growthInboundFeeKrw),
    growthShippingFeeKrw: String(rule.growthShippingFeeKrw),
    returnRate: String(rule.returnRate),
    returnCostPerUnitKrw: String(rule.returnCostPerUnitKrw),
    extraCostKrw: String(rule.extraCostKrw),
    effectiveFrom: formatDateOnly(rule.effectiveFrom),
    effectiveTo: rule.effectiveTo ? formatDateOnly(rule.effectiveTo) : null,
    note: rule.note
  };
}

function deserializeCoupangCostRuleRollbackSnapshot(snapshot: CoupangCostRuleRollbackSnapshot): Prisma.CoupangCostRuleUncheckedUpdateInput {
  return {
    salePriceKrw: new Prisma.Decimal(snapshot.salePriceKrw),
    supplyPriceKrw: new Prisma.Decimal(snapshot.supplyPriceKrw),
    productCostKrw: new Prisma.Decimal(snapshot.productCostKrw),
    salesFeeRate: new Prisma.Decimal(snapshot.salesFeeRate),
    salesFeeKrw: new Prisma.Decimal(snapshot.salesFeeKrw),
    sellerShippingFeeKrw: snapshot.sellerShippingFeeKrw === null ? null : new Prisma.Decimal(snapshot.sellerShippingFeeKrw),
    hanaroShippingFeeKrw: snapshot.hanaroShippingFeeKrw === null ? null : new Prisma.Decimal(snapshot.hanaroShippingFeeKrw),
    growthInboundFeeKrw: new Prisma.Decimal(snapshot.growthInboundFeeKrw),
    growthShippingFeeKrw: new Prisma.Decimal(snapshot.growthShippingFeeKrw),
    returnRate: new Prisma.Decimal(snapshot.returnRate),
    returnCostPerUnitKrw: new Prisma.Decimal(snapshot.returnCostPerUnitKrw),
    extraCostKrw: new Prisma.Decimal(snapshot.extraCostKrw),
    effectiveFrom: requiredDateFromBody(snapshot.effectiveFrom, "effectiveFrom"),
    effectiveTo: snapshot.effectiveTo ? requiredDateFromBody(snapshot.effectiveTo, "effectiveTo") : null,
    note: snapshot.note
  };
}

function sameCoupangCostRuleRollbackSnapshot(rule: Prisma.CoupangCostRuleGetPayload<Record<string, never>>, snapshot: CoupangCostRuleRollbackSnapshot) {
  return JSON.stringify(serializeCoupangCostRuleRollbackSnapshot(rule)) === JSON.stringify(snapshot);
}

function parseCoupangCostRuleRollbackSnapshot(value: Prisma.JsonValue | undefined): CoupangCostRuleRollbackSnapshot | null {
  if (!value || !isJsonObject(value)) return null;
  const decimalFields = [
    "salePriceKrw", "supplyPriceKrw", "productCostKrw", "salesFeeRate", "salesFeeKrw",
    "growthInboundFeeKrw", "growthShippingFeeKrw", "returnRate", "returnCostPerUnitKrw",
    "extraCostKrw"
  ] as const;
  if (decimalFields.some((field) => !isFiniteDecimalText(value[field]))) return null;
  if (!isNullableFiniteDecimalText(value.sellerShippingFeeKrw)
    || !isNullableFiniteDecimalText(value.hanaroShippingFeeKrw)
    || !isStrictDateOnlyText(value.effectiveFrom)
    || !(value.effectiveTo === null || isStrictDateOnlyText(value.effectiveTo))
    || !(value.note === null || typeof value.note === "string")) {
    return null;
  }
  return {
    salePriceKrw: String(value.salePriceKrw), supplyPriceKrw: String(value.supplyPriceKrw),
    productCostKrw: String(value.productCostKrw), salesFeeRate: String(value.salesFeeRate), salesFeeKrw: String(value.salesFeeKrw),
    sellerShippingFeeKrw: value.sellerShippingFeeKrw,
    hanaroShippingFeeKrw: value.hanaroShippingFeeKrw,
    growthInboundFeeKrw: String(value.growthInboundFeeKrw), growthShippingFeeKrw: String(value.growthShippingFeeKrw),
    returnRate: String(value.returnRate), returnCostPerUnitKrw: String(value.returnCostPerUnitKrw),
    extraCostKrw: String(value.extraCostKrw), effectiveFrom: String(value.effectiveFrom),
    effectiveTo: value.effectiveTo,
    note: value.note
  };
}

function isFiniteDecimalText(value: Prisma.JsonValue | undefined): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    return new Prisma.Decimal(value).isFinite();
  } catch {
    return false;
  }
}

function isNullableFiniteDecimalText(value: Prisma.JsonValue | undefined): value is string | null {
  return value === null || isFiniteDecimalText(value);
}

function isStrictDateOnlyText(value: Prisma.JsonValue | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Boolean(toDateOnly(value));
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

function maybeCostRuleCreate(
  body: Record<string, unknown>,
  latestCostRule: CoupangCostRuleSnapshot | null = null
): Prisma.CoupangCostRuleCreateNestedManyWithoutProductInput | undefined {
  if (!hasCoupangCostFields(body)) {
    return undefined;
  }
  const sellerShippingFeeKrw = Object.prototype.hasOwnProperty.call(body, "sellerShippingFeeKrw")
    ? nullableNonNegativeCostDecimalFromBody(body.sellerShippingFeeKrw, "sellerShippingFeeKrw")
    : latestCostRule?.sellerShippingFeeKrw ?? null;
  const hanaroShippingFeeKrw = Object.prototype.hasOwnProperty.call(body, "hanaroShippingFeeKrw")
    ? nullableNonNegativeCostDecimalFromBody(body.hanaroShippingFeeKrw, "hanaroShippingFeeKrw")
    : latestCostRule?.hanaroShippingFeeKrw ?? null;
  return {
    create: {
      salePriceKrw: nonNegativeCostDecimalFromBody(body.salePriceKrw, "salePriceKrw") ?? latestCostRule?.salePriceKrw,
      supplyPriceKrw: nonNegativeCostDecimalFromBody(body.supplyPriceKrw, "supplyPriceKrw") ?? latestCostRule?.supplyPriceKrw,
      productCostKrw: nonNegativeCostDecimalFromBody(body.productCostKrw, "productCostKrw") ?? latestCostRule?.productCostKrw,
      salesFeeRate: decimal(0),
      salesFeeKrw: decimal(0),
      sellerShippingFeeKrw,
      hanaroShippingFeeKrw,
      growthInboundFeeKrw: nonNegativeCostDecimalFromBody(body.growthInboundFeeKrw, "growthInboundFeeKrw")
        ?? latestCostRule?.growthInboundFeeKrw,
      growthShippingFeeKrw: nonNegativeCostDecimalFromBody(body.growthShippingFeeKrw, "growthShippingFeeKrw")
        ?? latestCostRule?.growthShippingFeeKrw,
      returnRate: body.returnRate === undefined ? latestCostRule?.returnRate : rateDecimalFromBody(body.returnRate, "returnRate"),
      returnCostPerUnitKrw: nonNegativeCostDecimalFromBody(body.returnCostPerUnitKrw, "returnCostPerUnitKrw") ?? latestCostRule?.returnCostPerUnitKrw,
      extraCostKrw: nonNegativeCostDecimalFromBody(body.extraCostKrw, "extraCostKrw") ?? latestCostRule?.extraCostKrw,
      effectiveFrom: body.effectiveFrom ? requiredDateFromBody(body.effectiveFrom, "effectiveFrom") : undefined,
      note: body.note === undefined ? latestCostRule?.note : optionalString(body.note)
    }
  };
}

const COUPANG_COST_FIELDS = [
  "salePriceKrw",
  "supplyPriceKrw",
  "productCostKrw",
  "sellerShippingFeeKrw",
  "hanaroShippingFeeKrw",
  "growthInboundFeeKrw",
  "growthShippingFeeKrw",
  "returnRate",
  "returnCostPerUnitKrw",
  "extraCostKrw"
] as const;

function hasCoupangCostFields(body: Record<string, unknown>) {
  return COUPANG_COST_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(body, field));
}

function decimalFromBody(value: unknown, field: string) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const text = String(value).trim();
  const isNumericInput = (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(text));
  if (!isNumericInput) {
    throw invalidCoupangCostField(field, "must be a numeric value");
  }
  return new Prisma.Decimal(text);
}

function nonNegativeCostDecimalFromBody(value: unknown, field: string) {
  const parsed = decimalFromBody(value, field);
  if (parsed !== undefined && (parsed.isNegative() || !parsed.isInteger() || parsed.greaterThan(MAX_COUPANG_COST_INTEGER_KRW))) {
    throw invalidCoupangCostField(field, `must be a non-negative integer no greater than ${MAX_COUPANG_COST_INTEGER_KRW}`);
  }
  return parsed;
}

function invalidCoupangCostField(field: string, requirement: string) {
  return new BadRequestException({
    code: `INVALID_${field.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase().replace(/_KRW$/, "")}`,
    field,
    message: `${field} ${requirement}.`
  });
}

function nullableNonNegativeCostDecimalFromBody(value: unknown, field: string) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  return nonNegativeCostDecimalFromBody(value, field) ?? null;
}

function currentKoreaDateOnly() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return requiredDateFromBody(`${value.year}-${value.month}-${value.day}`, "date");
}

function rethrowCoupangCostRuleWriteError(error: unknown): never {
  const target = error && typeof error === "object" && "meta" in error
    ? String((error.meta as { target?: unknown } | undefined)?.target ?? "")
    : "";
  if (error && typeof error === "object" && "code" in error && error.code === "P2002"
    && ((target.includes("coupang_product_id") && target.includes("effective_from"))
      || (target.includes("coupangProductId") && target.includes("effectiveFrom"))
      || target.includes("coupang_cost_rules_coupang_product_id_effective_from_key"))) {
    throw new BadRequestException({
      code: "COUPANG_COST_RULE_DATE_EXISTS",
      message: "A cost rule already starts on this date; retry or correct that history row instead."
    });
  }
  throw error;
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

function strictSumNullable(values: Array<number | null | undefined>) {
  if (values.some((value) => value === null || value === undefined || !Number.isFinite(value))) {
    return null;
  }
  return values.reduce<number>((sum, value) => sum + Number(value), 0);
}

function compareNullableNumbersDesc(a: number | null, b: number | null) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
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
  | "id"
  | "supplyPriceKrw"
  | "productCostKrw"
  | "salesFeeRate"
  | "salesFeeKrw"
  | "sellerShippingFeeKrw"
  | "hanaroShippingFeeKrw"
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

type CoupangSalesFeeRuleForSelection = Pick<
  Prisma.CoupangSalesFeeRuleGetPayload<Record<string, never>>,
  "id" | "salesFeeRate" | "effectiveFrom" | "effectiveTo" | "note" | "createdAt" | "updatedAt"
>;

export function findSalesFeeRuleForDate<T extends CoupangSalesFeeRuleForSelection>(rules: T[], date: Date): T | null {
  return (
    rules
      .filter((rule) => rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date))
      .sort((a, b) => (
        b.effectiveFrom.getTime() - a.effectiveFrom.getTime()
        || b.createdAt.getTime() - a.createdAt.getTime()
        || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1)
      ))[0] ?? null
  );
}

function serializeSalesFeeRule(rule: CoupangSalesFeeRuleForSelection) {
  const salesFeeRate = numberFrom(rule.salesFeeRate);
  return {
    id: rule.id,
    salesFeeRate,
    salesFeePercent: Math.round(salesFeeRate * 100_000_000) / 1_000_000,
    effectiveFrom: formatDateOnly(rule.effectiveFrom),
    effectiveTo: rule.effectiveTo ? formatDateOnly(rule.effectiveTo) : null,
    note: rule.note,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt
  };
}

function sortCoupangCostRulesForSettings<T extends CoupangCostRuleForSelection>(rules: T[]): T[] {
  return [...rules].sort(compareCoupangCostRuleForSelection);
}

function compareCoupangCostRuleForSelection(a: CoupangCostRuleForSelection, b: CoupangCostRuleForSelection) {
  return (
    b.effectiveFrom.getTime() - a.effectiveFrom.getTime() ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    (a.id === b.id ? 0 : a.id < b.id ? 1 : -1)
  );
}

function costInput(rule: Prisma.CoupangCostRuleGetPayload<Record<string, never>>): CoupangCostInput {
  return {
    salePriceKrw: numberFrom(rule.salePriceKrw),
    supplyPriceKrw: numberFrom(rule.supplyPriceKrw),
    productCostKrw: numberFrom(rule.productCostKrw),
    sellerShippingFeeKrw: nullableNumberFrom(rule.sellerShippingFeeKrw),
    hanaroShippingFeeKrw: nullableNumberFrom(rule.hanaroShippingFeeKrw),
    growthInboundFeeKrw: numberFrom(rule.growthInboundFeeKrw),
    growthShippingFeeKrw: numberFrom(rule.growthShippingFeeKrw),
    returnRate: numberFrom(rule.returnRate),
    returnCostPerUnitKrw: numberFrom(rule.returnCostPerUnitKrw),
    extraCostKrw: numberFrom(rule.extraCostKrw)
  };
}
