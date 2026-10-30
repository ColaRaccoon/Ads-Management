import test from "node:test";
import assert from "node:assert/strict";
import type { UnifiedRule } from "@prisma/client";
import type { AdapterBatch, AdapterRequest, AdSpendFact, CommonExpenseFact, Platform, SaleFact, SourceCoverage } from "../types";
import { PLATFORMS } from "../types";
import type { PublishedReportFact, ReportTotals } from "../report-contract";
import { ExactDecimal as D } from "./decimal";
import { compareMedia, compareTotals, prepareReportBatch, reportBuckets, scopePolicyComponents, summarizeReport } from "./report-calculation";
import { allocateProportionally } from "./report-allocation";

const date = "2026-10-26", quality = { isEstimate: false, confidence: "SOURCE_REPORTED" as const, issues: [] as string[] };
const q = (value: string) => new D(value).toFixed(6);
const req = (platform: Platform): AdapterRequest => ({ contractVersion: "product-performance-v1.1.0", runId: "run", readSnapshotId: "snapshot",
  from: date, to: date, scopeKeys: ["account"], platforms: [platform], scopePolicyVersion: "scope", nameRuleVersion: "name", saleUnitRuleVersion: "unit",
  allocationRuleVersion: "allocation", calculationVersion: "calculation", fxVersion: "fx", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 });
const sale = (revenue: string | null, profit: string | null, productName: string | null = "A", extra = {}): SaleFact => ({ productName,
  saleUnitName: "단품", operatingRevenue: revenue, profitBeforeAds: profit, calculationQuantity: "1", marketplace: "CAFE24", quality, ...extra } as SaleFact);
const ad = (amount: string | null, productName: string | null = "A", extra = {}): AdSpendFact => ({ productName, amountKrw: amount,
  originalAmount: amount ?? "10", currency: "KRW", attribution: productName ? "DIRECT" : "UNALLOCATED", medium: "META", name: { originalName: "광고 이름" }, quality, ...extra } as AdSpendFact);
const expense = (amount: string | null, kind: CommonExpenseFact["kind"] = "OTHER", productName: string | null = null): CommonExpenseFact => ({ productName,
  amountKrw: amount, originalAmount: amount ?? "0", unallocatedAmount: productName ? "0" : amount, kind, allocationStatus: productName ? "DIRECT" : "UNALLOCATED", quality } as CommonExpenseFact);
const cov = (platform: Platform, component: SourceCoverage["component"], extra: Partial<SourceCoverage> = {}): SourceCoverage => ({ platform, component,
  sourceSystem: platform, scopeKey: "account", date, participation: "INCLUDED", collectionState: "COMPLETE", rowsPresent: 1, zeroConfirmed: false,
  selectedSource: "SOURCE", selectedUploadId: null, sourceVersion: "1", collectedAt: "2026-10-27T00:00:00Z", sourceAsOf: "2026-10-27T00:00:00Z",
  calculatedAt: "2026-10-27T00:00:00Z", lastSuccessAt: "2026-10-27T00:00:00Z", sourceFingerprint: "fingerprint", nameRuleVersion: "name", costRuleVersion: "unit",
  mappedRows: 1, unmappedRows: 0, unmatchedAmount: "0", missingCostRows: 0, missingFxAmount: "0", unallocatedAmount: "0", quality, ...extra });
const batch = (sales: SaleFact[] = [], adSpends: AdSpendFact[] = [], commonExpenses: CommonExpenseFact[] = [], coverage: SourceCoverage[] = []): AdapterBatch =>
  ({ sales, adSpends, commonExpenses, coverage, sourceControlTotals: [], sourceFingerprint: "fingerprint", nextCursor: null });
const publish = (platform: Platform, value: AdapterBatch, rules: UnifiedRule[] = []): PublishedReportFact[] => prepareReportBatch(req(platform), value, rules)
  .map(row => ({ ...row, platform, scopeKey: "account", date }));
const rule = (platform: Platform, component: string, method: string, targets: Array<{ productName: string; weight?: string }>, extra = {}): UnifiedRule => ({
  id: "rule", kind: "ALLOCATION", productId: null, platform, scopeKey: "account", payload: { component, method, nameExact: null, targets },
  active: true, validFrom: new Date("2026-01-01"), validTo: null, identityKey: "test", version: 1,
  createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), ...extra } as UnifiedRule);

test("marketplace complete metrics retain source costs and withhold unknown cross-market ad allocation", () => {
  const facts = [...publish("CAFE24", batch([sale("100", "60")])),
    ...publish("NAVER", batch([sale("200", "120", "A", { marketplace: "NAVER_SMARTSTORE" })], [ad("10", "A", { medium: "NAVER_DA" })])),
    ...publish("META", batch([], [ad("20")]))];
  const coverage = [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST"), cov("NAVER", "SALE"), cov("NAVER", "DIRECT_COST"), cov("NAVER", "AD_SPEND"), cov("META", "AD_SPEND")];
  const result = summarizeReport(facts, coverage, { platforms: ["CAFE24", "NAVER", "META"] });
  const store = result.byMarketplace.find(row => row.marketplace === "CAFE24")!;
  assert.equal(store.completeRevenue, q("100"));
  assert.equal(store.profitBeforeAds, q("60"));
  assert.equal(store.estimatedProfit, null);
  assert.equal(store.profitUnavailableReason, "CROSS_MARKET_AD_ALLOCATION_UNKNOWN");
  assert.equal(result.byMarketplace.find(row => row.marketplace === "NAVER_SMARTSTORE")!.estimatedProfit, q("110"));
  assert.equal(result.completeTotals.estimatedProfit, q("150"));
  const excluded = summarizeReport(facts, coverage, { platforms: ["CAFE24", "NAVER"] });
  assert.equal(excluded.byMarketplace.find(row => row.marketplace === "CAFE24")!.estimatedProfit, q("60"));
  assert.equal(excluded.completeTotals.estimatedProfit, q("170"));
});

test("unallocated Meta product spend cannot produce a complete Cafe24 net profit", () => {
  const facts = [...publish("CAFE24", batch([sale("100", "60")])), ...publish("META", batch([], [ad("20", null)]))];
  const result = summarizeReport(facts, [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST"), cov("META", "AD_SPEND")], { platforms: ["CAFE24", "META"], productName: "A" });
  assert.equal(result.byMarketplace[0].estimatedProfit, null);
  assert.equal(result.byMarketplace[0].profitUnavailableReason, "CROSS_MARKET_AD_ALLOCATION_UNKNOWN");
  assert.equal(result.byMedium[0].completeAdSpend, null);
});

test("partial marketplace revenue and missing costs stay unavailable to before-after comparisons", () => {
  const facts = publish("CAFE24", batch([sale("100", "60"), sale(null, null)]));
  const result = summarizeReport(facts, [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST")], { platforms: ["CAFE24"] });
  assert.equal(result.byMarketplace[0].revenue, q("100"));
  assert.equal(result.byMarketplace[0].completeRevenue, null);
  assert.equal(result.byMarketplace[0].estimatedProfit, null);
  assert.equal(result.byMarketplace[0].profitUnavailableReason, "MISSING_INPUT");
});

test("sales and media aggregate independently; repeated same-name orders survive compact grouping", () => {
  const sales = batch([sale("100", "60"), sale("100", "60")]);
  const ads = batch([], [ad("3"), ad("5")]);
  const facts = [...publish("CAFE24", sales), ...publish("META", ads)];
  assert.equal(facts.length, 2);
  assert.equal(facts[0].rowsCount, 2);
  const result = summarizeReport(facts, [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST"), cov("META", "AD_SPEND")], { platforms: ["META", "CAFE24"] });
  assert.equal(result.knownTotals.revenue, q("200"));
  assert.equal(result.knownTotals.adSpend, q("8"));
  assert.equal(result.completeTotals.estimatedProfit, q("112"));
  assert.equal(result.knownTotals.mer, "25.0000000000");
});

test("compact payload drops order keys, names, options and non-enum issue strings", () => {
  const values = publish("CAFE24", batch([sale("100", "50", "A", { ref: { sourceRecordKey: "order-secret" },
    name: { originalName: "customer-secret", originalOption: "raw-option" }, quality: { ...quality, issues: ["COST_SOURCE_MISSING", "raw-order-secret", "ORDER:123@secret"] } })]));
  const json = JSON.stringify(values);
  for (const secret of ["order-secret", "customer-secret", "raw-option", "raw-order-secret", "123@secret"]) assert.equal(json.includes(secret), false);
  assert.deepEqual(values[0].quality.issues, ["COST_SOURCE_MISSING"]);
});

test("partial known revenue and profit are separate; a group containing unknown rows is incomplete", () => {
  const coverage = [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST")];
  const rows = publish("CAFE24", batch([sale("100", "60"), sale("40", null), sale(null, null)]));
  const result = summarizeReport(rows, coverage, { platforms: ["CAFE24"] });
  assert.equal(result.knownTotals.revenue, q("140"));
  assert.equal(result.knownTotals.profitBeforeAds, q("60"));
  assert.equal(result.knownTotals.estimatedProfit, q("60"));
  assert.equal(result.completeTotals.revenue, null);
  assert.equal(result.completeTotals.estimatedProfit, null);
  assert.equal(result.knownTotals.adSpend, null);
});

test("all unknown amounts never become zero; a completely missing day stays null", () => {
  const coverage = [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST")];
  const unknown = summarizeReport(publish("CAFE24", batch([sale(null, null)])), coverage, { platforms: ["CAFE24"] });
  assert.equal(unknown.knownTotals.revenue, null);
  assert.equal(unknown.knownTotals.profitBeforeAds, null);
  const missing = summarizeReport([], [cov("CAFE24", "SALE", { collectionState: "NOT_COLLECTED", rowsPresent: 0 })], { platforms: ["CAFE24"] });
  assert.equal(missing.knownTotals.revenue, null);
  assert.equal(missing.completeTotals.revenue, null);
});

test("confirmed zero and absent product in a collected source are valid zeros", () => {
  const coverage = [cov("CAFE24", "SALE", { rowsPresent: 0, zeroConfirmed: true }), cov("CAFE24", "DIRECT_COST", { rowsPresent: 0, zeroConfirmed: true }),
    cov("META", "AD_SPEND", { rowsPresent: 0, zeroConfirmed: true })];
  const result = summarizeReport([], coverage, { platforms: ["CAFE24", "META"], productName: "A" });
  assert.equal(result.completeTotals.revenue, q("0"));
  assert.equal(result.completeTotals.estimatedProfit, q("0"));
  assert.equal(result.completeTotals.adSpend, q("0"));
  assert.equal(result.knownTotals.mer, null);
  assert.equal(result.byMedium[0].adSpend, q("0"));
});

test("one missing selected day makes complete null while preserving known days", () => {
  const facts = publish("CAFE24", batch([sale("100", "50")]));
  const coverage = [cov("CAFE24", "SALE"), cov("CAFE24", "SALE", { date: "2026-10-25", rowsPresent: 0, collectionState: "NOT_COLLECTED" })];
  const result = summarizeReport(facts, coverage, { platforms: ["CAFE24"] });
  assert.equal(result.knownTotals.revenue, q("100"));
  assert.equal(result.completeTotals.revenue, null);
  assert.ok(result.issues.includes("INCOMPLETE_COVERAGE"));
});

test("Naver estimate metadata does not block computable values; actual read errors do", () => {
  const estimate = { isEstimate: true, confidence: "ESTIMATED" as const, issues: ["NAVER_PAYMENT_DATE_COMPLETION_UNPROVEN", "NAVER_STORED_FINGERPRINT_MISSING"] };
  const facts = publish("NAVER", batch([sale("100", "50", "A", { marketplace: "NAVER_SMARTSTORE", quality: estimate })]));
  const coverage = [cov("NAVER", "SALE", { collectionState: "PARTIAL", quality: estimate }), cov("NAVER", "DIRECT_COST", { collectionState: "PARTIAL", quality: estimate })];
  const result = summarizeReport(facts, coverage, { platforms: ["NAVER"] });
  assert.equal(result.completeTotals.revenue, q("100"));
  assert.equal(result.isEstimate, true);
  const failed = summarizeReport(facts, coverage.map(row => ({ ...row, quality: { ...estimate, issues: ["NAVER_ORDER_ITEMS_READ_FAILED"] } })), { platforms: ["NAVER"] });
  assert.equal(failed.knownTotals.revenue, q("100"));
  assert.equal(failed.completeTotals.revenue, null);
});

test("Naver malformed omitted ad rows are a true incompleteness, not estimate confidence", () => {
  const facts = publish("NAVER", batch([], [ad("10", "A", { medium: "NAVER_DA" })]));
  const result = summarizeReport(facts, [cov("NAVER", "AD_SPEND", { collectionState: "PARTIAL", rowsPresent: 2,
    quality: { isEstimate: true, confidence: "ESTIMATED", issues: ["NAVER_AD_AMOUNT_INVALID"] } })], { platforms: ["NAVER"] });
  assert.equal(result.knownTotals.adSpend, q("10"));
  assert.equal(result.completeTotals.adSpend, null);
});

test("previous complete stale revision stays usable and carries its warning", () => {
  const facts = publish("META", batch([], [ad("10")]));
  const result = summarizeReport(facts, [cov("META", "AD_SPEND", { collectionState: "STALE", quality: { ...quality, issues: ["STALE_DATA"] } })], { platforms: ["META"] });
  assert.equal(result.completeTotals.adSpend, q("10"));
  assert.ok(result.issues.includes("STALE_DATA"));
});

test("scope profit preserves unclassified sales, common shipping and unallocated expense once", () => {
  const facts = [...publish("CAFE24", batch([sale("200", "100"), sale("20", "10", null)], [], [expense("4", "SHIPPING_INCOME"), expense("7", "OTHER")])),
    ...publish("META", batch([], [ad("20", null)]))];
  const coverage = [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST"), cov("CAFE24", "COMMON_EXPENSE"), cov("META", "AD_SPEND")];
  const scope = summarizeReport(facts, coverage, { platforms: ["CAFE24", "META"] });
  assert.equal(scope.knownTotals.estimatedProfit, q("87"));
  assert.equal(scope.productProfitSubtotal, q("100"));
  assert.equal(scope.scopeBalances.unallocatedAdSpend, q("20"));
  assert.equal(scope.scopeBalances.unallocatedExpense, q("7"));
  assert.equal(scope.scopeBalances.shippingIncome, q("4"));
  assert.equal(scope.scopeBalances.unallocatedShippingIncome, q("4"));
  assert.equal(scope.scopeBalances.unclassifiedRevenue, q("20"));
  assert.equal(scope.scopeBalances.unclassifiedProfitBeforeAds, q("10"));
  assert.equal(new D(scope.productProfitSubtotal!).plus(scope.scopeBalances.unclassifiedProfitBeforeAds!)
    .minus(scope.scopeBalances.unallocatedAdSpend!).minus(scope.scopeBalances.unallocatedExpense!)
    .plus(scope.scopeBalances.unallocatedShippingIncome!).toFixed(6), scope.knownTotals.estimatedProfit);
  assert.equal(scope.unclassifiedSales[0].amount, q("20"));
  const product = summarizeReport(facts, coverage, { platforms: ["CAFE24", "META"], productName: "A" });
  assert.equal(product.knownTotals.revenue, q("200"));
  assert.equal(product.knownTotals.estimatedProfit, q("100"));
  assert.equal(product.completeTotals.estimatedProfit, null);
  assert.equal(product.scopeBalances.unclassifiedRevenue, scope.scopeBalances.unclassifiedRevenue);
  assert.equal(product.scopeBalances.unallocatedShippingIncome, scope.scopeBalances.unallocatedShippingIncome);
});

test("scope profit reconciles mapped profit, unclassified profit, unallocated ads and only unallocated shipping income", () => {
  const facts = [...publish("CAFE24", batch([sale("200", "100", "A"), sale("100", "30", "B"), sale("20", "-5", null)], [],
    [expense("10", "SHIPPING_INCOME", "A"), expense("4", "SHIPPING_INCOME"), expense("2", "OTHER", "B"), expense("7", "OTHER")])),
    ...publish("META", batch([], [ad("5", "A"), ad("3", null)]))];
  const coverage = [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST"), cov("CAFE24", "COMMON_EXPENSE"), cov("META", "AD_SPEND")];
  const scope = summarizeReport(facts, coverage, { platforms: ["CAFE24", "META"] });
  assert.equal(scope.productProfitSubtotal, q("133"));
  assert.equal(scope.scopeBalances.shippingIncome, q("14"));
  assert.equal(scope.scopeBalances.unallocatedShippingIncome, q("4"));
  assert.equal(scope.scopeBalances.unclassifiedRevenue, q("20"));
  assert.equal(scope.scopeBalances.unclassifiedProfitBeforeAds, q("-5"));
  assert.equal(scope.scopeBalances.unallocatedAdSpend, q("3"));
  assert.equal(scope.scopeBalances.unallocatedExpense, q("7"));
  assert.equal(scope.knownTotals.estimatedProfit, q("122"));
  assert.equal(new D(scope.productProfitSubtotal!).plus(scope.scopeBalances.unclassifiedProfitBeforeAds!)
    .minus(scope.scopeBalances.unallocatedAdSpend!).minus(scope.scopeBalances.unallocatedExpense!)
    .plus(scope.scopeBalances.unallocatedShippingIncome!).toFixed(6), scope.knownTotals.estimatedProfit);
  const product = summarizeReport(facts, coverage, { platforms: ["CAFE24", "META"], productName: "A" });
  assert.equal(product.knownTotals.estimatedProfit, q("105"));
  assert.equal(product.scopeBalances.unclassifiedProfitBeforeAds, q("-5"));
  assert.equal(product.scopeBalances.unallocatedShippingIncome, q("4"));
});

test("unknown unclassified and unallocated balances remain null alongside known mapped amounts", () => {
  const facts = [...publish("CAFE24", batch([sale("100", "60", "A"), sale(null, null, null)], [],
    [expense("4", "SHIPPING_INCOME", "A"), expense(null, "SHIPPING_INCOME"), expense(null)])),
    ...publish("META", batch([], [ad("5", "A"), ad(null, null)]))];
  const scope = summarizeReport(facts, [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST"), cov("CAFE24", "COMMON_EXPENSE"), cov("META", "AD_SPEND")],
    { platforms: ["CAFE24", "META"] });
  assert.equal(scope.scopeBalances.unclassifiedRevenue, null);
  assert.equal(scope.scopeBalances.unclassifiedProfitBeforeAds, null);
  assert.equal(scope.scopeBalances.unallocatedShippingIncome, null);
  assert.equal(scope.scopeBalances.unallocatedExpense, null);
  assert.equal(scope.scopeBalances.unallocatedAdSpend, null);
  assert.equal(scope.scopeBalances.shippingIncome, q("4"));
});

test("unrelated product missing cost does not remove complete profit for a fully costed product", () => {
  const facts = publish("CAFE24", batch([sale("100", "60", "A"), sale("40", null, "B")]));
  const coverage = [cov("CAFE24", "SALE", { missingCostRows: 1 }), cov("CAFE24", "DIRECT_COST", { collectionState: "PARTIAL", missingCostRows: 1 })];
  const result = summarizeReport(facts, coverage, { platforms: ["CAFE24"], productName: "A" });
  assert.equal(result.completeTotals.profitBeforeAds, q("60"));
  const whole = summarizeReport(facts, coverage, { platforms: ["CAFE24"] });
  assert.equal(whole.completeTotals.profitBeforeAds, null);
});

test("unclassified source sales cannot prove a product zero or a complete product total", () => {
  const facts = publish("CAFE24", batch([sale("100", "60", "A"), sale("40", "20", null)]));
  const coverage = [cov("CAFE24", "SALE", { unmappedRows: 1 }), cov("CAFE24", "DIRECT_COST", { unmappedRows: 1 })];
  const a = summarizeReport(facts, coverage, { platforms: ["CAFE24"], productName: "A" });
  assert.equal(a.knownTotals.revenue, q("100"));
  assert.equal(a.completeTotals.revenue, null);
  const absent = summarizeReport(facts, coverage, { platforms: ["CAFE24"], productName: "B" });
  assert.equal(absent.knownTotals.revenue, null);
  assert.equal(absent.completeTotals.revenue, null);
  assert.equal(summarizeReport(facts, coverage, { platforms: ["CAFE24"] }).completeTotals.revenue, q("140"));
});

test("all 32 platform combinations use selected amounts and the selected ad denominator", () => {
  const saleMap: Partial<Record<Platform, string>> = { CAFE24: "100", NAVER: "200", COUPANG: "300" };
  const adMap: Partial<Record<Platform, string>> = { META: "10", GOOGLE: "20", NAVER: "30", COUPANG: "40" };
  const medium = { META: "META", GOOGLE: "GOOGLE", NAVER: "NAVER_DA", COUPANG: "COUPANG_ADS", CAFE24: "" };
  const market = { NAVER: "NAVER_SMARTSTORE", COUPANG: "COUPANG", CAFE24: "CAFE24", META: "", GOOGLE: "" };
  const facts = PLATFORMS.flatMap(platform => publish(platform, batch(saleMap[platform] ? [sale(saleMap[platform]!, saleMap[platform]!, "A", { marketplace: market[platform] })] : [],
    adMap[platform] ? [ad(adMap[platform]!, "A", { medium: medium[platform] })] : [], platform === "NAVER" ? [expense("5"), expense("1", "SHIPPING_INCOME")] : [])));
  const coverage = PLATFORMS.flatMap(platform => [...(saleMap[platform] ? [cov(platform, "SALE"), cov(platform, "DIRECT_COST")] : []),
    ...(adMap[platform] ? [cov(platform, "AD_SPEND")] : []), ...(platform === "NAVER" ? [cov(platform, "COMMON_EXPENSE")] : [])]);
  for (let mask = 0; mask < 32; mask++) {
    const platforms = PLATFORMS.filter((_, index) => (mask & (1 << index)) !== 0), result = summarizeReport(facts, coverage, { platforms });
    const sales = platforms.filter(platform => saleMap[platform]), ads = platforms.filter(platform => adMap[platform]);
    const revenue = sales.reduce((total, platform) => total.plus(saleMap[platform]!), new D(0)), spend = ads.reduce((total, platform) => total.plus(adMap[platform]!), new D(0));
    assert.equal(result.completeTotals.revenue, sales.length ? revenue.toFixed(6) : null, String(mask));
    assert.equal(result.completeTotals.adSpend, ads.length ? spend.toFixed(6) : null, String(mask));
    assert.equal(result.completeTotals.estimatedProfit, sales.length ? revenue.minus(spend).minus(platforms.includes("NAVER") ? 4 : 0).toFixed(6) : null, String(mask));
    assert.equal(result.completeTotals.mer, sales.length && ads.length ? revenue.div(spend).toFixed(10) : null, String(mask));
    if (ads.length) assert.equal(result.byMedium.reduce((total, row) => total.plus(row.share!), new D(0)).toDecimalPlaces(8).toFixed(), "100", String(mask));
    assert.equal(result.unallocatedExpenses.length, platforms.includes("NAVER") ? 2 : 0, String(mask));
    const previous = summarizeReport(facts, coverage, { platforms });
    assert.equal(compareTotals(result.knownTotals, previous.knownTotals, 1, 1).adSpend.change, ads.length ? q("0") : null);
  }
});

test("excluded Naver failures do not affect other source totals or quality", () => {
  const facts = publish("CAFE24", batch([sale("100", "50")]));
  const coverage = [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST"), cov("NAVER", "SALE", { collectionState: "NOT_COLLECTED", quality: { ...quality, issues: ["NAVER_READ_FAILED"] } })];
  const result = summarizeReport(facts, coverage, { platforms: ["CAFE24"] });
  assert.equal(result.completeTotals.estimatedProfit, q("50"));
  assert.equal(result.issues.includes("NAVER_READ_FAILED"), false);
});

test("fixed common and ad allocations preserve source amounts, including negative micro corrections", () => {
  const rules = [rule("NAVER", "AD_SPEND", "FIXED_WEIGHTS", [{ productName: "B", weight: "0.5" }, { productName: "A", weight: "0.5" }]),
    rule("NAVER", "OTHER", "FIXED_WEIGHTS", [{ productName: "A", weight: "0.5" }, { productName: "B", weight: "0.5" }])];
  const facts = publish("NAVER", batch([], [ad("-0.000001", null, { medium: "NAVER_DA", originalAmount: "-0.000003" })], [expense("1")], [cov("NAVER", "AD_SPEND")]), rules);
  assert.equal(facts.filter(row => row.component === "AD_SPEND").reduce((total, row) => total.plus(row.amountKrw!), new D(0)).toFixed(6), "-0.000001");
  assert.equal(facts.filter(row => row.component === "AD_SPEND").reduce((total, row) => total.plus(row.originalAmount!), new D(0)).toFixed(6), "-0.000003");
  assert.equal(facts.find(row => row.component === "AD_SPEND" && row.productName === "A")?.amountKrw, "-0.000001");
  assert.equal(facts.filter(row => row.component === "COMMON_EXPENSE").reduce((total, row) => total.plus(row.amountKrw!), new D(0)).toFixed(6), q("1"));
  assert.ok(facts.every(row => row.attribution === "ALLOCATED"));
});

test("revenue-share allocation uses original source sales, and selection cannot redistribute excluded cost", () => {
  const values = batch([sale("100", "50", "A"), sale("300", "150", "B")], [], [expense("40")], [cov("CAFE24", "SALE")]);
  const rules = [rule("CAFE24", "OTHER", "REVENUE_SHARE", [{ productName: "A" }, { productName: "B" }])];
  const facts = publish("CAFE24", values, rules);
  assert.equal(facts.find(row => row.component === "COMMON_EXPENSE" && row.productName === "A")?.amountKrw, q("10"));
  assert.equal(facts.find(row => row.component === "COMMON_EXPENSE" && row.productName === "B")?.amountKrw, q("30"));
  assert.equal(summarizeReport(facts, values.coverage, { platforms: ["META"] }).unallocatedExpenses.length, 0);
  assert.equal(summarizeReport(facts, values.coverage, { platforms: ["CAFE24"], productName: "A" }).knownTotals.estimatedProfit, q("40"));
});

test("allocation with zero/unknown revenue base stays unallocated and direct attribution is not overwritten", () => {
  const rules = [rule("CAFE24", "OTHER", "REVENUE_SHARE", [{ productName: "A" }, { productName: "B" }])];
  const zero = publish("CAFE24", batch([sale("0", "0")], [], [expense("20")], [cov("CAFE24", "SALE")]), rules);
  assert.equal(zero.find(row => row.component === "COMMON_EXPENSE")?.attribution, "UNALLOCATED");
  const unknown = publish("CAFE24", batch([sale(null, null)], [], [expense("20")], [cov("CAFE24", "SALE")]), rules);
  assert.ok(unknown.find(row => row.component === "COMMON_EXPENSE")?.quality.issues.includes("REVENUE_ALLOCATION_INCOMPLETE"));
  const direct = publish("CAFE24", batch([], [], [expense("20", "OTHER", "C")], [cov("CAFE24", "SALE")]), rules);
  assert.equal(direct[0].productName, "C");
  assert.equal(direct[0].attribution, "DIRECT");
});

test("allocation conflicts, account/date mismatch and ten-place fixed weights are handled deterministically", () => {
  const a = rule("META", "AD_SPEND", "FIXED_WEIGHTS", [{ productName: "A", weight: "0.3333333333" }, { productName: "B", weight: "0.6666666667" }]);
  const values = batch([], [ad("1", null)], [], [cov("META", "AD_SPEND")]);
  const allocated = publish("META", values, [a]);
  assert.equal(allocated.find(row => row.productName === "A")?.amountKrw, "0.333333");
  assert.equal(allocated.find(row => row.productName === "B")?.amountKrw, "0.666667");
  const conflict = publish("META", values, [a, { ...a, id: "other" }]);
  assert.equal(conflict[0].attribution, "UNALLOCATED");
  assert.ok(conflict[0].quality.issues.includes("AMBIGUOUS_ALLOCATION_RULE"));
  assert.equal(publish("META", values, [{ ...a, scopeKey: "other-account" }])[0].attribution, "UNALLOCATED");
  assert.equal(publish("META", values, [{ ...a, validTo: new Date("2026-10-25") }])[0].attribution, "UNALLOCATED");
});

test("revenue proportional thirds conserve large sums without rounding weight ratios", () => {
  const result = allocateProportionally("9007199254740993.000001", [{ productName: "C", weight: "1" }, { productName: "A", weight: "1" }, { productName: "B", weight: "1" }]);
  assert.equal(result.reduce((total, row) => total.plus(row.amount), new D(0)).toFixed(6), "9007199254740993.000001");
  assert.equal(result[0].productName, "A");
  assert.equal(new D(result[0].amount).minus(result[1].amount).toFixed(6), "0.000001");
});

test("period comparisons suppress zero and non-positive prior profit bases and retain daily averages", () => {
  const totals: ReportTotals = { revenue: "100", adSpend: "20", profitBeforeAds: "-10", estimatedProfit: "-30", mer: "5.0000000000" };
  const previous: ReportTotals = { revenue: "0", adSpend: null, profitBeforeAds: "-20", estimatedProfit: "0", mer: "0.3333333333" };
  const result = compareTotals(totals, previous, 10, 5);
  assert.equal(result.revenue.reason, "ZERO_BASE");
  assert.equal(result.revenue.change, q("100"));
  assert.equal(result.profitBeforeAds.reason, "NON_POSITIVE_PROFIT_BASE");
  assert.equal(result.profitBeforeAds.changePct, null);
  assert.equal(result.estimatedProfit.change, q("-30"));
  assert.equal(result.adSpend.reason, "MISSING_INPUT");
  assert.equal(result.revenue.currentDailyAverage, q("10"));
  assert.equal(result.mer.change, "4.6666666667");
  assert.equal(compareTotals(totals, { ...previous, profitBeforeAds: "20" }, 1, 1).profitBeforeAds.changePct, null);
});

test("non-participating ad component does not block a product's participating sales-only profit", () => {
  const facts = publish("NAVER", batch([sale("100", "50", "A", { marketplace: "NAVER_SMARTSTORE" })]));
  const result = summarizeReport(facts, [cov("NAVER", "SALE"), cov("NAVER", "DIRECT_COST"),
    cov("NAVER", "AD_SPEND", { participation: "NOT_APPLICABLE" })], { platforms: ["NAVER"], productName: "A" });
  assert.equal(result.completeTotals.estimatedProfit, q("50"));
  assert.equal(result.knownTotals.adSpend, null);
  assert.equal(result.knownTotals.mer, null);
});

test("bucket MER and medium shares are computed from totals rather than daily percentages", () => {
  const day1 = [...publish("CAFE24", batch([sale("100", "80")])), ...publish("META", batch([], [ad("10")]))];
  const day2 = [...publish("CAFE24", batch([sale("90", "70")])), ...publish("META", batch([], [ad("90")]))].map(row => ({ ...row, date: "2026-10-27" }));
  const coverage = [cov("CAFE24", "SALE"), cov("CAFE24", "DIRECT_COST"), cov("META", "AD_SPEND")];
  const result = summarizeReport([...day1, ...day2], [...coverage, ...coverage.map(row => ({ ...row, date: "2026-10-27" }))], { platforms: ["META", "CAFE24"] });
  assert.equal(result.completeTotals.mer, "1.9000000000");
  assert.notEqual(result.completeTotals.mer, "5.5000000000");
});

test("medium comparison computes percentage-point share and total-spend contribution", () => {
  const report = (meta: string, google: string) => summarizeReport([...publish("META", batch([], [ad(meta)])), ...publish("GOOGLE", batch([], [ad(google, "A", { medium: "GOOGLE" })]))],
    [cov("META", "AD_SPEND"), cov("GOOGLE", "AD_SPEND")], { platforms: ["META", "GOOGLE"] });
  const current = report("900000", "1100000"), previous = report("600000", "1000000");
  const meta = compareMedia(current, previous).find(row => row.medium === "META")!;
  assert.equal(meta.changePct, "50.0000000000");
  assert.equal(meta.share, "45.0000000000");
  assert.equal(meta.shareChangePp, "7.5000000000");
  assert.equal(meta.spendChangeContributionPp, "18.7500000000");
});

test("calendar week/month buckets retain clipped boundaries, leap days and partial periods", () => {
  assert.deepEqual(reportBuckets("2026-10-27", "2026-11-02", "week"), [
    { date: "2026-10-26", bucketFrom: "2026-10-27", bucketTo: "2026-11-01", partialPeriod: true, dayCount: 6 },
    { date: "2026-11-02", bucketFrom: "2026-11-02", bucketTo: "2026-11-02", partialPeriod: true, dayCount: 1 }]);
  assert.deepEqual(reportBuckets("2024-02-01", "2024-02-29", "month"), [
    { date: "2024-02-01", bucketFrom: "2024-02-01", bucketTo: "2024-02-29", partialPeriod: false, dayCount: 29 }]);
  assert.equal(reportBuckets("2026-10-26", "2026-10-26", "day")[0].partialPeriod, false);
});

test("product participation policy intersects platform, account, component and effective date", () => {
  const policy = { ...rule("META", "AD_SPEND", "UNALLOCATED", []), kind: "SCOPE_POLICY", productId: "product", payload: { components: ["AD_SPEND"] } };
  assert.deepEqual(scopePolicyComponents([], "product", "CAFE24", "account", date, ["SALE", "DIRECT_COST"]), ["SALE", "DIRECT_COST"]);
  assert.deepEqual(scopePolicyComponents([policy], "product", "META", "account", date, ["AD_SPEND"]), ["AD_SPEND"]);
  assert.deepEqual(scopePolicyComponents([policy], "product", "CAFE24", "account", date, ["SALE", "DIRECT_COST"]), []);
  assert.deepEqual(scopePolicyComponents([policy], "product", "META", "other", date, ["AD_SPEND"]), []);
  assert.deepEqual(scopePolicyComponents([{ ...policy, validFrom: new Date("2026-10-27") }], "product", "META", "account", date, ["AD_SPEND"]), []);
});

test("prepareReportBatch rejects a multi-day partition before producing unpartitioned aggregates", () => {
  assert.throws(() => prepareReportBatch({ ...req("META"), to: "2026-10-27" }, batch()), /ONE_DAY/);
});
