import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { authCoordinator } from "@/features/auth/auth-coordination";
after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());
import { ChangeAnalysis, changeAnalysisView } from "./change-analysis";
import { analyzeChanges } from "./change-analysis-model";
import { shiftDate } from "./model";
import { testData, testFilters } from "./test-fixture";

function fixture() {
  const filters = testFilters({ from: "2026-10-01", to: "2026-10-28", productName: "" });
  const data = testData(filters);
  data.timeseries.items = Array.from({ length: 28 }, (_, i) => {
    const date = shiftDate(filters.from, i), after = date >= "2026-10-14";
    return { ...data.timeseries.items[0], date, bucketFrom: date, bucketTo: date, partial: false,
      byMedium: [{ medium: "META", adSpend: after ? "130.123456" : "100.123456", completeAdSpend: after ? "130.123456" : "100.123456", share: "100" }],
      byMarketplace: [{ marketplace: "CAFE24", revenue: "1000.123456", completeRevenue: after ? "1180.123456" : "1000.123456", estimatedProfit: null, profitUnavailableReason: "CROSS_MARKET_AD_ALLOCATION_UNKNOWN" },
        { marketplace: "NAVER_SMARTSTORE", revenue: "1000", completeRevenue: after ? "1120" : "1000", estimatedProfit: after ? "300" : "200" },
        { marketplace: "COUPANG", revenue: "1000", completeRevenue: after ? "960" : "1000", estimatedProfit: after ? "180" : "200" }] };
  });
  return { data, filters };
}

test("operator view renders real marketplace changes with integer units and honest allocation status", () => {
  const { data, filters } = fixture();
  const html = renderToStaticMarkup(<ChangeAnalysis data={data} filters={filters} />);
  assert.match(html, /판매처별로 얼마나 달라졌을까/);
  assert.match(html, /\+18%/); assert.match(html, /\+180원/);
  assert.match(html, /네이버/); assert.match(html, /\+50%/);
  assert.match(html, /전후 자료 없음/);
  assert.doesNotMatch(html, /1000\.123456|100\.123456|산점도|상관계수/);
});

test("incomplete windows expose per-cell coverage instead of zero-filled results", () => {
  const { data, filters } = fixture();
  data.timeseries.items = data.timeseries.items.filter(row => row.date === "2026-10-14");
  const html = renderToStaticMarkup(<ChangeAnalysis data={data} filters={filters} />);
  assert.match(html, /전0\/후1일/);
  assert.match(html, /변경 전 — · 변경 후/);
  assert.match(html, /각 항목에 확인된 금액이 있는 날의 평균/);
  assert.doesNotMatch(html, /\+18%/);
});

test("partial known Cafe24 profit remains visible despite one source or historical allocation issue", () => {
  const { data, filters } = fixture();
  for (const row of data.timeseries.items) {
    const own = row.byMarketplace.find(m => m.marketplace === "CAFE24")!;
    own.display = {
      revenue: { value: own.completeRevenue!, state: "COMPLETE", availableSources: ["CAFE24"], missingSources: [] },
      estimatedProfit: { value: row.date < "2026-10-14" ? "200" : "250", state: "PARTIAL", availableSources: ["CAFE24", "META"], missingSources: ["GOOGLE"] },
      adSpend: { value: "100", state: "PARTIAL", availableSources: ["META"], missingSources: ["GOOGLE"] },
    };
  }
  const html = renderToStaticMarkup(<ChangeAnalysis data={data} filters={filters} />);
  assert.match(html, /\+25%/); assert.match(html, /\+50원/);
  assert.match(html, /확인된 금액 · 전7\/후7일/);
  assert.match(html, /확인된 금액 · Google 광고/);
  assert.doesNotMatch(html, /배분 기준 확인 필요/);
});

test("week or month buckets cannot masquerade as daily change analysis", () => {
  const { data, filters } = fixture();
  const html = renderToStaticMarkup(<ChangeAnalysis data={data} filters={{ ...filters, grain: "week" }} />);
  assert.match(html, /일별 자료가 필요합니다/);
  assert.doesNotMatch(html, /판매처별로 얼마나/);
});


test("single Google selection automatically chooses a covered comparison date and exposes partial days", () => {
  const { data } = fixture();
  const filters = testFilters({ from: "2026-09-30", to: "2026-10-29", productName: "", platforms: ["GOOGLE", "CAFE24"] });
  data.summary.selectedPlatforms = filters.platforms;
  data.timeseries.items = Array.from({ length: 30 }, (_, i) => {
    const date = shiftDate(filters.from, i), value = date >= "2026-10-20" && date !== "2026-10-24" ? "100" : null;
    return { ...data.timeseries.items[0], date, bucketFrom: date, bucketTo: date,
      byMedium: [{ medium: "GOOGLE", adSpend: value, completeAdSpend: value, share: null }] };
  });
  const html = renderToStaticMarkup(<ChangeAnalysis data={data} filters={filters} />);
  assert.match(html, /value="2026-10-23"/);
  assert.match(html, /자동 조정: 2026-10-14 → 2026-10-23/);
  assert.match(html, /전3\/후6일 확보/);
  assert.match(html, /실제 광고비 변경일을 감지한 결과가 아닙니다/);
  assert.doesNotMatch(html, /비교 불가/);
});

function splitFixture() {
  const f = fixture();
  for (const bucket of f.data.timeseries.items) {
    const after = bucket.date >= "2026-10-14";
    bucket.byMarketplace = [{ marketplace: "CAFE24_META", revenue: after ? "1200" : "1000", completeRevenue: after ? "1200" : "1000", estimatedProfit: after ? "300" : "200" },
      { marketplace: "CAFE24_YOUTUBE", revenue: after ? "250" : "200", completeRevenue: after ? "250" : "200", estimatedProfit: after ? "-50" : "100" },
      ...bucket.byMarketplace.filter(row => row.marketplace !== "CAFE24")];
  }
  return f;
}
const analysisOptions = { medium: "META" as const, changeDate: "2026-10-14", windowDays: 7, lagDays: 0 };
test("split channels remain visible in result cells, graph indices, and CSV source rows", () => {
  const { data, filters } = splitFixture();
  const html = renderToStaticMarkup(<ChangeAnalysis data={data} filters={filters} />);
  assert.match(html, /자사몰\(메타\)/); assert.match(html, /자사몰\(유튜브\)/);
  assert.match(html, /−150%/); assert.doesNotMatch(html, /자사몰\(이전집계\)/);
  const analysis = analyzeChanges(data.timeseries.items, analysisOptions);
  const view = changeAnalysisView(analysis, filters.platforms, "revenue", "Meta");
  assert.deepEqual(view.channels.map(row => row.id), ["CAFE24_META", "CAFE24_YOUTUBE", "NAVER_SMARTSTORE", "COUPANG"]);
  const day = view.graphRows.find(row => row.date === "2026-10-14")!;
  assert.equal(day.CAFE24_META, 120); assert.equal(day.CAFE24_YOUTUBE, 125);
  assert.equal(view.rawRows.find(row => row.label === "자사몰(유튜브) 추정 순이익")!.value.change, -150);
  assert.equal(changeAnalysisView(analysis, ["META"], "revenue", "Meta").channels.length, 0);
});

test("old before and split after retain exact independent keys without invented cross-version deltas", () => {
  const { data, filters } = splitFixture();
  for (const bucket of data.timeseries.items.filter(row => row.date < "2026-10-14")) bucket.byMarketplace = [
    { marketplace: "CAFE24", revenue: "1200", completeRevenue: "1200", estimatedProfit: "300" }];
  const analysis = analyzeChanges(data.timeseries.items, analysisOptions);
  const view = changeAnalysisView(analysis, filters.platforms, "revenue", "Meta");
  const meta = view.results.find(row => row.id === "CAFE24_META")!.value!;
  const legacy = view.results.find(row => row.id === "CAFE24")!.value!;
  assert.equal(meta.revenue.before, null); assert.equal(meta.revenue.after, 1200); assert.equal(meta.revenue.change, null);
  assert.equal(legacy.revenue.before, 1200); assert.equal(legacy.revenue.after, null); assert.equal(legacy.revenue.change, null);
  assert.equal(view.graphRows.find(row => row.date === "2026-10-14")!.CAFE24_META, null);
  assert.equal(view.graphRows.find(row => row.date === "2026-10-14")!.CAFE24, null);
  assert.equal(view.rawRows.find(row => row.label === "자사몰(메타) 매출")!.value.changePct, null);
  const html = renderToStaticMarkup(<ChangeAnalysis data={data} filters={filters} />);
  assert.match(html, /자사몰\(이전집계\)/); assert.match(html, /변경 전 자료 없음/); assert.match(html, /변경 후 자료 없음/);
});

test("combined historical publications retain one Cafe24 row and mixed scope values remain visible", () => {
  const legacy = fixture();
  const oldView = changeAnalysisView(analyzeChanges(legacy.data.timeseries.items, analysisOptions), legacy.filters.platforms, "revenue", "Meta");
  assert.equal(oldView.channels[0].name, "자사몰"); assert.equal(oldView.channels.length, 3);
  const { data, filters } = splitFixture();
  for (const bucket of data.timeseries.items) bucket.byMarketplace.push({ marketplace: "CAFE24", revenue: "111", completeRevenue: "111", estimatedProfit: null });
  const view = changeAnalysisView(analyzeChanges(data.timeseries.items, analysisOptions), filters.platforms, "revenue", "Meta");
  assert.equal(view.channels.length, 5);
  assert.equal(view.rawRows.find(row => row.label === "자사몰(이전집계) 매출")!.value.after, 111);
  assert.equal(view.graphRows[0].CAFE24, null);
  assert.equal(view.graphRows[0].CAFE24Raw, 111);
  assert.equal(view.rawRows.find(row => row.label === "자사몰(이전집계) 매출")!.value.change, null);
  assert.equal(view.rawRows.find(row => row.label === "자사몰(이전집계) 매출")!.value.comparisonIssue, "STOREFRONT_SCOPE_CHANGED");
});
