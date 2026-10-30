import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { authCoordinator } from "@/features/auth/auth-coordination";
after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());
import { ChangeAnalysis } from "./change-analysis";
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
  assert.match(html, /배분 기준 확인 필요/);
  assert.doesNotMatch(html, /1000\.123456|100\.123456|산점도|상관계수/);
});

test("incomplete windows expose per-cell coverage instead of zero-filled results", () => {
  const { data, filters } = fixture();
  data.timeseries.items = data.timeseries.items.filter(row => row.date >= "2026-10-14");
  const html = renderToStaticMarkup(<ChangeAnalysis data={data} filters={filters} />);
  assert.match(html, /전 0 \/ 7일 · 후 7 \/ 7일 확보/);
  assert.match(html, /비교할 완전한 일별 입력이 없습니다/);
  assert.match(html, /확보된 날의 평균/);
  assert.doesNotMatch(html, /\+18%/);
});

test("week or month buckets cannot masquerade as daily change analysis", () => {
  const { data, filters } = fixture();
  const html = renderToStaticMarkup(<ChangeAnalysis data={data} filters={{ ...filters, grain: "week" }} />);
  assert.match(html, /일별 자료가 필요합니다/);
  assert.doesNotMatch(html, /판매처별로 얼마나/);
});
