import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, type AdapterRequest } from "../types";
import { assertNaverAllowedScope, normalizeNaverDay, NaverPerformanceAdapter } from "./naver.adapter";
import { naverQueries, naverPageDate } from "./naver-reader";
import type { UnifiedManagementRepository } from "../management.repository";

const scope = "11111111-1111-4111-8111-111111111111", date = "2026-10-26", at = "2026-10-27T01:00:00.000Z";
const request = (): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: "run", readSnapshotId: "snapshot", from: date, to: date,
  scopeKeys: [scope], platforms: ["NAVER"], scopePolicyVersion: "scope", nameRuleVersion: "names", saleUnitRuleVersion: "units",
  allocationRuleVersion: "allocation", calculationVersion: "naver-profit-v2-preserved", fxVersion: "fx", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 10000 });
type Raw = Parameters<typeof normalizeNaverDay>[1];
const config = { products: [{ canonicalName: "버닝웨이브바" }, { canonicalName: "플로우라이트" }, { canonicalName: "카프슬리브" }, { canonicalName: "쿨토시" }], nameRules: [] };
const row = (id: string, extra: Record<string, unknown>) => ({ id, updatedAt: at, storeId: scope, ...extra });
const input = (): Raw => ({ ...Object.fromEntries(Object.keys(naverQueries(scope, date)).map(key => [key, []])),
  stores: [row(scope, { platformType: "NAVER_SMARTSTORE", deliveryUnitCost: "2800" })],
  canonical_sales_units: [row("unit", { displayName: "버닝웨이브바", matchAliases: [], parentSalesUnitId: null, isGroup: false, isActive: true })],
  order_items: [row("order", { externalProductOrderId: "source-order", orderSourceSignatureId: null, canonicalSalesUnitId: "unit",
    rawProductName: "버닝웨이브바", rawOptionInfo: null, paymentDate: date, saleStatus: "SALE", quantity: "1", productPaymentAmount: "100",
    paymentCommission: "0", knowledgeShoppingSellingInterlockCommission: null, saleCommission: null, channelCommission: null,
    deliveryFeeAmount: "0", packageNumber: "package", orderId: "order" })],
  sales_unit_cost_settings: [row("cost", { canonicalSalesUnitId: "unit", unitCost: "20", otherCost: "0", feeRate: "0.1", isActive: true,
    effectiveFrom: "2026-01-01", effectiveTo: null })]
} as unknown as Raw);
const errors = () => Object.fromEntries(Object.keys(naverQueries(scope, date)).map(key => [key, []])) as unknown as Parameters<typeof normalizeNaverDay>[2];
const normalize = (raw = input(), issues = errors()) => normalizeNaverDay(request(), raw, issues, config, at);

test("Naver only reads enabled explicitly allowed stores; OFF selection fails before repository access", () => {
  assertNaverAllowedScope(scope, `other, ${scope}`);
  assert.throws(() => assertNaverAllowedScope(scope, ""), /NOT_AUTHORIZED/);
  assert.throws(() => naverPageDate({ ...request(), cursor: "2026-10-25" }), /OUT_OF_RANGE/);
  let reads = 0;
  const adapter = new NaverPerformanceAdapter({ read: () => { reads++; throw new Error("unexpected read"); } } as unknown as UnifiedManagementRepository);
  const previous = process.env.UNIFIED_PERFORMANCE_ENABLED;
  process.env.UNIFIED_PERFORMANCE_ENABLED = "true";
  try { assert.throws(() => adapter.read({ ...request(), platforms: ["META"] })); assert.equal(reads, 0); }
  finally { if (previous === undefined) delete process.env.UNIFIED_PERFORMANCE_ENABLED; else process.env.UNIFIED_PERFORMANCE_ENABLED = previous; }
});

test("Naver SQL binds scope/day and projects no customer payload or credentials", () => {
  const queries = naverQueries(scope, date);
  for (const sql of Object.values(queries)) {
    assert(sql.sql.includes("public.")); assert(!sql.sql.includes(scope)); assert(!sql.sql.includes(date));
    assert(!/SELECT\s+(?:\*|(?:[a-z]+\.)?payload\s+FROM)|rawPayload|credentials|sellerAccountId/i.test(sql.sql));
  }
  assert(queries.order_items.values.includes(scope)); assert(queries.order_items.values.includes(date));
  assert(queries.order_items.sql.includes("t.payload->>'paymentDate'"));
});

test("Naver valid numeric estimates survive missing or malformed optional sync/stored metadata", () => {
  const raw = input();
  raw.order_sync_states = [row("state", { initialCoverageFrom: "bad-date" })];
  raw.daily_sales_unit_profits = [row("stored", { date, calculationVersion: "bad version / text", calculatedAt: "bad timestamp" })];
  const batch = normalize(raw);
  assert.equal(batch.sales[0].operatingRevenue, "100.000000"); assert.equal(batch.sales[0].profitBeforeAds, "70.000000");
  assert(batch.coverage[0].quality.issues.includes("NAVER_SYNC_METADATA_INVALID"));
  assert(batch.coverage[0].quality.issues.includes("NAVER_STORED_CALCULATION_VERSION_OLD"));
});

test("Naver latest failed receipt prevents using older success for complete or confirmed zero", () => {
  const raw = input(); raw.order_items = [];
  raw.receipts = [row("latest", { mode: "YESTERDAY", status: "FAILED", dateFrom: date, dateTo: date, finishedAt: at }),
    row("old", { mode: "YESTERDAY", status: "SUCCEEDED", dateFrom: date, dateTo: date, finishedAt: at,
      paymentDateMissingCount: "0", unknownOrderStatusCount: "0" })];
  const batch = normalize(raw);
  assert.equal(batch.coverage[0].zeroConfirmed, false); assert.equal(batch.sourceControlTotals[0].selectedAmount, null);
});

test("Naver store SELECT failure preserves revenue/income but cannot fabricate 3500 delivery cost", () => {
  const raw = input(), issues = errors(); raw.stores = []; issues.stores.push("NAVER_STORES_READ_FAILED");
  const batch = normalize(raw, issues);
  assert.equal(batch.sales[0].operatingRevenue, "100.000000");
  assert(batch.commonExpenses.some(e => e.kind === "SHIPPING_INCOME"));
  assert(!batch.commonExpenses.some(e => e.kind === "SHIPPING_COST"));
  assert.equal(batch.coverage.find(c => c.component === "COMMON_EXPENSE")?.collectionState, "PARTIAL");
});

test("Naver source group alias with distinct child products stays unallocated; no parent/child sale double count", () => {
  const raw = input();
  raw.canonical_sales_units.push(row("group", { displayName: "공동그룹", matchAliases: ["공동광고"], isGroup: true, isActive: true, parentSalesUnitId: null }),
    row("child2", { displayName: "플로우라이트", matchAliases: [], isGroup: false, isActive: true, parentSalesUnitId: "group" }));
  raw.canonical_sales_units[0].parentSalesUnitId = "group";
  raw.ad_excel_uploads = [row("upload", { sourceType: "NAVER_DA_XLSX", reportDate: date, isActive: true, state: "CONFIRMED", weekdayValidationStatus: "PASSED" })];
  raw.ad_campaign_daily_costs = [row("ad", { reportDate: date, sourceUploadId: "upload", campaignId: "new-id", campaignName: "공동광고 캠페인", totalCost: "17" })];
  const batch = normalize(raw);
  assert.equal(batch.sales.length, 1); assert.equal(batch.sales[0].productName, "버닝웨이브바");
  assert.equal(batch.adSpends.length, 1); assert.equal(batch.adSpends[0].productName, null); assert.equal(batch.adSpends[0].attribution, "UNALLOCATED");
  assert.equal(batch.sourceControlTotals.find(c => c.measure === "AD_SPEND")?.unallocatedAmount, "17.000000");
});

test("Naver explicit canonical product group restores its child's differently spaced unit name without fuzzy identity", () => {
  const raw = input();
  raw.canonical_sales_units = [row("group", { displayName: "버닝웨이브바", matchAliases: [], isGroup: true, isActive: true, parentSalesUnitId: null }),
    row("unit", { displayName: "버닝 웨이브바 기본형", matchAliases: [], isGroup: false, isActive: true, parentSalesUnitId: "group" })];
  raw.order_items[0].rawProductName = "버닝웨이브바 기본형";
  const batch = normalize(raw);
  assert.equal(batch.sales[0].productName, "버닝웨이브바"); assert.equal(batch.sales[0].saleUnitName, "버닝 웨이브바 기본형");
  assert.equal(batch.sales[0].productCost, "20.000000");
});

test("Naver ad normalization failure preserves valid common expenses, and common failure preserves ads", () => {
  const raw = input();
  raw.ad_excel_uploads = [row("upload", { sourceType: "NAVER_DA_XLSX", reportDate: date, isActive: true, state: "CONFIRMED", weekdayValidationStatus: "PASSED" })];
  const ad = row("ad", { reportDate: date, sourceUploadId: "upload", campaignId: "campaign", campaignName: "버닝웨이브바", totalCost: "17" });
  raw.ad_campaign_daily_costs = [ad, ad];
  raw.daily_fake_purchases = [row("fake", { date, amount: "5" })];
  const invalidAds = normalize(raw);
  assert.equal(invalidAds.adSpends.length, 0); assert(invalidAds.commonExpenses.some(e => e.kind === "FAKE_PURCHASE"));
  assert.equal(invalidAds.coverage.find(c => c.component === "AD_SPEND")?.collectionState, "PARTIAL");
  raw.ad_campaign_daily_costs = [ad]; raw.daily_fake_purchases.push(raw.daily_fake_purchases[0]);
  const invalidCommon = normalize(raw);
  assert.equal(invalidCommon.adSpends[0].amountKrw, "17.000000");
  assert.equal(invalidCommon.coverage.find(c => c.component === "COMMON_EXPENSE")?.collectionState, "PARTIAL");
});
