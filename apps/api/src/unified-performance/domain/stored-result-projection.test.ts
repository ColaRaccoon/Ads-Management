import assert from "node:assert/strict";
import test from "node:test";
import type { NativeResultAmount, NativeStoredResult } from "../native-result-contract";
import type { PublishedReportFact } from "../report-contract";
import type { Platform, SourceCoverage } from "../types";
import { prepareNativeResultFacts, summarizeNativeResults } from "./stored-result-projection";

const value = (known: string | null, complete = known): NativeResultAmount => ({ known, complete });
const row = (overrides: Partial<NativeStoredResult> = {}): NativeStoredResult => ({ kind: "SUMMARY", group: "NAVER",
  productKey: "SUMMARY", productName: null, quantity: "1", revenue: value("1000"), adSpend: value("100"),
  netProfit: value("47.123456"), profitBeforeAds: value("900"), sourceUpdatedAt: null, issues: [], ...overrides });
const facts = (rows: NativeStoredResult[], platform: Platform = "NAVER", scopeKey = "shop-a", date = "2026-11-01"): PublishedReportFact[] =>
  prepareNativeResultFacts(rows).map(fact => ({ ...fact, platform, scopeKey, date }));
const coverage = (overrides: Partial<SourceCoverage> = {}): SourceCoverage => ({ sourceSystem: "fixture", platform: "NAVER", component: "SALE",
  scopeKey: "shop-a", date: "2026-11-01", participation: "INCLUDED", collectionState: "COMPLETE", rowsPresent: 1,
  zeroConfirmed: false, selectedSource: "API", selectedUploadId: null, sourceVersion: "v1", collectedAt: null, sourceAsOf: null,
  calculatedAt: null, lastSuccessAt: null, sourceFingerprint: "fingerprint", nameRuleVersion: "v1", costRuleVersion: "v1",
  mappedRows: 1, unmappedRows: 0, unmatchedAmount: "0", missingCostRows: 0, missingFxAmount: null, unallocatedAmount: "0",
  quality: { isEstimate: false, confidence: "SOURCE_REPORTED", issues: [] }, ...overrides });

test("serialization preserves each final money field and stable original product identity", () => {
  const native = row({ kind: "PRODUCT", productKey: "source-id", productName: "원본 상품", netProfit: value("-9007199254.123456") });
  const serialized = prepareNativeResultFacts([native])[0];
  assert.deepEqual(serialized.nativeResult, native);
  assert.equal(serialized.saleUnitName, "source-id");
  assert.equal(serialized.nativeResult?.netProfit.complete, "-9007199254.123456");
  assert.equal(serialized.factKey, prepareNativeResultFacts([{ ...native, netProfit: value("99") }])[0].factKey);
});

test("summary uses published source SUMMARY net instead of before-ads subtraction or product totals", () => {
  const published = facts([row(), row({ kind: "PRODUCT", productKey: "p", productName: "상품", netProfit: value("17"), adSpend: value("10") })]);
  const before = structuredClone(published);
  const result = summarizeNativeResults(published, [coverage()], { platforms: ["NAVER"] });
  assert.equal(result.completeTotals.estimatedProfit, "47.123456");
  assert.equal(result.completeTotals.adSpend, "100.000000");
  assert.equal(result.productProfitSubtotal, "17.000000");
  assert.deepEqual(published, before);
});

test("source exact fractional outputs can be summed without applying the storage-column scale to JSON", () => {
  const source = row({ revenue: value("1000.123456789012"), netProfit: value("47.123456789012") });
  const published = facts([source]);
  assert.equal(published[0].nativeResult?.revenue.known, "1000.123456789012");
  const result = summarizeNativeResults(published, [coverage()], { platforms: ["NAVER"] });
  assert.equal(result.completeTotals.revenue, "1000.123457");
  assert.equal(result.completeTotals.estimatedProfit, "47.123457");
});

test("product selection sums exact matching native product results across scoped days", () => {
  const rows = [row(), row({ kind: "PRODUCT", productKey: "p", productName: "상품", netProfit: value("17") }),
    row({ kind: "PRODUCT", productKey: "other", productName: "다른상품", netProfit: value("999") })];
  const result = summarizeNativeResults([...facts(rows), ...facts(rows, "NAVER", "shop-b", "2026-11-02")],
    [coverage(), coverage({ scopeKey: "shop-b", date: "2026-11-02" })], { platforms: ["NAVER"], productName: "상품" });
  assert.equal(result.completeTotals.estimatedProfit, "34.000000");
  assert.equal(result.productProfitSubtotal, "34.000000");
});

test("missing scope/day publication leaves known source money partial without borrowing a different day", () => {
  const result = summarizeNativeResults(facts([row()]), [coverage(), coverage({ date: "2026-11-02" }), coverage({ scopeKey: "shop-b" })], { platforms: ["NAVER"] });
  assert.equal(result.knownTotals.estimatedProfit, "47.123456");
  assert.equal(result.completeTotals.estimatedProfit, null);
  assert.equal(result.byMarketplace[0].display?.estimatedProfit.state, "PARTIAL");
  assert.ok(result.issues.includes("NATIVE_RESULT_NOT_PUBLISHED"));
});

test("known partial and unavailable net remain distinct independently of complete revenue and ads", () => {
  const partial = summarizeNativeResults(facts([row({ netProfit: value("13", null) })]), [coverage()], { platforms: ["NAVER"] });
  assert.equal(partial.knownTotals.estimatedProfit, "13.000000"); assert.equal(partial.completeTotals.estimatedProfit, null);
  const unknown = summarizeNativeResults(facts([row({ netProfit: value(null) })]), [coverage()], { platforms: ["NAVER"] });
  assert.equal(unknown.knownTotals.estimatedProfit, null);
  assert.equal(unknown.completeTotals.revenue, "1000.000000");
  assert.equal(unknown.byMarketplace[0].display?.estimatedProfit.state, "UNAVAILABLE");
});

test("original storefront and Google final results ignore unrelated reconstructed ad ledgers", () => {
  const native = facts([row({ group: "STOREFRONT", netProfit: value("11"), adSpend: value("22") }),
    row({ group: "GOOGLE", netProfit: value("-7"), adSpend: value("33") })], "CAFE24");
  const unrelated = { ...native[0], platform: "META" as const, component: "AD_SPEND" as const, nativeResult: undefined,
    amountKrw: "999999", completeAmountKrw: "999999" };
  const result = summarizeNativeResults([...native, unrelated], [coverage({ platform: "CAFE24" })], { platforms: ["CAFE24", "META", "GOOGLE"] });
  assert.equal(result.completeTotals.estimatedProfit, "4.000000");
  assert.equal(result.completeTotals.adSpend, "55.000000");
  assert.equal(result.byMarketplace.find(m => m.marketplace === "CAFE24_META")?.estimatedProfit, "11.000000");
  assert.equal(result.byMarketplace.find(m => m.marketplace === "CAFE24_YOUTUBE")?.estimatedProfit, "-7.000000");
});

test("absent product cannot become confirmed zero from a partial source summary", () => {
  const result = summarizeNativeResults(facts([row({ revenue: value("100", null), netProfit: value("10", null) })]),
    [coverage({ collectionState: "PARTIAL" })], { platforms: ["NAVER"], productName: "없는상품" });
  assert.equal(result.completeTotals.revenue, null);
  assert.equal(result.completeTotals.estimatedProfit, null);
});

test("ad-only complete totals require every expected account/day publication", () => {
  const ad: PublishedReportFact = { ...facts([row()], "META")[0], component: "AD_SPEND", nativeResult: undefined,
    amountKrw: "100", completeAmountKrw: "100" };
  const result = summarizeNativeResults([ad], [coverage({ platform: "META", component: "AD_SPEND" }),
    coverage({ platform: "META", component: "AD_SPEND", scopeKey: "missing", collectionState: "NOT_COLLECTED" })], { platforms: ["META"] });
  assert.equal(result.knownTotals.adSpend, "100.000000");
  assert.equal(result.completeTotals.adSpend, null);
  assert.equal(result.knownTotals.estimatedProfit, null);
});

test("confirmed empty ad days and absent products in complete ad sources retain confirmed zero", () => {
  const empty = summarizeNativeResults([], [coverage({ platform: "META", component: "AD_SPEND", rowsPresent: 0, zeroConfirmed: true })], { platforms: ["META"] });
  assert.equal(empty.knownTotals.adSpend, "0.000000");
  assert.equal(empty.completeTotals.adSpend, "0.000000");
  const ad: PublishedReportFact = { ...facts([row({ kind: "PRODUCT", productName: "다른상품", productKey: "other" })], "META")[0],
    component: "AD_SPEND", nativeResult: undefined, amountKrw: "100", completeAmountKrw: "100" };
  const product = summarizeNativeResults([ad], [coverage({ platform: "META", component: "AD_SPEND" })], { platforms: ["META"], productName: "없는상품" });
  assert.equal(product.knownTotals.adSpend, "0.000000");
  assert.equal(product.completeTotals.adSpend, "0.000000");
});

test("policy non-participation does not make an independently complete participating group partial", () => {
  const result = summarizeNativeResults(facts([row({ group: "COUPANG" })], "COUPANG"), [coverage({ platform: "COUPANG" }),
    coverage({ platform: "NAVER", participation: "NOT_APPLICABLE" })], { platforms: ["NAVER", "COUPANG"], productName: "absent" });
  assert.equal(result.completeTotals.revenue, "0.000000");
  assert.ok(!result.issues.includes("NATIVE_RESULT_NOT_PUBLISHED"));
});

test("sole storefront authority covers its same-day legacy shadow without suppressing real shops or legacy-only data", () => {
  const rows = (authoritative: boolean, unknown = false) => (["STOREFRONT", "GOOGLE"] as const).map(group => row({ group,
    ...(unknown ? { revenue: value(null), adSpend: value(null), netProfit: value(null), profitBeforeAds: value(null) } : {}),
    ...(authoritative ? { audit: { scopeOwnership: "SOLE_STOREFRONT", coveredLegacyScope: "LEGACY_UNBOUND" } } : {}) }));
  const configured = facts(rows(true), "CAFE24", "configured-shop");
  const configuredCoverage = coverage({ platform: "CAFE24", scopeKey: "configured-shop" });
  const legacy = facts(rows(false, true), "CAFE24", "LEGACY_UNBOUND");
  const legacyCoverage = coverage({ platform: "CAFE24", scopeKey: "LEGACY_UNBOUND", collectionState: "NOT_COLLECTED" });
  const baseline = summarizeNativeResults(configured, [configuredCoverage], { platforms: ["CAFE24"] });
  for (const [extraFacts, extraCoverage] of [[legacy, [legacyCoverage]], [[], [legacyCoverage]], [legacy, []]] as const) {
    const all = summarizeNativeResults([...configured, ...extraFacts], [configuredCoverage, ...extraCoverage], { platforms: ["CAFE24"] });
    assert.deepEqual(all.knownTotals, baseline.knownTotals);
    assert.deepEqual(all.completeTotals, baseline.completeTotals);
    assert.deepEqual(all.byMarketplace, baseline.byMarketplace);
    assert.ok(!all.issues.includes("NATIVE_RESULT_NOT_PUBLISHED"));
  }
  const twoShops = summarizeNativeResults([...facts(rows(false), "CAFE24", "shop-a"), ...facts(rows(false), "CAFE24", "shop-b"), ...legacy],
    [coverage({ platform: "CAFE24" }), coverage({ platform: "CAFE24", scopeKey: "shop-b" }), legacyCoverage], { platforms: ["CAFE24"] });
  assert.equal(twoShops.knownTotals.revenue, "4000.000000");
  assert.equal(twoShops.completeTotals.revenue, null);
  const legacyOnly = summarizeNativeResults(facts(rows(false), "CAFE24", "LEGACY_UNBOUND"),
    [coverage({ platform: "CAFE24", scopeKey: "LEGACY_UNBOUND" })], { platforms: ["CAFE24"] });
  assert.equal(legacyOnly.completeTotals.revenue, "2000.000000");
  const otherDayGap = summarizeNativeResults(configured, [configuredCoverage, { ...legacyCoverage, date: "2026-11-02" }], { platforms: ["CAFE24"] });
  assert.equal(otherDayGap.completeTotals.revenue, null, "authority on one date cannot cover another date");
});
