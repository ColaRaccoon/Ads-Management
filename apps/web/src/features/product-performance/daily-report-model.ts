import { chartNumber } from "./chart-model";
import type { Bucket, DisplayAmount, Platform, SelectionOptions } from "./types";

export type DailyAmountState = DisplayAmount["state"];
export type DailyMetric = {
  current: number | null; previous: number | null; change: number | null; changePct: number | null;
  currentState: DailyAmountState; previousState: DailyAmountState; missingSources: string[];
  currentMissingSources: string[]; previousMissingSources: string[];
  comparisonIssue?: "STOREFRONT_SCOPE_CHANGED";
};
type DailyAmount = { value: number | null; state: DailyAmountState; missingSources: string[] };
type ReportMetric = "revenue" | "estimatedProfit" | "adSpend";
const METRICS: ReportMetric[] = ["revenue", "estimatedProfit", "adSpend"];
const DAY = 86400000;
const dateNumber = (date: string) => Date.parse(`${date}T00:00:00Z`);
function validDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(dateNumber(date)) && new Date(dateNumber(date)).toISOString().slice(0, 10) === date;
}
const unavailable = (): DailyAmount => ({ value: null, state: "UNAVAILABLE", missingSources: [] });
const unique = (values: readonly string[]) => [...new Set(values)].sort();
function dailyBuckets(buckets: readonly Bucket[]) {
  const rows = new Map<string, Bucket>(), duplicates = new Set<string>();
  for (const bucket of buckets) {
    if (!validDate(bucket.date) || bucket.date !== bucket.bucketFrom || bucket.bucketFrom !== bucket.bucketTo) continue;
    if (rows.has(bucket.date)) duplicates.add(bucket.date);
    rows.set(bucket.date, bucket);
  }
  for (const date of duplicates) rows.delete(date);
  return rows;
}

/** A publication date is a query anchor, not a guarantee that a monetary value exists. */
export function latestPublishedDate(ranges: SelectionOptions["availableDateRanges"],
  selection: { platforms: readonly Platform[]; scopeKeys?: readonly string[] }, capDate: string): string | null {
  if (!validDate(capDate)) throw new Error("조회 기준일을 확인해 주세요.");
  const dates = ranges.filter(row => selection.platforms.includes(row.platform) &&
    (selection.scopeKeys === undefined || selection.scopeKeys.includes(row.scopeKey)))
    .map(row => row.to).filter((date): date is string => date !== null && validDate(date) && date <= capDate);
  if (!dates.length) return null;
  return dates.sort().at(-1)!;
}

function readAmount(display: DisplayAmount | undefined, fallback: string | null | undefined): DailyAmount {
  const value = chartNumber(display ? display.state === "UNAVAILABLE" ? null : display.value : fallback);
  return { value, state: value === null ? "UNAVAILABLE" : display?.state ?? "COMPLETE", missingSources: unique(display?.missingSources ?? []) };
}
function sourceIssues(bucket: Bucket, metric: ReportMetric): string[] {
  const displays = metric === "adSpend" ? bucket.byMedium.flatMap(row => row.displayAdSpend?.missingSources ?? []) :
    bucket.byMarketplace.flatMap(row => row.display?.[metric]?.missingSources ?? []);
  const components = metric === "revenue" ? ["SALE"] : metric === "adSpend" ? ["AD_SPEND"] : ["SALE", "DIRECT_COST", "AD_SPEND", "COMMON_EXPENSE"];
  const coverage = bucket.coverage.filter(row => row.participation === "INCLUDED" && components.includes(row.component) &&
    (row.collectionState === "NOT_COLLECTED" || row.collectionState === "MAPPING_REQUIRED" || row.collectionState === "PARTIAL" ||
      metric === "estimatedProfit" && row.missingCostRows > 0)).map(row => row.platform);
  return unique([...displays, ...coverage]);
}
function totalAmount(bucket: Bucket | undefined, metric: ReportMetric): DailyAmount {
  if (!bucket) return unavailable();
  const complete = chartNumber(bucket.completeTotals[metric]), known = chartNumber(bucket.knownTotals[metric]);
  const value = complete ?? known;
  return { value, state: value === null ? "UNAVAILABLE" : complete !== null ? "COMPLETE" : "PARTIAL",
    missingSources: complete !== null ? [] : sourceIssues(bucket, metric) };
}
function comparison(current: DailyAmount, previous: DailyAmount): DailyMetric {
  const rawChange = current.value === null || previous.value === null ? null : current.value - previous.value;
  const change = rawChange !== null && Number.isFinite(rawChange) && Math.abs(rawChange) <= Number.MAX_SAFE_INTEGER ? rawChange : null;
  const rawPct = change === null || previous.value === null || previous.value <= 0 ? null : change / previous.value * 100;
  return { current: current.value, previous: previous.value, change,
    changePct: rawPct !== null && Number.isFinite(rawPct) ? rawPct : null,
    currentState: current.state, previousState: previous.state,
    currentMissingSources: current.missingSources, previousMissingSources: previous.missingSources,
    missingSources: unique([...current.missingSources, ...previous.missingSources]) };
}

/** Latest observed numeric day, for an explicit "last available data" action only. */
export function latestDailyDate(buckets: readonly Bucket[], capDate?: string): string | null {
  if (capDate !== undefined && !validDate(capDate)) throw new Error("조회 기준일을 확인해 주세요.");
  const dates = [...dailyBuckets(buckets).values()].filter(row => (!capDate || row.date <= capDate) &&
    (METRICS.some(metric => totalAmount(row, metric).value !== null) ||
      row.byMarketplace.some(m => readAmount(m.display?.revenue, m.completeRevenue).value !== null ||
        readAmount(m.display?.estimatedProfit, m.estimatedProfit).value !== null) ||
      row.byMedium.some(m => readAmount(m.displayAdSpend, m.completeAdSpend).value !== null))).map(row => row.date).sort();
  return dates.at(-1) ?? null;
}

/** Exact calendar D versus D−1; never substitute an earlier available day or total channel rows twice. */
export function buildDailyReport(buckets: readonly Bucket[], date: string) {
  if (!validDate(date)) throw new Error("성과를 확인할 날짜를 선택해 주세요.");
  const previousDate = new Date(dateNumber(date) - DAY).toISOString().slice(0, 10);
  const rows = dailyBuckets(buckets), current = rows.get(date), previous = rows.get(previousDate);
  const totals = Object.fromEntries(METRICS.map(metric => [metric, comparison(totalAmount(current, metric), totalAmount(previous, metric))])) as Record<ReportMetric, DailyMetric>;
  // The selected day's persisted keys decide the layout. Never reinterpret an old
  // combined Cafe24 amount as either new channel, including across version boundaries.
  const splitKeys = ["CAFE24_META", "CAFE24_YOUTUBE"];
  const currentMarkets = current?.byMarketplace.map(row => row.marketplace) ?? [];
  const previousMarkets = previous?.byMarketplace.map(row => row.marketplace) ?? [];
  const storefrontMode = currentMarkets.some(key => splitKeys.includes(key)) ? "SPLIT" as const :
    currentMarkets.includes("CAFE24") ? "COMBINED" as const : previousMarkets.some(key => splitKeys.includes(key)) ? "SPLIT" as const : "COMBINED" as const;
  const marketIds = unique([...(current?.byMarketplace ?? []), ...(previous?.byMarketplace ?? [])].map(row => row.marketplace));
  const mediumIds = unique([...(current?.byMedium ?? []), ...(previous?.byMedium ?? [])].map(row => row.medium));
  const marketAmount = (bucket: Bucket | undefined, marketplace: string, metric: "revenue" | "estimatedProfit") => {
    const row = bucket?.byMarketplace.find(row => row.marketplace === marketplace);
    return readAmount(row?.display?.[metric], metric === "revenue" ? row?.completeRevenue : row?.estimatedProfit);
  };
  const mediumAmount = (bucket: Bucket | undefined, medium: string) => {
    const row = bucket?.byMedium.find(row => row.medium === medium);
    return readAmount(row?.displayAdSpend, row?.completeAdSpend);
  };
  const legacyScopeChanged = [...currentMarkets, ...previousMarkets].some(key => splitKeys.includes(key));
  const marketComparison = (marketplace: string, metric: "revenue" | "estimatedProfit"): DailyMetric => {
    const value = comparison(marketAmount(current, marketplace, metric), marketAmount(previous, marketplace, metric));
    return marketplace === "CAFE24" && legacyScopeChanged ? { ...value, change: null, changePct: null, comparisonIssue: "STOREFRONT_SCOPE_CHANGED" } : value;
  };
  return { date, previousDate, totals, storefrontMode, mixedStorefront: storefrontMode === "SPLIT" && currentMarkets.includes("CAFE24"),
    hasCurrentData: METRICS.some(metric => totals[metric].current !== null),
    hasPreviousData: METRICS.some(metric => totals[metric].previous !== null),
    isEstimate: current?.isEstimate ?? false,
    marketplaces: marketIds.map(marketplace => ({ marketplace,
      revenue: marketComparison(marketplace, "revenue"), estimatedProfit: marketComparison(marketplace, "estimatedProfit") })),
    media: mediumIds.map(medium => ({ medium, adSpend: comparison(mediumAmount(current, medium), mediumAmount(previous, medium)) })) };
}
export type DailyReport = ReturnType<typeof buildDailyReport>;

export function dailyMetricStatusLabel(metric: DailyMetric): string | null {
  if (metric.current === null && metric.previous === null) return "전일·선택일 자료 없음";
  if (metric.current === null) return "선택일 자료 없음";
  if (metric.previous === null) return "전일 자료 없음";
  if (metric.comparisonIssue === "STOREFRONT_SCOPE_CHANGED") return "집계 범위 변경 · 증감 비교 제외";
  if (metric.previous < 0) return "전일 음수 · 증감액 확인";
  if (metric.previous === 0) return metric.current > 0 && metric.previousState === "COMPLETE" ? "0원에서 증가" : "전일 0원 · 증감액 확인";
  return null;
}
