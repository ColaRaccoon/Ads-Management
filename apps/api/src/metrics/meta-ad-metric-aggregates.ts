import { numberFrom } from "../common/date-range";
import { formatDateOnly } from "../domain/date-number";
import { MarginCalculator } from "../domain/margin-calculator";
import { isPurchaseResult } from "../domain/meta-ad-daily-csv";
import { aggregateMetaVideoMetrics } from "../domain/meta-video-metrics";
import { PeriodMetricCalculator } from "../domain/period-metric-calculator";
import { AdDailyMetricRow, CreativeFinancialContext } from "./metric-types";

const marginCalculator = new MarginCalculator();

export function aggregateAdDailyRows(calculator: PeriodMetricCalculator, rows: AdDailyMetricRow[]) {
  const totals = calculator.calculate(
    rows.map((row) => ({
      metricDate: formatDateOnly(row.metricDate),
      spendUsd: numberFrom(row.spendUsd),
      spendKrw: null,
      resultCount: adPurchaseCount(row),
      impressions: numberFrom(row.impressions),
      linkClicks: row.linkClicks,
      clicksAll: row.clicksAll,
      landingPageViews: row.landingPageViews,
      revenueKrw: null,
      marginKrw: null
    }))
  );
  const videoTotals = aggregateMetaVideoMetrics(rows);
  return {
    totals: {
      ...totals,
      ...videoTotals,
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
      purchaseCount === 0
        ? 0
        : salePriceKrw !== null && Number.isFinite(salePriceKrw)
          ? purchaseCount * salePriceKrw
          : null;
    const margin = costRule && spendKrw !== null
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
      resultCount: purchaseCount,
      impressions: numberFrom(row.impressions),
      linkClicks: row.linkClicks,
      clicksAll: row.clicksAll,
      landingPageViews: row.landingPageViews,
      revenueKrw,
      marginKrw
    };
  });
  const totals = calculator.calculate(periodRows);
  const videoTotals = aggregateMetaVideoMetrics(rows);
  const hasUnknownSpendKrw = periodRows.some((row) => row.spendUsd > 0 && row.spendKrw === null);
  const hasUnknownRevenueKrw = periodRows.some((row) => row.resultCount > 0 && row.revenueKrw === null);
  const hasUnknownMarginKrw = periodRows.some((row) => row.marginKrw === null);
  const spendKrw = hasUnknownSpendKrw ? null : totals.spendKrw;
  const revenueKrw = hasUnknownRevenueKrw ? null : totals.revenueKrw;
  const marginKrw = hasUnknownMarginKrw ? null : totals.marginKrw;

  return {
    totals: {
      ...totals,
      ...videoTotals,
      spendKrw,
      revenueKrw,
      marginKrw,
      cpaKrw: spendKrw === null ? null : divideOrNull(spendKrw, totals.purchaseCount),
      roas: spendKrw === null || revenueKrw === null ? null : divideOrNull(revenueKrw, spendKrw),
      cpmUsd: divideOrNull(totals.spendUsd * 1000, totals.impressions)
    },
    dataDays: totals.dataDays
  };
}

export function adPurchaseCount(row: { resultIndicator: string | null; resultCount: number; purchaseCount: number }) {
  return isPurchaseResult(row.resultIndicator) ? row.resultCount : row.purchaseCount;
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

export function findRuleForDate<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(rules: T[], date: Date): T | null {
  return (
    rules
      .filter((rule) => rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date))
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null
  );
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
