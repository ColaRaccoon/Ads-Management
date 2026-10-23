import { aggregateMetricReasons, hasMixedMetaAttribution, sumComplete } from "../domain/meta-conditional-metrics";
import { numberFrom } from "../common/date-range";
import { formatDateOnly } from "../domain/date-number";
import { MarginCalculator } from "../domain/margin-calculator";
import { isPurchaseResult } from "../domain/meta-ad-daily-csv";
import { aggregateMetaVideoMetrics } from "../domain/meta-video-metrics";
import { PeriodMetricCalculator } from "../domain/period-metric-calculator";
import { findEffectiveRuleForDate } from "../domain/effective-rule";
import { AdDailyMetricRow, CreativeFinancialContext } from "./metric-types";
import {aggregateMetaProviderPurchases} from "./meta-provider-purchases";

const marginCalculator = new MarginCalculator();

export function aggregateAdDailyRows(calculator: PeriodMetricCalculator, rows: AdDailyMetricRow[]) {
  const totals = calculator.calculate(
    rows.map((row) => ({
      metricDate: formatDateOnly(row.metricDate),
      spendUsd: numberFrom(row.spendUsd),
      spendKrw: null,
      resultCount: adPurchaseCount(row) ?? 0,
      impressions: numberFrom(row.impressions),
      linkClicks: row.linkClicks,
      clicksAll: row.clicksAll,
      landingPageViews: row.landingPageViews ?? 0,
      revenueKrw: null,
      marginKrw: null
    }))
  );
  const videoTotals = aggregateMetaVideoMetrics(rows);
  return {
    totals: {
      ...totals,
      ...videoTotals,
      ...conditionalTotals(rows, totals),
      ...aggregateMetaProviderPurchases(rows),
      cpmUsd: divideOrNull(totals.spendUsd * 1000, totals.impressions)
    },
    dataDays: totals.dataDays
  };
}

export function aggregateCreativeDailyRows(
  calculator: PeriodMetricCalculator,
  rows: AdDailyMetricRow[],
  context: CreativeFinancialContext
) {
  const periodRows = rows.map((row) => {
    const metricDate = formatDateOnly(row.metricDate);
    const spendUsd = numberFrom(row.spendUsd);
    const purchaseCount = adPurchaseCount(row);
    const costRule = row.productId
      ? findRuleForDate(context.costRulesByProductId.get(row.productId) ?? [], row.metricDate)
      : null;
    const exchangeRate = context.exchangeRateByDate.get(metricDate) ?? null;
    const legacyExchangeRate = costRule ? numberFrom(costRule.fxRateKrwPerUsd) : 0;
    const exchangeRateKrwPerUsd = exchangeRate
      ? numberFrom(exchangeRate.rate)
      : legacyExchangeRate > 0
        ? legacyExchangeRate
        : null;
    const spendKrw = spendUsd === 0
      ? 0
      : exchangeRateKrwPerUsd === null
        ? null
        : spendUsd * exchangeRateKrwPerUsd;
    const salePriceKrw = costRule ? numberFrom(costRule.salePriceKrw) : null;
    const revenueKrw =
      purchaseCount === null ? null : purchaseCount === 0
        ? 0
        : salePriceKrw !== null && Number.isFinite(salePriceKrw)
          ? purchaseCount * salePriceKrw
          : null;
    const margin = costRule && spendKrw !== null && purchaseCount !== null
      ? marginCalculator.margin(
          {
            spendUsd,
            purchaseCount,
            exchangeRateKrwPerUsd: exchangeRateKrwPerUsd ?? 0
          },
          {
            salePriceKrw: numberFrom(costRule.salePriceKrw),
            vatKrw: numberFrom(costRule.vatKrw),
            productCostKrw: numberFrom(costRule.productCostKrw),
            shippingKrw: numberFrom(costRule.shippingKrw),
            extraCostKrw: numberFrom(costRule.extraCostKrw)
          }
        )
      : null;
    // Meta Daily와 같은 원가 기준을 쓰되, 제품 매칭이 없으면 제품별 순이익을 확정하지 않는다.
    const marginKrw = row.productId
      ? margin?.marginKrw ?? (purchaseCount === 0 && spendKrw !== null ? -spendKrw : null)
      : null;

    return {
      metricDate,
      spendUsd,
      spendKrw,
      resultCount: purchaseCount ?? 0,
      impressions: numberFrom(row.impressions),
      linkClicks: row.linkClicks,
      clicksAll: row.clicksAll,
      landingPageViews: row.landingPageViews ?? 0,
      revenueKrw,
      marginKrw
    };
  });
  const totals = calculator.calculate(periodRows);
  const videoTotals = aggregateMetaVideoMetrics(rows);
  const hasUnknownSpendKrw = periodRows.some((row) => row.spendUsd > 0 && row.spendKrw === null);
  const hasUnknownRevenueKrw = hasMixedMetaAttribution(rows) || rows.some((row) => adPurchaseCount(row) === null) || periodRows.some((row) => row.resultCount > 0 && row.revenueKrw === null);
  const hasUnknownMarginKrw = hasMixedMetaAttribution(rows) || periodRows.some((row) => row.marginKrw === null);
  const spendKrw = hasUnknownSpendKrw ? null : totals.spendKrw;
  const revenueKrw = hasUnknownRevenueKrw ? null : totals.revenueKrw;
  const marginKrw = hasUnknownMarginKrw ? null : totals.marginKrw;

  return {
    totals: {
      ...totals,
      ...videoTotals,
      ...conditionalTotals(rows, totals),
      ...aggregateMetaProviderPurchases(rows),
      spendKrw,
      revenueKrw,
      marginKrw,
      cpaKrw: spendKrw === null || hasMixedMetaAttribution(rows) || rows.some((row) => adPurchaseCount(row) === null) ? null : divideOrNull(spendKrw, totals.purchaseCount),
      roas: spendKrw === null || revenueKrw === null ? null : divideOrNull(revenueKrw, spendKrw),
      cpmUsd: divideOrNull(totals.spendUsd * 1000, totals.impressions)
    },
    dataDays: totals.dataDays
  };
}

export function adPurchaseCount(row: { source?: string; resultIndicator: string | null; resultCount: number | null; purchaseCount: number | null }) {
  return row.source === "API" ? row.purchaseCount : isPurchaseResult(row.resultIndicator) ? row.resultCount : row.purchaseCount;
}

export function aggregateAddToCartRatePct(
  rows: readonly (Pick<AdDailyMetricRow, "reach" | "addToCartCount"> & { source?: string })[]
) {
  if (rows.length > 1) return null;
  const complete = rows.length > 0 && rows.every(
    (row) => row.addToCartCount !== null || row.source !== "API" && row.reach === 0
  );
  if (!complete) {
    return null;
  }
  const reach = rows.reduce((sum, row) => sum + row.reach, 0);
  const addToCartCount = rows.reduce((sum, row) => sum + (row.addToCartCount ?? 0), 0);
  return divideOrNull(addToCartCount * 100, reach);
}

export function summarizeDeliveryStatus(values: Array<string | null>) {
  const normalized = values.filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  if (normalized.includes("active")) {
    return "active";
  }
  if (normalized.includes("inactive")) {
    return "inactive";
  }
  return values.find((value): value is string => Boolean(value)) ?? null;
}

export function findRuleForDate<
  T extends { id: string; effectiveFrom: Date; effectiveTo: Date | null; createdAt: Date }
>(rules: T[], date: Date): T | null {
  return findEffectiveRuleForDate(rules, date);
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

export function divideOrNull(value: number | null, denominator: number): number | null {
  if (value === null || denominator === 0) {
    return null;
  }
  return value / denominator;
}

export function firstNonNull<T>(values: Array<T | null | undefined>): T | null {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

export function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

export function singleUniqueNonEmpty(values: Array<string | null | undefined>) {
  const uniqueValues = uniqueNonEmpty(values);
  return uniqueValues.length === 1 ? uniqueValues[0] : null;
}

export function summarizeParseStatus(values: Array<"PARSED" | "FALLBACK">) {
  return values.includes("FALLBACK") ? "FALLBACK" : "PARSED";
}

function conditionalTotals(rows: AdDailyMetricRow[], totals: { cpaUsd: number | null; cpaKrw: number | null }) {
  const mixed = hasMixedMetaAttribution(rows);
  const purchaseCount = mixed ? null : sumComplete(rows.map(adPurchaseCount));
  const metricUnavailableReasons = aggregateMetricReasons(rows);
  if (purchaseCount === null) metricUnavailableReasons.purchaseCount ??= "PARTIAL_METRIC";
  const landingPageViews = mixed ? null : sumComplete(rows.map((row) => row.landingPageViews));
  const shopClicks = sumComplete(rows.map((row) => row.shopClicks));
  const attributions = [...new Set(rows.map((row) => row.attributionSetting))];
  const conversionOverrides: Record<string, null> = {};
  if (mixed) {
    metricUnavailableReasons.purchaseCount = "MIXED_ATTRIBUTION";
    metricUnavailableReasons.landingPageViews = "MIXED_ATTRIBUTION";
    for (const field of ["videoPlay3s", "videoPlay25", "videoPlay50", "videoPlay75", "videoPlay100"]) {
      conversionOverrides[`${field}Count`] = null;
      conversionOverrides[`${field}RatePct`] = null;
      metricUnavailableReasons[`${field}Count`] = "MIXED_ATTRIBUTION";
    }
  }
  return { ...conversionOverrides, purchaseCount, landingPageViews, shopClicks, metricUnavailableReasons,
    hasApiMetrics: rows.some((row) => row.source === "API"), attributionContexts: [...new Set(rows.map((row) => JSON.stringify([row.attributionSetting, row.actionReportTime, [...(row.attributionWindows ?? [])].sort()])))],
    attributionSettings: attributions, actionReportTimes: [...new Set(rows.map((row) => row.actionReportTime))],
    cpaUsd: purchaseCount === null ? null : totals.cpaUsd,
    cpaKrw: purchaseCount === null ? null : totals.cpaKrw };
}
