import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { authCoordinator } from "../auth/auth-coordination";
import { AuthContext, type AuthContextValue } from "../auth/auth-context";
import { NameRuleFields } from "./name-rule-fields";
import { NamePreview } from "./name-preview";
import { AllocationFields } from "./allocation-fields";
import { SaleUnitFields } from "./sale-unit-fields";
import { LegacyNameRules, legacyCandidateDraft, projectLegacyNameRules } from "./legacy-name-rules";
import type { NameResolution, NameSample, Product } from "./types";

after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());

const products: Product[] = [
  { id: "product-a", canonicalName: "Product A", active: true, version: 3 },
  { id: "product-b", canonicalName: "Product B", active: true, version: 1 },
];
const noop = () => {};

test("name fields preserve aliases, option conditions and sale-unit text in disabled review", () => {
  const html = renderToStaticMarkup(<NameRuleFields disabled onChange={noop} payload={{
    matchType: "CONTAINS", terms: ["Alias A", "Alias B"], excludeTerms: ["Except"],
    optionExact: "1+1", optionInclude: ["세트"], optionExclude: ["단품"],
    nameField: "product_name", saleUnitName: "2개입 세트",
  }} />);
  assert.match(html, /<fieldset disabled="">/);
  for (const value of ["Alias A\nAlias B", "Except", "1+1", "세트", "단품", "product_name", "2개입 세트"])
    assert.ok(html.includes(value), value);
  assert.match(html, /value="CONTAINS" selected=""/);
  assert.doesNotMatch(html, /name="(?:productId|externalProductId)"/);
});

test("name preview escapes original input and shows product/unit candidates, rule evidence and repair reasons", () => {
  const samples: NameSample[] = [{ originalName: "<script>제품</script>", originalOption: "1+1", platform: "CAFE24",
    scopeKey: "isolated-source", nameField: "product_name", businessDate: "2026-10-28" }];
  const results: NameResolution[] = [{ originalName: samples[0].originalName, originalOption: "1+1", canonicalProductName: null,
    saleUnitName: null, matchStatus: "AMBIGUOUS", candidateNames: ["Product A", "Product B"], ruleIds: ["rule-a", "rule-b"],
    reasons: ["MULTIPLE_PRODUCT_CANDIDATES"], unitPreview: { status: "UNIT_REQUIRED", reason: "MULTIPLE_SALE_UNIT_CANDIDATES",
      candidates: [{ ruleId: "unit-a", saleUnitName: "단품" }, { ruleId: "unit-b", saleUnitName: "2개입" }] } }];
  const html = renderToStaticMarkup(<NamePreview samples={samples} results={results} disabled onSamplesChange={noop} />);
  assert.ok(html.includes("&lt;script&gt;제품&lt;/script&gt;"));
  assert.doesNotMatch(html, /<script>/);
  for (const value of ["복수 제품 후보", "Product A / Product B", "rule-a / rule-b", "단품 / 2개입", "판매단위 규칙: unit-a", "옵션 조건을 수정하세요", "판매단위 후보가 여러 개"])
    assert.ok(html.includes(value), value);
  assert.match(html, /<fieldset disabled="">/);
  assert.doesNotMatch(html, /type="number"/);
});

function allocation(targets: Array<{ productName: string; weight: string }>) {
  return renderToStaticMarkup(<AllocationFields products={products} onChange={noop} payload={{ method: "FIXED_WEIGHTS", component: "AD_SPEND", targets }} />);
}

test("allocation validates ten-place sums exactly and flags short sums, invalid weights and normalized duplicate products", () => {
  const exact = allocation([{ productName: "Product A", weight: "0.3333333333" }, { productName: "Product B", weight: "0.6666666667" }]);
  assert.match(exact, /비중 합계: 1 \/ 1/);
  assert.match(exact, /비중 합계가 유효합니다/);
  assert.doesNotMatch(exact, /비중을 확인하세요/);
  const short = allocation([{ productName: "Product A", weight: "0.3333333333" }, { productName: "Product B", weight: "0.6666666666" }]);
  assert.match(short, /비중 합계: 0.9999999999 \/ 1/);
  assert.match(short, /비중을 확인하세요/);
  const invalid = allocation([{ productName: "Product A", weight: "0" }, { productName: "Product B", weight: "0.12345678901" }]);
  assert.match(invalid, /aria-invalid="true"/);
  assert.match(invalid, /비중을 확인하세요/);
  const duplicate = allocation([{ productName: "Product A", weight: "0.5" }, { productName: " product   a ", weight: "0.5" }]);
  assert.match(duplicate, /같은 제품을 중복 지정할 수 없습니다/);
  const revenueShare = renderToStaticMarkup(<AllocationFields products={products} onChange={noop} payload={{ method: "REVENUE_SHARE", component: "SHIPPING_COST", targets: [{ productName: "Product A", weight: null }] }} />);
  assert.match(revenueShare, /분모가 0이거나 매출이 불완전하면 미배분/);
  assert.match(revenueShare, /조회 플랫폼을 해제해도 다른 제품에 다시 배분하지 않습니다/);
});

test("sale-unit fields keep confirmed zero separate from null and retain exact large decimal amounts", () => {
  const html = renderToStaticMarkup(<SaleUnitFields disabled onChange={noop} payload={{ saleUnitName: "2개입 세트", quantityBasis: "SALE_UNIT_TOTAL",
    unitsPerSaleUnit: "2", salePrice: "0", productCost: null, shippingCost: "9007199254740993.123456", otherCost: "0", optionInclude: ["1+1"] }} />);
  assert.match(html, /<fieldset disabled=""/);
  assert.match(html, /판매가 \(원\)<input[^>]*value="0"/);
  assert.match(html, /제품 원가 \(원\)<input[^>]*value=""/);
  assert.match(html, /value="9007199254740993.123456"/);
  assert.match(html, /빈 금액은 미입력으로 보존하며 0원은 유효/);
  assert.match(html, /구성 수량을 다시 곱하지 않습니다/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /type="number"/);
  const invalid = renderToStaticMarkup(<SaleUnitFields onChange={noop} payload={{ saleUnitName: "단품", unitsPerSaleUnit: "0", productCost: "-1" }} />);
  assert.match(invalid, /role="alert"/);
});

test("legacy projection retains date/option semantics while rejecting ID-only and regex rules and ambiguous automatic products", () => {
  const [meta] = projectLegacyNameRules("META", [{ id: "old-a", matchType: "CONTAINS", pattern: "Alias A", priority: 2,
    product: { displayName: " product   a " }, validFrom: "2026-10-01T00:00:00.000Z", validTo: "2026-10-15T00:00:00.000Z", isActive: false }]);
  const draft = legacyCandidateDraft(meta, products)!;
  assert.equal(draft.productId, "product-a");
  assert.equal(draft.validFrom, "2026-10-01");
  assert.equal(draft.validTo, "2026-10-15");
  assert.equal(draft.active, false);
  assert.ok(!("expectedVersion" in draft));
  assert.ok(!("id" in draft));
  assert.equal(legacyCandidateDraft(meta, [...products, { ...products[0], id: "duplicate" }])!.productId, null);
  assert.equal(legacyCandidateDraft(meta, products, "product-b")!.productId, "product-b");
  const [regex] = projectLegacyNameRules("META", [{ matchType: "REGEX", pattern: ".*" }]);
  assert.equal(regex.payload, null);
  assert.equal(legacyCandidateDraft(regex, products), null);
  const [idOnly] = projectLegacyNameRules("CAFE24", [{ productNumbers: ["external-id"], optionIncludeKeywords: ["option-only"] }]);
  assert.equal(idOnly.payload, null);
  assert.equal(legacyCandidateDraft(idOnly, products), null);
  const aliases = projectLegacyNameRules("CAFE24", [{ id: "cafe-a", product: { displayName: "Product A" }, productNumbers: ["external-id"],
    productNameAliases: ["alias-a", "alias-b"], productNameIncludeKeywords: ["base"], optionIncludeKeywords: ["set"], optionExcludeKeywords: ["single"], matchTarget: "SEPARATE" }]);
  assert.equal(aliases.length, 2);
  assert.deepEqual(aliases.map(alias => alias.payload!.terms), [["base", "alias-a"], ["base", "alias-b"]]);
  assert.deepEqual(aliases[0].payload!.optionInclude, ["set"]);
  assert.deepEqual(aliases[0].payload!.optionExclude, ["single"]);
  assert.ok(!JSON.stringify(aliases[0].payload).includes("external-id"));
  assert.ok(aliases[0].notes.some(note => note.includes("외부 상품번호 조건 1개")));
  const fallback = legacyCandidateDraft(aliases[0], products)!;
  assert.equal(fallback.validFrom, new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date()));
  assert.ok(aliases[0].notes.some(note => note.includes("오늘을 초안")));
  const [coupang] = projectLegacyNameRules("COUPANG", [{ includeKeywords: ["product"], excludeKeywords: ["single"], adEnabled: false }]);
  assert.equal(coupang.payload!.nameField, "product_name");
  assert.equal(coupang.scopeKey, "LEGACY_COUPANG_SINGLE_UPLOAD");
});

test("legacy read-only review renders independently cached name rules and blocks draft use without a unique product", () => {
  const candidates = projectLegacyNameRules("META", [{ id: "old-a", matchType: "CONTAINS", pattern: "Alias A", priority: 2, product: { displayName: "Product A" } }]);
  const client = new QueryClient();
  client.setQueryData(["unified", "legacy-name-rules", "META"], { candidates });
  const unused = async (): Promise<never> => { throw new Error("Unexpected auth mutation"); };
  const auth: AuthContextValue = { user: null, permissions: ["data.read"], isLoading: false, isAuthenticated: true,
    status: "authenticated", can: permission => permission === "data.read", login: unused, acceptInvitation: unused,
    completeInvitation: unused, logout: unused, refreshAuth: async () => null };
  const render = (catalog: Product[]) => renderToStaticMarkup(<QueryClientProvider client={client}><AuthContext.Provider value={auth}>
    <LegacyNameRules products={catalog} onUse={() => { throw new Error("SSR must not write or select a draft"); }} />
  </AuthContext.Provider></QueryClientProvider>);
  try {
    const html = render(products);
    for (const value of ["Meta 기존 이름 규칙", "Cafe24 기존 이름 규칙", "Google 기존 이름 규칙", "쿠팡 기존 이름 규칙", "기존 우선순위 2", "이름 규칙 초안으로 사용"])
      assert.ok(html.includes(value), value);
    assert.doesNotMatch(html, /disabled="">이름 규칙 초안으로 사용/);
    assert.match(render([...products, { ...products[0], id: "duplicate" }]), /disabled="">이름 규칙 초안으로 사용/);
  } finally { client.clear(); }
});
