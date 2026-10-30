import type { AdapterRequest, Platform, Quality, SourceCoverage } from "./types";

export const REPORT_CALCULATION_VERSION = "unified-report-v1";
/** Only compact, public-safe daily aggregates are persisted in the reporting fact payload. */
export interface ReportFact {
  component: "SALE" | "AD_SPEND" | "COMMON_EXPENSE" | "SHIPPING_INCOME";
  factKey: string;
  productName: string | null;
  saleUnitName: string | null;
  amountKrw: string | null;
  completeAmountKrw: string | null;
  profitBeforeAds: string | null;
  completeProfitBeforeAds: string | null;
  originalAmount: string | null;
  currency: string | null;
  quantity: string | null;
  attribution: "DIRECT" | "ALLOCATED" | "UNALLOCATED";
  medium: string | null;
  marketplace: string | null;
  commonKind: string | null;
  rowsCount: number;
  quality: Quality;
}
export interface PublishedReportFact extends ReportFact { platform: Platform; scopeKey: string; date: string }
export interface ReportTotals {
  revenue: string | null;
  adSpend: string | null;
  profitBeforeAds: string | null;
  estimatedProfit: string | null;
  mer: string | null;
}
/** Known published amounts remain usable when an independent source has no data.
 * A partially available source can appear in both arrays. Null is never confirmed zero. */
export interface DisplayAmount { value: string | null; state: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  availableSources: Platform[]; missingSources: Platform[] }
export interface ReportSummary {
  knownTotals: ReportTotals;
  completeTotals: ReportTotals;
  productProfitSubtotal: string | null;
  byMarketplace: Array<{ marketplace: string; revenue: string | null; completeRevenue?: string | null; profitBeforeAds?: string | null; estimatedProfit?: string | null; adSpend?: string | null; profitUnavailableReason?: string | null; display?: { revenue: DisplayAmount; estimatedProfit: DisplayAmount; adSpend: DisplayAmount } }>;
  byMedium: Array<{ medium: string; adSpend: string | null; completeAdSpend?: string | null; displayAdSpend?: DisplayAmount; share: string | null }>;
  unallocatedExpenses: Array<{ platform: Platform; scopeKey: string; date: string; kind: string | null; amount: string | null }>;
  unallocatedAdSpends: Array<{ platform: Platform; scopeKey: string; date: string; medium: string | null; amount: string | null }>;
  unclassifiedSales: Array<{ platform: Platform; scopeKey: string; date: string; amount: string | null }>;
  scopeBalances: {
    unallocatedAdSpend: string | null;
    unallocatedExpense: string | null;
    shippingIncome: string | null;
    unallocatedShippingIncome: string | null;
    unclassifiedRevenue: string | null;
    unclassifiedProfitBeforeAds: string | null;
  };
  isEstimate: boolean;
  issues: string[];
}
export interface SourcePartition { platform: Platform; scopeKey: string; date: string }
export type RunRequest = AdapterRequest;
export interface PublishedReportSnapshot {
  facts: PublishedReportFact[];
  coverage: SourceCoverage[];
}
