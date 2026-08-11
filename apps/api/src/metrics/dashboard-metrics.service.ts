import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { dateRangeDays, parseDateRange } from "../common/date-range";
import { ComparisonCalculator } from "../domain/comparison-calculator";
import { parseDeliveryStatusFilter } from "./metric-filters";
import { divideOrNull } from "./meta-ad-metric-aggregates";
import { shiftRange } from "./meta-adset-metric-aggregates";
import { MetaAdsetMetricDecorationService } from "./meta-adset-metric-decoration.service";
import { DecoratedMetric } from "./metric-types";

@Injectable()
export class DashboardMetricsService {
  private readonly comparisonCalculator = new ComparisonCalculator();

  constructor(
    private readonly prisma: PrismaService,
    private readonly decorationService: MetaAdsetMetricDecorationService
  ) {}

  async dashboardSummary(from?: string, to?: string, compare?: string, deliveryStatusInput?: string) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const range = parseDateRange(from, to);
    const decorated = await this.decorationService.decoratedMetrics(range.fromDate, range.toDate, deliveryStatus);
    const aggregate = this.decorationService.aggregate(decorated);
    const selectedDays = dateRangeDays(range.from, range.to);
    const health = await this.health(range.fromDate, range.toDate, decorated);
    const decisions = await this.decisionSummary(range.fromDate, range.toDate);

    const previousDayRange = shiftRange(range.toDate, range.toDate, -1);
    const previousSamePeriodRange = shiftRange(range.fromDate, range.toDate, -selectedDays);
    const firstDayRange = { fromDate: range.fromDate, toDate: range.fromDate };
    const lastDayRange = { fromDate: range.toDate, toDate: range.toDate };

    const [previousDay, previousSamePeriod, firstDay, lastDay] = await Promise.all([
      this.decorationService.aggregate(
        await this.decorationService.decoratedMetrics(previousDayRange.fromDate, previousDayRange.toDate, deliveryStatus)
      ),
      this.decorationService.aggregate(
        await this.decorationService.decoratedMetrics(previousSamePeriodRange.fromDate, previousSamePeriodRange.toDate, deliveryStatus)
      ),
      this.decorationService.aggregate(
        await this.decorationService.decoratedMetrics(firstDayRange.fromDate, firstDayRange.toDate, deliveryStatus)
      ),
      this.decorationService.aggregate(
        await this.decorationService.decoratedMetrics(lastDayRange.fromDate, lastDayRange.toDate, deliveryStatus)
      )
    ]);

    return {
      selectedPeriod: {
        from: range.from,
        to: range.to,
        selectedDays,
        dataDays: aggregate.dataDays
      },
      totals: aggregate.totals,
      averages: {
        dailySpendKrw: divideOrNull(aggregate.totals.spendKrw, aggregate.dataDays),
        dailyPurchaseCount: divideOrNull(aggregate.totals.purchaseCount, aggregate.dataDays),
        dailyMarginKrw: divideOrNull(aggregate.totals.marginKrw, aggregate.dataDays)
      },
      comparisons: {
        previousDay: this.compareAggregate(aggregate, previousDay),
        previousSamePeriod: this.compareAggregate(aggregate, previousSamePeriod),
        firstDay: this.compareAggregate(lastDay, firstDay)
      },
      health,
      decisions,
      compare: compare ?? "previousSamePeriod"
    };
  }

  async dashboardTrends(from?: string, to?: string, groupByInput = "date", deliveryStatusInput?: string) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const range = parseDateRange(from, to);
    const decorated = await this.decorationService.decoratedMetrics(range.fromDate, range.toDate, deliveryStatus);
    const groups = new Map<string, DecoratedMetric[]>();
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
        const aggregate = this.decorationService.aggregate(rows);
        return {
          date,
          group: group ?? "all",
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

  async health(fromDate: Date, toDate: Date, decorated: DecoratedMetric[]) {
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
    const uploadErrorCount = await this.prisma.uploadRowError.count({
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

  async decisionSummary(fromDate: Date, toDate: Date) {
    const logs = await this.prisma.decisionLog.findMany({
      where: { periodStart: fromDate, periodEnd: toDate },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      take: 20
    });
    const counts = logs.reduce<Record<string, number>>((acc, log) => {
      acc[log.decision] = (acc[log.decision] ?? 0) + 1;
      return acc;
    }, {});
    return { counts, topRecommendations: logs.slice(0, 8) };
  }

  private compareAggregate(
    current: ReturnType<MetaAdsetMetricDecorationService["aggregate"]>,
    previous: ReturnType<MetaAdsetMetricDecorationService["aggregate"]>
  ) {
    return {
      spendKrw: this.comparisonCalculator.compare(current.totals.spendKrw, previous.totals.spendKrw),
      purchaseCount: this.comparisonCalculator.compare(current.totals.purchaseCount, previous.totals.purchaseCount),
      cpaKrw: this.comparisonCalculator.compare(current.totals.cpaKrw, previous.totals.cpaKrw),
      marginKrw: this.comparisonCalculator.compare(current.totals.marginKrw, previous.totals.marginKrw)
    };
  }
}
