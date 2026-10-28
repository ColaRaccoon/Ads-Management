import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAdDay, sum } from "./ad-source";
import { CONTRACT_VERSION } from "../types";
import type { AdapterRequest } from "../types";
import type { AdDayInput, AdRow } from "./ad-source";

const adRequest = (_platform: "GOOGLE"): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: "test-run", readSnapshotId: "test-snapshot",
  from: "2026-10-26", to: "2026-10-26", scopeKeys: ["scope"], platforms: ["GOOGLE"], sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100,
  scopePolicyVersion: "scope-v1", nameRuleVersion: "name-v1", saleUnitRuleVersion: "unit-v1", allocationRuleVersion: "allocation-v1", calculationVersion: "calculation-v1", fxVersion: "fx-v1" });
const adRow = (key: string, amount: string): AdRow => ({ id: key, entityKey: key, originalName: "보호대", source: "API", sourceVersion: "1", runOrUploadId: "run",
  observedAt: "2026-10-26T01:00:00Z", updatedAt: "2026-10-26T01:00:00Z", amount, conversionRevenue: null });
const adInput = (rows: readonly AdRow[]): AdDayInput => ({ platform: "GOOGLE", date: "2026-10-26", scopeKey: "scope", currency: "USD", timeZone: "Asia/Seoul", rows,
  selectedSource: "API", complete: true, sourceIssues: [], storedCoverage: null, excludedRows: 0,
  fx: { rate: "1324.3", sourceDate: "2026-10-26", provider: "KOREA_EXIM", fallbackType: "EXACT" }, configuration: { products: [{ canonicalName: "보호대" }], nameRules: [] } });

test("Google large integer micros remain exact beyond Number precision and conversion value is reference only", () => {
  const row = { ...adRow("new-campaign-id", "9007199254740993"), conversionRevenue: "12000000" };
  const batch = normalizeAdDay(adRequest("GOOGLE"), { ...adInput([row]), platform: "GOOGLE", currency: "KRW", fx: null });
  assert.equal(batch.adSpends[0].originalAmount, "9007199254.740993");
  assert.equal(batch.adSpends[0].amountKrw, "9007199254.740993");
  assert.equal(batch.adSpends[0].referenceConversionRevenue, "12000000.000000");
  assert.equal(batch.sales.length, 0); assert.equal(batch.commonExpenses.length, 0);
  assert.equal(batch.adSpends[0].fx.rate, "1"); assert.equal(batch.adSpends[0].productName, "보호대");
});

test("Google non-KRW FX preserves micros and missing currency conversion", () => {
  const input = { ...adInput([adRow("a", "1234567")]), platform: "GOOGLE" as const, currency: "USD" };
  const converted = normalizeAdDay(adRequest("GOOGLE"), input).adSpends[0];
  assert.equal(converted.originalAmount, "1.234567"); assert.equal(converted.amountKrw, "1634.937078");
  const missing = normalizeAdDay(adRequest("GOOGLE"), { ...input, fx: null });
  assert.equal(missing.adSpends[0].amountKrw, null);
  assert.equal(missing.sourceControlTotals[0].selectedAmount, "1.234567");
});

test("Google campaign names classify identically after ID changes and retain separate campaign costs", () => {
  const rows = [adRow("old-id", "1000000"), adRow("new-id", "2000000")];
  const batch = normalizeAdDay(adRequest("GOOGLE"), { ...adInput(rows), platform: "GOOGLE", currency: "KRW", fx: null });
  assert.deepEqual(batch.adSpends.map(fact => fact.productName), ["보호대", "보호대"]);
  assert.equal(sum(batch.adSpends.map(fact => fact.amountKrw!)).toFixed(), "3");
  assert.equal(batch.sourceControlTotals[0].difference, "0.000000");
});

test("Google integer-only micros and a genuine zero day differ from missing collection", () => {
  assert.throws(() => normalizeAdDay(adRequest("GOOGLE"), { ...adInput([adRow("a", "1.5")]), platform: "GOOGLE", currency: "KRW" }), /integer string/);
  const zero = normalizeAdDay(adRequest("GOOGLE"), { ...adInput([]), platform: "GOOGLE", currency: "KRW" });
  assert.equal(zero.sourceControlTotals[0].selectedAmount, "0.000000");
  const missing = normalizeAdDay(adRequest("GOOGLE"), { ...adInput([]), platform: "GOOGLE", currency: "KRW", complete: false });
  assert.equal(missing.sourceControlTotals[0].selectedAmount, null);
});
