import { effectiveFilters } from "./model";
import { PLATFORMS, type DashboardData, type Envelope, type Filters, type Metric, type MetricComparison, type Options, type Totals } from "./types";

export function testFilters(next: Partial<Filters> = {}): Filters {
  return effectiveFilters({ from: "2026-10-20", to: "2026-10-26", compareFrom: "", compareTo: "", compareMode: "previous",
    platforms: [...PLATFORMS], productName: "제품 <A>", grain: "day", ...next });
}
export function testEnvelope(filters = testFilters(), snapshotHash = "snapshot"): Envelope {
  const totals: Totals = { revenue: "1234.123456", adSpend: "100.000000", profitBeforeAds: "500.000000", estimatedProfit: "400.000000", mer: "12.3412345600" };
  const comparison = Object.fromEntries((Object.keys(totals) as Metric[]).map(metric => [metric, { current: totals[metric], previous: totals[metric], change: "0.000000", changePct: "0.0000000000", reason: null, currentDailyAverage: totals[metric], previousDailyAverage: totals[metric] }])) as Record<Metric, MetricComparison>;
  return { contractVersion: "product-performance-v1.1.0", snapshotHash, selection: { selectedPlatforms: filters.platforms,
    excludedPlatforms: PLATFORMS.filter(p => !filters.platforms.includes(p)), scopeKeys: filters.scopeKeys ?? [], productName: filters.productName || null,
    from: filters.from, to: filters.to, compareFrom: filters.compareFrom, compareTo: filters.compareTo, grain: filters.grain, selectionHash: "selection" },
    selectedPlatforms: filters.platforms, excludedPlatforms: PLATFORMS.filter(p => !filters.platforms.includes(p)), scopeLabel: "선택 플랫폼 합계", profitLabel: "선택 범위 추정이익",
    metricAvailability: { state: "SALE_AND_AD", revenue: true, adSpend: true, profitBeforeAds: true, estimatedProfit: true, mer: true },
    knownTotals: { ...totals }, completeTotals: { ...totals }, productProfitSubtotal: "400.000000", byMarketplace: [{ marketplace: "CAFE24", revenue: totals.revenue }],
    byMedium: [{ medium: "META", adSpend: totals.adSpend, share: "100.0000000000" }], unallocatedExpenses: [], unallocatedAdSpends: [], unclassifiedSales: [],
    scopeBalances: { unallocatedAdSpend: "0.000000", unallocatedExpense: "0.000000", shippingIncome: "0.000000", unallocatedShippingIncome: "0.000000", unclassifiedRevenue: "0.000000", unclassifiedProfitBeforeAds: "0.000000" },
    isEstimate: true, issues: [], versions: { calculationVersion: "unified-report-v1" }, latestConfigurationVersions: {}, requestedCalculationVersion: "unified-report-v1", asOfBySource: [],
    coverage: [], comparisonCoverage: [], warnings: [], provisional: false,
    comparison: { known: comparison, complete: structuredClone(comparison), byMedium: [], previousByMarketplace: [{ marketplace: "CAFE24", revenue: totals.revenue }], currentDays: 7, previousDays: 7, unequalPeriods: false } };
}
export function testData(filters = testFilters()): DashboardData {
  const e = testEnvelope(filters);
  return { summary: { ...e, items: [], total: 0, nextCursor: null },
    timeseries: { ...e, items: [{ ...e, date: filters.from, bucketFrom: filters.from, bucketTo: filters.to, partial: true }], total: 1, nextCursor: null },
    diagnostics: { ...e, items: [], total: 0, nextCursor: null } };
}
export function testOptions(filters = testFilters()): Options {
  return { ...testEnvelope({ ...filters, productName: "", scopeKeys: undefined }), products: [{ productName: "제품 <A>", active: true, historical: false }], scopes: [], platformOptions: [], availableDateRanges: [],
    defaultSelection: { platforms: [...PLATFORMS], from: filters.from, to: filters.to } };
}
