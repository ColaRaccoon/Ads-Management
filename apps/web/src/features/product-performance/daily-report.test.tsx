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
