import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PerformanceKpis } from "./kpis";
import { ComparisonTable } from "./comparison-table";
import { PerformanceFilters } from "./filters";
import { authCoordinator } from "@/features/auth/auth-coordination";
import { PLATFORMS, type Envelope, type Filters, type Metric, type MetricComparison, type Options, type Totals } from "./types";

after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());

function fixture(): Envelope {
  const totals: Totals = { revenue: "9007199254740993.000001", adSpend: "2000000.000000", profitBeforeAds: "3000000.000000", estimatedProfit: "1000000.000000", mer: "4.5000000000" };
  const comparisons = Object.fromEntries((Object.keys(totals) as Metric[]).map(metric => [metric, {
    current: totals[metric], previous: "1000000.000000", change: "500000.000000", changePct: "50.0000000000", reason: null,
    currentDailyAverage: "50000.000000", previousDailyAverage: "25000.000000"
  }])) as Record<Metric, MetricComparison>;
  return {
    contractVersion: "product-performance-v1.1.0", snapshotHash: "fixture", knownTotals: { ...totals }, completeTotals: { ...totals }, productProfitSubtotal: "1000000.000000",
    byMarketplace: [], byMedium: [], unallocatedExpenses: [], unallocatedAdSpends: [], unclassifiedSales: [],
    scopeBalances: { unallocatedAdSpend: "0.000000", unallocatedExpense: "0.000000", shippingIncome: "0.000000", unallocatedShippingIncome: "0.000000", unclassifiedRevenue: "0.000000", unclassifiedProfitBeforeAds: "0.000000" },
    isEstimate: false, issues: [], selection: { selectedPlatforms: [...PLATFORMS], excludedPlatforms: [], scopeKeys: [], productName: "제품 A",
      from: "2026-10-20", to: "2026-10-26", compareFrom: "2026-10-13", compareTo: "2026-10-19", grain: "day", selectionHash: "fixture" },
    selectedPlatforms: [...PLATFORMS], excludedPlatforms: [], scopeLabel: "전체 플랫폼 기준", profitLabel: "제품 추정 순이익",
    metricAvailability: { state: "SALE_AND_AD", revenue: true, adSpend: true, profitBeforeAds: true, estimatedProfit: true, mer: true },
    versions: { calculationVersion: "unified-report-v1" }, latestConfigurationVersions: {}, requestedCalculationVersion: "unified-report-v1", asOfBySource: [], coverage: [], comparisonCoverage: [], warnings: [], provisional: false,
    comparison: { known: structuredClone(comparisons), complete: structuredClone(comparisons), previousByMarketplace: [], byMedium: [{ medium: "META", current: "900000.000000", previous: "600000.000000", change: "300000.000000", changePct: "50.0000000000", share: "45.0000000000", previousShare: "37.5000000000", shareChangePp: "7.5000000000", spendChangeContributionPp: "18.7500000000", reason: null }], currentDays: 7, previousDays: 7, unequalPeriods: false }
  };
}

test("KPI preserves API decimal precision and marks only incomplete numeric totals as partial", () => {
  const data = fixture();
  let html = renderToStaticMarkup(<PerformanceKpis data={data} />);
  assert.match(html, /9,007,199,254,740,993\.000001 원/);
  assert.match(html, /수치 계산 완료/);
  data.completeTotals.revenue = null;
  data.completeTotals.estimatedProfit = null;
  html = renderToStaticMarkup(<PerformanceKpis data={data} />);
  assert.match(html, /확인된 부분/);
  assert.match(html, /완전 합계 미확정/);
  assert.match(html, /부분 금액/);
});

test("accepted Naver estimate stays visible when numeric totals are complete", () => {
  const data = fixture(); data.isEstimate = true;
  const html = renderToStaticMarkup(<PerformanceKpis data={data} />);
  assert.match(html, /9,007,199,254,740,993\.000001 원/);
  assert.match(html, /추정 데이터 포함/);
  assert.match(html, /수치 계산 완료/);
  assert.doesNotMatch(html, /부분 금액/);
});

test("ad-only and empty selection never display source values as sale or profit totals", () => {
  const data = fixture();
  data.metricAvailability = { state: "AD_ONLY", revenue: false, adSpend: true, profitBeforeAds: false, estimatedProfit: false, mer: false };
  let html = renderToStaticMarkup(<PerformanceKpis data={data} />);
  assert.match(html, /해당 없음/);
  assert.doesNotMatch(html, /9,007,199,254,740,993/);
  data.metricAvailability = { state: "EMPTY_SELECTION", revenue: false, adSpend: false, profitBeforeAds: false, estimatedProfit: false, mer: false };
  data.selectedPlatforms = [];
  html = renderToStaticMarkup(<PerformanceKpis data={data} />);
  assert.match(html, /플랫폼을 선택하세요/);
  assert.doesNotMatch(html, /2,000,000 원|0 원/);
});

test("sale-only KPI does not describe a post-ad total profit", () => {
  const data = fixture(); data.selectedPlatforms = ["CAFE24"];
  data.metricAvailability = { state: "SALE_ONLY", revenue: true, adSpend: false, profitBeforeAds: true, estimatedProfit: true, mer: false };
  data.profitLabel = "선택 범위 광고 전 이익";
  const html = renderToStaticMarkup(<PerformanceKpis data={data} />);
  assert.match(html, /광고 전 이익/);
  assert.doesNotMatch(html, /제품 추정 순이익|전체 적용 광고비/);
});

test("comparison renders server amounts, ratio units, share and contribution percentage points", () => {
  const data = fixture(); data.comparison.unequalPeriods = true; data.comparison.previousDays = 14;
  const html = renderToStaticMarkup(<ComparisonTable data={data} />);
  for (const amount of ["900,000 원", "600,000 원", "300,000 원", "50,000 원", "25,000 원"]) assert.ok(html.includes(amount), amount);
  assert.match(html, /50(?:\.0+)?%/);
  assert.match(html, /45(?:\.0+)?%/);
  assert.match(html, /7\.5(?:0+)?\s*%p/);
  assert.match(html, /18\.75(?:0+)?\s*%p/);
  assert.match(html, /4\.5(?:0+)?배/);
  assert.match(html, /기간 길이가 다릅니다/);
  assert.match(html, /전기 일평균/);
});

test("comparison preserves zero-base and partial labels without inventing a percentage", () => {
  const data = fixture();
  data.comparison.complete.estimatedProfit.current = null;
  data.comparison.known.estimatedProfit = { current: "1000000.000000", previous: "-1000000.000000", change: "2000000.000000", changePct: null, reason: "NON_POSITIVE_PROFIT_BASE", currentDailyAverage: null, previousDailyAverage: null };
  data.comparison.byMedium[0] = { ...data.comparison.byMedium[0], previous: "0.000000", changePct: null, reason: "ZERO_BASE" };
  const html = renderToStaticMarkup(<ComparisonTable data={data} />);
  assert.match(html, /확인된 부분 기준/);
  assert.match(html, /신규 집행 · 전기 0/);
  assert.match(html, /2,000,000 원/);
  assert.doesNotMatch(html, /Infinity|NaN/);
});

test("filters preserve full and explicit empty scope selections and expose fixed-name options", () => {
  const data = fixture();
  const value: Filters = { from: "2026-10-20", to: "2026-10-26", compareFrom: "2026-10-13", compareTo: "2026-10-19", compareMode: "previous", grain: "day", platforms: [...PLATFORMS], productName: "제품 <A>" };
  const options = { ...data, products: [{ productName: "제품 <A>", active: true, historical: false }], scopes: [{ platform: "CAFE24", scopeKey: "store-A", label: "내 스토어" }], platformOptions: [], availableDateRanges: [], defaultSelection: { platforms: [...PLATFORMS], from: value.from, to: value.to } } as Options;
  let html = renderToStaticMarkup(<PerformanceFilters value={value} options={options} onChange={() => {}} />);
  assert.match(html, /제품 &lt;A&gt;/);
  assert.match(html, /추정 데이터 포함/);
  assert.match(html, /전체 플랫폼 기준/);
  assert.match(html, /내 스토어/);
  assert.equal((html.match(/type="checkbox" checked=""/g) ?? []).length, 7);
  html = renderToStaticMarkup(<PerformanceFilters value={{ ...value, platforms: [], scopeKeys: [] }} options={options} onChange={() => {}} />);
  assert.match(html, /플랫폼을 선택하세요/);
  assert.match(html, /계정·스토어를 선택하세요/);
  assert.equal((html.match(/type="checkbox" checked=""/g) ?? []).length, 0);
});

test("explicit account selection locks platform changes until scope metadata is available", () => {
  const value: Filters = { from: "2026-10-20", to: "2026-10-26", compareFrom: "2026-10-13", compareTo: "2026-10-19", compareMode: "previous", grain: "day", platforms: [...PLATFORMS], productName: "", scopeKeys: ["store-A"] };
  let html = renderToStaticMarkup(<PerformanceFilters value={value} options={undefined} onChange={() => {}} />);
  assert.match(html, /<fieldset disabled=""><legend>포함할 플랫폼/);
  assert.match(html, /플랫폼 정보를 불러온 뒤 플랫폼을 변경/);
  html = renderToStaticMarkup(<PerformanceFilters value={{ ...value, scopeKeys: undefined }} options={undefined} onChange={() => {}} />);
  assert.doesNotMatch(html, /<fieldset disabled/);
  assert.doesNotMatch(html, /플랫폼 정보를 불러온 뒤 플랫폼을 변경/);
});
