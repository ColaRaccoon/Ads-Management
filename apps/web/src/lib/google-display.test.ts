import test from "node:test";
import assert from "node:assert/strict";
import { googleCampaignColumns, googleMoney, googleProfitColumns, googleRatio, googleReasons, googleSaleUnit } from "./google-display";
import { blankGoogleMapping, editGoogleMapping, googleMappingInputError, googleSaleConfigurationText } from "./google-mapping-form";
import { serializeCsv } from "./csv";
import type { GoogleCampaignRow, GoogleMapping, GoogleProfitRow } from "../types/google";

export const profitFixture: GoogleProfitRow = {
  productId: "product-1", date: "2026-10-25", quantity: 2, lineCount: 2,
  revenueKrw: 100000, knownRevenueKrw: 100000, collectedRevenueKrw: 100000,
  grossCostKrw: 40000, couponDeductionKrw: 5000, adSpendKrw: 20000, adSpendKrwExact: "20000", knownAdSpendKrw: 20000,
  marginKrw: 35000, calculatedMarginKrw: 35000, marginRate: 0.35, roas: 5,
  priceMismatchCount: 0, complete: true, warningCodes: []
};

test("Google UI preserves zero, unknown, micros and negative margins", () => {
  assert.equal(googleMoney(0), "0 원");
  assert.equal(googleMoney(null), "—");
  assert.equal(googleMoney("9007199254740993.000001"), "9,007,199,254,740,993.000001 원");
  assert.equal(googleMoney(-20000), "-20,000 원");
  assert.equal(googleRatio(null), "—");
  assert.equal(googleRatio(0.35, true), "35.00%");
  assert.equal(googleRatio(5), "5.00배");
});

test("profit export retains API totals, unresolved values, exact cost and warning reasons", () => {
  const columns = googleProfitColumns(() => "상품A");
  const complete = columns.map((column) => column.value(profitFixture));
  assert.ok(complete.includes(35000));
  assert.ok(complete.includes(0.35));
  assert.ok(complete.includes(5));
  const missing = { ...profitFixture, adSpendKrw: null, adSpendKrwExact: null, marginKrw: null, complete: false, warningCodes: ["GOOGLE_COLLECTION_INCOMPLETE", "COUPON_UNRESOLVED"] };
  const csv = serializeCsv(columns, [missing]);
  assert.match(csv, /미확정/);
  assert.match(csv, /광고비 미수집/);
  assert.match(csv, /쿠폰 판정/);
  assert.equal(columns.find((column) => column.header === "확정 마진 (KRW)")?.value(missing), null);
  assert.match(serializeCsv(columns, [{ ...profitFixture, adSpendKrwExact: "20000.000001" }]), /20000\.000001/);
});

test("campaign export never duplicates product revenue, margin or ROAS and escapes formula names", () => {
  const row: GoogleCampaignRow = { connectionId: "google-1", customerId: "123", campaignId: "456", campaignName: "=1+1", currencyCode: "KRW", productIds: ["product-1"], hasUnmapped: false, costMicros: "20000000000", adSpendKrw: 20000, adSpendKrwExact: "20000", impressions: 1000, clicks: 10, ctr: 0.01, cpcKrw: 2000, warningCodes: [] };
  const columns = googleCampaignColumns(() => "상품A");
  assert.ok(columns.every((column) => !/매출|마진|ROAS/.test(column.header)));
  const csv = serializeCsv(columns, [row]);
  assert.match(csv, /'=1\+1/);
  assert.match(csv, /20000000000/);
});

test("distinct incomplete causes remain distinguishable in screen and CSV", () => {
  const codes = ["MISSING_COST_RULE", "COUPON_UNRESOLVED", "UNALLOCATED_AD_SPEND", "UNMAPPED_SALES", "MISSING_EXCHANGE_RATE", "TIME_ZONE_MISMATCH", "GOOGLE_COLLECTION_INCOMPLETE", "CAFE24_COLLECTION_INCOMPLETE"];
  assert.equal(new Set(codes.map((code) => googleReasons([code]))).size, codes.length);
});

const saleMapping: GoogleMapping = {
  id: "sale-mapping", kind: "SALE", connectionId: "cafe24-account", campaignId: null, productNo: "product-number",
  optionScope: "PRODUCT", optionName: "", productId: "product-1", productName: "상품A", startDate: "2026-10-01", endDate: null,
  updatedAt: "2026-10-26T01:00:00.000Z", saleUnitLabel: "1+1 세트", salePriceKrwOverride: 21900,
  productCostKrwOverride: 8000, shippingKrwOverride: 3000, extraCostKrwOverride: 0
};

test("switching mapping kind creates a clean payload without the other kind's identity", () => {
  const sale = blankGoogleMapping("SALE", "2026-10-24");
  assert.equal(sale.kind, "SALE");
  assert.equal(sale.optionScope, "EXACT");
  assert.equal(sale.optionName, "");
  assert.equal(Object.hasOwn(sale, "campaignId"), false);
  const salePayload = JSON.parse(JSON.stringify({ ...sale, productNo: "product-number", optionScope: "PRODUCT", productId: "product-1" }));
  assert.equal(Object.hasOwn(salePayload, "campaignId"), false);
  assert.equal(salePayload.startDate, "2026-10-24");
  const campaign = blankGoogleMapping("CAMPAIGN", "2026-10-23");
  assert.equal(campaign.campaignId, "");
  assert.equal(Object.hasOwn(campaign, "productNo"), false);
  assert.equal(Object.hasOwn(campaign, "optionName"), false);
  assert.equal(Object.hasOwn(campaign, "salePriceKrwOverride"), false);
});

test("editing a product-wide set mapping preserves exact unit amounts and optimistic version", () => {
  const draft = editGoogleMapping(saleMapping);
  assert.equal(draft.optionScope, "PRODUCT");
  assert.equal(draft.optionName, "");
  assert.equal(draft.saleUnitLabel, "1+1 세트");
  assert.equal(draft.salePriceKrwOverride, 21900);
  assert.equal(draft.productCostKrwOverride, 8000);
  assert.equal(draft.extraCostKrwOverride, 0);
  assert.equal(draft.expectedUpdatedAt, saleMapping.updatedAt);
  assert.equal(googleMappingInputError(draft), null);
  assert.match(googleSaleConfigurationText(draft), /판매가 21,900 원/);
  assert.equal(editGoogleMapping({ ...saleMapping, optionScope: undefined }).optionScope, "EXACT");
});

test("partial or invalid configuration cannot be submitted while explicit zero stays valid", () => {
  const draft = editGoogleMapping(saleMapping);
  assert.match(googleMappingInputError({ ...draft, shippingKrwOverride: null })!, /4개/);
  assert.match(googleMappingInputError({ ...draft, salePriceKrwOverride: -1 })!, /0 이상/);
  assert.match(googleMappingInputError({ ...draft, salePriceKrwOverride: 1.000001 })!, /둘째 자리/);
  assert.match(googleMappingInputError({ ...draft, optionName: "옵션" })!, /상품번호 전체/);
  const noAmounts = { ...draft, salePriceKrwOverride: null, productCostKrwOverride: null, shippingKrwOverride: null, extraCostKrwOverride: null };
  assert.match(googleMappingInputError(noAmounts)!, /판매단위 이름/);
  assert.equal(googleMappingInputError({ ...noAmounts, saleUnitLabel: null }), null);
  const campaign = editGoogleMapping({ ...saleMapping, kind: "CAMPAIGN", campaignId: "campaign-1", productNo: null });
  assert.equal(campaign.salePriceKrwOverride, undefined);
  assert.equal(campaign.saleUnitLabel, undefined);
});

test("set quantity and prices are exported once with the server unit label", () => {
  const row = { ...profitFixture, quantity: 1, saleUnitLabel: "1+1 세트", saleUnitLabels: ["1+1 세트"], revenueKrw: 21900 };
  const columns = googleProfitColumns(() => "상품A");
  assert.equal(columns.find((column) => column.header === "판매수량")!.value(row), 1);
  assert.equal(columns.find((column) => column.header === "설정 판매가 기준 매출 (KRW)")!.value(row), 21900);
  assert.equal(columns.find((column) => column.header === "판매단위")!.value(row), "1+1 세트");
  assert.match(googleSaleUnit({ saleUnitLabel: null, saleUnitLabels: ["1+1 세트", "2세트"] }), /혼합 단위/);
});
