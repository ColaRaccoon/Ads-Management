import test, { after } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { authCoordinator } from "@/features/auth/auth-coordination";
import { testData, testFilters } from "./test-fixture";
import { DailyProductsTable } from "./daily-products-table";
import { buildDailyProductsReport, compareDailyProductAmounts, dailyProductChange, dailyProductMoney, dailyProductsScopeLabel,
  type DailyProductsAggregate, type DailyProductsResponse, type PublishedAmount } from "./daily-products-model";
import type { DisplayAmount, Totals } from "./types";

after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());
const display = (value: string | null, state: DisplayAmount["state"] = value === null ? "UNAVAILABLE" : "COMPLETE"): DisplayAmount =>
  ({ value, state, availableSources: [], missingSources: [] });
function totals(next: Partial<Totals> = {}): Totals { return { revenue: null, adSpend: null, estimatedProfit: null, profitBeforeAds: null, mer: null, ...next }; }
function aggregate(next: Partial<DailyProductsAggregate> = {}): DailyProductsAggregate {
  return { knownTotals: totals(), completeTotals: totals(), byMarketplace: [], byMedium: [], isEstimate: false, ...next };
}
function market(marketplace: string, revenue: string | null, adSpend: string | null, estimatedProfit: string | null) {
  return { marketplace, revenue, adSpend, estimatedProfit, completeRevenue: revenue,
    display: { revenue: display(revenue), adSpend: display(adSpend), estimatedProfit: display(estimatedProfit) } };
}
function fixture() {
  const filters = testFilters({ from: "2026-10-28", to: "2026-10-29", compareMode: "custom", compareFrom: "2026-10-28", compareTo: "2026-10-28" });
  const data = testData(filters);
  const previous = aggregate({ knownTotals: totals({ revenue: "1000", adSpend: "200", estimatedProfit: "100" }), completeTotals: totals({ revenue: "1000", adSpend: "200", estimatedProfit: "100" }),
    byMarketplace: [market("CAFE24_META", "600", "100", "80"), market("CAFE24_YOUTUBE", "400", "100", "20")] });
  const current = aggregate({ knownTotals: totals({ revenue: "1500", adSpend: "300", estimatedProfit: "150" }), completeTotals: totals({ revenue: "1500", adSpend: "300", estimatedProfit: "150" }),
    byMarketplace: [market("CAFE24_META", "900", "100", "200"), market("CAFE24_YOUTUBE", "600", "200", "-50")],
    scopeBalances: { unallocatedAdSpend: "10", unallocatedExpense: "20", shippingIncome: "30", unallocatedShippingIncome: "5", unclassifiedRevenue: "60", unclassifiedProfitBeforeAds: "25" } });
  const response: DailyProductsResponse = { summary: data.summary, timeseries: data.timeseries, reportDate: "2026-10-29", previousDate: "2026-10-28", totalProducts: 1, nextCursor: null,
    products: [{ productKey: "p1", productName: "테스트 제품", active: true, historical: false, current, previous }], allProducts: { current, previous } };
  return { filters, response };
}
const published = (value: string | null, state: PublishedAmount["state"] = value === null ? "UNAVAILABLE" : "COMPLETE"): PublishedAmount =>
  ({ value, state, isEstimate: false, reasonCodes: [] });

test("native channels use their persisted fields and total never adds the displayed channel amounts", () => {
  const { filters, response } = fixture();
  response.products[0].current.byMarketplace.push(market("COUPANG", "999", "777", "555"));
  const report = buildDailyProductsReport(response, "2026-10-29", filters), row = report.rows[0];
  assert.equal(row.groups.STOREFRONT.revenue.current.value, "900");
  assert.equal(row.groups.GOOGLE.revenue.current.value, "600");
  assert.equal(row.groups.GOOGLE.netProfit.current.value, "-50");
  assert.equal(row.groups.GOOGLE.netProfit.changePct, "-350.0000000000");
  assert.equal(row.groups.GOOGLE.netProfit.comparisonReason, "LOSS_TRANSITION");
  assert.equal(row.groups.TOTAL.revenue.current.value, "1500");
  assert.equal(row.groups.TOTAL.netProfit.current.value, "150");
  assert.equal(dailyProductChange(row.groups.TOTAL.revenue), "+50.0%");
  assert.equal(report.reconciliation.find(item => item.key === "unclassifiedRevenue")?.current, "60");
});

test("Naver native-source transition preserves stored amounts but excludes misleading channel and total deltas", () => {
  const { filters, response } = fixture();
  response.products[0].current.byMarketplace.push(market("NAVER_SMARTSTORE", "250", "25", "50"));
  response.products[0].previous.byMarketplace.push(market("NAVER_SMARTSTORE", "100", "20", "10"));
  response.allProducts.current.comparisonBasis = { NAVER: "native-store-a" };
  response.allProducts.previous.comparisonBasis = { NAVER: "legacy-store-a" };
  const report = buildDailyProductsReport(response, "2026-10-29", filters);
  for (const row of [report.rows[0], report.totals]) for (const group of ["NAVER", "TOTAL"] as const) {
    assert.equal(row.groups[group].revenue.changePct, null);
    assert.equal(row.groups[group].revenue.change, null);
    assert.equal(dailyProductChange(row.groups[group].revenue), "기준 변경");
  }
  assert.equal(report.rows[0].groups.NAVER.revenue.current.value, "250");
  assert.equal(report.rows[0].groups.NAVER.revenue.previous.value, "100");
  assert.equal(report.rows[0].groups.TOTAL.revenue.current.value, "1500");
  assert.equal(report.rows[0].groups.STOREFRONT.revenue.changePct, "50.0000000000");
  assert.ok(report.warnings.some(warning => warning.includes("네이버 집계 기준")));
  response.allProducts.previous.comparisonBasis = { NAVER: "native-store-a" };
  assert.equal(buildDailyProductsReport(response, "2026-10-29", filters).rows[0].groups.NAVER.revenue.changePct, "150.0000000000");
  response.allProducts.previous.comparisonBasis = { NAVER: "legacy-store-a" };
  assert.equal(buildDailyProductsReport(response, "2026-10-29", { ...filters, platforms: ["CAFE24"] }).rows[0].groups.TOTAL.revenue.changePct, "50.0000000000");
  delete response.allProducts.previous.comparisonBasis;
  assert.equal(buildDailyProductsReport(response, "2026-10-29", filters).rows[0].groups.NAVER.revenue.changePct, "150.0000000000");
});

test("zero, missing, negative bases and partial values retain different comparison states", () => {
  assert.equal(dailyProductChange(compareDailyProductAmounts(published("0"), published("0"))), "전일 0");
  assert.equal(dailyProductChange(compareDailyProductAmounts(published("100"), published(null))), "전일 없음");
  assert.equal(dailyProductChange(compareDailyProductAmounts(published(null), published("100"))), "자료 없음");
  assert.equal(dailyProductChange(compareDailyProductAmounts(published("10"), published("-5"))), "흑자 전환");
  assert.equal(dailyProductChange(compareDailyProductAmounts(published("-10"), published("-5"))), "전일 음수");
  const partial = compareDailyProductAmounts(published("110", "PARTIAL"), published("100"));
  assert.equal(partial.current.state, "PARTIAL"); assert.equal(dailyProductChange(partial), "+10.0%");
  assert.equal(dailyProductChange(compareDailyProductAmounts(published("999.9"), published("1000"))), "0.0%");
});

test("large decimal values are compared and rendered without floating point precision loss", () => {
  const metric = compareDailyProductAmounts(published("9007199254740993.123456"), published("9007199254740992.123456"));
  assert.equal(metric.change, "1.0000000000");
  assert.equal(dailyProductMoney(metric.current.value), "9,007,199,254,740,993");
  assert.equal(dailyProductMoney("9007199254740993.5"), "9,007,199,254,740,994");
  assert.equal(dailyProductMoney("-0.0001"), "0");
  assert.equal(dailyProductMoney("-10.5"), "−11");
});

test("legacy storefront is never relabeled as Google sales and channel transition blocks comparison", () => {
  const { filters, response } = fixture();
  response.products[0].previous.byMarketplace = [market("CAFE24", "1000", "200", "100")];
  const report = buildDailyProductsReport(response, "2026-10-29", filters), row = report.rows[0];
  assert.equal(row.groups.STOREFRONT.revenue.previous.value, "1000");
  assert.equal(row.groups.STOREFRONT.revenue.changePct, null);
  assert.equal(dailyProductChange(row.groups.STOREFRONT.revenue), "기준 변경");
  assert.equal(row.groups.GOOGLE.revenue.previous.value, null);
  assert.equal(row.groups.TOTAL.revenue.changePct, "50.0000000000");
});

test("mixed storefront revisions never produce a made-up combined channel", () => {
  const { filters, response } = fixture();
  response.products[0].current.byMarketplace.push(market("CAFE24", "1000", "200", "100"));
  const report = buildDailyProductsReport(response, "2026-10-29", filters);
  assert.equal(report.rows[0].groups.STOREFRONT.revenue.current.state, "UNAVAILABLE");
  assert.equal(report.rows[0].groups.STOREFRONT.revenue.current.value, null);
  assert.match(report.warnings.join(" "), /섞여/);
});

test("selection excludes only a metric's sources and media-only queries still show their ads", () => {
  const { filters, response } = fixture();
  filters.platforms = ["CAFE24", "META"];
  let report = buildDailyProductsReport(response, "2026-10-29", filters);
  assert.equal(report.rows[0].groups.GOOGLE.adSpend.current.state, "EXCLUDED");
  assert.equal(report.rows[0].groups.GOOGLE.revenue.current.value, "600");
  assert.equal(report.rows[0].groups.COUPANG.revenue.current.state, "EXCLUDED");
  filters.platforms = ["GOOGLE"];
  response.products[0].current.byMarketplace = [];
  response.products[0].current.byMedium = [{ medium: "GOOGLE", adSpend: "77", completeAdSpend: "77", share: "100", displayAdSpend: display("77") }];
  report = buildDailyProductsReport(response, "2026-10-29", filters);
  assert.equal(report.rows[0].groups.GOOGLE.adSpend.current.value, "77");
  assert.equal(report.rows[0].groups.GOOGLE.revenue.current.state, "EXCLUDED");
  assert.equal(report.rows[0].groups.TOTAL.revenue.current.state, "EXCLUDED");
});

test("inactive, zero and historical rows remain visible and duplicate or truncated results are refused", () => {
  const { filters, response } = fixture();
  response.products.push({ productKey: "old", productName: "과거 제품", active: false, historical: true, current: aggregate(), previous: aggregate() });
  response.products.push({ productKey: "zero", productName: "0원 제품", active: false, historical: false,
    current: aggregate({ knownTotals: totals({ revenue: "0" }), completeTotals: totals({ revenue: "0" }) }), previous: aggregate() });
  response.totalProducts = 3;
  assert.equal(buildDailyProductsReport(response, "2026-10-29", filters).rows.length, 3);
  response.totalProducts = 4;
  assert.throws(() => buildDailyProductsReport(response, "2026-10-29", filters), /완전하지/);
  response.totalProducts = 3; response.products[2].productKey = "old";
  assert.throws(() => buildDailyProductsReport(response, "2026-10-29", filters), /완전하지/);
});

test("policy non-participation stays distinct from user exclusion and missing data", () => {
  const { filters, response } = fixture();
  filters.platforms = ["CAFE24", "META", "GOOGLE"];
  response.products[0].current.notApplicable = { revenue: ["CAFE24"], adSpend: ["META"] };
  let report = buildDailyProductsReport(response, "2026-10-29", filters);
  assert.equal(report.rows[0].groups.STOREFRONT.revenue.current.state, "NOT_APPLICABLE");
  assert.equal(report.rows[0].groups.STOREFRONT.netProfit.current.state, "NOT_APPLICABLE");
  assert.equal(report.rows[0].groups.GOOGLE.revenue.current.state, "NOT_APPLICABLE");
  assert.equal(report.rows[0].groups.TOTAL.revenue.current.state, "NOT_APPLICABLE");
  assert.equal(report.rows[0].groups.TOTAL.adSpend.current.state, "COMPLETE");
  assert.equal(report.rows[0].groups.GOOGLE.adSpend.current.state, "COMPLETE");
  assert.equal(report.rows[0].groups.COUPANG.revenue.current.state, "EXCLUDED");
  filters.platforms = ["CAFE24", "GOOGLE"];
  report = buildDailyProductsReport(response, "2026-10-29", filters);
  assert.equal(report.rows[0].groups.STOREFRONT.adSpend.current.state, "EXCLUDED");
  response.products[0].current.byMarketplace = [market("CAFE24", "1000", "200", "100")];
  report = buildDailyProductsReport(response, "2026-10-29", filters);
  assert.equal(report.rows[0].groups.STOREFRONT.adSpend.current.state, "COMPLETE");
  delete response.products[0].current.notApplicable;
  response.products[0].current.byMarketplace = [];
  report = buildDailyProductsReport(response, "2026-10-29", filters);
  assert.equal(report.rows[0].groups.STOREFRONT.revenue.current.state, "UNAVAILABLE");
});

test("report uses exact prior calendar day and rejects a substituted date", () => {
  const { filters, response } = fixture();
  response.reportDate = "2024-03-01"; response.previousDate = "2024-02-29";
  assert.equal(buildDailyProductsReport(response, "2024-03-01", filters).previousDate, "2024-02-29");
  response.previousDate = "2024-02-28";
  assert.throws(() => buildDailyProductsReport(response, "2024-03-01", filters), /완전하지/);
  assert.throws(() => buildDailyProductsReport(response, "2026-02-30", filters), /보고일/);
});

test("scope descriptions resolve names without exposing internal account keys", () => {
  const { filters, response } = fixture();
  response.summary.selection.scopeKeys = ["internal-store-a", "internal-store-b"];
  const unresolved = dailyProductsScopeLabel(response, filters);
  assert.match(unresolved, /계정·스토어 2개/); assert.doesNotMatch(unresolved, /internal-store/);
  const named = dailyProductsScopeLabel(response, filters, { products: [], scopes: [{ platform: "CAFE24", scopeKey: "internal-store-a", label: "대표 자사몰" }], platformOptions: [], availableDateRanges: [], defaultSelection: { platforms: [], from: "2026-10-28", to: "2026-10-29" } });
  assert.match(named, /대표 자사몰/); assert.match(named, /이름 미확인 계정 1개/); assert.doesNotMatch(named, /internal-store/);
});

test("table contains the required 16 columns, all products and a single final total", () => {
  const { filters, response } = fixture();
  response.products.push({ ...response.products[0], productKey: "last", productName: "마지막 <제품>", active: false, historical: true });
  response.totalProducts = 2;
  const report = buildDailyProductsReport(response, "2026-10-29", filters);
  const html = renderToStaticMarkup(<DailyProductsTable report={report} />);
  assert.equal((html.match(/class="daily-products-number-col"/g) ?? []).length, 15);
  assert.equal((html.match(/data-product-key=/g) ?? []).length, 3);
  assert.equal((html.match(/class="daily-products-total"/g) ?? []).length, 1);
  assert.match(html, /마지막 &lt;제품&gt;/); assert.match(html, /전체 2개 제품/);
  assert.match(html, /전일 2026-10-28/); assert.match(html, /\(\+50.0%\)/);
  assert.match(html, /제품 미귀속 금액/); assert.match(html, /미분류 매출/);
  assert.equal((html.match(/scope="colgroup"/g) ?? []).length, 5);
});

test("print filtering only annotates original rows and does not replace screen amounts or duplicate the table", () => {
  const { filters, response } = fixture();
  response.products.push({ ...response.products[0], productKey: "print-selected", productName: "출력 대상 제품" });
  response.totalProducts = 2;
  const report = buildDailyProductsReport(response, "2026-10-29", filters);
  const original = structuredClone(report);
  const printReport = { ...report, rows: report.rows.filter(row => row.productKey === "print-selected"),
    exportSelection: { platform: "COUPANG" as const, label: "쿠팡", totalProducts: 2, basis: "당일 판매·광고 활동 제품" } };
  const filtered = renderToStaticMarkup(<DailyProductsTable report={report} printReport={printReport} />);
  assert.equal((filtered.match(/<table\b/g) ?? []).length, 1);
  assert.equal((filtered.match(/data-product-key=/g) ?? []).length, 3);
  assert.match(filtered, /<tr(?=[^>]*data-product-key="p1")(?=[^>]*data-print-hidden="true")[^>]*>/);
  assert.doesNotMatch(filtered, /<tr(?=[^>]*data-product-key="print-selected")(?=[^>]*data-print-hidden="true")[^>]*>/);
  assert.match(filtered, /<tr(?=[^>]*class="daily-products-total")(?=[^>]*data-print-hidden="true")[^>]*>/);
  assert.match(filtered, /data-print-filtered="true" data-print-count="1"/);
  assert.match(filtered, /전체 2개 제품/);
  assert.match(filtered, /출력 제품 필터: 쿠팡 · 당일 판매·광고 활동 제품/);
  assert.match(filtered, /전체 제품 합계와 미귀속 조정을 포함하지 않습니다/);
  assert.match(filtered, /1,500/);
  assert.deepEqual(report, original);
  const unfiltered = renderToStaticMarkup(<DailyProductsTable report={report} />);
  assert.doesNotMatch(unfiltered, /data-print-hidden="true"/);
});
