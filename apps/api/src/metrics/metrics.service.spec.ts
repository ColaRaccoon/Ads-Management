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

function fakeMetricsPrisma(input: { costRuleFxRateKrwPerUsd: number; costRuleVatKrw?: number; exchangeRates: unknown[] }) {
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
