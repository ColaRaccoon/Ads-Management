import test from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION } from "./types";
import type { AdapterBatch, AdapterRequest, SourceRef } from "./types";
import { assertAdapterRequest, assertAdapterBatch, logicalSourceKey, assertOffsetTimestamp } from "./adapter-contract";

const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: "run", readSnapshotId: "snapshot", from: "2026-10-01", to: "2026-10-01", scopeKeys: ["store"], platforms: ["NAVER"],
  scopePolicyVersion: "s1", nameRuleVersion: "n1", saleUnitRuleVersion: "u1", allocationRuleVersion: "a1", calculationVersion: "c1", fxVersion: "f1", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 };
const source: SourceRef = { sourceSystem: "NAVER_JSONB", platform: "NAVER", schema: "public", table: "daily_fake_purchases", scopeKey: "store", recordKind: "FAKE_PURCHASE", sourceRecordKey: "one", selectedSource: "stored", sourceVersion: "v1", uploadOrRunId: null, payloadHash: null, providerUpdatedAt: null, observedAt: "2026-10-01T00:00:00Z", businessDate: "2026-10-01", dateBasis: "paymentDate", sourceTimeZone: "Asia/Seoul" };
const batch = (): AdapterBatch => ({ sales: [], adSpends: [], coverage: [], sourceControlTotals: [], nextCursor: null, sourceFingerprint: null,
  commonExpenses: [{ ref: { ...source }, expenseKey: "expense", kind: "FAKE_PURCHASE", scopeKey: "store", productName: null, allocationStatus: "UNALLOCATED", allocationRuleVersion: "a1", originalAmount: "10", amountKrw: null, unallocatedAmount: null, quality: { isEstimate: true, confidence: "ESTIMATED", issues: ["SOURCE_LIMITATION"] } }] });
test("adapter request rejects excluded sources, invalid/leap dates, oversized windows and multi-scope batches", () => {
  assert.doesNotThrow(() => assertAdapterRequest(request, "NAVER"));
  assert.throws(() => assertAdapterRequest(request, "META"));
  assert.throws(() => assertAdapterRequest({ ...request, from: "2026-02-29" }, "NAVER"));
  assert.throws(() => assertAdapterRequest({ ...request, to: "2027-10-01" }, "NAVER"));
  assert.throws(() => assertAdapterRequest({ ...request, scopeKeys: [] }, "NAVER"));
});
test("logical key preserves same-name separate orders and distinguishes record kinds", () => {
  assert.notEqual(logicalSourceKey(source), logicalSourceKey({ ...source, sourceRecordKey: "two" }));
  assert.notEqual(logicalSourceKey(source), logicalSourceKey({ ...source, recordKind: "SALE" }));
});
test("timestamp evidence requires valid calendar dates and an explicit offset; ad-only platforms cannot emit common costs", () => {
  assert.doesNotThrow(() => assertOffsetTimestamp("2026-10-01T12:00:00+09:00"));
  assert.throws(() => assertOffsetTimestamp("2026-10-01T12:00:00"));
  assert.throws(() => assertOffsetTimestamp("2026-02-31T12:00:00Z"));
  const adExpense = batch(); adExpense.commonExpenses[0].ref.platform = "META";
  assert.throws(() => assertAdapterBatch({ ...request, platforms: ["META"] }, "META", adExpense), /Ad-only/);
});
test("batch boundary preserves missing/estimated values and rejects duplicate facts, numeric JSON and escaped scope", () => {
  assert.doesNotThrow(() => assertAdapterBatch(request, "NAVER", batch()));
  const duplicate = batch(); duplicate.commonExpenses.push({ ...duplicate.commonExpenses[0] });
  assert.throws(() => assertAdapterBatch(request, "NAVER", duplicate), /Duplicate/);
  const escaped = batch(); escaped.commonExpenses[0].ref.scopeKey = "other";
  assert.throws(() => assertAdapterBatch(request, "NAVER", escaped));
  const unsafe = batch(); unsafe.commonExpenses[0].amountKrw = 10 as unknown as string;
  assert.throws(() => assertAdapterBatch(request, "NAVER", unsafe), /decimal string/);
});
