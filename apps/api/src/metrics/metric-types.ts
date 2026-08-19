import { Prisma } from "@prisma/client";
import { ProductCpaThresholds } from "../domain/margin-calculator";

export type MetricWithRelations = Prisma.MetaAdsetDailyMetricGetPayload<{
  include: { product: true; metaAdset: true };
}>;
export type CostRule = Prisma.ProductCostRuleGetPayload<Record<string, never>>;
export type CpaRule = Prisma.ProductCpaRuleGetPayload<Record<string, never>>;
export type ExchangeRateRow = Prisma.ExchangeRateGetPayload<Record<string, never>>;
export type AdDailyMetricRow = Prisma.MetaAdDailyMetricGetPayload<Record<string, never>>;

export type CreativeFinancialContext = {
  costRulesByProductId: Map<string, CostRule[]>;
  exchangeRateByDate: Map<string, ExchangeRateRow>;
};

export type RuleStatus =
  | "OK"
  | "UNMATCHED"
  | "MISSING_COST_RULE"
  | "MISSING_CPA_RULE"
  | "MISSING_EXCHANGE_RATE"
  | "MISSING_RULES";

export type DecoratedMetric = {
  metric: MetricWithRelations;
  metricDate: string;
  spendUsd: number;
  purchaseCount: number;
  spendKrw: number | null;
  revenueKrw: number | null;
  marginKrw: number | null;
  cpaKrw: number | null;
  cpaUsd: number | null;
  ruleStatus: RuleStatus;
  thresholds: ProductCpaThresholds | null;
  costRule: CostRule | null;
  cpaRule: CpaRule | null;
  exchangeRate: ExchangeRateRow | null;
};

export type AdMetricQuery = {
  from?: string;
  to?: string;
  campaignId?: string;
  adsetId?: string;
  productId?: string;
  stage?: string;
  deliveryStatus?: string;
};

export type AdsetMetricQuery = {
  from?: string;
  to?: string;
  campaignId?: string;
  productId?: string;
  stage?: string;
  decision?: string;
  deliveryStatus?: string;
};

export type CampaignMetricQuery = {
  from?: string;
  to?: string;
  productId?: string;
  stage?: string;
  deliveryStatus?: string;
};

export type CreativeMetricQuery = AdMetricQuery & { q?: string };

export type CreativeVideoTrendQuery = {
  from?: string;
  to?: string;
  productId?: string;
  deliveryStatus?: string;
};
