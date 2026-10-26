import test from "node:test";
import assert from "node:assert/strict";
import { googleCampaignColumns, googleMoney, googleNumber, googleProfitColumns, googleRatio, googleReasons, googleSaleUnit } from "./google-display";
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

test("Google UI rounds integers without losing large decimal precision or displaying negative zero", () => {
  assert.equal(googleMoney(0), "0 원");
  assert.equal(googleMoney(null), "—");
  assert.equal(googleMoney("9007199254740993.000001"), "9,007,199,254,740,993 원");
  assert.equal(googleMoney("9007199254740993.5"), "9,007,199,254,740,994 원");
  assert.equal(googleMoney("-9007199254740993.500000"), "-9,007,199,254,740,993 원");
  assert.equal(googleMoney("-9007199254740993.500001"), "-9,007,199,254,740,994 원");
  assert.equal(googleMoney("-0.5"), "0 원");
  assert.equal(googleMoney(-0.5), "0 원");
  assert.equal(googleMoney("-0.500001"), "-1 원");
  assert.equal(googleMoney("invalid"), "—");
  assert.equal(googleMoney(Infinity), "—");
  assert.equal(googleMoney(-20000), "-20,000 원");
  assert.equal(googleNumber(1.5), "2");
  assert.equal(googleNumber(-1.5), "-1");
  assert.equal(googleNumber(-0), "0");
  assert.equal(googleNumber(undefined), "—");
  assert.equal(googleRatio(null), "—");
  assert.equal(googleRatio(0.35, true), "35%");
  assert.equal(googleRatio(0.356, true), "36%");
  assert.equal(googleRatio(-0.004, true), "0%");
  assert.equal(googleRatio(5), "5배");
  assert.equal(googleRatio(5.5), "6배");
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

test("profit CSV appends advertising metrics without changing legacy columns or API precision", () => {
  const columns = googleProfitColumns(() => "상품A");
  assert.deepEqual(columns.slice(0, -5).map((column) => column.header), [
    "일자", "상품 ID", "상품", "판매수량", "판매단위", "설정 판매가 기준 매출 (KRW)",
    "계산 가능한 매출 부분합 (KRW)", "수집 판매가 기준 금액 (결제액 아님, KRW)", "판매비용 (KRW)",
    "유튜브 판매행 쿠폰 차감 (KRW)", "배분 Google 광고비 (KRW)", "확정 마진 (KRW)",
    "계산 가능한 잠정 마진 (KRW)", "마진율 (비율)", "페이지 기준 ROAS (배)", "판매가 차이 행 수", "완전성", "확인 사유"
  ]);
  const additional = columns.slice(-5);
  assert.deepEqual(additional.map((column) => column.header), ["노출수", "클릭수", "클릭률 (비율)", "클릭당 비용 (KRW)", "판매 1개당 광고비 (카페24 판매수량 기준, KRW)"]);
  const metrics = { impressions: 98765, clicks: 321, ctr: 0.0032501392193590857, cpcKrw: 674.318373, costPerSaleKrw: 54114.04942975 };
  const complete = { ...profitFixture, ...metrics };
  assert.deepEqual(additional.map((column) => column.value(complete)), Object.values(metrics));
  const csv = serializeCsv(columns, [complete]);
  for (const value of Object.values(metrics)) assert.ok(csv.includes(String(value)), `exact API value ${value}`);
  assert.deepEqual(additional.map((column) => column.value(profitFixture)), [null, null, null, null, null]);
  const unknown = { ...profitFixture, impressions: null, clicks: null, ctr: null, cpcKrw: null, costPerSaleKrw: null };
  assert.deepEqual(additional.map((column) => column.value(unknown)), [null, null, null, null, null]);
  const zero = { ...profitFixture, impressions: 0, clicks: 0, ctr: 0, cpcKrw: 0, costPerSaleKrw: 0 };
  assert.deepEqual(additional.map((column) => column.value(zero)), [0, 0, 0, 0, 0]);
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

test("automatic campaign matching warnings retain distinct Korean reasons in campaign CSV", () => {
  assert.equal(googleReasons(["CAMPAIGN_PRODUCT_NOT_FOUND"]), "캠페인명에서 활성 상품명을 찾지 못함");
  assert.equal(googleReasons(["AMBIGUOUS_CAMPAIGN_PRODUCT"]), "캠페인명에 여러 상품이 포함되어 자동 연결 보류");
  const campaign: GoogleCampaignRow = { connectionId: "google-1", customerId: "123", campaignId: "unresolved", campaignName: "상품A 상품B", currencyCode: "KRW", productIds: [], hasUnmapped: true, costMicros: "1000000", adSpendKrw: 1, adSpendKrwExact: "1", impressions: 5, clicks: 1, ctr: 0.2, cpcKrw: 1, warningCodes: ["AMBIGUOUS_CAMPAIGN_PRODUCT", "UNALLOCATED_AD_SPEND"] };
  const csv = serializeCsv(googleCampaignColumns(() => "상품A"), [campaign]);
  assert.match(csv, /캠페인명에 여러 상품이 포함되어 자동 연결 보류/);
  assert.match(csv, /미배분 Google 광고비 존재/);
  assert.doesNotMatch(csv, /확인 필요 \(/);
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
