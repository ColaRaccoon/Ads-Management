import { AdStage } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MetaAdsetMetricsReadService } from "./meta-adset-metrics-read.service";
import { DecoratedMetric } from "./metric-types";

describe("MetaAdsetMetricsReadService response and query contract", () => {
  it("returns product totals, averages, thresholds, and rule status", async () => {
    const calls: unknown[] = [];
    const rows = [decorated("2026-08-10", 10), decorated("2026-08-11", 5)];
    const decoration = {
      decoratedMetrics: async (...args: unknown[]) => {
        calls.push(args);
        return rows;
      },
      aggregate: () => aggregate()
    };
    const service = new MetaAdsetMetricsReadService({} as never, decoration as never);

    const result = await service.productMetrics("2026-08-10", "2026-08-11", "active");

    expect(result).toEqual([
      expect.objectContaining({
        productId: "product-1",
        product: expect.objectContaining({ id: "product-1", displayName: "Product" }),
        totals: expect.objectContaining({ spendUsd: 15, spendKrw: 19500, purchaseCount: 3 }),
        averages: { dailySpendKrw: 9750, dailyPurchaseCount: 1.5, dailyMarginKrw: 2500 },
        dataDays: 2,
        thresholds: expect.objectContaining({ targetCpaKrw: 10000, breakEvenCpaKrw: 15000 }),
        targetCpaKrw: 10000,
        breakEvenCpaKrw: 15000,
        watchCpaKrw: 12000,
        stopCpaKrw: 14000,
        ruleStatus: "OK"
      })
    ]);
    expect(calls[0]).toEqual([
      new Date("2026-08-10T00:00:00.000Z"),
      new Date("2026-08-11T00:00:00.000Z"),
      "active"
    ]);
  });

  it.each([
    ["UUID", "123e4567-e89b-42d3-a456-426614174000", { campaignRefId: "123e4567-e89b-42d3-a456-426614174000" }],
    ["external ID", "campaign-external", { campaign: { externalCampaignId: "campaign-external" } }]
  ])("keeps isCurrent/date/delivery and %s campaign filtering for adset rows", async (_label, campaignId, expectedCampaignWhere) => {
    const findManyCalls: Array<{ where: Record<string, unknown> }> = [];
    const prisma = {
      metaAdsetDailyMetric: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          findManyCalls.push(args);
          return [{}];
        }
      }
    };
    const decoration = {
      decorate: async () => [decorated("2026-08-10", 10)],
      aggregate: () => aggregate()
    };
    const service = new MetaAdsetMetricsReadService(prisma as never, decoration as never);

    const result = await service.adsetMetrics({
      from: "2026-08-10",
      to: "2026-08-11",
      campaignId,
      productId: "product-1",
      stage: AdStage.SC,
      deliveryStatus: "inactive"
    });

    expect(findManyCalls[0].where).toMatchObject({
      isCurrent: true,
      metricDate: { gte: new Date("2026-08-10T00:00:00.000Z"), lte: new Date("2026-08-11T00:00:00.000Z") },
      deliveryStatus: { equals: "inactive", mode: "insensitive" },
      productId: "product-1",
      stage: AdStage.SC,
      metaAdset: expectedCampaignWhere
    });
    expect(result).toEqual([
      expect.objectContaining({
        metaAdsetId: "adset-ref-1",
        adsetName: "Adset",
        product: expect.objectContaining({ id: "product-1" }),
        stage: AdStage.SC,
        deliveryStatus: "active",
        totals: expect.objectContaining({ spendUsd: 15, purchaseCount: 3 }),
        dataDays: 2,
        thresholds: expect.objectContaining({ targetCpaKrw: 10000 }),
        ruleStatus: "OK",
        cpaDeltaVsPreviousDay: null,
        firstSeenOn: "2026-08-01",
        lastSeenOn: "2026-08-10"
      })
    ]);
  });

  it("returns unmatched rows with the current/date/delivery filters intact", async () => {
    let query: Record<string, unknown> | null = null;
    const unmatched = [{ id: "metric-unmatched", productId: null }];
    const prisma = {
      metaAdsetDailyMetric: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          query = args.where;
          return unmatched;
        }
      }
    };
    const service = new MetaAdsetMetricsReadService(prisma as never, {} as never);

    const result = await service.unmatchedMetrics("2026-08-10", "2026-08-11", "all");

    expect(result).toBe(unmatched);
    expect(query).toMatchObject({
      isCurrent: true,
      metricDate: { gte: new Date("2026-08-10T00:00:00.000Z"), lte: new Date("2026-08-11T00:00:00.000Z") },
      productId: null
    });
    expect(query).not.toHaveProperty("deliveryStatus");
  });
});

function decorated(metricDate: string, spendUsd: number): DecoratedMetric {
  return {
    metricDate,
    spendUsd,
    purchaseCount: metricDate.endsWith("10") ? 1 : 2,
    spendKrw: spendUsd * 1300,
    revenueKrw: 20000,
    marginKrw: 2500,
    cpaKrw: 6500,
    cpaUsd: 5,
    ruleStatus: "OK",
    thresholds: {
      targetCpaKrw: 10000,
      breakEvenCpaKrw: 15000,
      watchCpaKrw: 12000,
      stopCpaKrw: 14000,
      contributionBeforeAdsKrw: 15000
    },
    costRule: {} as never,
    cpaRule: {} as never,
    exchangeRate: null,
    metric: {
      metaAdsetId: "adset-ref-1",
      adsetName: "Adset",
      productId: "product-1",
      product: { id: "product-1", displayName: "Product" },
      stage: AdStage.SC,
      deliveryStatus: "active",
      metaAdset: {
        firstSeenOn: new Date("2026-08-01T00:00:00.000Z"),
        lastSeenOn: new Date("2026-08-10T00:00:00.000Z")
      }
    } as never
  };
}

function aggregate() {
  return {
    totals: {
      spendUsd: 15,
      spendKrw: 19500,
      purchaseCount: 3,
      marginKrw: 5000,
      cpaKrw: 6500
    },
    dataDays: 2
  };
}
