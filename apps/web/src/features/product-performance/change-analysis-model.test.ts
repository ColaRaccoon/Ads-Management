import test from "node:test";
import assert from "node:assert/strict";
import { analyzeChanges } from "./change-analysis-model";
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
