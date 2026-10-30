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
