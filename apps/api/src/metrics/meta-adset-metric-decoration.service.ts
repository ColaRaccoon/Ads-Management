import { hasMixedMetaAttribution } from "../domain/meta-conditional-metrics";
import {hasMetaProviderPurchases} from "./meta-provider-purchases";
import { Injectable } from "@nestjs/common";
import { Prisma, SourceDataKind } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { selectCurrentSourceRows } from "../common/source-read-policy";
import { numberFrom } from "../common/date-range";
import { formatDateOnly, toDateOnly } from "../domain/date-number";
import { MarginCalculator } from "../domain/margin-calculator";
import { PeriodMetricCalculator } from "../domain/period-metric-calculator";
import { deliveryStatusWhere, parseDeliveryStatusFilter } from "./metric-filters";
import { adPurchaseCount, findRuleForDate } from "./meta-ad-metric-aggregates";
import { adsetMetricKey, aggregateDecoratedMetrics } from "./meta-adset-metric-aggregates";
import { DecoratedMetric, MetricWithRelations } from "./metric-types";
import type { DashboardMetricRow } from "./dashboard-decimal-metrics";

type DashboardGuardWindow = { fromDate: Date; toDate: Date };
type AdsetMetricKey = Pick<MetricWithRelations, "metricDate" | "metaAdsetId">;

@Injectable()
export class MetaAdsetMetricDecorationService {
  private readonly marginCalculator = new MarginCalculator();
  private readonly periodCalculator = new PeriodMetricCalculator();

  constructor(private readonly prisma: PrismaService) {}

  async decoratedMetrics(
    fromDate: Date,
    toDate: Date,
    deliveryStatusInput?: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma
  ) {
    return this.decorate(await this.selectedMetrics(fromDate, toDate, deliveryStatusInput, client), client);
  }

  private async selectedMetrics(fromDate: Date, toDate: Date, deliveryStatusInput: string | undefined, client: PrismaService | Prisma.TransactionClient) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const candidates = await client.metaAdsetDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: fromDate, lte: toDate },
        ...deliveryStatusWhere(deliveryStatus)
      },
      include: { product: true, metaAdset: true },
      orderBy: [{ metricDate: "asc" }, { adsetName: "asc" }, { id: "asc" }]
    });
    const metrics = await selectCurrentSourceRows(
      client, SourceDataKind.META_ADSET, candidates, (row) => row.metricDate
    );
    return metrics;
  }

  async dashboardMetrics(fromDate: Date, toDate: Date, deliveryStatusInput?: string, client: PrismaService | Prisma.TransactionClient = this.prisma,
    guardWindows?: readonly DashboardGuardWindow[], includeProductName = true): Promise<DashboardMetricRow[]> {
    const metrics = await this.selectedDashboardMetrics(fromDate, toDate, deliveryStatusInput, client, includeProductName);
    if (metrics.length === 0) return [];
    const productIds = [...new Set(metrics.map(r => r.productId).filter(Boolean))] as string[];
    const dates = [...new Set(metrics.map(r => formatDateOnly(r.metricDate)))];
    const [costs, cpas, rates, counts] = await Promise.all([
      productIds.length ? client.productCostRule.findMany({ where: { productId: { in: productIds } }, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }] }) : Promise.resolve([]),
      productIds.length ? client.productCpaRule.findMany({ where: { productId: { in: productIds } }, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }] }) : Promise.resolve([]),
      client.exchangeRate.findMany({ where: { baseCurrency: "USD", quoteCurrency: "KRW", provider: "KOREA_EXIM", rateDate: { in: dates.map(d => toDateOnly(d)!) } } }),
      // Preserve the old META_AD source/lineage rejection even when provider
      // purchases make ad-level fallback values unnecessary.
      metrics.every(hasMetaProviderPurchases)
        ? this.guardProviderAdSources(metrics, client, guardWindows).then(() => new Map<string, number | null>())
        : this.correctedAdsetPurchaseCounts(metrics, client, guardWindows)
    ]);
    const byDate = new Map(rates.map(r => [formatDateOnly(r.rateDate), r]));
    return metrics.map(metric => {
      const metricDate = formatDateOnly(metric.metricDate), costRule = metric.productId ? findRuleForDate(costs.filter(r => r.productId === metric.productId), metric.metricDate) : null;
      const cpaRule = metric.productId ? findRuleForDate(cpas.filter(r => r.productId === metric.productId), metric.metricDate) : null;
      const exchangeRate = byDate.get(metricDate) ?? null, purchaseKey = adsetMetricKey(metricDate, metric.metaAdsetId);
      const purchaseCount = hasMetaProviderPurchases(metric) ? metric.purchaseCount : counts.has(purchaseKey) ? counts.get(purchaseKey)! : metric.source === "API" ? null : metric.resultCount;
      const ruleStatus = !metric.productId ? "UNMATCHED" : !costRule ? cpaRule ? "MISSING_COST_RULE" : "MISSING_RULES" : !exchangeRate && !costRule.fxRateKrwPerUsd.gt(0) ? "MISSING_EXCHANGE_RATE" : !cpaRule ? "MISSING_CPA_RULE" : "OK";
      return { metric, metricDate, purchaseCount, costRule, cpaRule, exchangeRate, ruleStatus };
    });
  }

  private async selectedDashboardMetrics(fromDate: Date, toDate: Date, deliveryStatusInput: string | undefined,
    client: PrismaService | Prisma.TransactionClient, includeProductName: boolean) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const candidates: DashboardMetricRow["metric"][] = await client.metaAdsetDailyMetric.findMany({
      where: { isCurrent: true, metricDate: { gte: fromDate, lte: toDate }, ...deliveryStatusWhere(deliveryStatus) },
      ...(includeProductName ? { include: { product: { select: { displayName: true } } } } : {}),
      orderBy: [{ metricDate: "asc" }, { adsetName: "asc" }, { id: "asc" }]
    });
    return selectCurrentSourceRows(client, SourceDataKind.META_ADSET, candidates, row => row.metricDate);
  }

  aggregate(rows: DecoratedMetric[]) {
    return aggregateDecoratedMetrics(this.periodCalculator, rows);
  }

  async decorate(
    metrics: MetricWithRelations[],
    client: PrismaService | Prisma.TransactionClient = this.prisma
  ): Promise<DecoratedMetric[]> {
    if (metrics.length === 0) return [];
    const productIds = Array.from(new Set(metrics.map((metric) => metric.productId).filter(Boolean))) as string[];
    const metricDates = Array.from(new Set(metrics.map((metric) => formatDateOnly(metric.metricDate))));
    const [costRules, cpaRules, exchangeRates] = await Promise.all([
      client.productCostRule.findMany({
        where: { productId: { in: productIds } },
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }]
      }),
      client.productCpaRule.findMany({
        where: { productId: { in: productIds } },
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }]
      }),
      client.exchangeRate.findMany({
        where: {
          baseCurrency: "USD",
          quoteCurrency: "KRW",
          provider: "KOREA_EXIM",
          rateDate: { in: metricDates.map((date) => toDateOnly(date)).filter((date): date is Date => Boolean(date)) }
        }
      })
    ]);
    const exchangeRateByDate = new Map(exchangeRates.map((rate) => [formatDateOnly(rate.rateDate), rate]));
    const adsetPurchaseCounts = await this.correctedAdsetPurchaseCounts(metrics, client);
    return metrics.map((metric) => {
      const metricDate = formatDateOnly(metric.metricDate);
      const spendUsd = numberFrom(metric.spendUsd);
      const exchangeRate = exchangeRateByDate.get(metricDate) ?? null;
      const purchaseKey = adsetMetricKey(metricDate, metric.metaAdsetId);
      const purchaseCount = hasMetaProviderPurchases(metric)?metric.purchaseCount:adsetPurchaseCounts.has(purchaseKey) ? adsetPurchaseCounts.get(purchaseKey)! :
        metric.source === "API" ? null : metric.resultCount;
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
      if (purchaseCount === null) return {
        metric, metricDate, spendUsd, purchaseCount, spendKrw: spendUsd * exchangeRateKrwPerUsd,
        revenueKrw: null, marginKrw: null, cpaKrw: null, cpaUsd: null,
        ruleStatus: cpaRule ? "OK" as const : "MISSING_CPA_RULE" as const,
        thresholds, costRule, cpaRule, exchangeRate
      };
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

  async correctedAdsetPurchaseCounts(
    metrics: AdsetMetricKey[],
    client: PrismaService | Prisma.TransactionClient = this.prisma,
    guardWindows?: readonly DashboardGuardWindow[]
  ) {
    if (metrics.length === 0) {
      return new Map<string, number | null>();
    }

    const adCandidates = await client.metaAdDailyMetric.findMany({
      where: this.adCandidateWhere(metrics, guardWindows),
      select: {
        metricDate: true,
        source: true,
        connectionId: true,
        metaAdsetRefId: true,
        resultIndicator: true,
        resultCount: true,
        purchaseCount: true, attributionSetting: true, actionReportTime: true, attributionWindows: true
      }
    });
    const adMetrics = await selectCurrentSourceRows(
      client, SourceDataKind.META_AD, adCandidates, (row) => row.metricDate
    );

    const counts = new Map<string, number | null>();
    const groups = new Map<string, typeof adMetrics>();
    for (const row of adMetrics) {
      const key = adsetMetricKey(formatDateOnly(row.metricDate), row.metaAdsetRefId);
      groups.set(key, [...(groups.get(key) ?? []), row]);
      const count = adPurchaseCount(row);
      counts.set(key, count === null || counts.has(key) && counts.get(key) === null
        ? null : (counts.get(key) ?? 0) + count);
    }
    for (const [key, rows] of groups) if (hasMixedMetaAttribution(rows)) counts.set(key, null);
    return counts;
  }

  private async guardProviderAdSources(metrics: AdsetMetricKey[], client: PrismaService | Prisma.TransactionClient,
    guardWindows?: readonly DashboardGuardWindow[]) {
    const candidates = await client.metaAdDailyMetric.findMany({
      where: this.adCandidateWhere(metrics, guardWindows),
      select: { metricDate: true, source: true, connectionId: true }
    });
    await selectCurrentSourceRows(client, SourceDataKind.META_AD, candidates, row => row.metricDate);
  }

  private adCandidateWhere(metrics: AdsetMetricKey[], guardWindows?: readonly DashboardGuardWindow[]): Prisma.MetaAdDailyMetricWhereInput {
    if (guardWindows && metrics.some(metric => !guardWindows.some(window => metric.metricDate >= window.fromDate && metric.metricDate <= window.toDate)))
      throw new Error("DASHBOARD_GUARD_WINDOW_MISMATCH");
    const groups = guardWindows
      ? guardWindows.map(window => metrics.filter(metric => metric.metricDate >= window.fromDate && metric.metricDate <= window.toDate)).filter(rows => rows.length > 0)
      : [metrics];
    const predicates = groups.map(rows => ({
      metricDate: { in: [...new Set(rows.map(metric => formatDateOnly(metric.metricDate)))].map(date => toDateOnly(date)!) },
      metaAdsetRefId: { in: [...new Set(rows.map(metric => metric.metaAdsetId))] }
    }));
    // A wide date×ID product can include keys absent from both original reads.
    // OR preserves the exact union of their two candidate scopes instead.
    return guardWindows ? { isCurrent: true, OR: predicates } : { isCurrent: true, ...predicates[0] };
  }
}
