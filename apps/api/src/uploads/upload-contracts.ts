import { AdStage, ConflictPolicy, MatchSource, Prisma } from "@prisma/client";
import { ParsedMetaAdDailyRow } from "../domain/meta-ad-daily-csv";
import { ParsedMetaAdsetRow } from "../domain/meta-csv";

export type MetricImportInput = {
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

export type AdMetricImportInput = {
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

export type AdsetAggregateInput = {
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

export type DeletedAdMetricKey = {
  id: string;
  creativeId: string | null;
  metricDate: Date;
  metaCampaignId: string;
  metaAdsetId: string;
  adIdentityKey: string;
  adNameSnapshot: string;
};

export type DeletedAdsetMetricKey = {
  id: string;
  metricDate: Date;
  metaAdsetId: string;
};

export type CreativePlacementCleanupKey = {
  creativeId: string;
  metaCampaignId: string;
  metaAdsetId: string;
  originalAdName: string;
};

export type AdDailyMetricRow = Prisma.MetaAdDailyMetricGetPayload<Record<string, never>>;
