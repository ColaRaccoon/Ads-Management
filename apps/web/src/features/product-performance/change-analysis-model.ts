import { chartNumber } from "./chart-model";
import type { AnalysisMedium } from "./relationships-model";
import type { Bucket } from "./types";

const DAY = 86400000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
type Period = [string, string];
export type ChangeMetric = { before: number | null; after: number | null; change: number | null; changePct: number | null;
  beforeDays: number; afterDays: number; expectedDays: number; beforePartialDays: number; afterPartialDays: number; missingSources: string[] };
export type ChangeAnalysisOptions = { medium: AnalysisMedium; changeDate: string; windowDays: number; lagDays: number };
export function analyzeChanges(buckets: Bucket[], options: ChangeAnalysisOptions) {
  const { medium, changeDate, windowDays, lagDays } = options;
  if (![7, 14].includes(windowDays) || ![0, 3, 7].includes(lagDays) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(changeDate) || !Number.isFinite(Date.parse(`${changeDate}T00:00:00Z`)) || shift(changeDate, 0) !== changeDate)
    throw new Error("광고비 변경일과 비교 범위를 확인해 주세요.");
  const outcomeStart = shift(changeDate, lagDays);
  const periods = { adBefore: [shift(changeDate, -windowDays), shift(changeDate, -1)] as Period,
    adAfter: [changeDate, shift(changeDate, windowDays - 1)] as Period,
    outcomeBefore: [shift(outcomeStart, -windowDays), shift(outcomeStart, -1)] as Period,
    outcomeAfter: [outcomeStart, shift(outcomeStart, windowDays - 1)] as Period };
  // Never reinterpret an aggregated week/month, duplicated date, or missing day as daily data.
  const daily = new Map<string, Bucket>();
  const duplicates = new Set<string>();
  for (const bucket of buckets) {
    if (bucket.bucketFrom !== bucket.bucketTo || bucket.date !== bucket.bucketFrom) continue;
    if (daily.has(bucket.date)) duplicates.add(bucket.date);
    daily.set(bucket.date, bucket);
  }
  for (const date of duplicates) daily.delete(date);
  const marketplaces = [...new Set([...daily.values()].flatMap(row => row.byMarketplace.map(market => market.marketplace)))].sort();
  type Amount = { value: number | null; partial: boolean; missingSources: string[] };
  type Display = { value: string | null; state: string; missingSources: string[] };
  const amount = (display: Display | undefined, fallback: string | null | undefined): Amount => ({
    value: chartNumber(display ? display.state === "UNAVAILABLE" ? null : display.value : fallback),
    partial: display?.state === "PARTIAL", missingSources: display?.missingSources ?? [],
  });
  const ads = (bucket: Bucket) => {
    const row = bucket.byMedium.find(row => row.medium === medium);
    return amount(row?.displayAdSpend, row?.completeAdSpend);
  };
  const sale = (bucket: Bucket, marketplace: string, metric: "revenue" | "estimatedProfit") => {
    const row = bucket.byMarketplace.find(row => row.marketplace === marketplace);
    return amount(row?.display?.[metric], metric === "revenue" ? row?.completeRevenue : row?.estimatedProfit);
  };
  const mean = ([from, to]: Period, get: (bucket: Bucket) => Amount) => {
    const samples = [...daily.values()].filter(row => row.date >= from && row.date <= to).map(get);
    const values = samples.filter((sample): sample is Amount & { value: number } => sample.value !== null);
    const total = values.reduce((sum, sample) => sum + sample.value, 0);
    return { days: values.length, partialDays: values.filter(sample => sample.partial).length,
      missingSources: [...new Set(samples.flatMap(sample => sample.missingSources))],
      mean: values.length && Number.isFinite(total) && Math.abs(total) <= Number.MAX_SAFE_INTEGER ? total / values.length : null };
  };
  const compare = (beforePeriod: Period, afterPeriod: Period, get: (bucket: Bucket) => Amount): ChangeMetric => {
    const a = mean(beforePeriod, get), b = mean(afterPeriod, get);
    const change = a.mean === null || b.mean === null ? null : b.mean - a.mean;
    return { before: a.mean, after: b.mean, change, changePct: change === null || a.mean === null || a.mean <= 0 ? null : change / a.mean * 100,
      beforeDays: a.days, afterDays: b.days, expectedDays: windowDays, beforePartialDays: a.partialDays, afterPartialDays: b.partialDays,
      missingSources: [...new Set([...a.missingSources, ...b.missingSources])] };
  };
  const start = periods.adBefore[0] < periods.outcomeBefore[0] ? periods.adBefore[0] : periods.outcomeBefore[0];
  const end = periods.adAfter[1] > periods.outcomeAfter[1] ? periods.adAfter[1] : periods.outcomeAfter[1];
  const dates: string[] = [];
  for (let date = start; date <= end; date = shift(date, 1)) dates.push(date);
  return { periods, spend: compare(periods.adBefore, periods.adAfter, ads), marketplaces: marketplaces.map(marketplace => ({ marketplace,
    revenue: compare(periods.outcomeBefore, periods.outcomeAfter, bucket => sale(bucket, marketplace, "revenue")),
    estimatedProfit: compare(periods.outcomeBefore, periods.outcomeAfter, bucket => sale(bucket, marketplace, "estimatedProfit")),
    profitUnavailableReason: [...daily.values()].filter(row => row.date >= periods.outcomeBefore[0] && row.date <= periods.outcomeAfter[1])
      .map(row => row.byMarketplace.find(m => m.marketplace === marketplace)?.profitUnavailableReason).find(reason => reason != null) ?? null })),
    series: dates.map(date => { const bucket = daily.get(date); return { date, adSpend: bucket ? ads(bucket).value : null, adPartial: bucket ? ads(bucket).partial : false,
      marketplaces: marketplaces.map(marketplace => ({ marketplace, revenue: bucket ? sale(bucket, marketplace, "revenue").value : null, revenuePartial: bucket ? sale(bucket, marketplace, "revenue").partial : false,
        estimatedProfit: bucket ? sale(bucket, marketplace, "estimatedProfit").value : null, estimatedProfitPartial: bucket ? sale(bucket, marketplace, "estimatedProfit").partial : false })) }; }) };
}
