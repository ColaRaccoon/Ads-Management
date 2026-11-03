import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { authCoordinator } from "@/features/auth/auth-coordination";
import { DailyReportSheet, dailyChangeLabel, dailyReportFilters, dailyReportKey } from "./daily-report";
import { buildDailyReport } from "./daily-report-model";
import { testData, testFilters } from "./test-fixture";
after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());

function fixture() {
  const filters = testFilters({ productName: "베놈무릎보호대", scopeKeys: ["store-a"] });
  const data = testData(filters);
  data.timeseries.items = ["2026-10-28", "2026-10-29"].map((date, i) => ({ ...data.timeseries.items[0], date, bucketFrom: date, bucketTo: date,
    completeTotals: { ...data.timeseries.items[0].completeTotals, revenue: null, adSpend: null, estimatedProfit: null },
    knownTotals: { ...data.timeseries.items[0].knownTotals, revenue: i ? "1200000.49" : "1000000.01", adSpend: i ? "110000" : "100000", estimatedProfit: i ? "140000" : "100000" },
    byMedium: [{ medium: "META", adSpend: i ? "110000" : "100000", completeAdSpend: i ? "110000" : "100000", share: "100" }],
    byMarketplace: [{ marketplace: "CAFE24", revenue: i ? "1200000.49" : "1000000.01", completeRevenue: i ? "1200000.49" : "1000000.01", estimatedProfit: i ? "140000" : "100000" }] }));
  return { filters, data };
}

test("daily report prints selected date, exact preceding date, scope, integer KPIs and three required sections", () => {
  const { filters, data } = fixture();
  const html = renderToStaticMarkup(<DailyReportSheet data={data} date="2026-10-29" filters={filters} />);
  assert.match(html, /2026-10-29/); assert.match(html, /전일 비교 2026-10-28/);
  assert.match(html, /베놈무릎보호대/); assert.match(html, /1개 계정·스토어 선택/);
  assert.match(html, /1,200,000원/); assert.match(html, /140,000원/); assert.match(html, /110,000원/);
  assert.match(html, /\+20% · \+200,000원/); assert.match(html, /확인된 금액 기준/);
  assert.match(html, /판매처별 매출 · 이익/); assert.match(html, /광고 매체별 집행비/);
  assert.doesNotMatch(html, /1,200,000.49|산점도|svg|success|발행 계산 버전/);
});

test("native source mode explains stored final results and shows only selected-day KST source publication times", () => {
  const { filters, data } = fixture();
  data.summary.resultBasis = "NATIVE_FINAL";
  data.summary.issues.push("STOREFRONT_GOOGLE_SALES_MAY_OVERLAP");
  data.summary.asOfBySource = [
    { platform: "CAFE24", scopeKey: "internal-store-id", date: "2026-10-29", sourceAsOf: "2026-10-29T01:02:00Z", publishedAt: "2026-10-29T02:03:00Z", stale: true },
    { platform: "NAVER", scopeKey: "store", date: "2026-10-29", sourceAsOf: null, publishedAt: null, stale: false },
    { platform: "CAFE24", scopeKey: "previous", date: "2026-10-28", sourceAsOf: "2026-10-28T01:02:00Z", publishedAt: "2026-10-28T02:03:00Z", stale: false }
  ];
  const html = renderToStaticMarkup(<DailyReportSheet data={data} date="2026-10-29" filters={filters} />);
  assert.match(html, /저장된 플랫폼 원본 계산 결과/);
  assert.match(html, /원본자료 기준 2026-10-29 10:02 · 통합 발행 2026-10-29 11:03/);
  assert.match(html, /원본자료 기준 미확인 · 통합 발행 미확인/);
  assert.match(html, /이전 성공 자료/); assert.match(html, /구글 원본 매출과 겹칠 수/);
  assert.doesNotMatch(html, /2026-10-28 10:02|internal-store-id/);
  assert.match(html, /1,200,000원/); assert.match(html, /140,000원/);
});

test("manually requested missing day is never silently replaced by prior known data", () => {
  const { filters, data } = fixture();
  const html = renderToStaticMarkup(<DailyReportSheet data={data} date="2026-10-30" filters={filters} />);
  assert.match(html, /선택일 2026-10-30에 확인 가능한 금액이 없습니다/);
  assert.match(html, /당일 자료 없음/); assert.match(html, /전일 1,200,000원/);
  assert.doesNotMatch(html, /당일 금액.{0,15}0원/);
});

test("daily compact query contains exactly D and D−1 and retains product/platform/accounts", () => {
  const filters = testFilters({ scopeKeys: ["account"], productName: "exact-product", platforms: ["META", "CAFE24"] });
  const query = dailyReportFilters(filters, "2026-10-29");
  assert.equal(query.from, "2026-10-28"); assert.equal(query.to, "2026-10-29");
  assert.equal(query.compareFrom, "2026-10-28"); assert.equal(query.compareTo, "2026-10-28"); assert.equal(query.compareMode, "custom");
  assert.equal(query.productName, filters.productName); assert.deepEqual(query.scopeKeys, filters.scopeKeys); assert.deepEqual(query.platforms, filters.platforms);
  assert.notDeepEqual(dailyReportKey("user-a", query), dailyReportKey("user-b", query));
  assert.notDeepEqual(dailyReportKey("user-a", query), dailyReportKey("user-a", dailyReportFilters(filters, "2026-10-28")));
});

test("report status distinguishes missing, confirmed zero, partial zero and negative baseline", () => {
  const { data } = fixture();
  const value = buildDailyReport(data.timeseries.items, "2026-10-29").totals.revenue;
  assert.equal(dailyChangeLabel({ ...value, previous: null }), "전일 자료 없음");
  assert.equal(dailyChangeLabel({ ...value, previous: 0, previousState: "COMPLETE" }), "0원에서 증가");
  assert.equal(dailyChangeLabel({ ...value, previous: 0, previousState: "PARTIAL" }), "전일 기준 0원");
  assert.equal(dailyChangeLabel({ ...value, previous: -10 }), "전일 음수 · 증감액 비교");
});


test("printed report retains provisional and estimated-source labels", () => {
  const { filters, data } = fixture(); data.summary.provisional = true;
  const html = renderToStaticMarkup(<DailyReportSheet data={data} date="2026-10-29" filters={filters} />);
  assert.match(html, /잠정 자료 · 한국시간 오늘을 포함한 집계/);
  assert.match(html, /추정 데이터 포함/);
});


test("persisted split storefront rows render four channels with exact negative Youtube profit and no combined duplicate", () => {
  const { filters, data } = fixture();
  for (const bucket of data.timeseries.items) bucket.byMarketplace = [
    { marketplace: "CAFE24_META", revenue: "900000", completeRevenue: "900000", estimatedProfit: "2542448" },
    { marketplace: "CAFE24_YOUTUBE", revenue: "300000", completeRevenue: "300000", estimatedProfit: bucket.date === "2026-10-29" ? "-129169" : "100000" },
    { marketplace: "NAVER_SMARTSTORE", revenue: "100000", completeRevenue: "100000", estimatedProfit: "20000" },
    { marketplace: "COUPANG", revenue: "50000", completeRevenue: "50000", estimatedProfit: "5000" },
  ];
  const html = renderToStaticMarkup(<DailyReportSheet data={data} date="2026-10-29" filters={filters} />);
  assert.match(html, /자사몰\(메타\)/); assert.match(html, /자사몰\(유튜브\)/);
  assert.match(html, /2,542,448원/); assert.match(html, /-129,169원/);
  assert.match(html, /−229% · −229,169원/);
  assert.match(html, /네이버 스마트스토어/); assert.match(html, /쿠팡/);
  assert.doesNotMatch(html, /scope="row">자사몰 Cafe24/);
  assert.match(html, /integrated-daily-split/);
  // KPI remains the authoritative daily total; channel amounts are never added again in the UI.
  assert.match(html, /1,200,000원/); assert.match(html, /140,000원/);
});

test("mixed old/new publication dates show missing previous split values instead of comparing the old total", () => {
  const { filters, data } = fixture();
  data.timeseries.items[1].byMarketplace = [
    { marketplace: "CAFE24_META", revenue: "900000", completeRevenue: "900000", estimatedProfit: "100000" },
    { marketplace: "CAFE24_YOUTUBE", revenue: null, estimatedProfit: null },
  ];
  const html = renderToStaticMarkup(<DailyReportSheet data={data} date="2026-10-29" filters={filters} />);
  const match = html.match(/<th scope="row">자사몰\(메타\)<\/th>(.*?)<\/tr>/);
  assert.ok(match); assert.match(match[1], /전일 자료 없음/); assert.doesNotMatch(match[1], /\+\d+%/);
  assert.match(html, /자사몰\(유튜브\)<\/th>.*?전일·당일 자료 없음/);
});

test("old publications keep one combined Cafe24 row without fabricated split rows", () => {
  const { filters, data } = fixture();
  const html = renderToStaticMarkup(<DailyReportSheet data={data} date="2026-10-29" filters={filters} />);
  assert.match(html, /scope="row">자사몰 Cafe24/);
  assert.doesNotMatch(html, /자사몰\(메타\)|자사몰\(유튜브\)|integrated-daily-split/);
});

test("a current mixed-scope publication displays its remaining legacy amount as an independent fifth channel", () => {
  const { filters, data } = fixture();
  data.timeseries.items[1].byMarketplace = [
    { marketplace: "CAFE24_META", revenue: "900000", completeRevenue: "900000", estimatedProfit: "100000" },
    { marketplace: "CAFE24_YOUTUBE", revenue: "200000", completeRevenue: "200000", estimatedProfit: "-20000" },
    { marketplace: "CAFE24", revenue: "12345", completeRevenue: "12345", estimatedProfit: null },
  ];
  const html = renderToStaticMarkup(<DailyReportSheet data={data} date="2026-10-29" filters={filters} />);
  const legacy = html.match(/<th scope="row">자사몰\(이전집계\)<\/th>(.*?)<\/tr>/);
  assert.ok(legacy); assert.match(legacy[1], /12,345원/); assert.match(legacy[1], /집계 범위 변경 · 증감 비교 제외/);
  assert.doesNotMatch(legacy[1], /−99%|−1,187,655원/); assert.match(html, /integrated-daily-mixed/);
  assert.equal((html.match(/scope="row">자사몰/g) ?? []).length, 3);
  const meta = html.match(/<th scope="row">자사몰\(메타\)<\/th>(.*?)<\/tr>/)!;
  assert.match(meta[1], /전일 자료 없음/); assert.doesNotMatch(meta[1], /\+\d+%/);
  // The KPI remains the persisted total even while five channel rows are displayed.
  assert.match(html, /1,200,000원/);
});
