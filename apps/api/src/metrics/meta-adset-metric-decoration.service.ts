import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { numberFrom } from "../common/date-range";
import { formatDateOnly, toDateOnly } from "../domain/date-number";
import { MarginCalculator } from "../domain/margin-calculator";
import { PeriodMetricCalculator } from "../domain/period-metric-calculator";
import { deliveryStatusWhere, parseDeliveryStatusFilter } from "./metric-filters";
import { adPurchaseCount, findRuleForDate } from "./meta-ad-metric-aggregates";
import { adsetMetricKey, aggregateDecoratedMetrics } from "./meta-adset-metric-aggregates";
import { DecoratedMetric, MetricWithRelations } from "./metric-types";

@Injectable()
export class MetaAdsetMetricDecorationService {
  private readonly marginCalculator = new MarginCalculator();
  private readonly periodCalculator = new PeriodMetricCalculator();

  constructor(private readonly prisma: PrismaService) {}

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

  aggregate(rows: DecoratedMetric[]) {
    return aggregateDecoratedMetrics(this.periodCalculator, rows);
  }

  async decorate(metrics: MetricWithRelations[]): Promise<DecoratedMetric[]> {
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
    const adsetPurchaseCounts = await this.correctedAdsetPurchaseCounts(metrics);
    return metrics.map((metric) => {
      const metricDate = formatDateOnly(metric.metricDate);
      const spendUsd = numberFrom(metric.spendUsd);
      const exchangeRate = exchangeRateByDate.get(metricDate) ?? null;
      const purchaseCount = adsetPurchaseCounts.get(adsetMetricKey(metricDate, metric.metaAdsetId)) ?? metric.resultCount;
      if (!metric.productId) {
        return {
          metric,
          metricDate,
          spendUsd,
          purchaseCount,
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
          purchaseCount,
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
          purchaseCount,
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
        { spendUsd, purchaseCount, exchangeRateKrwPerUsd },
        costInput
      );
      return {
        metric,
        metricDate,
        spendUsd,
        purchaseCount,
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

  async correctedAdsetPurchaseCounts(metrics: MetricWithRelations[]) {
    if (metrics.length === 0) {
      return new Map<string, number>();
    }

    const metricDates = Array.from(new Set(metrics.map((metric) => formatDateOnly(metric.metricDate))));
    const metaAdsetIds = Array.from(new Set(metrics.map((metric) => metric.metaAdsetId)));
    const adMetrics = await this.prisma.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { in: metricDates.map((date) => toDateOnly(date)).filter((date): date is Date => Boolean(date)) },
        metaAdsetRefId: { in: metaAdsetIds }
      },
      select: {
        metricDate: true,
        metaAdsetRefId: true,
        resultIndicator: true,
        resultCount: true,
        purchaseCount: true
      }
    });

    const counts = new Map<string, number>();
    for (const row of adMetrics) {
      const key = adsetMetricKey(formatDateOnly(row.metricDate), row.metaAdsetRefId);
      counts.set(key, (counts.get(key) ?? 0) + adPurchaseCount(row));
    }
    return counts;
  }
}
