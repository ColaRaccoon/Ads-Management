import test, { after } from "node:test";
import { authCoordinator } from "@/features/auth/auth-coordination";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceProductMappings, sourceLinkDraft, sourceLinkRules, SOURCE_GROUPS, type SourceProduct } from "./source-product-mappings";
import type { Rule } from "./types";

after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());

test("source-link draft preserves the selected platform, exact original name, scope, dates and optimistic edit version", () => {
  for (const group of Object.keys(SOURCE_GROUPS) as (keyof typeof SOURCE_GROUPS)[]) {
    const draft = sourceLinkDraft(group, "베놈공용 2개입", "shop", "venom", "2026-10-01", "2026-10-31", "제품 통합");
    assert.equal(draft.platform, SOURCE_GROUPS[group].platform); assert.equal(draft.scopeKey, "shop");
    assert.deepEqual(draft.payload, { matchType: "EXACT", terms: ["베놈공용 2개입"], nameField: `native:${group}` });
    const rule = { ...draft, id: "link", version: 4 } as Rule;
    assert.equal(sourceLinkDraft(group, "베놈공용 2개입", "shop", "other", draft.validFrom, "", "수정", rule).expectedVersion, 4);
    assert.deepEqual(sourceLinkRules([rule], group, "shop", "  베놈공용 2개입  "), [rule]);
    assert.deepEqual(sourceLinkRules([rule], group, "other", "베놈공용 2개입"), []);
  }
});
test("mapping control displays original and proposed products, pending rebuild, exact variants and all platform choices", () => {
  const client = new QueryClient();
  const row: SourceProduct = { key: "source", group: "COUPANG", platform: "COUPANG", scopeKey: "shop", sourceName: "베놈공용 2개입",
    nameField: "native:COUPANG", firstDate: "2026-10-01", lastDate: "2026-10-31", publishedName: "베놈공용 2개입",
    targetName: "베놈무릎보호대", matchStatus: "MATCHED", pending: true, ruleIds: ["link"] };
  client.setQueryData(["unified-source-products", "user", "2026-10-01", "2026-10-31"], { products: [row], note: "발행된 상품만 표시" });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><SourceProductMappings products={[
    { id: "venom", canonicalName: "베놈무릎보호대", active: true, version: 1 }
  ]} rules={[]} from="2026-10-01" to="2026-10-31" userId="user" busy={false} canManage={false} onRange={() => {}} onPrepare={() => {}} /></QueryClientProvider>);
  for (const text of ["베놈공용 2개입", "베놈무릎보호대", "재집계 대기", "연결 설정", "네이버", "쿠팡", "Meta 광고", "Google 광고", "권한이 있는 사용자"]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes("미리본 규칙 저장")); client.clear();
});
