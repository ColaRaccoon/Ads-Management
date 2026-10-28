import test from "node:test";
import assert from "node:assert/strict";
import { bucketLabel, chartNumber, chartRows, compositionAvailable, movingAverages } from "./chart-model";
import type { Bucket } from "./types";

function bucket(date: string, amount: string | null = "70.000000"): Bucket {
  const totals = { revenue: "140.000000", adSpend: amount, profitBeforeAds: "100.000000", estimatedProfit: "30.000000", mer: "2.0000000000" };
  return { date, bucketFrom: date, bucketTo: date, partial: false, knownTotals: { ...totals }, completeTotals: { ...totals },
    byMedium: [{ medium: "NAVER_DA", adSpend: amount, share: "100.0000000000" }], byMarketplace: [],
    coverage: [], isEstimate: true, issues: [], productProfitSubtotal: null, unallocatedAdSpends: [], unallocatedExpenses: [], unclassifiedSales: [],
    scopeBalances: { unallocatedAdSpend: null, unallocatedExpense: null, shippingIncome: null, unallocatedShippingIncome: null, unclassifiedRevenue: null, unclassifiedProfitBeforeAds: null } };
}

test("missing inputs break lines, completed zero remains zero, and usable Naver estimates remain plotted", () => {
  const missing = bucket("2026-10-02", null);
  missing.completeTotals.revenue = null;
  missing.knownTotals.revenue = "27.000000";
  const zero = bucket("2026-10-03", "0.000000"); zero.completeTotals.revenue = "0.000000";
  const rows = chartRows([bucket("2026-10-01"), missing, zero], ["NAVER_DA"]);
  assert.equal(rows[0].revenue, 140);
  assert.equal(rows[0].ad0, 70);
  assert.equal(rows[1].revenue, null);
  assert.equal(rows[1].ad0, null);
  assert.equal(rows[2].revenue, 0);
  assert.equal(rows[2].ad0, 0);
});

test("chart coordinates reject unsafe monetary magnitudes without modifying original decimal strings", () => {
  const amount = "9007199254740993.123456";
  assert.equal(chartNumber(amount), null);
  assert.equal(chartNumber("9007199254740991.000001"), null);
  assert.equal(chartNumber("-9007199254740991.000001"), null);
  assert.equal(chartNumber("9007199254740991.000000"), Number.MAX_SAFE_INTEGER);
  assert.equal(chartNumber("12.123456"), 12.123456);
  assert.equal(amount, "9007199254740993.123456");
});

test("100 percent composition omits missing, nonpositive denominator and negative correction periods", () => {
  const zero = bucket("2026-10-01", "0.000000"), negative = bucket("2026-10-02"); negative.byMedium[0].share = "-10.0000000000";
  assert.equal(compositionAvailable(zero), false);
  assert.equal(compositionAvailable(negative), false);
  assert.equal(compositionAvailable(bucket("2026-10-03", null)), false);
  assert.equal(compositionAvailable(bucket("2026-10-04")), true);
});

test("seven day averages require consecutive complete daily buckets and preserve micro-unit rounding", () => {
  const rows = Array.from({ length: 7 }, (_, index) => bucket(`2026-10-0${index + 1}`, index === 0 ? "0.000004" : "0.000000"));
  assert.deepEqual(movingAverages(rows).slice(0, 6), Array(6).fill(null));
  assert.equal(movingAverages(rows)[6], "0.000001");
  rows[3].completeTotals.adSpend = null;
  assert.equal(movingAverages(rows)[6], null);
  rows[3] = bucket("2026-10-09");
  assert.equal(movingAverages(rows)[6], null);
});

test("partial calendar month label uses actual included dates instead of the calendar anchor", () => {
  const row = bucket("2026-10-01"); row.bucketFrom = "2026-10-15"; row.bucketTo = "2026-10-27"; row.partial = true;
  assert.equal(bucketLabel(row), "2026-10-15 ~ 2026-10-27 · 부분기간");
});
