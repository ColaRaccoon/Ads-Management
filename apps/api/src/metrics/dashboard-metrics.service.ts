import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { dateRangeDays, parseDateRange } from "../common/date-range";
import { ComparisonCalculator } from "../domain/comparison-calculator";
import { parseDeliveryStatusFilter } from "./metric-filters";
import { divideOrNull } from "./meta-ad-metric-aggregates";
import { shiftRange } from "./meta-adset-metric-aggregates";
import { MetaAdsetMetricDecorationService } from "./meta-adset-metric-decoration.service";
import { aggregateDashboardMetrics, compareMoney, divideMoney, type DashboardMetricRow } from "./dashboard-decimal-metrics";
import { metaCollectionSummary } from "../common/meta-collection-summary";

@Injectable()
export class DashboardMetricsService {
  private readonly comparisonCalculator = new ComparisonCalculator();

  constructor(
    private readonly prisma: PrismaService,
    private readonly decorationService: MetaAdsetMetricDecorationService
  ) {}

  metaCollection(from?: string, to?: string, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const range = parseDateRange(from, to);
    return metaCollectionSummary(client, range.fromDate, range.toDate);
  }

  async dashboardSummary(
    from?: string,
    to?: string,
    compare?: string,
    deliveryStatusInput?: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma
  ) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const range = parseDateRange(from, to);
    const selectedDays = dateRangeDays(range.from, range.to);
    const previousDayRange = shiftRange(range.toDate, range.toDate, -1);
    const previousSamePeriodRange = shiftRange(range.fromDate, range.toDate, -selectedDays);
    const firstDayRange = { fromDate: range.fromDate, toDate: range.fromDate };
    const lastDayRange = { fromDate: range.toDate, toDate: range.toDate };

    // Current and previous periods are contiguous. Decorate once using each
    // row's own date/rules, then aggregate attribution and money per period.
    const combinedRows = await this.decorationService.dashboardMetrics(
        previousSamePeriodRange.fromDate,
        range.toDate,
        deliveryStatus,
        client,
        [range, previousSamePeriodRange],
        false
    );
    // Reuse rows already decorated for their own metric date. These windows
    // are subsets of the selected period (or the preceding one-day period),
    // so repeated DB reads add no calculation inputs and can observe a later
    // current version within the same dashboard response.
    const rowsIn = (rows: DashboardMetricRow[], window: { fromDate: Date; toDate: Date }) =>
      rows.filter(row => row.metric.metricDate >= window.fromDate && row.metric.metricDate <= window.toDate);
    const decorated = rowsIn(combinedRows, range);
    const previousPeriodRows = rowsIn(combinedRows, previousSamePeriodRange);
    const aggregate = aggregateDashboardMetrics(decorated);
    const [health, decisions, metaCollection] = await Promise.all([
      this.health(range.fromDate, range.toDate, decorated, client),
      this.decisionSummary(range.fromDate, range.toDate, client),
      metaCollectionSummary(client, range.fromDate, range.toDate)
    ]);
    const previousDay = aggregateDashboardMetrics(rowsIn(selectedDays === 1 ? previousPeriodRows : decorated, previousDayRange));
    const previousSamePeriod = aggregateDashboardMetrics(previousPeriodRows);
    const firstDay = aggregateDashboardMetrics(rowsIn(decorated, firstDayRange));
    const lastDay = aggregateDashboardMetrics(rowsIn(decorated, lastDayRange));

    return {
      selectedPeriod: {
        from: range.from,
        to: range.to,
        selectedDays,
        dataDays: aggregate.dataDays
      },
      totals: aggregate.totals,
      averages: {
        dailySpendKrw: divideMoney(aggregate.totals.spendKrw, aggregate.dataDays),
        dailyPurchaseCount: divideOrNull(aggregate.totals.purchaseCount, aggregate.dataDays),
        dailyMarginKrw: divideMoney(aggregate.totals.marginKrw, aggregate.dataDays)
      },
      comparisons: {
        previousDay: this.compareAggregate(aggregate, previousDay),
        previousSamePeriod: this.compareAggregate(aggregate, previousSamePeriod),
        firstDay: this.compareAggregate(lastDay, firstDay)
      },
      health,
      metaCollection,
      decisions,
      compare: compare ?? "previousSamePeriod"
    };
  }

  async dashboardTrends(from?: string, to?: string, groupByInput = "date", deliveryStatusInput?: string) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const range = parseDateRange(from, to);
    const decorated = await this.decorationService.dashboardMetrics(
      range.fromDate, range.toDate, deliveryStatus, this.prisma, undefined, groupByInput === "product"
    );
    const groups = new Map<string, DashboardMetricRow[]>();
    for (const row of decorated) {
      const key =
        groupByInput === "stage"
          ? `${row.metricDate}:${row.metric.stage}`
          : groupByInput === "product"
            ? `${row.metricDate}:${row.metric.product?.displayName ?? "미매칭"}`
            : row.metricDate;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    return Array.from(groups.entries())
      .map(([key, rows]) => {
        const [date, group] = key.split(":");
        const aggregate = aggregateDashboardMetrics(rows);
        return {
          date,
          group: group ?? "all",
          metricUnavailableReasons: aggregate.totals.metricUnavailableReasons,
          hasApiMetrics: aggregate.totals.hasApiMetrics, attributionContexts: aggregate.totals.attributionContexts,
          spendUsd: aggregate.totals.spendUsd,
          spendKrw: aggregate.totals.spendKrw,
          purchaseCount: aggregate.totals.purchaseCount,
          cpaKrw: aggregate.totals.cpaKrw,
          cpaUsd: aggregate.totals.cpaUsd,
          marginKrw: aggregate.totals.marginKrw,
          revenueKrw: aggregate.totals.revenueKrw,
          ctrLinkPct: aggregate.totals.ctrLinkPct,
          cpcLinkUsd: aggregate.totals.cpcLinkUsd
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async health(
    fromDate: Date,
    toDate: Date,
    decorated: DashboardMetricRow[],
    client: PrismaService | Prisma.TransactionClient = this.prisma
  ) {
    const unmatchedCount = decorated.filter((row) => row.ruleStatus === "UNMATCHED").length;
    const missingCostRuleProducts = new Set(
      decorated
        .filter((row) => row.ruleStatus === "MISSING_COST_RULE" || row.ruleStatus === "MISSING_RULES")
        .map((row) => row.metric.productId)
        .filter(Boolean)
    );
    const missingCpaRuleProducts = new Set(
      decorated
        .filter((row) => row.metric.productId && !row.cpaRule)
        .map((row) => row.metric.productId)
        .filter(Boolean)
    );
    const missingExchangeRateDates = new Set(
      decorated.filter((row) => row.ruleStatus === "MISSING_EXCHANGE_RATE").map((row) => row.metricDate)
    );
    const uploadErrorCount = await client.uploadRowError.count({
      where: { batch: { reportStart: { lte: toDate }, reportEnd: { gte: fromDate } } }
    });
    return {
      unmatchedCount,
      missingCostRuleCount: missingCostRuleProducts.size,
      missingCpaRuleCount: missingCpaRuleProducts.size,
      missingExchangeRateCount: missingExchangeRateDates.size,
      uploadErrorCount
    };
  }

  async decisionSummary(
    fromDate: Date,
    toDate: Date,
    client: PrismaService | Prisma.TransactionClient = this.prisma
  ) {
    const logs = await client.decisionLog.findMany({
      where: { periodStart: fromDate, periodEnd: toDate },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: 20
    });
    const counts = logs.reduce<Record<string, number>>((acc, log) => {
      acc[log.decision] = (acc[log.decision] ?? 0) + 1;
      return acc;
    }, {});
    return { counts, topRecommendations: logs.slice(0, 8) };
  }

  private compareAggregate(
    current: ReturnType<typeof aggregateDashboardMetrics>,
    previous: ReturnType<typeof aggregateDashboardMetrics>
  ) {
    return {
      spendKrw: compareMoney(current.totals.spendKrw, previous.totals.spendKrw),
      purchaseCount: this.comparisonCalculator.compare(current.totals.purchaseCount, previous.totals.purchaseCount),
      cpaKrw: compareMoney(current.totals.cpaKrw, previous.totals.cpaKrw),
      marginKrw: compareMoney(current.totals.marginKrw, previous.totals.marginKrw)
    };
  }
}
