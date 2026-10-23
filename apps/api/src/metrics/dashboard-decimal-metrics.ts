import { Prisma } from "@prisma/client";
import { aggregateMetricReasons, hasMixedMetaAttribution, sumComplete } from "../domain/meta-conditional-metrics";
import { hasMetaProviderPurchases } from "./meta-provider-purchases";
import type { DecoratedMetric } from "./metric-types";
import { validCurrentMetadata } from "../domain/meta-current-metadata";

// Dashboard read DTOs keep money in decimal form through JSON serialization.
const Decimal = Prisma.Decimal.clone({ precision: 80 });
export type DashboardMetricRow = Pick<DecoratedMetric, "metricDate" | "purchaseCount" | "costRule" | "cpaRule" | "exchangeRate" | "ruleStatus"> & {
  // Summary needs scalar metrics only; product grouping needs its display name.
  // No dashboard calculation or output consumes the metaAdset relation.
  metric: Omit<DecoratedMetric["metric"], "metaAdset" | "product"> & { product?: { displayName: string } | null };
};
const decimal = (value: Prisma.Decimal | string | number) => new Decimal(value.toString());
const sum = (values: Prisma.Decimal[]) => values.reduce((a, b) => a.plus(b), new Decimal(0));
const complete = (values: (Prisma.Decimal | null)[]) => values.some(v => v === null) ? null : sum(values as Prisma.Decimal[]);
const money = (value: Prisma.Decimal | null) => value === null ? null : value.toFixed();
export function divideMoney(value: string | null, denominator: number) {
  return value === null || denominator === 0 ? null : decimal(value).div(denominator).toFixed();
}
export function compareMoney(current: string | null, previous: string | null) {
  const delta = current === null || previous === null ? null : decimal(current).minus(previous);
  return { current, previous, delta: money(delta), deltaPct: delta === null || decimal(previous!).isZero() ? null : delta.div(previous!).mul(100).toNumber() };
}
export function aggregateDashboardMetrics(rows: DashboardMetricRow[]) {
  const mixed = hasMixedMetaAttribution(rows.map(r => r.metric));
  const unknownPurchase = mixed || rows.some(r => r.purchaseCount === null);
  const purchaseCount = unknownPurchase ? null : sumComplete(rows.map(r => r.purchaseCount));
  const financial = rows.map(row => {
    const spend = decimal(row.metric.spendUsd), cost = row.costRule;
    const legacyFx = cost ? decimal(cost.fxRateKrwPerUsd) : null;
    const fx = row.exchangeRate ? decimal(row.exchangeRate.rate) : legacyFx?.gt(0) ? legacyFx : null;
    const spendKrw = spend.isZero() ? new Decimal(0) : fx === null ? null : spend.mul(fx);
    const revenue = row.purchaseCount === null ? null : row.purchaseCount === 0 ? new Decimal(0) : cost ? decimal(cost.salePriceKrw).mul(row.purchaseCount) : null;
    const margin = cost && revenue !== null && spendKrw !== null && row.purchaseCount !== null
      ? revenue.minus(decimal(cost.salePriceKrw).mul("0.1").plus(cost.productCostKrw).plus(cost.shippingKrw).plus(cost.extraCostKrw).mul(row.purchaseCount)).minus(spendKrw) : null;
    return { spend, spendKrw, revenue, margin };
  });
  const spend = sum(financial.map(r => r.spend)), spendKrw = complete(financial.map(r => r.spendKrw));
  const revenue = unknownPurchase ? null : complete(financial.map(r => r.revenue));
  const margin = unknownPurchase ? null : complete(financial.map(r => r.margin));
  const impressions = rows.reduce((n, r) => n + r.metric.impressions, 0n), linkClicks = rows.reduce((n, r) => n + r.metric.linkClicks, 0), clicksAll = rows.reduce((n, r) => n + r.metric.clicksAll, 0);
  const ctr = (clicks: number) => impressions === 0n ? null : decimal(clicks).mul(100).div(impressions.toString()).toNumber();
  const monetaryRatio = (n: Prisma.Decimal | null, d: number | null) => n === null || d === null || d === 0 ? null : n.div(d).toFixed();
  const providerComplete = rows.length > 0 && rows.every(r => hasMetaProviderPurchases(r.metric));
  const providerValue = providerComplete ? sum(rows.map(r => decimal(r.metric.purchaseValueUsd!))) : null;
  const providerCount = providerComplete ? rows.reduce((n, r) => n + r.metric.purchaseCount!, 0) : null;
  const reasons: Record<string, string> = aggregateMetricReasons(rows.map(r => r.metric));
  if (unknownPurchase) reasons.purchaseCount ??= "PARTIAL_METRIC";
  if (mixed) { reasons.purchaseCount = "MIXED_ATTRIBUTION"; reasons.landingPageViews = "MIXED_ATTRIBUTION"; }
  if (spendKrw === null) reasons.spendKrw = "MISSING_EXCHANGE_RATE";
  const dataDays = new Set(rows.map(r => r.metricDate)).size;
  return { dataDays, totals: {
    spendUsd: spend.toFixed(), spendKrw: money(spendKrw), purchaseCount, impressions: impressions.toString(), linkClicks, clicksAll,
    landingPageViews: mixed ? null : sumComplete(rows.map(r => r.metric.landingPageViews)), shopClicks: sumComplete(rows.map(r => r.metric.shopClicks)),
    revenueKrw: money(revenue), marginKrw: money(margin), cpaUsd: monetaryRatio(spend, purchaseCount), cpaKrw: monetaryRatio(spendKrw, purchaseCount),
    cpcLinkUsd: monetaryRatio(spend, linkClicks), cpcAllUsd: monetaryRatio(spend, clicksAll), ctrLinkPct: ctr(linkClicks), ctrAllPct: ctr(clicksAll),
    roas: revenue === null || spendKrw === null || spendKrw.isZero() ? null : revenue.div(spendKrw).toNumber(), dataDays,
    providerPurchaseCount: providerCount, providerPurchaseValueUsd: money(providerValue), providerPurchaseRoas: providerValue === null || spend.isZero() ? null : providerValue.div(spend).toNumber(),
    providerPurchaseCpaUsd: monetaryRatio(spend, providerCount), providerPurchaseContext: providerComplete ? "MCP_PROVIDER_DEFAULT_UNVERIFIED" : null,
    providerPurchaseDerivedZeroCount: providerComplete ? rows.filter(r => validCurrentMetadata(r.metric.currentMetadata) && r.metric.currentMetadata.sourceContext?.rawPurchaseNull === true).length : null,
    metricUnavailableReasons: reasons, hasApiMetrics: rows.some(r => r.metric.source === "API"),
    attributionContexts: [...new Set(rows.map(r => JSON.stringify([r.metric.attributionSetting, r.metric.actionReportTime, [...(r.metric.attributionWindows ?? [])].sort()])))],
    ruleStatus: rows.some(r => ["MISSING_COST_RULE", "MISSING_CPA_RULE", "MISSING_RULES", "MISSING_EXCHANGE_RATE"].includes(r.ruleStatus)) ? "CRITERIA_MISSING" : "OK"
  } };
}
