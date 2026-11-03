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
test("completed child options split only with an explicit option link and reconciled revenue/quantity", () => {
  const raw = fixture();
  raw.daily_sales_unit_profits[0].childRows = [{ canonicalSalesUnitId: "full", displayName: "풀메탈", date,
    totalQuantity: "361", totalProductRevenue: "5732080", totalAdCost: "0", estimatedNetProfit: "3428554" }];
  const config = { products: [{ canonicalName: "아이언볼" }], nameRules: [{ id: "option", canonicalProductName: "아이언볼", matchType: "EXACT" as const,
    terms: ["풀메탈"], platform: "NAVER" as const, scopeKey: scope, nameField: "native:NAVER_OPTION", validFrom: date, validTo: null, active: true }] };
  const batch = normalizeNaverStoredDay(request(), raw, errors(), config, at);
  assert.equal(batch.sales.length, 1); assert.equal(batch.nativeResults?.length, 3);
  const iron = batch.nativeResults!.find(row => row.productName === "아이언볼")!;
  assert.equal(iron.revenue.known, "5732080.000000"); assert.equal(iron.adSpend.known, "0.000000");
  assert.equal(iron.netProfit.known, "3428554.000000");
  const parent = batch.nativeResults!.find(row => row.kind === "PRODUCT" && !row.audit?.optionParentProductKey)!;
  assert.equal(parent.netProfit.known, "-2385197");
  assert.deepEqual(batch.nativeResults![0], normalize(raw).nativeResults![0]);
  (raw.daily_sales_unit_profits[0].childRows as Record<string, unknown>[])[0].totalProductRevenue = "1";
  const bad = normalizeNaverStoredDay(request(), raw, errors(), config, at);
  assert.equal(bad.nativeResults?.length, 2); assert.ok(bad.nativeResults![1].issues.includes("NAVER_STORED_OPTIONS_INVALID"));
});
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

test("durable native results retain product net directly and store final net includes fake purchases exactly once", () => {
  const raw = fixture();
  raw.daily_fake_purchases = [row("fake", { amount: "12345", updatedAt: "2026-11-02T08:00:00Z" })];
  const before = structuredClone(raw), batch = normalize(raw);
  const total = batch.nativeResults!.find(result => result.kind === "SUMMARY")!;
  const product = batch.nativeResults!.find(result => result.kind === "PRODUCT")!;
  assert.deepEqual(total.netProfit, { known: "988312.000000", complete: "988312.000000" });
  assert.deepEqual(product.netProfit, { known: "1043357.000000", complete: "1043357.000000" });
  assert.deepEqual(total.adSpend, { known: "2385197.000000", complete: "2385197.000000" });
  assert.equal(total.profitBeforeAds.known, "3373509.000000");
  assert.equal(product.profitBeforeAds.known, "3428554.000000");
  assert.equal(total.audit!.nativeNetBeforeFakePurchase, "1000657.000000");
  assert.equal(total.audit!.fakePurchaseAmount, "12345.000000");
  assert.equal(total.audit!.deliveryMargin, "-42700.000000");
  assert.equal(total.sourceUpdatedAt, "2026-11-02T08:00:00.000Z");
  assert.equal(total.quantity, "361.000000");
  assert.equal(product.productKey, `naver:${scope}:product:native-unit`);
  assert.ok(batch.coverage.every(coverage => coverage.sourceFingerprint === batch.sourceFingerprint && coverage.sourceVersion === batch.sourceFingerprint));
  assert.ok([...batch.sales, ...batch.adSpends, ...batch.commonExpenses].every(entry => entry.ref.sourceVersion === batch.sourceFingerprint));
  assert.deepEqual(raw, before, "producer never mutates source rows");
  raw.daily_sales_unit_profits[0].totalUnitCost = "999999";
  assert.deepEqual(normalize(raw).nativeResults!.map(result => result.netProfit), batch.nativeResults!.map(result => result.netProfit),
    "direct source net is not rebuilt from cost or VAT fields");
});

test("two native store final results reproduce 2255626 after the current ads and 304800 fake purchases", () => {
  const first = fixture(), second = fixture();
  Object.assign(first.daily_store_summaries[0], { totalProductRevenue: "5553500", totalAdCost: "2318578", estimatedNetProfit: "1025760",
    totalVatAmount: "555350", customerPaidDeliveryFee: "32200", estimatedDeliveryBaseCost: "0", deliveryMargin: "32200" });
  Object.assign(first.daily_sales_unit_profits[0], { totalProductRevenue: "5553500", totalAdCost: "2318578", estimatedNetProfit: "993560", vatAmount: "555350" });
  Object.assign(second.daily_store_summaries[0], { totalProductRevenue: "6372310", totalAdCost: "1759579", estimatedNetProfit: "1534666",
    totalVatAmount: "637231", customerPaidDeliveryFee: "0", estimatedDeliveryBaseCost: "241500", deliveryMargin: "-241500" });
  Object.assign(second.daily_sales_unit_profits[0], { totalProductRevenue: "6372310", totalAdCost: "1759579", estimatedNetProfit: "1776166", vatAmount: "637231" });
  // Only the combined fake purchase amount matters in this two-store fixture.
  second.daily_fake_purchases = [row("fake", { amount: "304800" })];
  const firstResult = normalize(first).nativeResults!.find(result => result.kind === "SUMMARY")!;
  const secondScope = "22222222-2222-4222-8222-222222222222";
  for (const rows of Object.values(second)) for (const item of rows) item.storeId = secondScope;
  second.stores[0].id = secondScope;
  const secondResult = normalizeNaverStoredDay({ ...request(), scopeKeys: [secondScope] }, second, errors(), configuration, at).nativeResults!.find(result => result.kind === "SUMMARY")!;
  assert.equal(new Prisma.Decimal(firstResult.netProfit.known!).plus(secondResult.netProfit.known!).toFixed(6), "2255626.000000");
  assert.notEqual(firstResult.productKey, secondResult.productKey);
  assert.equal(secondResult.adSpend.known, "1759579.000000", "the refreshed source ad value is retained directly");
});

test("native result nulls remain strict while children, store-level rows and empty days preserve their own identities", () => {
  const raw = fixture();
  raw.daily_sales_unit_profits[0].isStoreLevel = true;
  raw.daily_sales_unit_profits.push(row("child", { parentSalesUnitId: "native-unit", totalProductRevenue: "9999999", estimatedNetProfit: "9999999" }));
  let results = normalize(raw).nativeResults!;
  assert.equal(results.length, 2);
  assert.equal(results[1].kind, "PRODUCT"); assert.equal(results[1].productName, null);
  assert.equal(results[1].netProfit.known, "1043357.000000");
  raw.daily_store_summaries[0].estimatedNetProfit = null;
  raw.daily_sales_unit_profits[0].estimatedNetProfit = null;
  raw.daily_sales_unit_profits[0].totalQuantity = null;
  results = normalize(raw).nativeResults!;
  for (const result of results) {
    assert.deepEqual(result.netProfit, { known: null, complete: null });
    assert.equal(result.quantity, null);
  }
  const fakeUnknown = fixture(); fakeUnknown.daily_fake_purchases = [row("fake", { amount: "invalid" })];
  assert.deepEqual(normalize(fakeUnknown).nativeResults![0].netProfit, { known: null, complete: null });
  const adsUnknown = fixture(); adsUnknown.daily_store_summaries[0].totalAdCost = null; adsUnknown.daily_sales_unit_profits[0].totalAdCost = null;
  results = normalize(adsUnknown).nativeResults!;
  assert.deepEqual(results[0].adSpend, { known: null, complete: null });
  assert.equal(results[0].netProfit.known, "1000657.000000", "known stored net does not depend on reconstructing net plus/minus unknown ads");
  const empty = fixture(); empty.daily_sales_unit_profits = [];
  for (const key of ["totalProductRevenue", "totalAdCost", "estimatedNetProfit", "totalVatAmount", "customerPaidDeliveryFee", "estimatedDeliveryBaseCost", "deliveryMargin"]) empty.daily_store_summaries[0][key] = "0";
  assert.deepEqual(normalize(empty).nativeResults!.map(result => [result.kind, result.netProfit.known, result.quantity]), [["SUMMARY", "0.000000", "0.000000"]]);
});

test("native result identities and fingerprints are stable under source row reordering", () => {
  const raw = fixture();
  raw.daily_sales_unit_profits.push(row("store-row", { canonicalSalesUnitId: "store-unit", displayName: "스토어 공통", isStoreLevel: true,
    totalQuantity: "0", totalProductRevenue: "0", totalAdCost: "0", estimatedNetProfit: "0", vatAmount: "0" }));
  const first = normalize(raw);
  raw.daily_sales_unit_profits.reverse();
  const second = normalize(raw);
  assert.deepEqual(second.nativeResults, first.nativeResults);
  assert.equal(second.sourceFingerprint, first.sourceFingerprint);
});
