import { numberFrom } from "../common/date-range";
import { PeriodMetricCalculator, PeriodMetricResult, PeriodMetricRow } from "../domain/period-metric-calculator";
import { DecoratedMetric } from "./metric-types";

export function aggregateDecoratedMetrics(calculator: PeriodMetricCalculator, rows: DecoratedMetric[]) {
  const periodRows: PeriodMetricRow[] = rows.map((row) => ({
    metricDate: row.metricDate,
    spendUsd: row.spendUsd,
    spendKrw: row.spendKrw,
    resultCount: row.purchaseCount,
    impressions: numberFrom(row.metric.impressions),
    linkClicks: row.metric.linkClicks,
    clicksAll: row.metric.clicksAll,
    landingPageViews: row.metric.landingPageViews,
    revenueKrw: row.revenueKrw,
    marginKrw: row.marginKrw
  }));
  const calculated = calculator.calculate(periodRows);
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

export function summarizeRuleStatus(rows: DecoratedMetric[]) {
  const statuses = new Set(rows.map((row) => row.ruleStatus));
  if (statuses.has("UNMATCHED")) return "UNMATCHED";
  if (statuses.has("MISSING_RULES")) return "MISSING_RULES";
  if (statuses.has("MISSING_COST_RULE")) return "MISSING_COST_RULE";
  if (statuses.has("MISSING_EXCHANGE_RATE")) return "MISSING_EXCHANGE_RATE";
  if (statuses.has("MISSING_CPA_RULE")) return "MISSING_CPA_RULE";
  return "OK";
}

export function shiftRange(fromDate: Date, toDate: Date, deltaDays: number) {
  return {
    fromDate: new Date(fromDate.getTime() + deltaDays * 86_400_000),
    toDate: new Date(toDate.getTime() + deltaDays * 86_400_000)
  };
}

export function adsetMetricKey(metricDate: string, metaAdsetId: string) {
  return `${metricDate}:${metaAdsetId}`;
}
