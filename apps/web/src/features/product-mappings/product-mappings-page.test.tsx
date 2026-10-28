import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { authCoordinator } from "@/features/auth/auth-coordination";
import { ApiError } from "@/lib/api";
import { ProductMappingsPage } from "./product-mappings-page";
import { visibleNavGroups } from "@/components/app-shell";
import type { Configuration } from "./types";

after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());
const data: Configuration = { products: [{ id: "p", canonicalName: "제품 <A>", active: true, version: 3 }], rules: [{
  id: "r", kind: "NAME", productId: "p", platform: "CAFE24", scopeKey: null, validFrom: "2026-10-01", validTo: null, active: true, version: 2,
  payload: { matchType: "CONTAINS", terms: ["제품 <A>"] }
}], versions: { configurationVersion: "fixture" } };
function render(manage: boolean, error?: ApiError) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  if (error) client.getQueryCache().build(client, { queryKey: ["unified-configuration", "user"] }).setState({ status: "error", error, fetchStatus: "idle" });
  else client.setQueryData(["unified-configuration", "user"], data);
  const auth = { user: { id: "user" }, can: (permission: string) => permission === "data.read" || manage } as AuthContextValue;
  const html = renderToStaticMarkup(<AppRouterContext.Provider value={{} as AppRouterInstance}><QueryClientProvider client={client}><AuthContext.Provider value={auth}><ProductMappingsPage /></AuthContext.Provider></QueryClientProvider></AppRouterContext.Provider>);
  client.clear(); return html;
}
test("read-only page exposes existing rules and previews while hiding every save button", () => {
  const html = render(false);
  assert.match(html, /제품 &lt;A&gt;/);
  assert.match(html, /판정·영향 미리보기/);
  assert.match(html, /기존 이름 규칙 불러오기/);
  assert.match(html, /조회 범위에만 적용/);
  assert.doesNotMatch(html, /미리본 규칙 저장|제품 저장/);
  assert.doesNotMatch(html, /name="productNo"|name="externalId"/);
});
test("manager page requires a preview before saving and retains legacy routes", () => {
  const html = render(true);
  assert.match(html, /disabled="">미리본 규칙 저장/);
  assert.match(html, /disabled="">제품 저장/);
  for (const href of ["/mappings", "/settings/products", "/sales", "/google/mappings", "/coupang/products"]) assert.ok(html.includes(`href="${href}"`));
  assert.ok(visibleNavGroups(() => true).flatMap(g => g.items).some(i => i.href === "/products/mappings"));
});
test("disabled feature and permission responses have a recoverable page state", () => {
  assert.match(render(false, new ApiError(503, "통합 기능 비활성", "UNIFIED_PERFORMANCE_DISABLED")), /통합 기능 비활성/);
  assert.match(render(false, new ApiError(403, "forbidden")), /이 작업의 권한이 없습니다/);
  assert.match(render(false, new ApiError(503, "비활성")), /다시 조회/);
});
