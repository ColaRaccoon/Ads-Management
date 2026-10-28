import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION } from "../types";
import type { AdapterRequest } from "../types";
import { AdDayInput, AdRow, adPageDate, normalizeAdDay, sum } from "./ad-source";

export const adRequest = (platform: "META" | "GOOGLE" = "META"): AdapterRequest => ({
  contractVersion: CONTRACT_VERSION, runId: "test-run", readSnapshotId: "test-snapshot", from: "2026-10-26", to: "2026-10-26",
  scopeKeys: ["scope"], platforms: [platform], sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100,
  scopePolicyVersion: "scope-v1", nameRuleVersion: "name-v1", saleUnitRuleVersion: "unit-v1", allocationRuleVersion: "allocation-v1",
  calculationVersion: "calculation-v1", fxVersion: "fx-v1"
});
export const adRow = (key: string, amount: string, name = "보호대"): AdRow => ({ id: `row-${key}`, entityKey: key, originalName: name,
  source: "CSV", sourceVersion: "1", runOrUploadId: "batch", observedAt: "2026-10-26T01:00:00Z", updatedAt: "2026-10-26T02:00:00Z",
  amount, conversionRevenue: null });
export const adInput = (rows: readonly AdRow[]): AdDayInput => ({ platform: "META", date: "2026-10-26", scopeKey: "scope", currency: "USD",
  timeZone: "Asia/Seoul", rows, selectedSource: "CSV", complete: true, sourceIssues: [], storedCoverage: null,
  fx: { rate: "1324.3", sourceDate: "2026-10-26", provider: "KOREA_EXIM", fallbackType: "EXACT" }, excludedRows: 0,
  configuration: { products: [{ canonicalName: "보호대" }], nameRules: [] } });

test("Meta adset spend preserves USD, dated FX and independent same-name entities without sales", () => {
  const batch = normalizeAdDay(adRequest(), adInput([adRow("old-adset", "10.2500"), adRow("new-id-same-name", "2.5000")]));
  assert.equal(batch.sales.length, 0); assert.equal(batch.commonExpenses.length, 0);
  assert.equal(batch.adSpends.length, 2);
  assert.deepEqual(batch.adSpends.map(fact => fact.productName), ["보호대", "보호대"]);
  assert.equal(sum(batch.adSpends.map(fact => fact.originalAmount)).toFixed(), "12.75");
  assert.equal(sum(batch.adSpends.map(fact => fact.amountKrw!)).toFixed(), "16884.825");
  assert.equal(batch.adSpends[0].fx.requestedDate, "2026-10-26");
  assert.ok(batch.sourceControlTotals.every(control => control.difference === "0.000000"));
});

test("Meta classification collisions remain unassigned and amounts are conserved", () => {
  const input = adInput([adRow("a", "4", "공용 보호대"), adRow("b", "3", "알수없음")]);
  input.configuration = { products: [{ canonicalName: "제품A" }, { canonicalName: "제품B" }], nameRules: ["제품A", "제품B"].map((product, index) => ({
    id: String(index), canonicalProductName: product, matchType: "CONTAINS", terms: ["보호대"], validFrom: "2026-01-01"
  })) };
  const batch = normalizeAdDay(adRequest(), input);
  assert.equal(batch.adSpends[0].name.matchStatus, "AMBIGUOUS");
  assert.equal(batch.adSpends[1].name.matchStatus, "UNMATCHED");
  assert.equal(batch.sourceControlTotals[0].unmatchedAmount, "7.000000");
  assert.equal(batch.coverage[0].unmappedRows, 2);
});

test("missing Meta FX preserves original spend and null converted totals", () => {
  const input = { ...adInput([adRow("a", "1.23")]), fx: null };
  const batch = normalizeAdDay(adRequest(), input);
  assert.equal(batch.adSpends[0].originalAmount, "1.230000");
  assert.equal(batch.adSpends[0].amountKrw, null);
  assert.equal(batch.sourceControlTotals.find(control => control.currency === "KRW")!.selectedAmount, null);
  assert.equal(batch.coverage[0].missingFxAmount, "1.230000");
});

test("Meta saved weekend FX and name-based legacy fallback retain distinct evidence", () => {
  const weekend = adInput([adRow("new-id", "1")]); weekend.fx = { rate: "1324.6", sourceDate: "2026-10-23", provider: "KOREA_EXIM", fallbackType: "PREVIOUS_AVAILABLE" };
  assert.equal(normalizeAdDay(adRequest(), weekend).adSpends[0].fx.sourceDate, "2026-10-23");
  const fallback = { ...weekend, fx: null, legacyFx: new Map([["보호대", { rate: "1300", sourceDate: "2026-10-01", ruleId: "cost-rule" }]]) };
  const fact = normalizeAdDay(adRequest(), fallback).adSpends[0];
  assert.equal(fact.amountKrw, "1300.000000"); assert.equal(fact.fx.provider, "PRODUCT_COST_RULE");
  assert.ok(fact.quality.issues.includes("LEGACY_PRODUCT_FX_FALLBACK"));
});

test("deterministic micro-won residuals conserve exact daily conversion including negative corrections", () => {
  for (const sign of ["", "-"]) {
    const input = adInput([adRow("b", `${sign}0.0001`), adRow("a", `${sign}0.0001`)]);
    input.fx = { rate: "0.006", sourceDate: "2026-10-26", provider: "test", fallbackType: "EXACT" };
    const batch = normalizeAdDay(adRequest(), input);
    assert.equal(sum(batch.adSpends.map(fact => fact.amountKrw!)).toFixed(6), `${sign}0.000001`);
    const reversed = normalizeAdDay(adRequest(), { ...input, rows: [...input.rows].reverse() });
    assert.deepEqual(batch.adSpends.map(fact => fact.amountKrw), reversed.adSpends.map(fact => fact.amountKrw));
    assert.ok(batch.adSpends.some(fact => fact.roundingAdjustment !== "0.000000"));
  }
});

test("duplicate entity/day, excluded platform, insufficient page and invalid cursor are rejected", () => {
  assert.throws(() => normalizeAdDay(adRequest(), adInput([adRow("a", "1"), adRow("a", "2")])), /Duplicate/);
  assert.throws(() => normalizeAdDay({ ...adRequest(), platforms: ["CAFE24"] }, adInput([])), /Excluded/);
  assert.throws(() => normalizeAdDay({ ...adRequest(), limit: 1 }, adInput([adRow("a", "1"), adRow("b", "2")])), /PAGE_LIMIT/);
  assert.throws(() => adPageDate({ ...adRequest(), cursor: "2026-10-27" }, "META"), /escaped/);
});

test("empty published day is zero, uncollected day is null, and timezone mismatch never shifts its business date", () => {
  const zero = normalizeAdDay(adRequest(), adInput([]));
  assert.equal(zero.coverage[0].zeroConfirmed, true);
  assert.equal(zero.sourceControlTotals[0].selectedAmount, "0.000000");
  const missing = normalizeAdDay(adRequest(), { ...adInput([]), complete: false });
  assert.equal(missing.coverage[0].zeroConfirmed, false);
  assert.equal(missing.sourceControlTotals[0].selectedAmount, null);
  const timezone = normalizeAdDay(adRequest(), { ...adInput([adRow("a", "1")]), timeZone: "America/Los_Angeles" });
  assert.equal(timezone.adSpends[0].ref.businessDate, "2026-10-26");
  assert.ok(timezone.adSpends[0].quality.issues.includes("TIME_ZONE_MISMATCH"));
});

test("day cursor returns the next requested day, and no ad-level facts enter normalization", () => {
  const request = { ...adRequest(), to: "2026-11-01" };
  const batch = normalizeAdDay(request, adInput([adRow("adset-only", "1")]));
  assert.equal(batch.nextCursor, "2026-10-27");
  assert.equal(batch.adSpends[0].ref.table, "meta_adset_daily_metrics");
  assert.equal(batch.adSpends[0].ref.sourceSystem, "META_ADSET");
});
