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

  it("calculates each creative's net profit with its dated product costs and exchange rate", async () => {
    const metricDate = new Date("2026-08-10T00:00:00.000Z");
    const prisma = {
      metaAdDailyMetric: {
        findMany: async () => [
          adMetric("metric-1", 10, 2, { adNameSnapshot: "260810_웨이브바_01" })
        ]
      },
      productCostRule: {
        findMany: async () => [{
          id: "cost-1",
          productId: "product-1",
          salePriceKrw: new Prisma.Decimal(30_000),
          vatKrw: new Prisma.Decimal(3_000),
          productCostKrw: new Prisma.Decimal(10_000),
          shippingKrw: new Prisma.Decimal(2_000),
          extraCostKrw: new Prisma.Decimal(500),
          fxRateKrwPerUsd: new Prisma.Decimal(0),
          effectiveFrom: metricDate,
          effectiveTo: null,
          note: null,
          createdAt: metricDate
        }]
      },
      exchangeRate: {
        findMany: async () => [{
          rateDate: metricDate,
          rate: new Prisma.Decimal(1_300)
        }]
      },
      creative: { findMany: async () => [] }
    };
    const service = new MetaAdMetricsReadService(prisma as never);

    const result = await service.creativeMetrics({ from: "2026-08-10", to: "2026-08-10" });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      productId: "product-1",
      productName: "웨이브바",
      materialNo: "01",
      totals: {
        spendUsd: 10,
        spendKrw: 13_000,
        purchaseCount: 2,
        revenueKrw: 60_000,
        marginKrw: 16_000
      }
    });
  });

  it("does not publish a creative net profit when a sale has no matching cost rule", async () => {
    const prisma = {
      metaAdDailyMetric: {
        findMany: async () => [adMetric("metric-1", 10, 1)]
      },
      productCostRule: { findMany: async () => [] },
      exchangeRate: {
        findMany: async () => [{
          rateDate: new Date("2026-08-10T00:00:00.000Z"),
          rate: new Prisma.Decimal(1_300)
        }]
      },
      creative: { findMany: async () => [] }
    };
    const service = new MetaAdMetricsReadService(prisma as never);

    const result = await service.creativeMetrics({ from: "2026-08-10", to: "2026-08-10" });

    expect(result[0].totals).toMatchObject({
      spendKrw: 13_000,
      purchaseCount: 1,
      revenueKrw: null,
      marginKrw: null
    });
  });

  it("requires a UUID productId before querying creative video trends", async () => {
    let queryCount = 0;
    const prisma = {
      metaAdDailyMetric: {
        findMany: async () => {
          queryCount += 1;
          return [];
        }
      }
    };
    const service = new MetaAdMetricsReadService(prisma as never);

    await expect(service.creativeVideoTrends({ from: "2026-08-10", to: "2026-08-11" }))
      .rejects.toMatchObject({ response: { code: "PRODUCT_ID_REQUIRED" } });
    await expect(service.creativeVideoTrends({
      from: "2026-08-10",
      to: "2026-08-11",
      productId: "product-1"
    })).rejects.toMatchObject({ response: { code: "INVALID_PRODUCT_ID" } });
    expect(queryCount).toBe(0);
  });

  it("groups creative video trends by parsed creative and date with weighted rates", async () => {
    const productId = "123e4567-e89b-42d3-a456-426614174000";
    const queries: Array<Record<string, unknown>> = [];
    const prisma = {
      metaAdDailyMetric: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          queries.push(where);
          return [
            adMetric("material-10-later", 0, 0, {
              metricDate: new Date("2026-08-11T00:00:00.000Z"),
              adIdentityKey: "ad-10-c",
              metaAdId: "ad-10-c",
              adNameSnapshot: "260810_웨이브바_10_IG",
              productId,
              reach: 100,
              videoPlay3sCount: 0,
              videoPlay25Count: 0,
              videoPlay50Count: 0,
              videoPlay75Count: 0,
              videoPlay100Count: 0
            }),
            adMetric("material-2", 0, 0, {
              adIdentityKey: "ad-2",
              metaAdId: "ad-2",
              adNameSnapshot: "260810_웨이브바_2_IG",
              productId,
              reach: 50,
              videoPlay3sCount: 25
            }),
            adMetric("material-10-a", 0, 0, {
              adIdentityKey: "ad-10-a",
              metaAdId: "ad-10-a",
              adNameSnapshot: "260810_웨이브바_10_IG",
              productId,
              reach: 100,
              videoPlay3sCount: 50,
              videoPlay25Count: 10,
              videoPlay50Count: null,
              videoPlay75Count: 2,
              videoPlay100Count: 1
            }),
            adMetric("material-10-b", 0, 0, {
              adIdentityKey: "ad-10-b",
              metaAdId: "ad-10-b",
              adNameSnapshot: "260810_웨이브바_10_FB",
              productId,
              reach: 300,
              videoPlay3sCount: 75,
              videoPlay25Count: 30,
              videoPlay50Count: 15,
              videoPlay75Count: 6,
              videoPlay100Count: 3
            }),
            adMetric("material-10-zero-reach", 0, 0, {
              adIdentityKey: "ad-10-d",
              metaAdId: "ad-10-d",
              adNameSnapshot: "260810_웨이브바_10_IG",
              productId,
              reach: 0,
              videoPlay3sCount: null,
              videoPlay25Count: null,
              videoPlay50Count: null,
              videoPlay75Count: null,
              videoPlay100Count: null
            })
          ];
        }
      }
    };
    const service = new MetaAdMetricsReadService(prisma as never);

    const result = await service.creativeVideoTrends({
      from: "2026-08-10",
      to: "2026-08-11",
      productId,
      deliveryStatus: "active"
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      isCurrent: true,
      metricDate: {
        gte: new Date("2026-08-10T00:00:00.000Z"),
        lte: new Date("2026-08-11T00:00:00.000Z")
      },
      productId,
      adDeliveryStatus: { equals: "active", mode: "insensitive" }
    });
    expect(result.period).toEqual({
      from: "2026-08-10",
      to: "2026-08-11",
      selectedDays: 2,
      dataDays: 2
    });
    expect(result.creatives.map((creative) => creative.materialNo)).toEqual(["2", "10"]);
    expect(result.creatives[1]).toMatchObject({
      creativeKey: "웨이브바_10",
      displayName: "웨이브바_10",
      productName: "웨이브바",
      materialNo: "10",
      deliveryStatus: "active",
      originalAdNames: ["260810_웨이브바_10_FB", "260810_웨이브바_10_IG"],
      dataDays: 2,
      points: [
        {
          date: "2026-08-10",
          reach: 400,
          videoPlay3sRatePct: 31.25,
          videoPlay25RatePct: 10,
          videoPlay50RatePct: null,
          videoPlay75RatePct: 2,
          videoPlay100RatePct: 1
        },
        {
          date: "2026-08-11",
          reach: 100,
          videoPlay3sRatePct: 0,
          videoPlay25RatePct: 0,
          videoPlay50RatePct: 0,
          videoPlay75RatePct: 0,
          videoPlay100RatePct: 0
        }
      ]
    });
  });

  it("returns an empty creative video trend response without extra context queries", async () => {
    const productId = "123e4567-e89b-42d3-a456-426614174000";
    const prisma = {
      metaAdDailyMetric: { findMany: async () => [] }
    };
    const service = new MetaAdMetricsReadService(prisma as never);

    await expect(service.creativeVideoTrends({
      from: "2026-08-10",
      to: "2026-08-12",
      productId
    })).resolves.toEqual({
      productId,
      period: { from: "2026-08-10", to: "2026-08-12", selectedDays: 3, dataDays: 0 },
      creatives: []
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
