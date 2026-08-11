import { AdStage, MatchSource, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { toDateOnly } from "../domain/date-number";
import { MetaAdsetAggregateService } from "./meta-adset-aggregate.service";
import { AdsetAggregateInput } from "./upload-contracts";
import { snapshotMetricKey } from "./upload-keys";

describe("MetaAdsetAggregateService", () => {
  it("rebuilds one adset-day from current ad metrics without copying video counts", async () => {
    const metricDate = date("2026-08-10");
    const metrics = [
      adMetric("metric-1", "ad-1", metricDate, { spendUsd: 10, purchaseCount: 1, reach: 60 }),
      adMetric("metric-2", "ad-2", metricDate, { spendUsd: 5, purchaseCount: 2, reach: 40 })
    ];
    let imported: AdsetAggregateInput | null = null;
    const deactivatedInputs: Array<{ snapshotDates: Date[]; includedKeys: Set<string> }> = [];
    const prisma = { metaAdDailyMetric: { findMany: async () => metrics } };
    const metricVersionService = {
      importAdsetAggregateMetric: async (_batchId: string, input: AdsetAggregateInput) => {
        imported = input;
        return { imported: true, skipped: false };
      },
      deactivateMissingSnapshotMetrics: async (input: { snapshotDates: Date[]; includedKeys: Set<string> }) => {
        deactivatedInputs.push(input);
        return 0;
      }
    };
    const service = new MetaAdsetAggregateService(prisma as never, metricVersionService as never);

    const count = await service.refreshAdsetAggregatesFromAdMetrics("batch-1", [metricDate]);

    expect(count).toBe(1);
    expect(imported).toMatchObject({
      metaAdsetId: "adset-ref-1",
      metricDate,
      purchaseCount: 3,
      reach: 100,
      spendUsd: 15,
      productId: "product-1",
      productMatchSource: MatchSource.RULE,
      rawRow: {
        source: "meta_ad_daily_metrics",
        metricIds: ["metric-1", "metric-2"],
        adCount: 2
      }
    });
    expect(Object.keys(imported ?? {}).some((key) => key.startsWith("videoPlay"))).toBe(false);
    expect(deactivatedInputs[0]).toMatchObject({ snapshotDates: [metricDate] });
    expect(deactivatedInputs[0].includedKeys).toEqual(new Set([snapshotMetricKey(metricDate, "adset-ref-1")]));
  });
});

function adMetric(
  id: string,
  adIdentityKey: string,
  metricDate: Date,
  overrides: { spendUsd: number; purchaseCount: number; reach: number }
) {
  return {
    id,
    uploadBatchId: "batch-source",
    uploadRowId: `row-${id}`,
    campaignRefId: "campaign-ref-1",
    metaAdsetRefId: "adset-ref-1",
    metaAdRefId: `ad-ref-${id}`,
    creativeId: `creative-${id}`,
    metricDate,
    dateStart: metricDate,
    dateEnd: metricDate,
    metaCampaignId: "campaign-1",
    campaignNameSnapshot: "캠페인",
    metaAdsetId: "adset-1",
    adsetNameSnapshot: "광고세트",
    metaAdId: null,
    syntheticAdKey: adIdentityKey,
    adIdentityKey,
    adNameSnapshot: adIdentityKey,
    adDeliveryStatus: "active",
    attributionSetting: "7일 클릭",
    resultIndicator: "구매",
    resultCount: overrides.purchaseCount,
    purchaseCount: overrides.purchaseCount,
    reach: overrides.reach,
    videoPlay3sCount: 5,
    videoPlay25Count: 2,
    videoPlay50Count: 1,
    videoPlay75Count: 0,
    videoPlay100Count: 0,
    frequency: null,
    costPerResultUsd: null,
    adsetBudgetLabel: null,
    adsetBudgetType: null,
    spendUsd: new Prisma.Decimal(overrides.spendUsd),
    endStatus: null,
    qualityRanking: null,
    engagementRateRanking: null,
    conversionRateRanking: null,
    impressions: BigInt(100),
    cpmUsd: null,
    linkClicks: 10,
    shopClicks: 0,
    cpcLinkUsd: null,
    ctrLinkPct: null,
    clicksAll: 12,
    ctrAllPct: null,
    cpcAllUsd: null,
    landingPageViews: 8,
    costPerLandingPageViewUsd: null,
    productId: "product-1",
    stage: AdStage.SC,
    productMatchSource: MatchSource.RULE,
    stageMatchSource: MatchSource.RULE,
    productMatchRuleId: "rule-1",
    importVersion: 1,
    isCurrent: true,
    supersededByMetricId: null,
    rawRow: {},
    createdAt: metricDate
  };
}

function date(value: string) {
  const parsed = toDateOnly(value);
  if (!parsed) throw new Error(`Invalid date: ${value}`);
  return parsed;
}
