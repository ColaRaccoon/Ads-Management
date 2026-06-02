import { BadRequestException, Injectable } from "@nestjs/common";
import { AdStage, DecisionType, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { dateRangeDays, numberFrom, parseDateRange } from "../common/date-range";
import { formatDateOnly, toDateOnly } from "../domain/date-number";
import { MarginCalculator, ProductCpaThresholds } from "../domain/margin-calculator";
import { PeriodMetricCalculator, PeriodMetricRow, PeriodMetricResult } from "../domain/period-metric-calculator";
import { ComparisonCalculator } from "../domain/comparison-calculator";

type MetricWithRelations = Prisma.MetaAdsetDailyMetricGetPayload<{
  include: { product: true; metaAdset: true };
}>;
type CostRule = Prisma.ProductCostRuleGetPayload<Record<string, never>>;
type CpaRule = Prisma.ProductCpaRuleGetPayload<Record<string, never>>;
type ExchangeRateRow = Prisma.ExchangeRateGetPayload<Record<string, never>>;
type RuleStatus =
  | "OK"
  | "UNMATCHED"
  | "MISSING_COST_RULE"
  | "MISSING_CPA_RULE"
  | "MISSING_EXCHANGE_RATE"
  | "MISSING_RULES";

type DecoratedMetric = {
  metric: MetricWithRelations;
  metricDate: string;
  spendUsd: number;
  spendKrw: number | null;
  revenueKrw: number | null;
  marginKrw: number | null;
  cpaKrw: number | null;
  cpaUsd: number | null;
  ruleStatus: RuleStatus;

  thresholds: ProductCpaThresholds | null;
  costRule: CostRule | null;
  cpaRule: CpaRule | null;
  exchangeRate: ExchangeRateRow | null;
};

export type DeliveryStatusFilter = "active" | "inactive" | "all";

@Injectable()
export class MetricsService {
  private readonly marginCalculator = new MarginCalculator();
  private readonly periodCalculator = new PeriodMetricCalculator();
  private readonly comparisonCalculator = new ComparisonCalculator();

  constructor(private readonly prisma: PrismaService) {}

  async dashboardSummary(from?: string, to?: string, compare?: string, deliveryStatusInput?: string) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const range = parseDateRange(from, to);
    const decorated = await this.decoratedMetrics(range.fromDate, range.toDate, deliveryStatus);
    const aggregate = this.aggregate(decorated);
    const selectedDays = dateRangeDays(range.from, range.to);
    const health = await this.health(range.fromDate, range.toDate, decorated);
    const decisions = await this.decisionSummary(range.fromDate, range.toDate);

    const previousDayRange = shiftRange(range.toDate, range.toDate, -1);
    const previousSamePeriodRange = shiftRange(range.fromDate, range.toDate, -selectedDays);
    const firstDayRange = { fromDate: range.fromDate, toDate: range.fromDate };
    const lastDayRange = { fromDate: range.toDate, toDate: range.toDate };

    const [previousDay, previousSamePeriod, firstDay, lastDay] = await Promise.all([
      this.aggregate(await this.decoratedMetrics(previousDayRange.fromDate, previousDayRange.toDate, deliveryStatus)),
      this.aggregate(await this.decoratedMetrics(previousSamePeriodRange.fromDate, previousSamePeriodRange.toDate, deliveryStatus)),
      this.aggregate(await this.decoratedMetrics(firstDayRange.fromDate, firstDayRange.toDate, deliveryStatus)),
      this.aggregate(await this.decoratedMetrics(lastDayRange.fromDate, lastDayRange.toDate, deliveryStatus))
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

  async dashboardTrends(from?: string, to?: string, groupBy = "date", deliveryStatusInput?: string) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const range = parseDateRange(from, to);
    const decorated = await this.decoratedMetrics(range.fromDate, range.toDate, deliveryStatus);
    const groups = new Map<string, DecoratedMetric[]>();
    for (const row of decorated) {
      const key =
        groupBy === "stage"
          ? `${row.metricDate}:${row.metric.stage}`
          : groupBy === "product"
            ? `${row.metricDate}:${row.metric.product?.displayName ?? "미매칭"}`
            : row.metricDate;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    return Array.from(groups.entries())
      .map(([key, rows]) => {
        const [date, group] = key.split(":");
        const aggregate = this.aggregate(rows);
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

  async productMetrics(from?: string, to?: string, deliveryStatusInput?: string) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const range = parseDateRange(from, to);
    const decorated = (await this.decoratedMetrics(range.fromDate, range.toDate, deliveryStatus)).filter((row) => row.metric.productId);
    const groups = groupBy(decorated, (row) => row.metric.productId ?? "unmatched");

    return Array.from(groups.entries()).map(([productId, rows]) => {
      const aggregate = this.aggregate(rows);
      const first = rows[0];
      const thresholds = first.thresholds;
      return {
        productId,
        product: first.metric.product,
        totals: aggregate.totals,
        averages: {
          dailySpendKrw: divideOrNull(aggregate.totals.spendKrw, aggregate.dataDays),
          dailyPurchaseCount: divideOrNull(aggregate.totals.purchaseCount, aggregate.dataDays),
          dailyMarginKrw: divideOrNull(aggregate.totals.marginKrw, aggregate.dataDays)
        },
        dataDays: aggregate.dataDays,
        thresholds,
        targetCpaKrw: thresholds?.targetCpaKrw ?? null,
        breakEvenCpaKrw: thresholds?.breakEvenCpaKrw ?? null,
        watchCpaKrw: thresholds?.watchCpaKrw ?? null,
        stopCpaKrw: thresholds?.stopCpaKrw ?? null,
        ruleStatus: summarizeRuleStatus(rows)
      };
    });
  }

  async adsetMetrics(query: {
    from?: string;
    to?: string;
    campaignId?: string;
    productId?: string;
    stage?: string;
    decision?: string;
    deliveryStatus?: string;
  }) {
    const range = parseDateRange(query.from, query.to);
    const deliveryStatus = parseDeliveryStatusFilter(query.deliveryStatus);
    const where: Prisma.MetaAdsetDailyMetricWhereInput = {
      isCurrent: true,
      metricDate: { gte: range.fromDate, lte: range.toDate },
      ...deliveryStatusWhere(deliveryStatus),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.stage ? { stage: query.stage as AdStage } : {}),
      ...(query.campaignId
        ? {
            metaAdset: isUuid(query.campaignId)
              ? { campaignRefId: query.campaignId }
              : { campaign: { externalCampaignId: query.campaignId } }
          }
        : {})
    };
    const metrics = await this.prisma.metaAdsetDailyMetric.findMany({
      where,
      include: { product: true, metaAdset: true },
      orderBy: [{ metricDate: "asc" }, { adsetName: "asc" }]
    });
    const decorated = await this.decorate(metrics);
    const groups = groupBy(decorated, (row) => row.metric.metaAdsetId);
    const rows = Array.from(groups.entries()).map(([metaAdsetId, items]) => {
      const aggregate = this.aggregate(items);
      const first = items[0];
      const last = items[items.length - 1];
      return {
        metaAdsetId,
        adsetName: last.metric.adsetName,
        product: last.metric.product,
        stage: last.metric.stage,
        deliveryStatus: last.metric.deliveryStatus,
        totals: aggregate.totals,
        dataDays: aggregate.dataDays,
        thresholds: last.thresholds,
        ruleStatus: summarizeRuleStatus(items),
        cpaDeltaVsPreviousDay: null,
        firstSeenOn: first.metric.metaAdset.firstSeenOn ? formatDateOnly(first.metric.metaAdset.firstSeenOn) : null,
        lastSeenOn: last.metric.metaAdset.lastSeenOn ? formatDateOnly(last.metric.metaAdset.lastSeenOn) : null
      };
    });

    if (!query.decision) {
      return rows;
    }

    const decisionLogs = await this.prisma.decisionLog.findMany({
      where: {
        periodStart: range.fromDate,
        periodEnd: range.toDate,
        decision: query.decision as DecisionType,
        metaAdsetId: { in: rows.map((row) => row.metaAdsetId) }
      }
    });
    const allowed = new Set(decisionLogs.map((log) => log.metaAdsetId));
    return rows.filter((row) => allowed.has(row.metaAdsetId));
  }

  async campaignMetrics(query: { from?: string; to?: string; productId?: string; stage?: string; deliveryStatus?: string }) {
    const metrics = await this.currentAdMetrics(query);
    const groups = groupBy(metrics, (row) => row.metaCampaignId);
    return Array.from(groups.entries()).map(([metaCampaignId, rows]) => {
      const aggregate = aggregateAdDailyRows(this.periodCalculator, rows);
      const last = rows[rows.length - 1];
      return {
        metaCampaignId,
        campaignName: last.campaignNameSnapshot,
        adsetCount: new Set(rows.map((row) => row.metaAdsetId)).size,
        adCount: new Set(rows.map((row) => `${row.metaAdsetId}:${row.adIdentityKey}`)).size,
        deliveryStatus: summarizeDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
        stage: last.stage,
        totals: aggregate.totals,
        dataDays: aggregate.dataDays
      };
    });
  }

  async adMetrics(query: {
    from?: string;
    to?: string;
    campaignId?: string;
    adsetId?: string;
    productId?: string;
    stage?: string;
    deliveryStatus?: string;
  }) {
    const metrics = await this.currentAdMetrics(query);
    const groups = groupBy(metrics, (row) => `${row.metaCampaignId}:${row.metaAdsetId}:${row.adIdentityKey}`);
    return Array.from(groups.entries()).map(([, rows]) => {
      const aggregate = aggregateAdDailyRows(this.periodCalculator, rows);
      const first = rows[0];
      const last = rows[rows.length - 1];
      return {
        metaAdRefId: last.metaAdRefId,
        metaCampaignId: last.metaCampaignId,
        campaignName: last.campaignNameSnapshot,
        metaAdsetId: last.metaAdsetId,
        metaAdsetRefId: last.metaAdsetRefId,
        adsetName: last.adsetNameSnapshot,
        metaAdId: last.metaAdId,
        syntheticAdKey: last.syntheticAdKey,
        adIdentityKey: last.adIdentityKey,
        adName: last.adNameSnapshot,
        productId: last.productId,
        stage: last.stage,
        deliveryStatus: summarizeDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
        totals: aggregate.totals,
        dataDays: aggregate.dataDays,
        firstSeenOn: formatDateOnly(first.metricDate),
        lastSeenOn: formatDateOnly(last.metricDate)
      };
    });
  }

  async compareAdsByName(adName: string | undefined, from?: string, to?: string, deliveryStatus?: string) {
    if (!adName?.trim()) {
      throw new BadRequestException({ code: "AD_NAME_REQUIRED", message: "adName 값이 필요합니다." });
    }
    return this.adMetrics({ from, to, deliveryStatus }).then((rows) =>
      rows.filter((row) => row.adName === adName.trim()).sort((a, b) => b.totals.spendUsd - a.totals.spendUsd)
    );
  }

  async adsForAdset(metaAdsetId: string, from?: string, to?: string, deliveryStatusInput?: string) {
    const range = parseDateRange(from, to);
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const metrics = await this.prisma.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        ...adDeliveryStatusWhere(deliveryStatus),
        ...(isUuid(metaAdsetId) ? { OR: [{ metaAdsetRefId: metaAdsetId }, { metaAdsetId }] } : { metaAdsetId })
      },
      orderBy: [{ metricDate: "asc" }, { adNameSnapshot: "asc" }]
    });
    const groups = groupBy(metrics, (row) => `${row.metaCampaignId}:${row.metaAdsetId}:${row.adIdentityKey}`);
    return Array.from(groups.values()).map((rows) => {
      const aggregate = aggregateAdDailyRows(this.periodCalculator, rows);
      const last = rows[rows.length - 1];
      return {
        metaAdRefId: last.metaAdRefId,
        metaAdId: last.metaAdId,
        syntheticAdKey: last.syntheticAdKey,
        adIdentityKey: last.adIdentityKey,
        adName: last.adNameSnapshot,
        deliveryStatus: summarizeDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
        totals: aggregate.totals,
        dataDays: aggregate.dataDays
      };
    });
  }

  async adsetsForCampaign(metaCampaignId: string, from?: string, to?: string, deliveryStatusInput?: string) {
    const range = parseDateRange(from, to);
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const metrics = await this.prisma.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        ...adDeliveryStatusWhere(deliveryStatus),
        ...(isUuid(metaCampaignId) ? { OR: [{ campaignRefId: metaCampaignId }, { metaCampaignId }] } : { metaCampaignId })
      },
      orderBy: [{ metricDate: "asc" }, { adsetNameSnapshot: "asc" }]
    });
    const groups = groupBy(metrics, (row) => `${row.metaCampaignId}:${row.metaAdsetId}`);
    return Array.from(groups.values()).map((rows) => {
      const aggregate = aggregateAdDailyRows(this.periodCalculator, rows);
      const last = rows[rows.length - 1];
      return {
        metaAdsetRefId: last.metaAdsetRefId,
        metaAdsetId: last.metaAdsetId,
        adsetName: last.adsetNameSnapshot,
        adCount: new Set(rows.map((row) => row.adIdentityKey)).size,
        deliveryStatus: summarizeDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
        totals: aggregate.totals,
        dataDays: aggregate.dataDays
      };
    });
  }

  async unmatchedMetrics(from?: string, to?: string, deliveryStatusInput?: string) {
    const range = parseDateRange(from, to);
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    return this.prisma.metaAdsetDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        ...deliveryStatusWhere(deliveryStatus),
        productId: null
      },
      orderBy: [{ metricDate: "desc" }, { adsetName: "asc" }],
      include: { metaAdset: true }
    });
  }

  async decoratedMetrics(fromDate: Date, toDate: Date, deliveryStatusInput?: string) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const metrics = await this.prisma.metaAdsetDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: fromDate, lte: toDate },
        ...deliveryStatusWhere(deliveryStatus)
      },
      include: { product: true, metaAdset: true },
      orderBy: [{ metricDate: "asc" }, { adsetName: "asc" }]
    });
    return this.decorate(metrics);
  }

  private async currentAdMetrics(query: {
    from?: string;
    to?: string;
    campaignId?: string;
    adsetId?: string;
    productId?: string;
    stage?: string;
    deliveryStatus?: string;
  }) {
    const range = parseDateRange(query.from, query.to);
    const deliveryStatus = parseDeliveryStatusFilter(query.deliveryStatus);
    const and: Prisma.MetaAdDailyMetricWhereInput[] = [];
    if (query.campaignId) {
      and.push(
        isUuid(query.campaignId)
          ? { OR: [{ campaignRefId: query.campaignId }, { metaCampaignId: query.campaignId }] }
          : { metaCampaignId: query.campaignId }
      );
    }
    if (query.adsetId) {
      and.push(
        isUuid(query.adsetId)
          ? { OR: [{ metaAdsetRefId: query.adsetId }, { metaAdsetId: query.adsetId }] }
          : { metaAdsetId: query.adsetId }
      );
    }
    return this.prisma.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        ...adDeliveryStatusWhere(deliveryStatus),
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.stage ? { stage: query.stage as AdStage } : {}),
        ...(and.length > 0 ? { AND: and } : {})
      },
      orderBy: [{ metricDate: "asc" }, { campaignNameSnapshot: "asc" }, { adsetNameSnapshot: "asc" }, { adNameSnapshot: "asc" }]
    });
  }

  aggregate(rows: DecoratedMetric[]) {
    const periodRows: PeriodMetricRow[] = rows.map((row) => ({
      metricDate: row.metricDate,
      spendUsd: row.spendUsd,
      spendKrw: row.spendKrw,
      resultCount: row.metric.resultCount,
      impressions: numberFrom(row.metric.impressions),
      linkClicks: row.metric.linkClicks,
      clicksAll: row.metric.clicksAll,
      landingPageViews: row.metric.landingPageViews,
      revenueKrw: row.revenueKrw,
      marginKrw: row.marginKrw
    }));
    const calculated = this.periodCalculator.calculate(periodRows);
    const matchedRows = rows.filter((row) => row.metric.productId);
    const missingCostRule = matchedRows.some((row) => !row.costRule);
    const missingCpaRule = matchedRows.some((row) => !row.cpaRule);
    const missingExchangeRate = matchedRows.some((row) => row.ruleStatus === "MISSING_EXCHANGE_RATE");
    const totals: PeriodMetricResult & { ruleStatus: string } = {
      ...calculated,
      spendKrw: missingCostRule && calculated.spendKrw === 0 ? 0 : calculated.spendKrw,
      marginKrw: missingCostRule ? calculated.marginKrw : calculated.marginKrw,
      ruleStatus: missingCostRule || missingCpaRule || missingExchangeRate ? "CRITERIA_MISSING" : "OK"
    };
    return { totals, dataDays: calculated.dataDays };
  }

  private async decorate(metrics: MetricWithRelations[]): Promise<DecoratedMetric[]> {
    const productIds = Array.from(new Set(metrics.map((metric) => metric.productId).filter(Boolean))) as string[];
    const metricDates = Array.from(new Set(metrics.map((metric) => formatDateOnly(metric.metricDate))));
    const [costRules, cpaRules, exchangeRates] = await Promise.all([
      this.prisma.productCostRule.findMany({ where: { productId: { in: productIds } }, orderBy: { effectiveFrom: "desc" } }),
      this.prisma.productCpaRule.findMany({ where: { productId: { in: productIds } }, orderBy: { effectiveFrom: "desc" } }),
      this.prisma.exchangeRate.findMany({
        where: {
          baseCurrency: "USD",
          quoteCurrency: "KRW",
          provider: "KOREA_EXIM",
          rateDate: { in: metricDates.map((date) => toDateOnly(date)).filter((date): date is Date => Boolean(date)) }
        }
      })
    ]);
    const exchangeRateByDate = new Map(exchangeRates.map((rate) => [formatDateOnly(rate.rateDate), rate]));
    return metrics.map((metric) => {
      const metricDate = formatDateOnly(metric.metricDate);
      const spendUsd = numberFrom(metric.spendUsd);
      const exchangeRate = exchangeRateByDate.get(metricDate) ?? null;
      if (!metric.productId) {
        return {
          metric,
          metricDate,
          spendUsd,
          spendKrw: null,
          revenueKrw: null,
          marginKrw: null,
          cpaKrw: null,
          cpaUsd: null,
          ruleStatus: "UNMATCHED",
          thresholds: null,
          costRule: null,
          cpaRule: null,
          exchangeRate
        };
      }
      const costRule = findRuleForDate(costRules.filter((rule) => rule.productId === metric.productId), metric.metricDate);
      const cpaRule = findRuleForDate(cpaRules.filter((rule) => rule.productId === metric.productId), metric.metricDate);
      if (!costRule) {
        return {
          metric,
          metricDate,
          spendUsd,
          spendKrw: null,
          revenueKrw: null,
          marginKrw: null,
          cpaKrw: null,
          cpaUsd: null,
          ruleStatus: cpaRule ? "MISSING_COST_RULE" : "MISSING_RULES",
          thresholds: null,
          costRule,
          cpaRule,
          exchangeRate
        };
      }
      const salePriceKrw = numberFrom(costRule.salePriceKrw);
      const costInput = {
        salePriceKrw,
        vatKrw: salePriceKrw * 0.1,
        productCostKrw: numberFrom(costRule.productCostKrw),
        shippingKrw: numberFrom(costRule.shippingKrw),
        extraCostKrw: numberFrom(costRule.extraCostKrw)
      };
      const legacyExchangeRate = numberFrom(costRule.fxRateKrwPerUsd);
      const exchangeRateKrwPerUsd = exchangeRate
        ? numberFrom(exchangeRate.rate)
        : legacyExchangeRate > 0
          ? legacyExchangeRate
          : null;
      const thresholds = cpaRule
        ? this.marginCalculator.thresholds(costInput, {
            targetRatio: numberFrom(cpaRule.targetRatio),
            watchRatio: numberFrom(cpaRule.watchRatio),
            stopRatio: numberFrom(cpaRule.stopRatio)
          })
        : null;
      if (exchangeRateKrwPerUsd === null) {
        return {
          metric,
          metricDate,
          spendUsd,
          spendKrw: null,
          revenueKrw: null,
          marginKrw: null,
          cpaKrw: null,
          cpaUsd: null,
          ruleStatus: "MISSING_EXCHANGE_RATE",
          thresholds,
          costRule,
          cpaRule,
          exchangeRate
        };
      }
      const margin = this.marginCalculator.margin(
        { spendUsd, purchaseCount: metric.resultCount, exchangeRateKrwPerUsd },
        costInput
      );
      return {
        metric,
        metricDate,
        spendUsd,
        spendKrw: margin.spendKrw,
        revenueKrw: margin.revenueKrw,
        marginKrw: margin.marginKrw,
        cpaKrw: margin.cpaKrw,
        cpaUsd: margin.cpaUsd,
        ruleStatus: cpaRule ? "OK" : "MISSING_CPA_RULE",
        thresholds,
        costRule,
        cpaRule,
        exchangeRate
      };
    });
  }

  private async health(fromDate: Date, toDate: Date, decorated: DecoratedMetric[]) {
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
      decorated
        .filter((row) => row.ruleStatus === "MISSING_EXCHANGE_RATE")
        .map((row) => row.metricDate)
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

  private async decisionSummary(fromDate: Date, toDate: Date) {
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

  private compareAggregate(current: ReturnType<MetricsService["aggregate"]>, previous: ReturnType<MetricsService["aggregate"]>) {
    return {
      spendKrw: this.comparisonCalculator.compare(current.totals.spendKrw, previous.totals.spendKrw),
      purchaseCount: this.comparisonCalculator.compare(current.totals.purchaseCount, previous.totals.purchaseCount),
      cpaKrw: this.comparisonCalculator.compare(current.totals.cpaKrw, previous.totals.cpaKrw),
      marginKrw: this.comparisonCalculator.compare(current.totals.marginKrw, previous.totals.marginKrw)
    };
  }
}

function findRuleForDate<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(rules: T[], date: Date): T | null {
  return (
    rules
      .filter((rule) => rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date))
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null
  );
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function summarizeRuleStatus(rows: DecoratedMetric[]) {
  const statuses = new Set(rows.map((row) => row.ruleStatus));
  if (statuses.has("UNMATCHED")) return "UNMATCHED";
  if (statuses.has("MISSING_RULES")) return "MISSING_RULES";
  if (statuses.has("MISSING_COST_RULE")) return "MISSING_COST_RULE";
  if (statuses.has("MISSING_EXCHANGE_RATE")) return "MISSING_EXCHANGE_RATE";
  if (statuses.has("MISSING_CPA_RULE")) return "MISSING_CPA_RULE";
  return "OK";
}

function shiftRange(fromDate: Date, toDate: Date, deltaDays: number) {
  return {
    fromDate: new Date(fromDate.getTime() + deltaDays * 86_400_000),
    toDate: new Date(toDate.getTime() + deltaDays * 86_400_000)
  };
}

function divideOrNull(value: number | null, denominator: number): number | null {
  if (value === null || denominator === 0) {
    return null;
  }
  return value / denominator;
}

export function parseDeliveryStatusFilter(value?: string): DeliveryStatusFilter {
  if (!value) {
    return "active";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "active" || normalized === "inactive" || normalized === "all") {
    return normalized;
  }
  throw new BadRequestException({
    code: "INVALID_DELIVERY_STATUS",
    message: "deliveryStatus must be active, inactive, or all."
  });
}

function aggregateAdDailyRows(
  calculator: PeriodMetricCalculator,
  rows: Prisma.MetaAdDailyMetricGetPayload<Record<string, never>>[]
) {
  const totals = calculator.calculate(
    rows.map((row) => ({
      metricDate: formatDateOnly(row.metricDate),
      spendUsd: numberFrom(row.spendUsd),
      spendKrw: null,
      resultCount: row.purchaseCount,
      impressions: numberFrom(row.impressions),
      linkClicks: row.linkClicks,
      clicksAll: row.clicksAll,
      landingPageViews: row.landingPageViews,
      revenueKrw: null,
      marginKrw: null
    }))
  );
  return {
    totals: {
      ...totals,
      cpmUsd: divideOrNull(totals.spendUsd * 1000, totals.impressions)
    },
    dataDays: totals.dataDays
  };
}

function summarizeDeliveryStatus(values: Array<string | null>) {
  const normalized = values.filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  if (normalized.includes("active")) {
    return "active";
  }
  if (normalized.includes("inactive")) {
    return "inactive";
  }
  return values.find((value): value is string => Boolean(value)) ?? null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function deliveryStatusWhere(filter: DeliveryStatusFilter): Prisma.MetaAdsetDailyMetricWhereInput {
  if (filter === "all") {
    return {};
  }
  return { deliveryStatus: { equals: filter, mode: "insensitive" } };
}

export function adDeliveryStatusWhere(filter: DeliveryStatusFilter): Prisma.MetaAdDailyMetricWhereInput {
  if (filter === "all") {
    return {};
  }
  return { adDeliveryStatus: { equals: filter, mode: "insensitive" } };
}
