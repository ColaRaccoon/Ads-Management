import { ExactDecimal as D, decimal } from "./decimal";
import { assertBusinessDate } from "./product-name-resolver";

export interface RelationshipDay {
  date: string;
  adSpend: string | null;
  otherAdSpend: string | null;
  revenue: string | null;
  profitBeforeAds: string | null;
  isEstimate: boolean;
  issues: string[];
}
export const RELATIONSHIP_METRICS = ["adSpend", "otherAdSpend", "revenue", "profitBeforeAds"] as const;
type Metric = typeof RELATIONSHIP_METRICS[number];
type Outcome = "revenue" | "profitBeforeAds";
export interface RelationshipPair {
  outcomeDate: string; adDate: string; adSpend: string; outcome: string;
  otherAdSpend: string | null; isEstimate: boolean; issues: string[];
}
export interface RelationshipLag {
  lagDays: number; metric: Outcome; from: string; to: string;
  expectedDays: number; usedDays: number; excludedDays: number;
  excludedDates: Array<{ outcomeDate: string; adDate: string; reasons: string[] }>;
  pairs: RelationshipPair[]; coefficient: string | null; reasons: string[];
  volatility: { adSpendStdDev: string | null; outcomeStdDev: string | null };
  isEstimate: boolean; issues: string[];
}
export interface RelationshipWindow {
  from: string; to: string; expectedDays: number;
  metrics: Record<Metric, { usedDays: number; excludedDays: number; mean: string | null; complete: boolean }>;
}
export interface RelationshipBeforeAfter {
  windowDays: number; changeDate: string; before: RelationshipWindow; after: RelationshipWindow;
  changes: Record<Metric, { change: string | null; changePct: string | null; reason: string | null }>;
}
export interface RelationshipResult {
  policy: { minimumPairs: number; maximumMissingFraction: string; lagDirection: "AD_BEFORE_OUTCOME"; movingAverageUse: "VISUAL_ONLY" };
  lags: RelationshipLag[];
  daily: Array<RelationshipDay & { weekday: number; movingAverage7: Record<Metric, string | null> }>;
  beforeAfter: RelationshipBeforeAfter[];
  warnings: string[];
}
const DAY = 86400000;
const shift = (date: string, amount: number) => new Date(Date.parse(`${date}T00:00:00Z`) + amount * DAY).toISOString().slice(0, 10);
const dates = (from: string, to: string): string[] => {
  assertBusinessDate(from); assertBusinessDate(to);
  const count = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
  if (count < 1 || count > 366) throw new Error("Relationship outcome range must be 1–366 days.");
  return Array.from({ length: count }, (_, index) => shift(from, index));
};
const unique = (values: string[]) => [...new Set(values)].sort();
const mean = (values: string[]) => values.length ? values.reduce((sum, value) => sum.plus(decimal(value)), new D(0)).div(values.length) : null;
/** Population standard deviation describes the observed series, not inference uncertainty. */
function centered(values: string[]) {
  const average = mean(values);
  if (!average) return { deviations: [], sumSquares: new D(0), stddev: null };
  const deviations = values.map(value => decimal(value).minus(average));
  const sumSquares = deviations.reduce((sum, value) => sum.plus(value.mul(value)), new D(0));
  return { deviations, sumSquares, stddev: sumSquares.div(values.length).sqrt().toFixed(10) };
}
function lag(map: Map<string, RelationshipDay>, outcomeDates: string[], lagDays: number, metric: Outcome): RelationshipLag {
  const pairs: RelationshipPair[] = [], excludedDates: RelationshipLag["excludedDates"] = [];
  for (const outcomeDate of outcomeDates) {
    const adDate = shift(outcomeDate, -lagDays), x = map.get(adDate), y = map.get(outcomeDate);
    const reasons = [...(x?.adSpend == null ? ["MISSING_AD_SPEND"] : []), ...(y?.[metric] == null ? ["MISSING_OUTCOME"] : [])];
    if (reasons.length) { excludedDates.push({ outcomeDate, adDate, reasons }); continue; }
    pairs.push({ outcomeDate, adDate, adSpend: x!.adSpend!, outcome: y![metric]!, otherAdSpend: x!.otherAdSpend,
      isEstimate: x!.isEstimate || y!.isEstimate, issues: unique([...x!.issues, ...y!.issues]) });
  }
  const x = centered(pairs.map(p => p.adSpend)), y = centered(pairs.map(p => p.outcome));
  const reasons = [...(pairs.length < 60 ? ["INSUFFICIENT_PAIRS"] : []),
    ...(pairs.length && x.sumSquares.isZero() ? ["CONSTANT_AD_SPEND"] : []),
    ...(pairs.length && y.sumSquares.isZero() ? ["CONSTANT_OUTCOME"] : []),
    ...(new D(excludedDates.length).div(outcomeDates.length).gt("0.2") ? ["EXCESSIVE_MISSING"] : [])];
  const cross = x.deviations.reduce((sum, value, index) => sum.plus(value.mul(y.deviations[index])), new D(0));
  const coefficient = reasons.length ? null : D.max(-1, D.min(1, cross.div(x.sumSquares.mul(y.sumSquares).sqrt()))).toFixed(10);
  const contributing = unique(pairs.flatMap(p => [p.adDate, p.outcomeDate]));
  return { lagDays, metric, from: outcomeDates[0], to: outcomeDates[outcomeDates.length - 1],
    expectedDays: outcomeDates.length, usedDays: pairs.length, excludedDays: excludedDates.length, excludedDates, pairs,
    coefficient, reasons, volatility: { adSpendStdDev: x.stddev, outcomeStdDev: y.stddev },
    isEstimate: contributing.some(day => map.get(day)?.isEstimate),
    issues: unique(contributing.flatMap(day => map.get(day)?.issues ?? [])) };
}
function windowValues(map: Map<string, RelationshipDay>, from: string, to: string, outcomeFrom: string, outcomeTo: string, metric: Metric) {
  // Before/after descriptions remain inside the user's requested outcome period.
  return dates(from, to).filter(day => day >= outcomeFrom && day <= outcomeTo).map(day => map.get(day)?.[metric]).filter((v): v is string => v != null);
}
function window(map: Map<string, RelationshipDay>, from: string, to: string, outcomeFrom: string, outcomeTo: string): RelationshipWindow {
  const expected = dates(from, to);
  return { from, to, expectedDays: expected.length,
    metrics: Object.fromEntries(RELATIONSHIP_METRICS.map(metric => {
      const values = windowValues(map, from, to, outcomeFrom, outcomeTo, metric);
      return [metric, { usedDays: values.length, excludedDays: expected.length - values.length,
        mean: mean(values)?.toFixed(10) ?? null, complete: values.length === expected.length }];
    })) as RelationshipWindow["metrics"] };
}
function beforeAfter(map: Map<string, RelationshipDay>, from: string, to: string, changeDate: string, windowDays: number): RelationshipBeforeAfter {
  const before = window(map, shift(changeDate, -windowDays), shift(changeDate, -1), from, to);
  const after = window(map, changeDate, shift(changeDate, windowDays - 1), from, to);
  const changes = Object.fromEntries(RELATIONSHIP_METRICS.map(metric => {
    const a = after.metrics[metric], b = before.metrics[metric];
    // Partial-window means are inspectable, but do not masquerade as a full-window change.
    if (!a.complete || !b.complete || a.mean == null || b.mean == null)
      return [metric, { change: null, changePct: null, reason: "INCOMPLETE_WINDOW" }];
    // Never divide rounded mean strings: sub-micro daily averages can round to zero.
    const beforeMean = mean(windowValues(map, before.from, before.to, from, to, metric))!;
    const afterMean = mean(windowValues(map, after.from, after.to, from, to, metric))!;
    const change = afterMean.minus(beforeMean);
    return [metric, { change: change.toFixed(10),
      changePct: beforeMean.gt(0) ? change.div(beforeMean).mul(100).toFixed(10) : null,
      reason: beforeMean.isZero() ? "ZERO_BASE" : beforeMean.lt(0) ? "NON_POSITIVE_BASE" : null }];
  })) as RelationshipBeforeAfter["changes"];
  return { windowDays, changeDate, before, after, changes };
}

/** Raw daily values are paired once; moving averages never enter a coefficient or pair count. */
export function calculateRelationships(days: RelationshipDay[], options: { from: string; to: string; changeDate?: string }): RelationshipResult {
  const outcomeDates = dates(options.from, options.to), map = new Map<string, RelationshipDay>();
  for (const day of days) {
    assertBusinessDate(day.date);
    if (map.has(day.date)) throw new Error("Duplicate relationship date.");
    for (const metric of RELATIONSHIP_METRICS) if (day[metric] !== null) decimal(day[metric]);
    map.set(day.date, day);
  }
  if (options.changeDate) {
    assertBusinessDate(options.changeDate);
    if (options.changeDate < options.from || options.changeDate > options.to) throw new Error("Change date must lie inside the outcome period.");
  }
  const daily = outcomeDates.map(date => {
    const day = map.get(date) ?? { date, adSpend: null, otherAdSpend: null, revenue: null, profitBeforeAds: null, isEstimate: false, issues: ["NOT_COLLECTED"] };
    const movingAverage7 = Object.fromEntries(RELATIONSHIP_METRICS.map(metric => {
      const values = Array.from({ length: 7 }, (_, index) => map.get(shift(date, index - 6))?.[metric]);
      return [metric, values.every((value): value is string => value != null) ? mean(values)?.toFixed(6) ?? null : null];
    })) as Record<Metric, string | null>;
    return { ...day, weekday: new Date(`${date}T00:00:00Z`).getUTCDay(), movingAverage7 };
  });
  return { policy: { minimumPairs: 60, maximumMissingFraction: "0.2", lagDirection: "AD_BEFORE_OUTCOME", movingAverageUse: "VISUAL_ONLY" },
    lags: [0, 1, 3, 7, 14].flatMap(lagDays => (["revenue", "profitBeforeAds"] as const).map(metric => lag(map, outcomeDates, lagDays, metric))),
    daily, beforeAfter: options.changeDate ? [7, 14].map(n => beforeAfter(map, options.from, options.to, options.changeDate!, n)) : [],
    warnings: ["OBSERVATIONAL_RELATIONSHIP_ONLY", "MINIMUM_PAIRS_IS_DISPLAY_POLICY", "OTHER_MEDIA_AND_UNRECORDED_EVENTS_MAY_COCHANGE", "NET_PROFIT_DIRECTLY_SUBTRACTS_AD_SPEND"] };
}
