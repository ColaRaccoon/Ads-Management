import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GoogleOptions, GoogleReportResponse } from "../types/google";
import type { AuthContextValue } from "../features/auth/auth-context";

// The browser auth coordinator must not open Node's real cross-thread channel in SSR tests.
const originalChannel = globalThis.BroadcastChannel;
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true, writable: true });
const { GoogleReport } = await import("./google-report");
const { GoogleMappingEditor, GoogleSaleConfigurationFields } = await import("./google-mapping-editor");
const { AuthContext } = await import("../features/auth/auth-context");
const { visibleNavGroups } = await import("./app-shell");
Object.defineProperty(globalThis, "BroadcastChannel", { value: originalChannel, configurable: true, writable: true });

const row = { productId: "product-1", date: "2026-10-25", quantity: 2, lineCount: 2, revenueKrw: 100000, knownRevenueKrw: 100000, collectedRevenueKrw: 100000, grossCostKrw: 40000, couponDeductionKrw: 5000, adSpendKrw: 20000, adSpendKrwExact: "20000", knownAdSpendKrw: 20000, marginKrw: 35000, calculatedMarginKrw: 35000, marginRate: 0.35, roas: 5, priceMismatchCount: 0, complete: true, warningCodes: [] };
const options: GoogleOptions = { enabled: true, products: [{ id: "product-1", displayName: "상품A" }], connections: [{ id: "google-1", provider: "GOOGLE", displayName: "Google 계정", externalAccountId: "123", currencyCode: "KRW", timeZone: "Asia/Seoul" }] };
const fixture: GoogleReportResponse = {
  range: { from: "2026-10-25", to: "2026-10-25" }, summary: { ...row, calculatedProductsMarginKrw: 35000, allocatedAdSpendKrw: 20000, unallocatedAdSpendKrw: 0, unmappedSalesCount: 0 },
  products: [row], daily: [row], campaigns: [], unmappedSales: [],
  completeness: { complete: true, missingGoogleDates: [], missingCafe24Dates: [], completeDates: ["2026-10-25"], warningCodes: [] },
  reconciliation: { collectedAdSpendKrwExact: "20000", allocatedAdSpendKrwExact: "20000", unallocatedAdSpendKrwExact: "0", balanced: true, byCurrency: [] },
  pagination: { page: 1, pageSize: 50, total: 1 }, coverage: [{ connectionId: "google-1", provider: "GOOGLE", date: "2026-10-25", selectedSource: "API", complete: true, state: "COMPLETE_NONZERO", rowCount: 2, amount: "20000", lastSuccessAt: "2026-10-25T22:00:00Z", lastAttemptAt: "2026-10-25T22:00:00Z", warningCodes: [] }], notices: ["실제 결제액 또는 Google 클릭 전환 매출이 아닙니다."]
};
function render(data: GoogleReportResponse, query = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["google", "profit", query, 1], data);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><GoogleReport view="profit" query={query} options={options} /></QueryClientProvider>);
  client.clear(); return html;
}

test("profit renders server totals, collection dates, exact export scope and cost meaning", () => {
  const html = render({ ...fixture, summary: { ...fixture.summary, adSpendKrwExact: "20000.5" } });
  for (const value of ["35,000 원", "20,001 원", "35%", "5배", "상품A", "2026-10-25", "현재 페이지 CSV", "동일 기준 일별 전체 CSV", "수집가 금액", "Google 계정", "최근 성공"]) assert.ok(html.includes(value), value);
  assert.ok(!html.includes("35.00%"));
  assert.ok(!html.includes("20,000.5 원"));
});

test("incomplete collection does not display a zero or final profit", () => {
  const data = { ...fixture, summary: { ...fixture.summary, marginKrw: null, adSpendKrwExact: null, complete: false, warningCodes: ["GOOGLE_COLLECTION_INCOMPLETE"] }, completeness: { ...fixture.completeness, complete: false, missingGoogleDates: ["2026-10-25"], warningCodes: ["GOOGLE_COLLECTION_INCOMPLETE"] } };
  const html = render(data);
  assert.ok(html.includes("잠정 / 미확정"));
  assert.ok(html.includes("광고비 미수집"));
  assert.match(html, /전체 확정 상품마진<\/span><strong>—<\/strong>/);
});

test("product footer uses the server total across all pages instead of visible product margins", () => {
  const html = render({ ...fixture, summary: { ...fixture.summary, marginKrw: -123816.197719, adSpendKrwExact: "216456.197719" }, pagination: { page: 1, pageSize: 50, total: 51 } });
  const footer = html.match(/<tfoot>(.*?)<\/tfoot>/s)?.[1];
  assert.ok(footer, "the product table has a total footer");
  assert.match(footer, /Google 전체 합계/);
  assert.match(footer, /모든 페이지 포함/);
  assert.match(footer, /-123,816 원/);
  assert.match(footer, /216,456 원/);
  assert.doesNotMatch(footer, /35,000 원/);
  assert.match(html, /1 \/ 2 페이지/);
});

test("unknown total margin stays pending in the footer and bottom summary despite calculable product profits", () => {
  const html = render({ ...fixture, summary: { ...fixture.summary, marginKrw: null, calculatedMarginKrw: 35000, calculatedProductsMarginKrw: 35000, complete: false, warningCodes: ["UNALLOCATED_AD_SPEND"] } });
  const footer = html.match(/<tfoot>(.*?)<\/tfoot>/s)?.[1];
  const bottom = html.slice(html.lastIndexOf('<section class="panel google-profit-total"'));
  assert.ok(footer);
  assert.match(footer, /google-margin-pending">미확정<\/strong>/);
  assert.doesNotMatch(footer, /35,000 원/);
  assert.match(bottom, /최종 마진<\/span><strong class="google-margin-value google-margin-pending">미확정<\/strong>/);
  assert.match(bottom, /잠정 마진 합계: 35,000 원/);
  assert.doesNotMatch(bottom, /google-margin-positive/);
});

test("product, Google account and storefront filters label totals as the selected scope", () => {
  for (const filter of ["productId=product-1", "connectionId=google-1", "cafe24ConnectionId=cafe24-1"]) {
    const html = render(fixture, `from=2026-10-25&to=2026-10-25&${filter}`);
    assert.match(html, /<tfoot><tr><td>선택 범위 합계/);
    assert.match(html, /<h2>Google 선택 범위 마진<\/h2>/);
    assert.doesNotMatch(html, /<h2>Google 전체 마진<\/h2>/);
  }
  assert.match(render(fixture, "from=2026-10-25&to=2026-10-25"), /<h2>Google 전체 마진<\/h2>/);
});

test("individual product margins appear before diagnostics and the overall margin is the final section", () => {
  const html = render(fixture);
  const productTable = html.indexOf('aria-label="Google 상품별 마진"');
  assert.ok(productTable >= 0);
  assert.ok(productTable < html.indexOf("매출·비용 계산 기준 및 상세 합계"));
  assert.ok(productTable < html.indexOf("수집 완료 및 누락"));
  assert.ok(productTable < html.indexOf("광고비 배분 대사"));
  const bottom = html.lastIndexOf('<section class="panel google-profit-total"');
  assert.ok(bottom > html.indexOf("미연결 유튜브 판매"));
  assert.match(html.slice(bottom), /<h2>Google 전체 마진<\/h2>/);
  assert.match(html.slice(bottom), /최종 마진<\/span><strong class="google-margin-value google-margin-positive">35,000 원<\/strong>/);
  assert.ok(html.endsWith("</section>"));
});

test("mapping editor renders mutations only with mappings.manage and preserves read-only list", () => {
  const renderMapping = (manage: boolean) => {
    const client = new QueryClient();
    client.setQueryData(["google", "mappings", "", 1], { campaignMappings: [], salesMappings: [], audit: [], pagination: { page: 1, pageSize: 50, total: 0 } });
    const unused = async (): Promise<never> => { throw new Error("Auth mutation not expected"); };
    const auth: AuthContextValue = { user: null, permissions: manage ? ["data.read", "mappings.manage"] : ["data.read"], isLoading: false, isAuthenticated: true, status: "authenticated", login: unused, acceptInvitation: unused, completeInvitation: unused, logout: unused, can: (permission) => permission === "data.read" || (manage && permission === "mappings.manage"), refreshAuth: async () => null };
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><AuthContext.Provider value={auth}><GoogleMappingEditor options={options} query="" /></AuthContext.Provider></QueryClientProvider>);
    client.clear(); return html;
  };
  const reader = renderMapping(false);
  assert.ok(reader.includes("캠페인 연결"));
  assert.ok(reader.includes("mappings.manage 권한"));
  assert.ok(!reader.includes("<form"));
  assert.ok(!reader.includes("변경 영향 미리보기"));
  assert.ok(renderMapping(true).includes("변경 영향 미리보기"));
});

test("Google navigation respects data.read while keeping legacy Meta and Coupang entries", () => {
  assert.equal(visibleNavGroups(() => false).length, 0);
  const groups = visibleNavGroups((permission) => permission === "data.read");
  assert.equal(groups.find((group) => group.label === "Google")?.items.length, 4);
  assert.ok(groups.some((group) => group.items.some((item) => item.href === "/dashboard")));
  assert.ok(groups.some((group) => group.items.some((item) => item.href === "/coupang/dashboard")));
});

test("Google sale configuration fields use completed-set amounts with all four fields required", () => {
  const html = renderToStaticMarkup(<GoogleSaleConfigurationFields draft={{ kind: "SALE", connectionId: "cafe24-account", productId: "product-1", productNo: "product-number", optionScope: "PRODUCT", optionName: "", startDate: "2026-10-01", endDate: null, saleUnitLabel: "1+1 세트", salePriceKrwOverride: 21900, productCostKrwOverride: 8000, shippingKrwOverride: 3000, extraCostKrwOverride: 0 }} update={() => undefined} busy={false} />);
  for (const label of ["구성 판매가", "구성 상품원가", "구성 배송비", "구성 추가비용", "기존 공용 상품 설정은 변경하지 않습니다", "다시 2배 하지 않습니다"]) assert.ok(html.includes(label), label);
  assert.ok(html.includes('value="21900"'));
  assert.ok(html.includes('value="0"'));
  assert.ok(!html.includes('value="43800"'));
  assert.equal((html.match(/required=""/g) ?? []).length, 4);
});

test("profit table displays one complete set with the unchanged server revenue", () => {
  const setRow = { ...row, quantity: 1, saleUnitLabel: "1+1 세트", saleUnitLabels: ["1+1 세트"], revenueKrw: 21900 };
  const html = render({ ...fixture, products: [setRow], daily: [setRow] });
  assert.ok(html.includes("1+1 세트"));
  assert.ok(html.includes("21,900 원"));
  assert.match(html, /<td>1<br\/>1\+1 세트<\/td>/);
});
