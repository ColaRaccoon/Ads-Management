import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { AdStage, Prisma } from "@prisma/client";
import { deliveryStatusWhere, MetricsService, parseDeliveryStatusFilter } from "./metrics.service";
import { toDateOnly } from "../domain/date-number";

describe("MetricsService exchange rate fallback", () => {
  it("does not calculate with a zero legacy FX rate when DB exchange rate is missing", async () => {
    const prisma = fakeMetricsPrisma({
      costRuleFxRateKrwPerUsd: 0,
      exchangeRates: []
    });
    const service = new MetricsService(prisma as never);

    const rows = await service.decoratedMetrics(date("2026-05-29"), date("2026-05-29"));

    expect(rows[0].ruleStatus).toBe("MISSING_EXCHANGE_RATE");
    expect(rows[0].spendKrw).toBeNull();
    expect(rows[0].marginKrw).toBeNull();
  });

  it("allows positive legacy FX only as a fallback when DB exchange rate is missing", async () => {
    const prisma = fakeMetricsPrisma({
      costRuleFxRateKrwPerUsd: 1300,
      exchangeRates: []
    });
    const service = new MetricsService(prisma as never);

    const rows = await service.decoratedMetrics(date("2026-05-29"), date("2026-05-29"));

    expect(rows[0].ruleStatus).toBe("OK");
    expect(rows[0].spendKrw).toBe(13000);
  });

  it("calculates VAT as 10% of sale price instead of using stored rule VAT", async () => {
    const prisma = fakeMetricsPrisma({
      costRuleFxRateKrwPerUsd: 1300,
      costRuleVatKrw: 0,
      exchangeRates: []
    });
    const service = new MetricsService(prisma as never);

    const rows = await service.decoratedMetrics(date("2026-05-29"), date("2026-05-29"));

    expect(rows[0].marginKrw).toBe(16000);
    expect(rows[0].thresholds?.contributionBeforeAdsKrw).toBe(29000);
  });

  it("corrects adset purchase totals from ad-level custom conversion results", async () => {
    const prisma = fakeMetricsPrisma({
      costRuleFxRateKrwPerUsd: 1300,
      exchangeRates: [],
      adMetrics: [
        {
          metaAdsetRefId: "adset-1",
          metricDate: date("2026-05-29"),
          resultIndicator: "actions:offsite_conversion.custom.1532866761891806",
          resultCount: 5,
          purchaseCount: 0
        }
      ]
    });
    const service = new MetricsService(prisma as never);

    const rows = await service.decoratedMetrics(date("2026-05-29"), date("2026-05-29"));
    const aggregate = service.aggregate(rows);

    expect(aggregate.totals.purchaseCount).toBe(5);
    expect(rows[0].marginKrw).toBe(132000);
  });
});

describe("deliveryStatus filter", () => {
  it("defaults to active and normalizes supported values", () => {
    expect(parseDeliveryStatusFilter()).toBe("active");
    expect(parseDeliveryStatusFilter(" Active ")).toBe("active");
    expect(parseDeliveryStatusFilter("inactive")).toBe("inactive");
    expect(parseDeliveryStatusFilter("ALL")).toBe("all");
  });

  it("rejects unknown deliveryStatus values", () => {
    expect(() => parseDeliveryStatusFilter("paused")).toThrow(BadRequestException);
  });

  it("builds a case-insensitive Prisma filter except for all", () => {
    expect(deliveryStatusWhere("all")).toEqual({});
    expect(deliveryStatusWhere("inactive")).toEqual({
      deliveryStatus: { equals: "inactive", mode: "insensitive" }
    });
  });
});

describe("creativeMetrics", () => {
  it("uses the creative lifetime for dataDays instead of the selected date range", async () => {
    const prisma = fakeCreativeMetricsPrisma();
    const service = new MetricsService(prisma as never);

    const rows = await service.creativeMetrics({ from: "2026-06-08", to: "2026-06-08" });

    expect(rows[0].dataDays).toBe(8);
    expect(rows[0].totals.dataDays).toBe(1);
    expect(rows[0].firstSeenOn).toBe("2026-06-01");
    expect(rows[0].lastSeenOn).toBe("2026-06-08");
  });

  it("returns KRW spend, KRW CPA, KRW revenue, and ROAS for creative totals", async () => {
    const prisma = fakeCreativeMetricsPrisma();
    const service = new MetricsService(prisma as never);

    const rows = await service.creativeMetrics({ from: "2026-06-08", to: "2026-06-08" });

    expect(rows[0].totals.spendKrw).toBe(13000);
    expect(rows[0].totals.cpaKrw).toBe(13000);
    expect(rows[0].totals.revenueKrw).toBe(50000);
    expect(rows[0].totals.roas).toBeCloseTo(50000 / 13000, 6);
  });

  it("nulls aggregate KRW spend, KRW CPA, and ROAS when any spend row cannot calculate KRW", async () => {
    const prisma = fakeCreativeMetricsPrisma({
      adMetrics: [
        creativeAdMetric({ spendUsd: new Prisma.Decimal(10), purchaseCount: 1, productId: "product-1" }),
        creativeAdMetric({
          adIdentityKey: "ad-2",
          spendUsd: new Prisma.Decimal(5),
          purchaseCount: 0,
          productId: "product-without-rate"
        })
      ],
      exchangeRates: []
    });
    const service = new MetricsService(prisma as never);

    const rows = await service.creativeMetrics({ from: "2026-06-08", to: "2026-06-08" });

    expect(rows[0].totals.spendKrw).toBeNull();
    expect(rows[0].totals.cpaKrw).toBeNull();
    expect(rows[0].totals.revenueKrw).toBe(50000);
    expect(rows[0].totals.roas).toBeNull();
  });

  it("nulls aggregate revenue and ROAS when any purchase row cannot calculate revenue", async () => {
    const prisma = fakeCreativeMetricsPrisma({
      adMetrics: [
        creativeAdMetric({ spendUsd: new Prisma.Decimal(10), purchaseCount: 1, productId: "product-1" }),
        creativeAdMetric({
          adIdentityKey: "ad-2",
          spendUsd: new Prisma.Decimal(0),
          purchaseCount: 1,
          productId: "product-without-cost"
        })
      ]
    });
    const service = new MetricsService(prisma as never);

    const rows = await service.creativeMetrics({ from: "2026-06-08", to: "2026-06-08" });

    expect(rows[0].totals.spendKrw).toBe(13000);
    expect(rows[0].totals.cpaKrw).toBe(6500);
    expect(rows[0].totals.revenueKrw).toBeNull();
    expect(rows[0].totals.roas).toBeNull();
  });
});

function fakeCreativeMetricsPrisma(
  input: { adMetrics?: unknown[]; costRules?: unknown[]; exchangeRates?: unknown[] } = {}
) {
  return {
    metaAdDailyMetric: {
      findMany: async () => input.adMetrics ?? [creativeAdMetric()]
    },
    creative: {
      findMany: async () => [
        {
          creativeKey: "버닝웨이브바_04",
          firstSeenOn: date("2026-06-01"),
          lastSeenOn: date("2026-06-08")
        }
      ]
    },
    productCostRule: {
      findMany: async () => input.costRules ?? [creativeCostRule()]
    },
    exchangeRate: {
      findMany: async () => input.exchangeRates ?? [creativeExchangeRate()]
    }
  };
}

function creativeAdMetric(overrides: Record<string, unknown> = {}) {
  return {
    metricDate: date("2026-06-08"),
    creativeId: "creative-1",
    metaCampaignId: "campaign-1",
    metaAdsetId: "adset-1",
    adIdentityKey: "ad-1",
    adNameSnapshot: "260601_버닝웨이브바_04",
    adDeliveryStatus: "active",
    spendUsd: new Prisma.Decimal(10),
    resultIndicator: null,
    resultCount: 0,
    purchaseCount: 1,
    impressions: BigInt(1000),
    linkClicks: 20,
    clicksAll: 30,
    landingPageViews: 5,
    productId: "product-1",
    ...overrides
  };
}

function creativeCostRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "cost-rule-1",
    productId: "product-1",
    salePriceKrw: new Prisma.Decimal(50000),
    vatKrw: new Prisma.Decimal(5000),
    productCostKrw: new Prisma.Decimal(12000),
    shippingKrw: new Prisma.Decimal(3000),
    extraCostKrw: new Prisma.Decimal(1000),
    fxRateKrwPerUsd: new Prisma.Decimal(1200),
    effectiveFrom: date("2026-01-01"),
    effectiveTo: null,
    ...overrides
  };
}

function creativeExchangeRate(overrides: Record<string, unknown> = {}) {
  return {
    rateDate: date("2026-06-08"),
    rate: new Prisma.Decimal(1300),
    ...overrides
  };
}

function fakeMetricsPrisma(input: {
  costRuleFxRateKrwPerUsd: number;
  costRuleVatKrw?: number;
  exchangeRates: unknown[];
  adMetrics?: Array<{
    metaAdsetRefId: string;
    metricDate: Date;
    resultIndicator: string | null;
    resultCount: number;
    purchaseCount: number;
  }>;
}) {
  const metricDate = date("2026-05-29");
  return {
    metaAdsetDailyMetric: {
      findMany: async () => [
        {
          id: "metric-1",
          productId: "product-1",
          metricDate,
          spendUsd: new Prisma.Decimal(10),
          resultCount: 1,
          impressions: BigInt(1000),
          linkClicks: 10,
          clicksAll: 20,
          landingPageViews: 3,
          stage: AdStage.SC,
          metaAdsetId: "adset-1",
          adsetName: "SC test",
          metaAdset: { id: "adset-1", firstSeenOn: metricDate, lastSeenOn: metricDate },
          product: { id: "product-1", displayName: "Product" }
        }
      ]
    },
    metaAdDailyMetric: {
      findMany: async () => input.adMetrics ?? []
    },
    productCostRule: {
      findMany: async () => [
        {
          id: "cost-rule-1",
          productId: "product-1",
          salePriceKrw: new Prisma.Decimal(50000),
          vatKrw: new Prisma.Decimal(input.costRuleVatKrw ?? 5000),
          productCostKrw: new Prisma.Decimal(12000),
          shippingKrw: new Prisma.Decimal(3000),
          extraCostKrw: new Prisma.Decimal(1000),
          fxRateKrwPerUsd: new Prisma.Decimal(input.costRuleFxRateKrwPerUsd),
          effectiveFrom: date("2026-01-01"),
          effectiveTo: null
        }
      ]
    },
    productCpaRule: {
      findMany: async () => [
        {
          id: "cpa-rule-1",
          productId: "product-1",
          targetRatio: new Prisma.Decimal(0.8),
          watchRatio: new Prisma.Decimal(1.1),
          stopRatio: new Prisma.Decimal(1.25),
          effectiveFrom: date("2026-01-01"),
          effectiveTo: null
        }
      ]
    },
    exchangeRate: {
      findMany: async () => input.exchangeRates
    }
  };
}

function date(value: string) {
  const parsed = toDateOnly(value);
  if (!parsed) {
    throw new Error(`Invalid test date: ${value}`);
  }
  return parsed;
}
