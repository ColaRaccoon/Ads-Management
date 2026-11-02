import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyReport, dailyMetricStatusLabel, latestDailyDate, latestPublishedDate } from "./daily-report-model";
import type { Bucket, Coverage, DisplayAmount, Totals } from "./types";

const totals = (values: Partial<Totals> = {}): Totals => ({ revenue: null, estimatedProfit: null, adSpend: null, profitBeforeAds: null, mer: null, ...values });
const display = (value: string | null, state: DisplayAmount["state"] = value === null ? "UNAVAILABLE" : "COMPLETE"): DisplayAmount =>
  ({ value, state, availableSources: value === null ? [] : ["CAFE24"], missingSources: state === "COMPLETE" ? [] : ["GOOGLE"] });
const bucket = (date: string, values: Partial<Totals> = {}): Bucket => ({ date, bucketFrom: date, bucketTo: date, partial: false,
  knownTotals: totals(values), completeTotals: totals(values), byMarketplace: [], byMedium: [], coverage: [], isEstimate: false } as unknown as Bucket);

test("selected day compares independent authoritative totals with exactly the prior calendar day", () => {
  const rows = [bucket("2026-10-28", { revenue: "80", estimatedProfit: "40", adSpend: "10" }),
    bucket("2026-10-29", { revenue: "100", estimatedProfit: "30", adSpend: "20" })];
  const report = buildDailyReport(rows, "2026-10-29");
  assert.equal(report.previousDate, "2026-10-28");
  assert.equal(report.totals.revenue.change, 20); assert.equal(report.totals.revenue.changePct, 25);
  assert.equal(report.totals.estimatedProfit.change, -10); assert.equal(report.totals.estimatedProfit.changePct, -25);
  assert.equal(report.totals.adSpend.change, 10); assert.equal(report.totals.adSpend.changePct, 100);
  assert.equal(report.hasCurrentData, true); assert.equal(report.hasPreviousData, true);
});

test("total net profit and ad spend never sum marketplace and medium ledgers a second time", () => {
  const row = bucket("2026-10-29", { revenue: "100", estimatedProfit: "30", adSpend: "20" });
  row.byMarketplace = [{ marketplace: "CAFE24", revenue: "100", display: { revenue: display("100"), estimatedProfit: display("30"), adSpend: display("20") } }];
  row.byMedium = [{ medium: "META", adSpend: "20", completeAdSpend: "20", share: "100", displayAdSpend: display("20") }];
  const report = buildDailyReport([row], row.date);
  assert.equal(report.totals.estimatedProfit.current, 30); assert.equal(report.totals.adSpend.current, 20);
  assert.equal(report.marketplaces[0].estimatedProfit.current, 30); assert.equal(report.media[0].adSpend.current, 20);
});

test("missing Google preserves useful partial profit and other metrics; explicit unavailable stays null", () => {
  const row = bucket("2026-10-29", { revenue: "100", estimatedProfit: "30", adSpend: "20" });
  row.completeTotals.estimatedProfit = null; row.completeTotals.adSpend = null;
  row.coverage = [{ platform: "GOOGLE", component: "AD_SPEND", participation: "INCLUDED", collectionState: "NOT_COLLECTED", missingCostRows: 0 } as Coverage];
  row.byMarketplace = [{ marketplace: "CAFE24", revenue: "100", estimatedProfit: null, display: { revenue: display("100"), estimatedProfit: display("30", "PARTIAL"), adSpend: display("20", "PARTIAL") } }];
  row.byMedium = [{ medium: "GOOGLE", adSpend: "999", completeAdSpend: "999", share: null, displayAdSpend: display(null) }];
  const report = buildDailyReport([row], row.date);
  assert.equal(report.totals.revenue.currentState, "COMPLETE"); assert.deepEqual(report.totals.revenue.missingSources, []);
  assert.equal(report.totals.estimatedProfit.current, 30); assert.equal(report.totals.estimatedProfit.currentState, "PARTIAL");
  assert.deepEqual(report.totals.estimatedProfit.currentMissingSources, ["GOOGLE"]);
  assert.equal(report.marketplaces[0].estimatedProfit.current, 30); assert.equal(report.marketplaces[0].estimatedProfit.currentState, "PARTIAL");
  assert.equal(report.media[0].adSpend.current, null); assert.equal(report.media[0].adSpend.currentState, "UNAVAILABLE");
});

test("missing cost only suppresses profit, while known revenue and ad spend remain visible", () => {
  const report = buildDailyReport([bucket("2026-10-29", { revenue: "100", adSpend: "20" })], "2026-10-29");
  assert.equal(report.totals.revenue.current, 100); assert.equal(report.totals.adSpend.current, 20);
  assert.equal(report.totals.estimatedProfit.current, null); assert.equal(report.totals.estimatedProfit.currentState, "UNAVAILABLE");
});

test("missing selected day and missing previous day never substitute another available date", () => {
  const rows = [bucket("2026-10-27", { revenue: "80" }), bucket("2026-10-29", { revenue: "100" })];
  const current = buildDailyReport(rows, "2026-10-29");
  assert.equal(current.totals.revenue.previous, null); assert.equal(current.totals.revenue.change, null);
  assert.equal(dailyMetricStatusLabel(current.totals.revenue), "전일 자료 없음");
  const missing = buildDailyReport(rows, "2026-10-28");
  assert.equal(missing.date, "2026-10-28"); assert.equal(missing.totals.revenue.current, null);
  assert.equal(missing.totals.revenue.previous, 80); assert.equal(missing.hasCurrentData, false);
});

test("confirmed zero counts as data, but percentage is unavailable for zero or negative baselines", () => {
  const rows = [bucket("2026-10-28", { revenue: "0", estimatedProfit: "-10", adSpend: "0" }),
    bucket("2026-10-29", { revenue: "100", estimatedProfit: "20", adSpend: "0" })];
  const report = buildDailyReport(rows, "2026-10-29");
  assert.equal(report.totals.revenue.change, 100); assert.equal(report.totals.revenue.changePct, null);
  assert.equal(dailyMetricStatusLabel(report.totals.revenue), "0원에서 증가");
  assert.equal(report.totals.estimatedProfit.change, 30); assert.equal(report.totals.estimatedProfit.changePct, null);
  assert.equal(report.totals.adSpend.current, 0); assert.equal(report.hasPreviousData, true);
});

test("latest observed data ignores empty, weekly and duplicate dates and respects a date cap", () => {
  const older = bucket("2026-10-27", { revenue: "100" }), zero = bucket("2026-10-28", { revenue: "0" });
  const empty = bucket("2026-10-29"), weekly = { ...bucket("2026-10-30", { revenue: "999" }), bucketTo: "2026-11-05" };
  assert.equal(latestDailyDate([empty, weekly, older, zero]), zero.date);
  assert.equal(latestDailyDate([empty, weekly, older, zero], "2026-10-27"), older.date);
  assert.equal(latestDailyDate([empty, zero, { ...zero }]), null);
  assert.equal(buildDailyReport([zero, { ...zero }], zero.date).totals.revenue.current, null);
  assert.equal(buildDailyReport([weekly], weekly.date).totals.revenue.current, null);
});

test("publication anchor filters platform and account, excludes future dates, and does not assert numeric data", () => {
  const ranges = [{ platform: "GOOGLE" as const, scopeKey: "g", from: "2026-10-20", to: "2026-10-29" },
    { platform: "CAFE24" as const, scopeKey: "s", from: "2026-09-01", to: "2026-11-03" }];
  assert.equal(latestPublishedDate(ranges, { platforms: ["GOOGLE"] }, "2026-11-02"), "2026-10-29");
  assert.equal(latestPublishedDate(ranges, { platforms: ["GOOGLE", "CAFE24"], scopeKeys: ["s"] }, "2026-11-02"), null);
  assert.equal(latestPublishedDate(ranges, { platforms: ["GOOGLE", "CAFE24"] }, "2026-11-02"), "2026-10-29");
  assert.equal(latestPublishedDate(ranges, { platforms: ["GOOGLE"], scopeKeys: [] }, "2026-11-02"), null);
  assert.equal(latestPublishedDate(ranges, { platforms: ["GOOGLE"], scopeKeys: ["s"] }, "2026-11-02"), null);
  assert.equal(latestDailyDate([bucket("2026-10-29")]), null);
});

test("read models preserve their input and reject invalid business dates or unsafe amounts", () => {
  const row = bucket("2026-10-29", { revenue: "9007199254740993.123456", adSpend: "Infinity" }), before = structuredClone(row);
  const report = buildDailyReport([row], row.date);
  assert.equal(report.totals.revenue.current, null); assert.equal(report.totals.adSpend.current, null);
  assert.deepEqual(row, before);
  assert.throws(() => buildDailyReport([row], "2026-02-30"));
  assert.throws(() => latestDailyDate([row], "not-a-date"));
});

test("channels present only on the previous day are retained with a missing current amount", () => {
  const row = bucket("2026-10-28", { revenue: "80", adSpend: "10" });
  row.byMarketplace = [{ marketplace: "CAFE24", revenue: "80", completeRevenue: "80", estimatedProfit: "30" }];
  row.byMedium = [{ medium: "META", adSpend: "10", completeAdSpend: "10", share: "100" }];
  const report = buildDailyReport([row, bucket("2026-10-29")], "2026-10-29");
  assert.equal(report.marketplaces[0].revenue.current, null); assert.equal(report.marketplaces[0].revenue.previous, 80);
  assert.equal(report.media[0].adSpend.current, null); assert.equal(report.media[0].adSpend.previous, 10);
});
