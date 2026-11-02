import test from "node:test";
import assert from "node:assert/strict";
import { analyzeChanges, applyRecommendedDate, changeStatusLabel, recommendChangeDate } from "./change-analysis-model";
import type { Bucket } from "./types";

const row = (date: string, revenue: string | null = "100", profit: string | null = "30"): Bucket => ({
  date, bucketFrom: date, bucketTo: date, byMedium: [{ medium: "META", adSpend: "999", completeAdSpend: "10", share: "100" },
    { medium: "GOOGLE", adSpend: "888", completeAdSpend: "20", share: "100" }],
  byMarketplace: [{ marketplace: "CAFE24", revenue: "9999", completeRevenue: revenue, estimatedProfit: profit }]
} as Bucket);
const options = { medium: "META" as const, changeDate: "2026-10-08", windowDays: 7, lagDays: 0 };
const rows = Array.from({ length: 14 }, (_, i) => row(`2026-10-${String(i + 1).padStart(2, "0")}`, i < 7 ? "100" : "120", i < 7 ? "30" : "40"));

test("daily complete metrics compare window averages and never known partial amounts", () => {
  const result = analyzeChanges(rows, options);
  assert.equal(result.spend.before, 10);
  assert.equal(result.marketplaces[0].revenue.before, 100);
  assert.equal(result.marketplaces[0].revenue.after, 120);
  assert.equal(result.marketplaces[0].revenue.changePct, 20);
  assert.equal(result.marketplaces[0].estimatedProfit.change, 10);
  assert.equal(result.marketplaces[0].revenue.beforeDays, 7);
});
test("choosing another medium does not change marketplace net profit", () => {
  const a = analyzeChanges(rows, options), b = analyzeChanges(rows, { ...options, medium: "GOOGLE" });
  assert.equal(a.spend.before, 10);
  assert.equal(b.spend.before, 20);
  assert.deepEqual(a.marketplaces, b.marketplaces);
});

test("a legacy Cafe24 key alongside native channels retains means but suppresses scope-changing deltas", () => {
  const mixed = rows.map((bucket, index) => ({ ...bucket, byMarketplace: [
    { marketplace: "CAFE24", revenue: "9999", completeRevenue: index < 7 ? "100" : "10", estimatedProfit: index < 7 ? "30" : "3" },
    ...(index < 7 ? [] : [{ marketplace: "CAFE24_META", revenue: "90", completeRevenue: "90", estimatedProfit: "27" }]),
  ] }));
  const legacy = analyzeChanges(mixed, options).marketplaces.find(row => row.marketplace === "CAFE24")!;
  assert.equal(legacy.revenue.before, 100); assert.equal(legacy.revenue.after, 10);
  assert.equal(legacy.revenue.change, null); assert.equal(legacy.revenue.changePct, null);
  assert.equal(changeStatusLabel(legacy.revenue), "집계 범위 변경 · 증감 비교 제외");
  assert.equal(legacy.estimatedProfit.change, null);
});
test("missing dates and amounts preserve gaps and disclose used days", () => {
  const partial = rows.slice(1).map(r => r.date === "2026-10-09" ? row(r.date, null, null) : r);
  const result = analyzeChanges(partial, options);
  assert.equal(result.marketplaces[0].revenue.beforeDays, 6);
  assert.equal(result.marketplaces[0].revenue.afterDays, 6);
  assert.equal(result.series[0].adSpend, null);
  assert.equal(result.series.find(r => r.date === "2026-10-09")!.marketplaces[0].revenue, null);
});
test("lag shifts outcome windows while keeping spend windows fixed and future days unknown", () => {
  const result = analyzeChanges(rows, { ...options, lagDays: 7 });
  assert.deepEqual(result.periods.adBefore, ["2026-10-01", "2026-10-07"]);
  assert.deepEqual(result.periods.outcomeBefore, ["2026-10-08", "2026-10-14"]);
  assert.equal(result.marketplaces[0].revenue.after, null);
  assert.equal(result.marketplaces[0].revenue.afterDays, 0);
});
test("nonpositive profit baseline retains absolute change without a percentage", () => {
  const result = analyzeChanges(rows.map((r,i) => row(r.date, "100", i < 7 ? "-10" : "20")), options);
  assert.equal(result.marketplaces[0].estimatedProfit.change, 30);
  assert.equal(result.marketplaces[0].estimatedProfit.changePct, null);
});
test("weekly aggregates and duplicate daily dates never count as independent daily observations", () => {
  const result = analyzeChanges([...rows, rows[0], { ...rows[1], bucketTo: "2026-10-08", date: "2026-10-20", bucketFrom: "2026-10-20" }], options);
  assert.equal(result.spend.beforeDays, 6);
  assert.equal(result.series[0].adSpend, null);
  assert.throws(() => analyzeChanges(rows, { ...options, changeDate: "2026-02-30" }));
});

test("missing Google dates exclude only Google while other known display amounts survive", () => {
  const changed = rows.map((r, i) => ({ ...r,
    byMedium: r.byMedium.map(m => m.medium === "GOOGLE" && i < 7 ? { ...m, completeAdSpend: null, displayAdSpend: { value: null, state: "UNAVAILABLE" as const, availableSources: [], missingSources: ["GOOGLE" as const] } } : m),
    byMarketplace: r.byMarketplace.map(m => ({ ...m, estimatedProfit: null, profitUnavailableReason: "CROSS_MARKET_AD_ALLOCATION_UNKNOWN", display: {
      revenue: { value: i < 7 ? "100" : "120", state: "COMPLETE" as const, availableSources: ["CAFE24" as const], missingSources: [] },
      estimatedProfit: { value: i < 7 ? "25" : "35", state: "PARTIAL" as const, availableSources: ["CAFE24" as const, "META" as const], missingSources: ["GOOGLE" as const] },
      adSpend: { value: "10", state: "PARTIAL" as const, availableSources: ["META" as const], missingSources: ["GOOGLE" as const] },
    } })),
  }));
  const meta = analyzeChanges(changed, options), google = analyzeChanges(changed, { ...options, medium: "GOOGLE" });
  assert.equal(meta.spend.before, 10); assert.equal(meta.spend.beforeDays, 7);
  assert.equal(google.spend.before, null); assert.equal(google.spend.beforeDays, 0);
  assert.equal(meta.marketplaces[0].revenue.changePct, 20);
  assert.equal(meta.marketplaces[0].estimatedProfit.before, 25);
  assert.equal(meta.marketplaces[0].estimatedProfit.after, 35);
  assert.equal(meta.marketplaces[0].estimatedProfit.beforePartialDays, 7);
  assert.deepEqual(meta.marketplaces[0].estimatedProfit.missingSources, ["GOOGLE"]);
  assert.deepEqual(meta.marketplaces, google.marketplaces);
  assert.equal(meta.series[0].marketplaces[0].estimatedProfit, 25);
});

test("explicit unavailable display is not replaced by an old complete field or an invented zero", () => {
  const changed = rows.map(r => ({ ...r, byMedium: [{ ...r.byMedium[0], displayAdSpend: { value: null, state: "UNAVAILABLE" as const, availableSources: [], missingSources: ["META" as const] } }] }));
  const result = analyzeChanges(changed, options);
  assert.equal(result.spend.before, null); assert.equal(result.spend.after, null);
  assert.equal(result.spend.beforeDays, 0);
  assert.equal(result.series[0].adSpend, null);
});

test("partial known zero counts as an observed day without declaring the source complete", () => {
  const changed = rows.map(r => ({ ...r, byMedium: [{ ...r.byMedium[0], completeAdSpend: null, displayAdSpend: { value: "0", state: "PARTIAL" as const, availableSources: ["META" as const], missingSources: ["META" as const] } }] }));
  const result = analyzeChanges(changed, options);
  assert.equal(result.spend.before, 0); assert.equal(result.spend.beforeDays, 7);
  assert.equal(result.spend.beforePartialDays, 7); assert.equal(result.spend.changePct, null);
});


const googleDates = Array.from({ length: 30 }, (_, i) => {
  const date = new Date(Date.parse("2026-09-30T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
  const numeric = date >= "2026-10-20" && date !== "2026-10-24";
  return { ...row(date), byMedium: [{ medium: "GOOGLE", adSpend: numeric ? "100" : null, completeAdSpend: numeric ? "100" : null, share: null }] } as Bucket;
});
const googleRange = { from: "2026-09-30", to: "2026-10-29" };

test("date recommendation prioritizes complete calendar windows before balanced observed days", () => {
  const result = recommendChangeDate(googleDates, "GOOGLE", googleRange, 7, "2026-10-14");
  assert.deepEqual(result, { date: "2026-10-23", fullWindow: true, beforeDays: 3, afterDays: 6 });
  const missing = analyzeChanges(googleDates, { ...options, medium: "GOOGLE", changeDate: "2026-10-14" }).spend;
  assert.equal(applyRecommendedDate("2026-10-14", missing, result, false), "2026-10-23");
  assert.equal(applyRecommendedDate("2026-10-14", missing, result, true), "2026-10-14");
  assert.equal(analyzeChanges(googleDates, { ...options, medium: "GOOGLE", changeDate: result!.date }).series.find(row => row.date === "2026-10-24")!.adSpend, null);
});

test("recommendations use coverage only, not financial values, and retain an already usable date", () => {
  const original = recommendChangeDate(googleDates, "GOOGLE", googleRange, 7, "2026-10-14");
  const changed = googleDates.map((bucket, i) => ({ ...bucket, byMedium: bucket.byMedium.map(medium => ({ ...medium, completeAdSpend: medium.completeAdSpend === null ? null : String(i % 2 ? 1 : 1000000) })) }));
  assert.deepEqual(recommendChangeDate(changed, "GOOGLE", googleRange, 7, "2026-10-14"), original);
  assert.equal(applyRecommendedDate("2026-10-22", { before: 100, after: 120 }, original, false), "2026-10-22");
});

test("short ranges require explicit partial-window recommendation and one observed day gives no recommendation", () => {
  const short = recommendChangeDate(googleDates, "GOOGLE", { from: "2026-10-20", to: "2026-10-23" }, 7, "2026-10-20");
  assert.ok(short); assert.equal(short.fullWindow, false);
  assert.equal(applyRecommendedDate("2026-10-20", { before: null, after: 100 }, short, false), "2026-10-20");
  assert.equal(recommendChangeDate([googleDates.find(row => row.date === "2026-10-20")!], "GOOGLE", googleRange, 7, "2026-10-14"), null);
});

test("recommendation excludes duplicates, aggregate buckets and explicit unavailable display even with fallback numbers", () => {
  const duplicate = googleDates.find(row => row.date === "2026-10-20")!;
  const onlyOne = [duplicate, duplicate, { ...duplicate, date: "2026-10-21", bucketFrom: "2026-10-21", bucketTo: "2026-10-28" },
    { ...duplicate, date: "2026-10-22", bucketFrom: "2026-10-22", bucketTo: "2026-10-22", byMedium: [{ ...duplicate.byMedium[0], displayAdSpend: { value: null, state: "UNAVAILABLE" as const, availableSources: [], missingSources: ["GOOGLE" as const] } }] }];
  assert.equal(recommendChangeDate(onlyOne, "GOOGLE", googleRange, 7, "2026-10-14"), null);
});

test("confirmed numeric zero participates in date coverage and comparison status distinguishes missing, zero and negative", () => {
  const zeroRows = googleDates.map(bucket => ({ ...bucket, byMedium: bucket.byMedium.map(medium => ({ ...medium, completeAdSpend: medium.completeAdSpend === null ? null : "0" })) }));
  assert.equal(recommendChangeDate(zeroRows, "GOOGLE", googleRange, 7, "2026-10-14")!.date, "2026-10-23");
  const value = analyzeChanges(rows, options).spend;
  assert.equal(changeStatusLabel({ ...value, before: null, after: null }), "전후 자료 없음");
  assert.equal(changeStatusLabel({ ...value, before: null }), "변경 전 자료 없음");
  assert.equal(changeStatusLabel({ ...value, after: null }), "변경 후 자료 없음");
  assert.equal(changeStatusLabel({ ...value, before: 0, after: 10 }), "0원에서 증가");
  assert.equal(changeStatusLabel({ ...value, before: 0, after: 10, beforePartialDays: 1 }), "기준 0원 · 증감액 확인");
  assert.equal(changeStatusLabel({ ...value, before: 0, after: 10, beforeDays: 6 }), "기준 0원 · 증감액 확인");
  assert.equal(changeStatusLabel({ ...value, before: -1 }), "음수 기준 · 증감액 확인");
  assert.equal(changeStatusLabel(value), null);
});
