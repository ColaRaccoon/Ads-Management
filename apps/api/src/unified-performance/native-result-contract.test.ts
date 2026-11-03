import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { assertAdapterBatch } from "./adapter-contract";
import type { NativeStoredResult } from "./native-result-contract";
import { missingCoverage } from "./report.repository";
import { CONTRACT_VERSION, type AdapterBatch, type AdapterRequest, type Platform } from "./types";

const day = "2026-11-02";
function fixture(platform: Platform = "NAVER") {
  const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: "run", readSnapshotId: "snapshot",
    from: day, to: day, scopeKeys: ["scope"], platforms: [platform], scopePolicyVersion: "s", nameRuleVersion: "n",
    saleUnitRuleVersion: "u", allocationRuleVersion: "a", calculationVersion: "c", fxVersion: "f",
    sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 10000 };
  const groups = platform === "CAFE24" ? ["STOREFRONT", "GOOGLE"] as const : [platform as "NAVER" | "COUPANG"];
  const nativeResults: NativeStoredResult[] = groups.map(group => ({ kind: "SUMMARY", group,
    productKey: `${group}:summary`, productName: null, quantity: "0",
    revenue: { known: "0", complete: "0" }, adSpend: { known: "0", complete: "0" },
    netProfit: { known: "0", complete: "0" }, profitBeforeAds: { known: "0", complete: "0" },
    sourceUpdatedAt: "2026-11-02T09:00:00Z", issues: [] }));
  const batch: AdapterBatch = { nativeResults, sales: [], adSpends: [], commonExpenses: [],
    coverage: missingCoverage({ platform, scopeKey: "scope", label: "scope" }, day),
    sourceControlTotals: [], nextCursor: null, sourceFingerprint: "source-final" };
  return { request, batch, rows: nativeResults, validate: () => assertAdapterBatch(request, platform, batch) };
}

test("native contract preserves full source precision and independently stored final profit", () => {
  const f = fixture();
  const precise = "123456789012345678901.123456789012";
  f.rows[0].revenue = { known: precise, complete: precise };
  f.rows[0].adSpend = { known: "19.25", complete: "19.2500" };
  f.rows[0].netProfit = { known: "-3.333333333333", complete: "-3.333333333333" };
  f.rows[0].profitBeforeAds = { known: "999", complete: "999" };
  const before = structuredClone(f.batch);
  assert.doesNotThrow(f.validate);
  assert.deepEqual(f.batch, before, "validation never rounds JSON or derives final net from other fields");
  f.rows[0].revenue.complete = "123456789012345678901.123456789013";
  assert.throws(f.validate, /NATIVE_RESULT_COMPLETE_KNOWN_MISMATCH/, "equality is checked before six-place column quantization");
});

test("native complete amount requires an equal known amount for each independent metric", () => {
  for (const metric of ["revenue", "adSpend", "netProfit", "profitBeforeAds"] as const) {
    const f = fixture();
    f.rows[0][metric] = { known: null, complete: "0" };
    assert.throws(f.validate, /NATIVE_RESULT_COMPLETE_KNOWN_MISMATCH/, metric);
    f.rows[0][metric] = { known: "1", complete: "2" };
    assert.throws(f.validate, /NATIVE_RESULT_COMPLETE_KNOWN_MISMATCH/, metric);
    f.rows[0][metric] = { known: "1", complete: null };
    assert.doesNotThrow(f.validate);
    f.rows[0][metric] = { known: null, complete: null };
    assert.doesNotThrow(f.validate);
  }
});

test("native groups require exactly one owned summary and unique product identities", () => {
  for (const platform of ["CAFE24", "NAVER", "COUPANG"] as const) {
    const f = fixture(platform);
    assert.doesNotThrow(f.validate);
    f.rows.push({ ...f.rows[0], kind: "PRODUCT", productKey: "product", productName: "A" });
    assert.doesNotThrow(f.validate);
    f.rows.push({ ...f.rows.at(-1)! });
    assert.throws(f.validate, /DUPLICATE_NATIVE_RESULT/);
    f.rows.pop();
    f.rows.push({ ...f.rows[0], productKey: "second-summary" });
    assert.throws(f.validate, /NATIVE_RESULT_SUMMARY_REQUIRED/);
    f.rows.pop();
    f.rows[0].group = platform === "NAVER" ? "COUPANG" : "NAVER";
    assert.throws(f.validate, /INVALID_NATIVE_RESULT_IDENTITY/);
  }
  const cafe = fixture("CAFE24"); cafe.rows.pop();
  assert.throws(cafe.validate, /NATIVE_RESULT_SUMMARY_REQUIRED/, "both storefront and Google partitions are explicit");
});

test("native contract rejects ambiguous dates and invalid amounts without inventing zeroes", () => {
  const f = fixture();
  f.request.to = "2026-11-03";
  f.batch.coverage.push({ ...f.batch.coverage[0], date: "2026-11-03" });
  assert.throws(f.validate, /NATIVE_RESULT_SINGLE_DAY_REQUIRED/);
  for (const invalid of ["NaN", "Infinity", "1e3", "1000000000000000000000000"]) {
    const sample = fixture(); sample.rows[0].netProfit = { known: invalid, complete: null };
    assert.throws(sample.validate);
  }
});
