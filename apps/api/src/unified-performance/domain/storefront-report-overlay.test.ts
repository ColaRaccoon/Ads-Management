import test from "node:test";
import assert from "node:assert/strict";
import { overlayStorefrontResults, type StorefrontOverlayFact } from "./storefront-report-overlay";

type Fact = StorefrontOverlayFact & { factKey: string; productName: string | null; amountKrw: string | null; completeAmountKrw: string | null;
  profitBeforeAds: string | null; completeProfitBeforeAds: string | null; persistedNetProfit?: string | null; persistedAdSpend?: string | null;
  quality: { isEstimate: boolean; issues: string[] } };
const fact = (overrides: Partial<Fact> = {}): Fact => ({ component: "SALE", platform: "CAFE24", scopeKey: "shop", date: "2026-11-01", marketplace: "CAFE24", medium: null,
  factKey: "legacy", productName: "상품", amountKrw: "100.000000", completeAmountKrw: "100.000000", profitBeforeAds: "50.000000", completeProfitBeforeAds: "50.000000",
  quality: { isEstimate: false, issues: [] }, ...overrides });
const native = (channel: "META" | "YOUTUBE", overrides: Partial<Fact> = {}): Fact => fact({ component: "STOREFRONT_RESULT", factKey: channel,
  marketplace: channel === "META" ? "CAFE24_META" : "CAFE24_YOUTUBE", medium: channel === "META" ? "META" : "GOOGLE",
  persistedNetProfit: channel === "META" ? "40.000000" : "-10.000000", persistedAdSpend: "10.000000", ...overrides });

test("old publication facts remain untouched without a complete pair of native channel markers", () => {
  const old = fact(), ad = fact({ component: "AD_SPEND", platform: "META", marketplace: null, medium: "META" });
  const result = overlayStorefrontResults([old, ad]);
  assert.deepEqual(result, [old, ad]); assert.equal(result[0], old); assert.equal(result[1], ad);
});

test("paired native results replace legacy sales without touching independent ad or other marketplace facts", () => {
  const rows = [fact(), native("META"), native("YOUTUBE"), fact({ component: "AD_SPEND", medium: "META", marketplace: null }),
    fact({ platform: "NAVER", marketplace: "NAVER_SMARTSTORE" }), fact({ platform: "COUPANG", marketplace: "COUPANG" }),
    fact({ component: "COMMON_EXPENSE", marketplace: null })];
  const before = structuredClone(rows), result = overlayStorefrontResults(rows);
  assert.equal(result.length, rows.length - 1); assert.deepEqual(rows, before);
  const converted = result.filter(row => row.marketplace === "CAFE24_META" || row.marketplace === "CAFE24_YOUTUBE");
  assert.deepEqual(converted.map(row => row.component), ["SALE", "SALE"]);
  assert.equal(converted[0].persistedNetProfit, "40.000000"); assert.equal(converted[1].persistedNetProfit, "-10.000000");
  assert.equal(converted[1].persistedAdSpend, "10.000000");
  assert.deepEqual(result.slice(2), rows.slice(3));
  assert.deepEqual(overlayStorefrontResults(result), result);
});

test("replacement is confined to the represented scope and business date", () => {
  const oldOtherScope = fact({ scopeKey: "other" }), oldOtherDate = fact({ date: "2026-10-31" });
  const result = overlayStorefrontResults([fact(), native("META"), native("YOUTUBE"), oldOtherScope, oldOtherDate]);
  assert.equal(result.length, 4); assert.equal(result[2], oldOtherScope); assert.equal(result[3], oldOtherDate);
  const acrossPartitions = [fact(), native("META"), native("YOUTUBE", { scopeKey: "other" }), native("YOUTUBE", { date: "2026-10-31" })];
  assert.deepEqual(overlayStorefrontResults(acrossPartitions), acrossPartitions);
});

test("a missing or invalid channel marker cannot trigger replacement or partial promotion", () => {
  for (const invalid of [native("YOUTUBE", { medium: "META" }), native("YOUTUBE", { marketplace: "CAFE24" }), native("YOUTUBE", { platform: "GOOGLE" }), native("YOUTUBE", { component: "SALE" })]) {
    const rows = [fact(), native("META"), invalid]; assert.deepEqual(overlayStorefrontResults(rows), rows);
  }
  const rows = [fact(), native("META")]; assert.deepEqual(overlayStorefrontResults(rows), rows);
});

test("explicit empty-channel zero and unknown native amounts remain distinct without legacy fallback", () => {
  const zero = native("META", { productName: null, amountKrw: "0.000000", completeAmountKrw: "0.000000", profitBeforeAds: "0.000000", completeProfitBeforeAds: "0.000000", persistedNetProfit: "0.000000", persistedAdSpend: "0.000000" });
  const unknown = native("YOUTUBE", { amountKrw: null, completeAmountKrw: null, profitBeforeAds: null, completeProfitBeforeAds: null, persistedNetProfit: null, persistedAdSpend: null, quality: { isEstimate: true, issues: ["MISSING_INPUT"] } });
  const result = overlayStorefrontResults([fact(), zero, unknown]);
  assert.equal(result.length, 2); assert.equal(result[0].amountKrw, "0.000000"); assert.equal(result[0].persistedNetProfit, "0.000000");
  assert.equal(result[1].amountKrw, null); assert.equal(result[1].persistedNetProfit, null); assert.deepEqual(result[1].quality, unknown.quality);
});

test("all product result rows are retained and input row ordering is stable", () => {
  const rows = [fact(), native("META", { factKey: "m1", productName: "상품1" }), native("META", { factKey: "m2", productName: "상품2" }),
    native("YOUTUBE", { factKey: "y1", productName: "상품1" }), fact({ productName: "상품2", factKey: "legacy2" })];
  const result = overlayStorefrontResults(rows);
  assert.deepEqual(result.map(row => row.factKey), ["m1", "m2", "y1"]);
  assert.equal(result[0].productName, "상품1"); assert.equal(result[1].productName, "상품2");
});


const marker = (channel: "META" | "YOUTUBE", overrides: Partial<Fact> = {}) => native(channel, {
  factKey: `marker-${channel}`, productName: null, saleUnitName: "PARTITION_MARKER", rowsCount: 0,
  amountKrw: null, completeAmountKrw: null, profitBeforeAds: null, completeProfitBeforeAds: null, persistedNetProfit: null, persistedAdSpend: null, ...overrides,
});

test("product-independent markers survive SQL-style filtering and activate a single selected-product native channel", () => {
  const input = [fact({ productName: "selected" }), native("META", { productName: "selected" }), native("YOUTUBE", { productName: "other" }), marker("META"), marker("YOUTUBE")];
  const filtered = input.filter(row => row.productName === "selected" || row.productName === null);
  const result = overlayStorefrontResults(filtered);
  assert.equal(result.length, 3);
  assert.equal(result[0].component, "SALE"); assert.equal(result[0].marketplace, "CAFE24_META");
  assert.deepEqual(result.slice(1).map(row => row.component), ["STOREFRONT_RESULT", "STOREFRONT_RESULT"]);
  assert.equal(result.find(row => row.component === "SALE" && row.marketplace === "CAFE24"), undefined);
  assert.equal(result.find(row => row.component === "SALE" && row.marketplace === "CAFE24_YOUTUBE"), undefined);
  assert.deepEqual(overlayStorefrontResults(result), result);
});

test("marker-only native partitions never fabricate monetary zero facts", () => {
  const markers = [marker("META"), marker("YOUTUBE")], result = overlayStorefrontResults([fact(), ...markers]);
  assert.deepEqual(result, markers); assert.equal(result.some(row => row.component === "SALE"), false);
  for (const row of result) { assert.equal(row.amountKrw, null); assert.equal(row.persistedNetProfit, null); assert.equal(row.persistedAdSpend, null); }
  assert.deepEqual(overlayStorefrontResults(result), result);
});

test("marker readiness remains scoped and malformed named markers do not promote themselves", () => {
  const old = fact(), actual = native("META");
  for (const invalid of [marker("YOUTUBE", { rowsCount: 1 }), marker("YOUTUBE", { productName: "private-product" }), marker("YOUTUBE", { amountKrw: "0.000000" }), marker("YOUTUBE", { scopeKey: "other" })]) {
    const input = [old, actual, marker("META"), invalid];
    assert.deepEqual(overlayStorefrontResults(input), input);
  }
  const unknown = native("META", { amountKrw: null, completeAmountKrw: null, persistedNetProfit: null });
  const result = overlayStorefrontResults([old, unknown, marker("META"), marker("YOUTUBE")]);
  assert.equal(result[0].component, "SALE"); assert.equal(result[0].amountKrw, null); assert.equal(result[0].persistedNetProfit, null);
});
