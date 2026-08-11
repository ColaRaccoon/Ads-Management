import { AdStage, MatchSource, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MetaAdMetricsReadService } from "./meta-ad-metrics-read.service";

describe("MetaAdMetricsReadService response and query contract", () => {
  it("returns campaign and ad response fields from current ad-day rows", async () => {
    const queries: Array<Record<string, unknown>> = [];
    const prisma = {
      metaAdDailyMetric: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          queries.push(where);
          return [adMetric("metric-1", 10, 1), adMetric("metric-2", 5, 2)];
        }
      }
    };
    const service = new MetaAdMetricsReadService(prisma as never);

    const campaignRows = await service.campaignMetrics({
      from: "2026-08-10",
      to: "2026-08-10",
      deliveryStatus: "active"
    });
    const adRows = await service.adMetrics({
      from: "2026-08-10",
      to: "2026-08-10",
      campaignId: "campaign-external",
      adsetId: "123e4567-e89b-42d3-a456-426614174000",
      productId: "product-1",
      stage: AdStage.SC,
      deliveryStatus: "inactive"
    });

    expect(campaignRows).toEqual([
      expect.objectContaining({
        metaCampaignId: "campaign-1",
        campaignName: "Campaign",
        adsetCount: 1,
        adCount: 1,
        deliveryStatus: "active",
        stage: AdStage.SC,
        totals: expect.objectContaining({ spendUsd: 15, purchaseCount: 3, reach: 200 }),
        dataDays: 1
      })
    ]);
    expect(adRows).toEqual([
      expect.objectContaining({
        metaAdRefId: "ad-ref-1",
        metaCampaignId: "campaign-1",
        campaignName: "Campaign",
        metaAdsetId: "adset-1",
        metaAdsetRefId: "adset-ref-1",
        adsetName: "Adset",
        metaAdId: "ad-1",
        adIdentityKey: "ad-1",
        adName: "Creative A",
        productId: "product-1",
        stage: AdStage.SC,
        deliveryStatus: "active",
        totals: expect.objectContaining({ spendUsd: 15, purchaseCount: 3, cpaUsd: 5 }),
        dataDays: 1,
        firstSeenOn: "2026-08-10",
        lastSeenOn: "2026-08-10"
      })
    ]);
    expect(queries[0]).toMatchObject({
      isCurrent: true,
      metricDate: { gte: new Date("2026-08-10T00:00:00.000Z"), lte: new Date("2026-08-10T00:00:00.000Z") },
      adDeliveryStatus: { equals: "active", mode: "insensitive" }
    });
    expect(queries[1]).toMatchObject({
      isCurrent: true,
      adDeliveryStatus: { equals: "inactive", mode: "insensitive" },
      productId: "product-1",
      stage: AdStage.SC,
      AND: [
        { metaCampaignId: "campaign-external" },
        { OR: [
          { metaAdsetRefId: "123e4567-e89b-42d3-a456-426614174000" },
          { metaAdsetId: "123e4567-e89b-42d3-a456-426614174000" }
        ] }
      ]
    });
  });

  it("compare-by-name filters exact names and retains the ad response shape", async () => {
    const prisma = {
      metaAdDailyMetric: {
        findMany: async () => [
          adMetric("metric-a", 10, 1, { adIdentityKey: "ad-a", adNameSnapshot: "Creative A" }),
          adMetric("metric-b", 20, 2, { adIdentityKey: "ad-b", adNameSnapshot: "Creative B", metaAdId: "ad-2" })
        ]
      }
    };
    const service = new MetaAdMetricsReadService(prisma as never);

    const result = await service.compareAdsByName(" Creative B ", "2026-08-10", "2026-08-10", "all");

    expect(result).toEqual([
      expect.objectContaining({
        adName: "Creative B",
        adIdentityKey: "ad-b",
        totals: expect.objectContaining({ spendUsd: 20, purchaseCount: 2 })
      })
    ]);
  });

  it("keeps UUID/external OR branches for adset and campaign drill-downs", async () => {
    const queries: Array<Record<string, unknown>> = [];
    const prisma = {
      metaAdDailyMetric: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          queries.push(where);
          return [adMetric("metric-1", 10, 1)];
        }
      }
    };
    const service = new MetaAdMetricsReadService(prisma as never);
    const adsetUuid = "123e4567-e89b-42d3-a456-426614174000";
    const campaignUuid = "123e4567-e89b-42d3-a456-426614174001";

    const ads = await service.adsForAdset(adsetUuid, "2026-08-10", "2026-08-10", "active");
    const adsets = await service.adsetsForCampaign(campaignUuid, "2026-08-10", "2026-08-10", "all");

    expect(queries[0]).toMatchObject({
      isCurrent: true,
      adDeliveryStatus: { equals: "active", mode: "insensitive" },
      OR: [{ metaAdsetRefId: adsetUuid }, { metaAdsetId: adsetUuid }]
    });
    expect(queries[1]).toMatchObject({
      isCurrent: true,
      OR: [{ campaignRefId: campaignUuid }, { metaCampaignId: campaignUuid }]
    });
    expect(queries[1]).not.toHaveProperty("adDeliveryStatus");
    expect(ads[0]).toMatchObject({
      metaAdRefId: "ad-ref-1",
      adIdentityKey: "ad-1",
      adName: "Creative A",
      totals: expect.objectContaining({ spendUsd: 10 })
    });
    expect(adsets[0]).toMatchObject({
      metaAdsetRefId: "adset-ref-1",
      metaAdsetId: "adset-1",
      adsetName: "Adset",
      adCount: 1,
      totals: expect.objectContaining({ spendUsd: 10 })
    });
  });
});

function adMetric(
  id: string,
  spendUsd: number,
  purchaseCount: number,
  overrides: Record<string, unknown> = {}
) {
  const metricDate = new Date("2026-08-10T00:00:00.000Z");
  return {
    id,
    uploadBatchId: "batch-1",
    uploadRowId: `row-${id}`,
    campaignRefId: "campaign-ref-1",
    metaAdsetRefId: "adset-ref-1",
    metaAdRefId: "ad-ref-1",
    creativeId: "creative-1",
    metricDate,
    dateStart: metricDate,
    dateEnd: metricDate,
    metaCampaignId: "campaign-1",
    campaignNameSnapshot: "Campaign",
    metaAdsetId: "adset-1",
    adsetNameSnapshot: "Adset",
    metaAdId: "ad-1",
    syntheticAdKey: null,
    adIdentityKey: "ad-1",
    adNameSnapshot: "Creative A",
    adDeliveryStatus: "active",
    attributionSetting: null,
    resultIndicator: null,
    resultCount: 0,
    purchaseCount,
    reach: 100,
    videoPlay3sCount: 50,
    videoPlay25Count: 10,
    videoPlay50Count: 5,
    videoPlay75Count: 2,
    videoPlay100Count: 1,
    frequency: null,
    costPerResultUsd: null,
    adsetBudgetLabel: null,
    adsetBudgetType: null,
    spendUsd: new Prisma.Decimal(spendUsd),
    endStatus: null,
    qualityRanking: null,
    engagementRateRanking: null,
    conversionRateRanking: null,
    impressions: BigInt(1000),
    cpmUsd: null,
    linkClicks: 10,
    shopClicks: 0,
    cpcLinkUsd: null,
    ctrLinkPct: null,
    clicksAll: 20,
    ctrAllPct: null,
    cpcAllUsd: null,
    landingPageViews: 5,
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
    createdAt: metricDate,
    ...overrides
  };
}
