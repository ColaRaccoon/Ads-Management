// Called only by the loopback stage08 HTTP fixture with the web tsconfig.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadDashboard, dashboardKey, effectiveFilters, changeFilters, parseFilters, filterParams, money } from "../apps/web/src/features/product-performance/model";
import { PLATFORMS, type Filters, type Options } from "../apps/web/src/features/product-performance/types";
import { PerformanceKpis } from "../apps/web/src/features/product-performance/kpis";
import { ComparisonTable } from "../apps/web/src/features/product-performance/comparison-table";
import { BucketTooltip } from "../apps/web/src/features/product-performance/charts";
import { chartRows } from "../apps/web/src/features/product-performance/chart-model";
import { authCoordinator } from "../apps/web/src/features/auth/auth-coordination";

const base = process.env.UNIFIED_STAGE08_HTTP_BASE;
assert(base && /^http:\/\/127\.0\.0\.1:\d+\/api$/.test(base), "Only the test HTTP loopback endpoint is allowed.");
const read = async <T,>(path: string) => {
  const response = await fetch(base + path, { headers: { "x-fixture-role": "VIEWER" } });
  assert.equal(response.status, 200); return await response.json() as T;
};
const original: Filters = { from: "2026-10-26", to: "2026-10-26", compareFrom: "2026-10-19", compareTo: "2026-10-19",
  compareMode: "custom", grain: "day", platforms: [...PLATFORMS], productName: "정확 금액 <검토제품>" };
async function main() { try {
  const keys = new Set<string>();
  for (let mask = 0; mask < 32; mask++) {
    const platforms = PLATFORMS.filter((_, index) => mask & (1 << index));
    const filters = { ...original, platforms };
    keys.add(JSON.stringify(dashboardKey("fixture:read-only", filters)));
    const data = await loadDashboard(filters, read);
    const cards = renderToStaticMarkup(<PerformanceKpis data={data.summary} />);
    const table = renderToStaticMarkup(<ComparisonTable data={data.summary} />);
    const tooltip = renderToStaticMarkup(<BucketTooltip bucket={data.timeseries.items[0]} />);
    for (const metric of ["revenue", "adSpend", "profitBeforeAds", "estimatedProfit"] as const) {
      const amount = data.summary.completeTotals[metric];
      if (amount !== null) {
        assert(cards.includes(money(amount)), `card mask ${mask} ${metric}`);
        assert(table.includes(money(amount)), `table mask ${mask} ${metric}`);
        assert(tooltip.includes(money(amount)), `tooltip mask ${mask} ${metric}`);
      }
    }
    if (platforms.includes("NAVER")) assert(cards.includes("추정 데이터 포함") && tooltip.includes("추정 데이터 포함"));
    if (!platforms.length) assert(cards.includes("플랫폼을 선택하세요") && !cards.includes("0 원"));
    if (platforms.length === 1 && platforms[0] === "CAFE24") assert(cards.includes("선택 범위 광고 전 이익") && !cards.includes("추정 순이익"));
    if (platforms.length && platforms.every(platform => ["META", "GOOGLE"].includes(platform))) assert(cards.includes("해당 없음"));
  }
  assert.equal(keys.size, 32);
  const options = await read<Options>(`/unified-performance/options?${filterParams(original)}`);
  const scoped = { ...original, scopeKeys: options.scopes.filter(scope => ["NAVER", "CAFE24"].includes(scope.platform)).map(scope => scope.scopeKey).sort() };
  const scopedBefore = await loadDashboard(scoped, read);
  const off = changeFilters(scoped, { ...scoped, platforms: original.platforms.filter(platform => platform !== "NAVER") }, options.scopes);
  const offData = await loadDashboard(off, read); assert.equal(offData.summary.knownTotals.revenue, "1000.123456");
  const roundTrip = parseFilters(filterParams(off, true));
  const restored = changeFilters(roundTrip, { ...roundTrip, platforms: original.platforms }, options.scopes.filter(scope => scope.platform !== "NAVER"));
  const restoredData = await loadDashboard(restored, read);
  assert.deepEqual(restoredData.summary.knownTotals, scopedBefore.summary.knownTotals);
  assert.deepEqual(restoredData.summary.selection.scopeKeys, scopedBefore.summary.selection.scopeKeys);
  const data = await loadDashboard({ ...original, from: "2026-10-25", to: "2026-10-27", platforms: ["CAFE24"] }, read);
  const rows = chartRows(data.timeseries.items, []);
  assert.deepEqual(rows.map(row => row.revenue), [0, 1000.123456, null]);
  assert.equal(data.summary.completeTotals.revenue, null);
  const partialCards = renderToStaticMarkup(<PerformanceKpis data={data.summary} />);
  assert(partialCards.includes("확인된 부분") && partialCards.includes("1,000.123456 원"));
  const wide = await loadDashboard({ ...original, from: "2026-07-01", platforms: ["CAFE24"] }, read);
  assert.equal(wide.timeseries.items.length, wide.timeseries.total);
  // API diagnostics stay paginated and must be marked/read as a page if not eagerly collected.
  assert(wide.diagnostics.items.length === wide.diagnostics.total || wide.diagnostics.nextCursor !== null);
  assert.deepEqual(effectiveFilters({ ...original, compareMode: "week" }).compareFrom, "2026-10-19");
  assert.equal(effectiveFilters({ ...original, from: "2026-10-20", compareMode: "previous" }).compareFrom, "2026-10-13");
  console.log(JSON.stringify({ status: "PASS", selections: 32, renderedComponents: ["PerformanceKpis", "ComparisonTable", "BucketTooltip"],
    coordinates: "complete zero / exact known amount / missing null", timeSeriesPages: wide.timeseries.items.length, diagnosticsTotal: wide.diagnostics.total }));
} finally { (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close(); } }
void main().catch(error => { console.error(error); process.exitCode = 1; });
