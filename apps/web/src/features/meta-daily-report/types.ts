import type { MetaDailyColumnKey } from "@/lib/meta-daily-columns";
import type {
  MetaDailyDeliveryStatusFilter,
  MetaDailyReportSettings
} from "@/lib/meta-daily-settings";
import type { MetaCreativePerformanceRow } from "@/types/meta";

export type CreativePerformanceRow = MetaCreativePerformanceRow;
export type DeliveryStatusFilter = MetaDailyDeliveryStatusFilter;
export type ColumnKey = MetaDailyColumnKey;
export type DailyReportSettings = MetaDailyReportSettings;

export type ColumnDefinition = {
  key: ColumnKey;
  label: string;
};

export type ProductTotals = {
  spendUsd: number;
  spendKrw: number | null;
  purchaseCount: number;
  cpaUsd: number | null;
  cpaKrw: number | null;
  revenueKrw: number | null;
  roas: number | null;
};

export type ProductGroup = {
  productName: string;
  productId: string | null;
  rows: CreativePerformanceRow[];
  totals: ProductTotals;
};

export type ReportProductGroup = ProductGroup & {
  salesRow: SalesProductRow | null;
  salesOnly: boolean;
};

export type SalesProductPerformance = {
  rows: SalesProductRow[];
  summary: {
    salesLineCount: number;
    salesUnmatchedCount: number;
    adUnmatchedMetricCount: number;
    adUnmatchedSpendKrw: number | null;
  };
};

export type SalesProductRow = {
  productId: string;
  product?: {
    displayName?: string | null;
    name?: string | null;
    code?: string | null;
  } | null;
  quantity: number;
  revenueKrw: number;
  totalPaidKrw: number;
  adSpendUsd?: number | null;
  adSpendKrw: number | null;
  grossCostKrw: number | null;
  totalCostKrw: number | null;
  marginBeforeCouponKrw: number | null;
  couponDeductionKrw: number;
  marginKrw: number | null;
  marginRate: number | null;
  matchedSalesLineCount: number;
  couponOrderCount: number;
  couponExactOrderCount: number;
  couponEstimatedOrderCount: number;
  couponUnmatchedOrderCount: number;
  couponIgnoredResidualKrw: number;
};

export type SalesProductIndex = {
  byProductId: Map<string, SalesProductRow>;
  byProductName: Map<string, SalesProductNameMatch>;
};

export type SalesProductNameMatch = {
  row: SalesProductRow;
  ambiguous: boolean;
};

export type PreviousIndexes = {
  byCreativeKey: Map<string, CreativePerformanceRow>;
  byProductMaterial: Map<string, CreativePerformanceRow>;
  byDisplayName: Map<string, CreativePerformanceRow>;
};
