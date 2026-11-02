import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import type { AdapterRequest } from "../types";
import { assertSourceExecutionSucceeded, completeSourceCoverage } from "../aggregation.worker";
import { prepareReportBatch, summarizeReport } from "../domain/report-calculation";
import { normalizeNaverStoredDay } from "./naver-native-results";
import type { NaverStoredRaw, NaverStoredErrors } from "./naver-reader";

const date = "2026-11-01", at = "2026-11-02T07:00:00Z", scope = "11111111-1111-4111-8111-111111111111";
const request = (): AdapterRequest => ({ contractVersion: "product-performance-v1.1.0", runId: "run", readSnapshotId: "snapshot", from: date, to: date, scopeKeys: [scope], platforms: ["NAVER"],
  scopePolicyVersion: "s", nameRuleVersion: "n", saleUnitRuleVersion: "u", allocationRuleVersion: "a", calculationVersion: "c", fxVersion: "f", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 10000 });
const configuration = { products: [{ canonicalName: "상품A" }], nameRules: [] };
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, storeId: scope, date, updatedAt: at, calculationVersion: "profit-v2", calculatedAt: at, ...extra });
function fixture(): NaverStoredRaw {
  return { stores: [row(scope, { platformType: "NAVER_SMARTSTORE", deliveryUnitCost: "99999" })],
    daily_store_summaries: [row("summary", { totalProductRevenue: "5732080", totalAdCost: "2385197", estimatedNetProfit: "1000657", totalVatAmount: "573208",
      customerPaidDeliveryFee: "430500", estimatedDeliveryBaseCost: "473200", deliveryMargin: "-42700", deliveryUnitCost: "2800", profitStatus: "COMPLETE" })],
    daily_sales_unit_profits: [row("group", { canonicalSalesUnitId: "native-unit", displayName: "상품A", totalQuantity: "361", totalProductRevenue: "5732080", totalAdCost: "2385197",
      totalUnitCost: "1443300", totalFeeCost: "287018", totalOtherCost: "0", estimatedNetProfit: "1043357", vatAmount: "573208", isGroup: true,
      costSnapshotId: null, mappingBasisHash: null })], daily_fake_purchases: [] };
}
const errors = (): NaverStoredErrors => ({ stores: [], daily_store_summaries: [], daily_sales_unit_profits: [], daily_fake_purchases: [] });
const normalize = (raw = fixture(), readErrors = errors()) => normalizeNaverStoredDay(request(), raw, readErrors, configuration, at);
function summary(raw = fixture()) {
  const batch = completeSourceCoverage({ platform: "NAVER", scopeKey: scope, date, runId: "run", token: "token", previousRunId: null }, normalize(raw));
  const facts = prepareReportBatch(request(), batch).map(row => ({ ...row, platform: "NAVER" as const, scopeKey: scope, date }));
  return summarizeReport(facts, batch.coverage, { platforms: ["NAVER"] });
}

test("stored native financial values preserve actual 11/1 totals without current costs or order recomputation", () => {
  const first = normalize(), before = structuredClone(fixture());
  assert.equal(first.sales[0].profitBeforeAds, "3428554.000000");
  assert.equal(first.sales[0].productCost, "1443300.000000");
  assert.equal(first.adSpends[0].amountKrw, "2385197.000000");
  assert.equal(summary().knownTotals.estimatedProfit, "1000657.000000");
  assert.equal(summary().completeTotals.estimatedProfit, "1000657.000000");
  const second = fixture(); Object.assign(second.daily_store_summaries[0], { totalProductRevenue: "6530170", totalAdCost: "1651171", estimatedNetProfit: "1705318", totalVatAmount: "653017",
    customerPaidDeliveryFee: "0", estimatedDeliveryBaseCost: "227500", deliveryMargin: "-227500" });
  Object.assign(second.daily_sales_unit_profits[0], { totalProductRevenue: "6530170", totalAdCost: "1651171", totalQuantity: "206", totalUnitCost: "1878100", totalFeeCost: "415064", estimatedNetProfit: "1932818", vatAmount: "653017" });
  assert.equal(summary(second).knownTotals.estimatedProfit, "1705318.000000");
  assert.equal(new Prisma.Decimal(summary().knownTotals.estimatedProfit!).plus(summary(second).knownTotals.estimatedProfit!).toFixed(6), "2705975.000000");
  assert.deepEqual(fixture(), before);
  assert.ok(first.sourceControlTotals.every(control => control.difference === "0.000000"));
});

test("stored row net is authoritative even when component fields would yield another freshly calculated result", () => {
  const raw = fixture(); raw.daily_sales_unit_profits[0].totalUnitCost = "999999";
  assert.equal(normalize(raw).sales[0].profitBeforeAds, "3428554.000000");
  assert.equal(summary(raw).knownTotals.estimatedProfit, "1000657.000000");
  raw.daily_fake_purchases = [row("fake", { amount: "12345" })];
  assert.equal(summary(raw).knownTotals.estimatedProfit, "988312.000000");
  assert.equal(normalize(raw).commonExpenses.filter(row => row.kind === "FAKE_PURCHASE").length, 1);
});

test("nested child rows and explicit child-detail records never double parent financial totals", () => {
  const raw = fixture(); raw.daily_sales_unit_profits[0].childRows = [{ totalProductRevenue: 99999999, estimatedNetProfit: 9999999 }];
  raw.daily_sales_unit_profits.push(row("child-detail", { parentSalesUnitId: "native-unit", displayName: "자식", totalProductRevenue: "999999", estimatedNetProfit: "999999" }));
  assert.equal(normalize(raw).sales.length, 1);
  assert.equal(summary(raw).knownTotals.estimatedProfit, "1000657.000000");
});

test("native stored names alone classify products; store-level ad rows remain unallocated", () => {
  const raw = fixture(); raw.daily_sales_unit_profits[0].displayName = "네이티브 전용 상품";
  assert.equal(normalize(raw).sales[0].productName, "네이티브 전용 상품");
  raw.daily_sales_unit_profits[0].isStoreLevel = true;
  const batch = normalize(raw);
  assert.equal(batch.sales[0].productName, null); assert.equal(batch.adSpends[0].productName, null); assert.equal(batch.adSpends[0].attribution, "UNALLOCATED");
  assert.equal(summary(raw).knownTotals.estimatedProfit, "1000657.000000");
  assert.ok(batch.sales[0].name.restorationPath?.includes("daily_sales_unit_profits.displayName"));
});

test("missing, duplicated, mismatched-version, foreign-date or unreconciled stored snapshots never fall back to raw inputs", () => {
  const cases: NaverStoredRaw[] = [];
  const missing = fixture(); missing.daily_store_summaries = []; cases.push(missing);
  const duplicate = fixture(); duplicate.daily_store_summaries.push({ ...duplicate.daily_store_summaries[0], id: "summary2" }); cases.push(duplicate);
  const wrongVersion = fixture(); wrongVersion.daily_sales_unit_profits[0].calculationVersion = "profit-v1"; cases.push(wrongVersion);
  const wrongDate = fixture(); wrongDate.daily_sales_unit_profits[0].date = "2026-10-31"; cases.push(wrongDate);
  const mismatch = fixture(); mismatch.daily_store_summaries[0].estimatedNetProfit = "999999"; cases.push(mismatch);
  const nullSummary = fixture(); nullSummary.daily_store_summaries[0].estimatedNetProfit = null; nullSummary.daily_store_summaries[0].profitStatus = "INCOMPLETE_COST"; cases.push(nullSummary);
  const missingRows = fixture(); missingRows.daily_sales_unit_profits = []; cases.push(missingRows);
  for (const raw of cases) {
    const batch = normalize(raw); assert.equal(batch.sales.length, 0); assert.equal(batch.adSpends.length, 0);
    assert.ok(batch.coverage.every(row => row.collectionState === "NOT_COLLECTED" && !row.zeroConfirmed));
    assert.throws(() => assertSourceExecutionSucceeded(batch), /SOURCE_EXECUTION_FAILED/);
  }
});

test("confirmed empty zero summary is a genuine zero, while unknown inputs are never filled with zero", () => {
  const raw = fixture(); raw.daily_sales_unit_profits = [];
  for (const key of ["totalProductRevenue", "totalAdCost", "estimatedNetProfit", "totalVatAmount", "customerPaidDeliveryFee", "estimatedDeliveryBaseCost", "deliveryMargin"]) raw.daily_store_summaries[0][key] = "0";
  const batch = normalize(raw);
  assert.equal(batch.coverage.find(row => row.component === "SALE")!.zeroConfirmed, true);
  assert.equal(summary(raw).knownTotals.estimatedProfit, "0.000000");
  const partial = fixture(); partial.daily_store_summaries[0].estimatedNetProfit = null; partial.daily_sales_unit_profits[0].estimatedNetProfit = null;
  assert.equal(normalize(partial).sales[0].profitBeforeAds, null);
  assert.equal(summary(partial).knownTotals.estimatedProfit, null);
  assert.equal(summary(partial).knownTotals.revenue, "5732080.000000");
});

test("optional cost fingerprints and calculated timestamps never hide stored native estimates; financial changes invalidate evidence", () => {
  const raw = fixture(); const first = normalize(raw);
  raw.daily_store_summaries[0].calculatedAt = null;
  const fallback = normalize(raw); assert.equal(fallback.sales[0].profitBeforeAds, "3428554.000000");
  assert.equal(fallback.coverage[0].calculatedAt, new Date(at).toISOString());
  assert.notEqual(first.sourceFingerprint, fallback.sourceFingerprint);
  raw.daily_fake_purchases = [row("fake", { amount: "1" })];
  assert.notEqual(fallback.sourceFingerprint, normalize(raw).sourceFingerprint);
  const failed = errors(); failed.daily_sales_unit_profits = ["NAVER_DAILY_SALES_UNIT_PROFITS_READ_FAILED"];
  assert.equal(normalize(fixture(), failed).sales.length, 0);
});
