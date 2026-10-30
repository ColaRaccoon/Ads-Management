import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { authCoordinator } from "@/features/auth/auth-coordination";
import { ApiError } from "@/lib/api";
import { visibleNavGroups } from "@/components/app-shell";
import { ProductPerformancePage } from "./product-performance-page";
import { dashboardKey, filterParams } from "./model";
import { testData, testFilters, testOptions } from "./test-fixture";
import type { Filters } from "./types";
after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());

function render(f = testFilters(), state: "ready" | "loading" | "error" | "none" | "stale-selection" = "ready", error?: ApiError, can = true, params?: URLSearchParams) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const identity = "user:data.read", key = dashboardKey(identity, f);
  const optionsQuery = filterParams({ ...f, scopeKeys: undefined }).toString();
  // Keep the seeded SSR cache fresh; production staleTime=0 otherwise optimistically refetches on mount.
  const fresh = { updatedAt: Date.now() + 60000 };
  client.setQueryData(["product-performance-options", identity, optionsQuery], testOptions(f), fresh);
  if (state === "ready" || state === "none" || state === "stale-selection") {
    const data = testData(f);
    if (state === "none") {
      for (const metric of Object.keys(data.summary.knownTotals) as Array<keyof typeof data.summary.knownTotals>) {
        data.summary.knownTotals[metric] = null; data.summary.completeTotals[metric] = null;
      }
    }
    if (state === "stale-selection") data.summary.selection.productName = "이전 제품";
    client.setQueryData(key, data, fresh);
  }
  if (state === "error") client.getQueryCache().build(client, { queryKey: key }).setState({ status: "error", error, fetchStatus: "idle" });
  const auth = { user: { id: "user" }, permissions: ["data.read"], can: () => can } as unknown as AuthContextValue;
  const html = renderToStaticMarkup(<AppRouterContext.Provider value={{} as AppRouterInstance}><PathnameContext.Provider value="/products/performance"><SearchParamsContext.Provider value={params ?? filterParams(f, true)}><QueryClientProvider client={client}><AuthContext.Provider value={auth}><ProductPerformancePage /></AuthContext.Provider></QueryClientProvider></SearchParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider>);
  client.clear(); return html;
}
test("production page composes real query keys, exact cards, tables and diagnostics for a read-only user", () => {
  const html = render();
  assert.match(html, /1,234.123456 원/); assert.match(html, /기간 변화 비교/); assert.match(html, /데이터 진단과 계산 기준/);
  assert.match(html, /제품 &lt;A&gt;/); assert.match(html, /추정 데이터 포함/);
  assert.doesNotMatch(html, /제품 저장|규칙 저장|재집계 등록/);
  const nav = visibleNavGroups(() => true).flatMap(g => g.items);
  for (const href of ["/products/performance", "/products/mappings", "/storefront", "/dashboard", "/google/dashboard", "/coupang/dashboard"]) assert.ok(nav.some(item => item.href === href));
  assert.equal(visibleNavGroups(() => false).length, 0);
});
test("empty platforms or explicit empty accounts display a selection prompt with no previous KPI", () => {
  for (const f of [testFilters({ platforms: [] }), testFilters({ scopeKeys: [] })]) {
    const html = render(f);
    assert.match(html, /선택하세요/); assert.doesNotMatch(html, /제품 성과 요약|1,234.123456 원/);
  }
});
test("loading, disabled feature, forbidden scope and missing published data remain distinct", () => {
  assert.match(render(testFilters(), "loading"), /성과와 발행 버전을 확인/);
  assert.match(render(testFilters(), "error", new ApiError(503, "off", "UNIFIED_PERFORMANCE_DISABLED")), /아직 활성화되지 않았습니다/);
  assert.match(render(testFilters(), "error", new ApiError(403, "forbidden")), /권한 또는 허용된 계정/);
  assert.match(render(testFilters(), "none"), /확인 가능한 발행 데이터가 없습니다/);
  assert.doesNotMatch(render(testFilters(), "error", new ApiError(503, "failed")), /1,234.123456 원/);
});
test("permission denial, malformed URL and mismatched selection never render cached monetary data", () => {
  assert.doesNotMatch(render(testFilters(), "ready", undefined, false), /제품 성과 요약|1,234.123456 원/);
  assert.doesNotMatch(render(testFilters(), "stale-selection"), /제품 성과 요약|1,234.123456 원/);
  const html = render(testFilters(), "ready", undefined, true, new URLSearchParams('platforms=["UNKNOWN"]'));
  assert.match(html, /URL의 조회 조건이 올바르지 않습니다/);
  assert.doesNotMatch(html, /제품 성과 요약|1,234.123456 원/);
});
