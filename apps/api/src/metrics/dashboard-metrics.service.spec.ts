import { AdStage, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PeriodMetricCalculator } from "../domain/period-metric-calculator";
import { DashboardMetricsService } from "./dashboard-metrics.service";
import { aggregateDecoratedMetrics } from "./meta-adset-metric-aggregates";
import { MetaAdsetMetricDecorationService } from "./meta-adset-metric-decoration.service";
import { DecoratedMetric } from "./metric-types";

const periodCalculator = new PeriodMetricCalculator();

describe("DashboardMetricsService response contract", () => {
  it("assembles summary totals, comparisons, health, and decisions for the requested filter", async () => {
    const calls: Array<{ from: Date; to: Date; deliveryStatus?: string }> = [];
    const decoration = {
      decoratedMetrics: async (from: Date, to: Date, deliveryStatus?: string) => {
        calls.push({ from, to, deliveryStatus });
        return [decorated(format(from), 10)];
      },
      aggregate: (rows: DecoratedMetric[]) => aggregateDecoratedMetrics(periodCalculator, rows)
    };
    const prisma = {
      uploadRowError: { count: async () => 4 },
      decisionLog: {
        findMany: async () => [{ decision: "KEEP", severity: "LOW", createdAt: new Date("2026-08-10T00:00:00.000Z") }]
      }
    };
    const service = new DashboardMetricsService(prisma as never, decoration as never);

    const result = await service.dashboardSummary("2026-08-10", "2026-08-11", "previousDay", "inactive");

    expect(result).toMatchObject({
      selectedPeriod: { from: "2026-08-10", to: "2026-08-11", selectedDays: 2, dataDays: 1 },
      totals: { spendUsd: 10, spendKrw: 13000, purchaseCount: 2, cpaKrw: 6500 },
      averages: { dailySpendKrw: 13000, dailyPurchaseCount: 2, dailyMarginKrw: 5000 },
      comparisons: {
        previousDay: { spendKrw: expect.objectContaining({ current: 13000 }) },
        previousSamePeriod: { purchaseCount: expect.objectContaining({ current: 2 }) },
        firstDay: { marginKrw: expect.objectContaining({ current: 5000 }) }
      },
      health: {
        unmatchedCount: 0,
        missingCostRuleCount: 0,
        missingCpaRuleCount: 0,
        missingExchangeRateCount: 0,
        uploadErrorCount: 4
      },
      decisions: { counts: { KEEP: 1 }, topRecommendations: [expect.objectContaining({ decision: "KEEP" })] },
      compare: "previousDay"
    });
    expect(calls).toHaveLength(5);
    expect(calls[0]).toMatchObject({
      from: new Date("2026-08-10T00:00:00.000Z"),
      to: new Date("2026-08-11T00:00:00.000Z"),
      deliveryStatus: "inactive"
    });
  });

  it("groups dashboard trends without changing their response fields", async () => {
    const decoration = {
      decoratedMetrics: async () => [
        decorated("2026-08-10", 10, "Product A"),
        decorated("2026-08-10", 5, "Product A")
      ],
      aggregate: (rows: DecoratedMetric[]) => aggregateDecoratedMetrics(periodCalculator, rows)
    };
    const service = new DashboardMetricsService({} as never, decoration as never);

    const result = await service.dashboardTrends("2026-08-10", "2026-08-10", "product", "all");

    expect(result).toEqual([
      expect.objectContaining({
        date: "2026-08-10",
        group: "Product A",
        spendUsd: 15,
        spendKrw: 19500,
        purchaseCount: 4,
        cpaKrw: 4875,
        cpaUsd: 3.75,
        marginKrw: 10000,
        revenueKrw: 30000,
        ctrLinkPct: 10,
        cpcLinkUsd: 0.75
      })
    ]);
  });

  it("uses the real decoration query with current/date/delivery filters", async () => {
    const metricQueries: Array<Record<string, unknown>> = [];
    const metricDate = new Date("2026-08-10T00:00:00.000Z");
    const prisma = {
      metaAdsetDailyMetric: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          metricQueries.push(where);
          return [{
            id: "metric-1",
            metricDate,
            metaAdsetId: "adset-ref-1",
            adsetName: "Adset",
            deliveryStatus: "inactive",
            productId: null,
            product: null,
            metaAdset: { id: "adset-ref-1", firstSeenOn: metricDate, lastSeenOn: metricDate },
            stage: AdStage.SC,
            spendUsd: new Prisma.Decimal(10),
            resultCount: 2,
            impressions: BigInt(100),
            linkClicks: 10,
            clicksAll: 12,
            landingPageViews: 8
          }];
        }
      },
      metaAdDailyMetric: { findMany: async () => [] },
      productCostRule: { findMany: async () => [] },
      productCpaRule: { findMany: async () => [] },
      exchangeRate: { findMany: async () => [] },
      uploadRowError: { count: async () => 0 },
      decisionLog: { findMany: async () => [] }
    };
    const decoration = new MetaAdsetMetricDecorationService(prisma as never);
    const service = new DashboardMetricsService(prisma as never, decoration);

    const result = await service.dashboardSummary("2026-08-10", "2026-08-10", undefined, "inactive");

    expect(result.totals).toMatchObject({ spendUsd: 10, purchaseCount: 2, cpaUsd: 5 });
    expect(metricQueries[0]).toMatchObject({
      isCurrent: true,
      metricDate: { gte: metricDate, lte: metricDate },
      deliveryStatus: { equals: "inactive", mode: "insensitive" }
    });
  });
});

function decorated(metricDate: string, spendUsd: number, productName = "Product"): DecoratedMetric {
  return {
    metricDate,
    spendUsd,
    purchaseCount: 2,
    spendKrw: spendUsd * 1300,
    revenueKrw: spendUsd * 2000,
    marginKrw: 5000,
    cpaKrw: spendUsd * 650,
    cpaUsd: spendUsd / 2,
    ruleStatus: "OK",
    thresholds: null,
    costRule: {} as never,
    cpaRule: {} as never,
    exchangeRate: null,
    metric: {
      productId: "product-1",
      product: { displayName: productName },
      stage: AdStage.SC,
      impressions: BigInt(100),
      linkClicks: 10,
      clicksAll: 12,
      landingPageViews: 8
    } as never
  };
}

function format(date: Date) {
  return date.toISOString().slice(0, 10);
}
