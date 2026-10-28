import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { authCoordinator } from "@/features/auth/auth-coordination";
import { BucketTooltip, PerformanceCharts } from "./charts";
import { diagnosticCounts, DiagnosticsPanel } from "./diagnostics";
import type { Availability, Bucket, Coverage, DashboardData, Envelope } from "./types";

after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());
const availability: Availability = { state: "SALE_AND_AD", revenue: true, adSpend: true, profitBeforeAds: true, estimatedProfit: true, mer: true };
function coverage(patch: Partial<Coverage> = {}): Coverage {
  return { sourceSystem: "NAVER", platform: "NAVER", scopeKey: "store", date: "2026-10-27", component: "SALE", participation: "INCLUDED", collectionState: "COMPLETE",
    rowsPresent: 1, zeroConfirmed: false, sourceAsOf: "2026-10-27T14:00:00Z", calculatedAt: "2026-10-27T15:00:00Z", lastSuccessAt: "2026-10-27T14:00:00Z",
    mappedRows: 1, unmappedRows: 0, unmatchedAmount: "0.000000", missingCostRows: 0, missingFxAmount: "0.000000", unallocatedAmount: "0.000000", isEstimate: true, issues: ["ESTIMATED"], ...patch };
}
function fixture(): DashboardData {
  const totals = { revenue: "9007199254740993.123456", adSpend: "10.000001", profitBeforeAds: "20.000000", estimatedProfit: "9.999999", mer: "3.0000000000" };
  const zero = { revenue: "0.000000", adSpend: "0.000000", profitBeforeAds: "0.000000", estimatedProfit: "0.000000", mer: null };
  const comparisons = Object.fromEntries(Object.keys(totals).map(key => [key, { current: totals[key as keyof typeof totals], previous: "0.000000", change: totals[key as keyof typeof totals], changePct: null, reason: "ZERO_BASE", currentDailyAverage: totals[key as keyof typeof totals], previousDailyAverage: "0.000000" }])) as Envelope["comparison"]["known"];
  const envelope: Envelope = { contractVersion: "product-performance-v1.1.0", snapshotHash: "snapshot",
    selection: { selectedPlatforms: ["NAVER"], excludedPlatforms: ["META", "GOOGLE", "COUPANG", "CAFE24"], scopeKeys: ["store"], productName: "제품 <A>", from: "2026-10-27", to: "2026-10-27", compareFrom: "2026-10-26", compareTo: "2026-10-26", grain: "day", selectionHash: "selection" },
    selectedPlatforms: ["NAVER"], excludedPlatforms: ["META", "GOOGLE", "COUPANG", "CAFE24"], scopeLabel: "선택 플랫폼 기준", profitLabel: "선택 범위 추정이익", metricAvailability: { ...availability },
    versions: { calculationVersion: "MIXED", nameRuleVersion: "old" }, latestConfigurationVersions: { nameRuleVersion: "new" }, requestedCalculationVersion: "unified-report-v1",
    asOfBySource: [{ platform: "NAVER", scopeKey: "store", date: "2026-10-27", publishedAt: "2026-10-27T15:00:00Z", sourceAsOf: "2026-10-27T14:00:00Z", stale: false }],
    coverage: [coverage()], comparisonCoverage: [coverage({ date: "2026-10-26", collectionState: "NOT_COLLECTED", rowsPresent: 0, isEstimate: false, issues: [] })], warnings: ["CONFIGURATION_CHANGED_REBUILD_RECOMMENDED"], provisional: false,
    comparison: { known: comparisons, complete: comparisons, byMedium: [], previousByMarketplace: [{ marketplace: "NAVER_SMARTSTORE", revenue: "0.000000" }], currentDays: 1, previousDays: 1, unequalPeriods: false },
    knownTotals: { ...totals }, completeTotals: { ...totals }, productProfitSubtotal: totals.estimatedProfit,
    byMarketplace: [{ marketplace: "NAVER_SMARTSTORE", revenue: totals.revenue }], byMedium: [{ medium: "NAVER_DA", adSpend: totals.adSpend, share: "100.0000000000" }],
    unallocatedExpenses: [], unallocatedAdSpends: [], unclassifiedSales: [], scopeBalances: { unallocatedAdSpend: "0.000000", unallocatedExpense: "0.000000", shippingIncome: "0.000000", unallocatedShippingIncome: "0.000000", unclassifiedRevenue: "0.000000", unclassifiedProfitBeforeAds: "0.000000" }, isEstimate: true, issues: [] };
  const bucket: Bucket = { ...envelope, date: "2026-10-27", bucketFrom: "2026-10-27", bucketTo: "2026-10-27", partial: false };
  return { summary: { ...envelope, items: [], total: 0, nextCursor: null }, timeseries: { ...envelope, items: [bucket, { ...bucket, date: "2026-10-28", bucketFrom: "2026-10-28", bucketTo: "2026-10-28", knownTotals: { ...zero }, completeTotals: { ...zero } }], total: 2, nextCursor: null },
    diagnostics: { ...envelope, items: [{ ...coverage(), controlTotals: [{ currency: "USD", measure: "AD_SPEND", selectedAmount: "12.123456", assignedAmount: "10.123456", unmatchedAmount: "1.000000", unallocatedAmount: "1.000000", difference: "0.000000" }] }], total: 500, nextCursor: "next" } };
}

test("exact tooltip shows accepted estimates and distinguishes a missing complete amount from a partial amount", () => {
  const bucket = fixture().timeseries.items[0];
  bucket.completeTotals.revenue = null;
  const html = renderToStaticMarkup(<BucketTooltip bucket={bucket} availability={availability} />);
  assert.match(html, /추정 데이터 포함/);
  assert.match(html, /확인된 부분 금액 9,007,199,254,740,993\.123456 원/);
  assert.match(html, /10\.000001 원/);
  assert.match(html, /100%/);
  assert.doesNotMatch(html, /9007199254740992/);
});

test("ad-only tooltip uses not-applicable labels and sale-only uses the server profit label", () => {
  const bucket = fixture().timeseries.items[0];
  const adOnly = renderToStaticMarkup(<BucketTooltip bucket={bucket} availability={{ ...availability, state: "AD_ONLY", revenue: false, profitBeforeAds: false, estimatedProfit: false, mer: false }} />);
  assert.match(adOnly, /매출: 해당 없음/); assert.match(adOnly, /MER: 해당 없음/);
  const saleOnly = renderToStaticMarkup(<BucketTooltip bucket={bucket} availability={{ ...availability, state: "SALE_ONLY", adSpend: false, mer: false }} profitLabel="선택 범위 광고 전 이익" />);
  assert.match(saleOnly, /선택 범위 광고 전 이익/); assert.doesNotMatch(saleOnly, /추정이익:/);
});

test("chart data table and seller composition preserve unsafe monetary strings and confirmed zero", () => {
  const html = renderToStaticMarkup(<PerformanceCharts data={fixture()} />);
  assert.match(html, /안전한 숫자 범위/);
  assert.match(html, /9,007,199,254,740,993\.123456 원/);
  assert.match(html, /0 원 \/ 0 원/);
  assert.match(html, /차트 범례 · 계열 표시만 변경 \(합계·비중 분모 유지\)/);
  assert.match(html, /전기 확인 매출/);
});

test("diagnostic summary deduplicates inherited cost gaps, ignores excluded rows, and distinguishes confirmed zero from missing", () => {
  const rows = [coverage({ missingCostRows: 4, unmappedRows: 2 }), coverage({ component: "DIRECT_COST", missingCostRows: 4, unmappedRows: 2 }),
    coverage({ date: "2026-10-26", component: "AD_SPEND", collectionState: "NOT_COLLECTED" }), coverage({ date: "2026-10-25", zeroConfirmed: true, rowsPresent: 0 }),
    coverage({ date: "2026-10-24", participation: "EXCLUDED_BY_USER", missingCostRows: 20, collectionState: "NOT_COLLECTED" })];
  assert.deepEqual(diagnosticCounts(rows), { missingCost: 4, unmapped: 2, missingDates: ["2026-10-26"], stale: 0 });
});

test("diagnostics retain pagination limits, published-versus-current versions, Naver caveat and control currency", () => {
  const html = renderToStaticMarkup(<DiagnosticsPanel data={fixture()} />);
  assert.match(html, /진단 자료 1 \/ 500행 조회/);
  assert.match(html, /비교기간 진단:.*수집 누락 1일/);
  assert.match(html, /12\.123456 USD/); assert.doesNotMatch(html, /12\.123456 원/);
  assert.match(html, /MIXED/); assert.match(html, />old</); assert.match(html, />new</);
  assert.match(html, /네이버는 기존 저장 결과·계산 규칙의 추정 데이터/);
  assert.match(html, /선택 제품에 귀속된 비용이 아닙니다/);
});
test("missing FX amounts remain in source currency and are never labeled as converted KRW", () => {
  const data = fixture();
  data.diagnostics.items[0].missingFxAmount = "7.123456";
  const html = renderToStaticMarkup(<DiagnosticsPanel data={data} />);
  assert.match(html, /환율 누락 원금액 \(원천통화\)/);
  assert.match(html, /7\.123456 USD/); assert.doesNotMatch(html, /7\.123456 원/);
});
