import { Prisma } from "@prisma/client";
import type { PrismaService } from "../common/prisma.service";
import { GoogleReadService } from "../google/google-read.service";
import { SalesMetricsService } from "../sales/sales-metrics.service";
import type { NativeResultAmount, NativeStoredResult } from "./native-result-contract";

const amount = (value: number | null | undefined): string | null =>
  value == null || !Number.isFinite(value) ? null : new Prisma.Decimal(value).toFixed();
const metric = (value: string | null, complete: boolean, known = value): NativeResultAmount =>
  ({ known, complete: complete ? value : null });
const unavailable = (): NativeResultAmount => ({ known: null, complete: null });
type MetaReport = Awaited<ReturnType<SalesMetricsService["productPerformance"]>>;
type GoogleReport = Awaited<ReturnType<GoogleReadService["nativeOriginalStorefrontDay"]>>;

/** These are the same activity and nullable-total rules used by the original sales page.
 * Unmatched advertising remains an audit value; it is not silently allocated to products. */
export function originalMetaStoredResults(report: MetaReport, sourceComplete: boolean): NativeStoredResult[] {
  const rows = report.rows.filter(row => [row.quantity, row.revenueKrw, row.totalPaidKrw, row.adSpendUsd,
    row.adSpendKrw, row.couponDeductionKrw, row.couponUnmatchedOrderCount, row.couponUnknownOrderCount]
    .some(value => value != null && Number.isFinite(value) && value !== 0));
  const issues = ["ORIGINAL_META_WHOLE_STOREFRONT_BASIS", "STOREFRONT_GOOGLE_SALES_MAY_OVERLAP",
    ...(!sourceComplete ? ["SOURCE_COLLECTION_INCOMPLETE"] : [])];
  const sum = (select: (row: MetaReport["rows"][number]) => number | null) => {
    let total = 0;
    for (const row of rows) { const value = select(row); if (value === null || !Number.isFinite(value)) return null; total += value; }
    return amount(total);
  };
  const known = (value: string | null) => !sourceComplete && !rows.length ? null : value;
  const results: NativeStoredResult[] = rows.map(row => ({ kind: "PRODUCT", group: "STOREFRONT",
    productKey: row.productId, productName: row.product?.displayName ?? row.product?.name ?? null,
    quantity: amount(row.quantity), revenue: metric(amount(row.revenueKrw), sourceComplete),
    adSpend: metric(amount(row.adSpendKrw), sourceComplete), netProfit: metric(amount(row.marginKrw), sourceComplete),
    profitBeforeAds: unavailable(), sourceUpdatedAt: null,
    issues: [...issues, ...(row.ruleStatus !== "OK" ? [row.ruleStatus] : [])],
    audit: { basis: "sales/product-performance", grossCost: amount(row.grossCostKrw), coupon: amount(row.couponDeductionKrw),
      matchedSalesLineCount: String(row.matchedSalesLineCount) } }));
  results.unshift({ kind: "SUMMARY", group: "STOREFRONT", productKey: "SUMMARY", productName: null,
    quantity: known(sum(row => row.quantity)), revenue: metric(known(sum(row => row.revenueKrw)), sourceComplete),
    adSpend: metric(known(sum(row => row.adSpendKrw)), sourceComplete), netProfit: metric(known(sum(row => row.marginKrw)), sourceComplete),
    profitBeforeAds: unavailable(), sourceUpdatedAt: null, issues,
    audit: { basis: "sales/product-performance:visible-product-totals",
      unallocatedAdSpend: amount(report.summary.adUnmatchedSpendKrw),
      unmatchedSalesCount: String(report.summary.salesUnmatchedCount) } });
  return results;
}

/** Original Google summary owns unallocated spend and source gaps. Never sum products to replace it. */
export function originalGoogleStoredResults(report: GoogleReport, sourceComplete: boolean): NativeStoredResult[] {
  const convert = (row: GoogleReport["summary"] | GoogleReport["products"][number], kind: "SUMMARY" | "PRODUCT",
    productName: string | null): NativeStoredResult => {
    const salesComplete = sourceComplete && !row.warningCodes.some(issue =>
      ["CAFE24_COLLECTION_INCOMPLETE", "SOURCE_SELECTION_REQUIRED", "CAFE24_TIME_ZONE_MISMATCH", "CAFE24_CURRENCY_MISMATCH"].includes(issue));
    const adsComplete = !row.warningCodes.some(issue =>
      ["GOOGLE_COLLECTION_INCOMPLETE", "SOURCE_SELECTION_REQUIRED", "TIME_ZONE_MISMATCH", "TIME_ZONE_UNKNOWN", "MISSING_EXCHANGE_RATE"].includes(issue));
    return { kind, group: "GOOGLE", productKey: kind === "SUMMARY" ? "SUMMARY" : row.productId!, productName,
      quantity: amount(row.quantity), revenue: metric(row.revenueKrwExact, salesComplete, row.knownRevenueKrwExact),
      adSpend: metric(row.adSpendKrwExact, adsComplete, row.knownAdSpendKrwExact),
      netProfit: metric(row.marginKrwExact, sourceComplete && row.complete),
      profitBeforeAds: metric(row.profitBeforeAdsKrwExact, salesComplete), sourceUpdatedAt: null,
      issues: [...new Set([...row.warningCodes, "ORIGINAL_GOOGLE_MARGIN_BASIS", "STOREFRONT_GOOGLE_SALES_MAY_OVERLAP",
        ...(!sourceComplete ? ["SOURCE_COLLECTION_INCOMPLETE"] : [])])].sort(),
      audit: { basis: "google/profit:original-coupon-policy" } };
  };
  return [convert(report.summary, "SUMMARY", null), ...report.products.map(row => convert(row, "PRODUCT", row.productName))];
}

/** Called only by the source publisher in its repeatable-read transaction, never a report GET. */
export async function readOriginalStorefrontResults(prisma: PrismaService,
  options: { date: string; scopeKey: string; sourceComplete: boolean; ownsSource: boolean }): Promise<NativeStoredResult[]> {
  if (!options.ownsSource) return (["STOREFRONT", "GOOGLE"] as const).map(group => ({ kind: "SUMMARY", group,
    productKey: "SUMMARY", productName: null, quantity: null, revenue: unavailable(), adSpend: unavailable(),
    netProfit: unavailable(), profitBeforeAds: unavailable(), sourceUpdatedAt: null,
    issues: ["SOURCE_SCOPE_UNSUPPORTED"], audit: { basis: "ORIGINAL_REPORT_REQUIRES_SINGLE_STOREFRONT" } }));
  const [meta, google] = await Promise.all([
    new SalesMetricsService(prisma).productPerformance({ from: options.date, to: options.date }, true),
    new GoogleReadService(prisma).nativeOriginalStorefrontDay(prisma as unknown as Prisma.TransactionClient, options.date, options.scopeKey)
  ]);
  return [...originalMetaStoredResults(meta, options.sourceComplete), ...originalGoogleStoredResults(google, options.sourceComplete)]
    .map(row => ({ ...row, audit: { ...row.audit, scopeOwnership: "SOLE_STOREFRONT",
      ...(options.scopeKey !== "LEGACY_UNBOUND" ? { coveredLegacyScope: "LEGACY_UNBOUND" } : {}) } }));
}
