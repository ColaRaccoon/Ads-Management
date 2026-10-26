import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GoogleCampaignRow, GoogleMappings, GoogleOptions, GoogleReportResponse } from "../types/google";
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

function renderMapping(manage: boolean, mappings: GoogleMappings = { campaignMappings: [], salesMappings: [], audit: [], pagination: { page: 1, pageSize: 50, total: 0 } }, campaignReport?: GoogleReportResponse) {
  const client = new QueryClient();
  client.setQueryData(["google", "mappings", "", 1], mappings);
  if (campaignReport) client.setQueryData(["google", "campaigns", "", 1], campaignReport);
  const unused = async (): Promise<never> => { throw new Error("Auth mutation not expected"); };
  const auth: AuthContextValue = { user: null, permissions: manage ? ["data.read", "mappings.manage"] : ["data.read"], isLoading: false, isAuthenticated: true, status: "authenticated", login: unused, acceptInvitation: unused, completeInvitation: unused, logout: unused, can: (permission) => permission === "data.read" || (manage && permission === "mappings.manage"), refreshAuth: async () => null };
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><AuthContext.Provider value={auth}><GoogleMappingEditor options={options} query="" /></AuthContext.Provider></QueryClientProvider>);
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
  const productTable = html.indexOf('aria-label="Google 마진"');
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
  const reader = renderMapping(false);
  assert.ok(reader.includes("캠페인명 자동 연결"));
  assert.ok(reader.includes("mappings.manage 권한"));
  assert.ok(!reader.includes("<form"));
  assert.ok(!reader.includes("변경 영향 미리보기"));
  assert.ok(renderMapping(true).includes("변경 영향 미리보기"));
});

test("campaign name mappings show multiple campaigns for one product and explain unresolved names", () => {
  const campaign: GoogleCampaignRow = { connectionId: "google-1", customerId: "123", campaignId: "new-1", campaignName: "상품A 신규 캠페인", currencyCode: "KRW", productIds: ["product-1"], hasUnmapped: false, costMicros: "20000500000", adSpendKrw: 20000.5, adSpendKrwExact: "20000.5", impressions: 1000, clicks: 10, ctr: 0.01, cpcKrw: 2000.05, warningCodes: [] };
  const html = renderMapping(false, { campaignMappingMode: "CAMPAIGN_NAME", nameAutomaticProducts: [{ id: "product-1", displayName: "상품A", name: "원본 상품A" }], campaignMappings: [], salesMappings: [], audit: [], pagination: { page: 1, pageSize: 50, total: 0 } }, {
    ...fixture,
    campaigns: [campaign, { ...campaign, campaignId: "new-2", campaignName: "상품A 교체 캠페인" }, { ...campaign, campaignId: "unknown", campaignName: "브랜드 캠페인", productIds: [], hasUnmapped: true, warningCodes: ["CAMPAIGN_PRODUCT_NOT_FOUND"] }, { ...campaign, campaignId: "ambiguous", campaignName: "상품A 상품B", productIds: [], hasUnmapped: true, warningCodes: ["AMBIGUOUS_CAMPAIGN_PRODUCT"] }],
    pagination: { page: 1, pageSize: 50, total: 4 }
  });
  const results = html.match(/<table aria-label="캠페인명 자동 연결 결과">(.*?)<\/table>/s)?.[1];
  assert.ok(results);
  assert.match(results, /상품A 신규 캠페인<\/td><td>상품A<\/td>/);
  assert.match(results, /상품A 교체 캠페인<\/td><td>상품A<\/td>/);
  assert.match(results, /20,001 원/);
  assert.match(results, /캠페인명에서 활성 상품명을 찾지 못함/);
  assert.match(results, /캠페인명에 여러 상품이 포함되어 자동 연결 보류/);
  assert.equal((results.match(/<td>미배분<\/td>/g) ?? []).length, 2);
  assert.match(html, /상품명 인식 기준/);
  assert.match(html, /상품A \/ 원본 상품A/);
  assert.doesNotMatch(html, /<form/);
});

test("legacy campaign ID mappings remain collapsed read-only while sale configuration remains editable", () => {
  const common = { productId: "product-1", productName: "상품A", startDate: "2026-10-25", endDate: null, updatedAt: "2026-10-26T01:00:00Z" };
  const html = renderMapping(true, {
    campaignMappingMode: "CAMPAIGN_NAME", nameAutomaticProducts: [],
    campaignMappings: [{ ...common, id: "old-mapping", kind: "CAMPAIGN", connectionId: "google-1", campaignId: "legacy-campaign", productNo: null }],
    salesMappings: [{ ...common, id: "sale-mapping", kind: "SALE", connectionId: "cafe24-1", campaignId: null, productNo: "181", optionScope: "PRODUCT", saleUnitLabel: "1+1 세트", salePriceKrwOverride: 34900, productCostKrwOverride: 9000, shippingKrwOverride: 0, extraCostKrwOverride: 0 }],
    audit: [], pagination: { page: 1, pageSize: 50, total: 2 }
  }, fixture);
  const history = html.match(/<details class="panel"><summary>기존 캠페인 ID 연결 이력.*?<\/details>/s)?.[0];
  assert.ok(history, "legacy ID history is collapsed");
  assert.match(history, /legacy-campaign/);
  assert.doesNotMatch(history, /<button/);
  const form = html.match(/<form.*?<\/form>/s)?.[0];
  assert.ok(form);
  assert.match(form, /카페24 상품번호/);
  assert.match(form, /Google 전용 판매 구성/);
  assert.doesNotMatch(form, /캠페인 ID|value="CAMPAIGN"/);
  assert.match(html, /<details class="panel" open=""><summary>저장된 유튜브 판매 연결/);
  assert.equal((html.match(/수정 \/ 연결 해제/g) ?? []).length, 1);
  assert.match(html, /1\+1 세트/);
});

test("Google navigation respects data.read while keeping legacy Meta and Coupang entries", () => {
  assert.equal(visibleNavGroups(() => false).length, 0);
  const groups = visibleNavGroups((permission) => permission === "data.read");
  assert.equal(groups.find((group) => group.label === "Google")?.items.length, 4);
  assert.equal(groups.find((group) => group.label === "Google")?.items.find((item) => item.href === "/google/profit")?.label, "Google 마진");
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

test("Google margin displays server aggregate advertising ratios rather than averaging visible products", () => {
  const product = { ...row, impressions: 1000, clicks: 10, ctr: 0.01, cpcKrw: 2000, costPerSaleKrw: 10000 };
  const summary = { ...fixture.summary, impressions: 9000, clicks: 333, ctr: 0.037, cpcKrw: 123.456789, costPerSaleKrw: 4567.891234 };
  const html = render({ ...fixture, products: [product], summary });
  const table = html.match(/<table aria-label="Google 마진">(.*?)<\/table>/s)?.[1];
  assert.ok(table);
  const body = table.match(/<tbody>(.*?)<\/tbody>/s)?.[1];
  const footer = table.match(/<tfoot>(.*?)<\/tfoot>/s)?.[1];
  assert.ok(body);
  assert.ok(footer);
  assert.match(body, /<td>1,000<\/td><td>10<\/td><td>1%<\/td><td>2,000 원<\/td><td>10,000 원<\/td>/);
  assert.match(footer, /<td>9,000<\/td><td>333<\/td><td>4%<\/td><td>123 원<\/td><td>4,568 원<\/td>/);
  const bottom = html.slice(html.lastIndexOf('<section class="panel google-profit-total"'));
  assert.match(bottom, /노출수 \/ 클릭수<\/span><strong>9,000 \/ 333<\/strong>/);
  assert.match(bottom, /클릭률<\/span><strong>4%<\/strong>/);
  assert.match(bottom, /클릭당 비용<\/span><strong>123 원<\/strong>/);
  assert.match(bottom, /판매 1개당 광고비<\/span><strong>4,568 원<\/strong>/);
});

test("absent legacy or null advertising metrics remain unknown instead of becoming zero", () => {
  for (const metrics of [{}, { impressions: null, clicks: null, ctr: null, cpcKrw: null, costPerSaleKrw: null }]) {
    const html = render({ ...fixture, products: [{ ...row, ...metrics }], summary: { ...fixture.summary, ...metrics } });
    const table = html.match(/<table aria-label="Google 마진">(.*?)<\/table>/s)?.[1];
    assert.ok(table);
    for (const section of [table.match(/<tbody>(.*?)<\/tbody>/s)?.[1], table.match(/<tfoot>(.*?)<\/tfoot>/s)?.[1]]) {
      assert.ok(section);
      assert.match(section, /<td>20,000 원<\/td>(?:<td>—<\/td>){5}<td>5배<\/td>/);
    }
    const bottom = html.slice(html.lastIndexOf('<section class="panel google-profit-total"'));
    assert.match(bottom, /노출수 \/ 클릭수<\/span><strong>— \/ —<\/strong>/);
    for (const label of ["클릭률", "클릭당 비용", "판매 1개당 광고비"]) {
      assert.ok(bottom.includes(`${label}</span><strong>—</strong>`), label);
    }
  }
});

test("Google Ads conversion metrics are disclosed as uncollected and sale cost uses Cafe24 units", () => {
  const html = render(fixture);
  assert.match(html, /Google Ads 전환수·전환당 비용·전환가치는 현재 미수집/);
  assert.match(html, /설정가 매출을 Google Ads 전환가치로 표시하지 않습니다/);
  assert.match(html, /판매 1개당 광고비는 카페24 \[유튜브\] 판매수량 기준/);
  assert.match(html, /1\+1은 1세트로 계산/);
  assert.match(html, /Google Ads의 전환당 비용\(CPA\)과 다릅니다/);
  const headers = html.match(/<table aria-label="Google 마진"><thead>(.*?)<\/thead>/s)?.[1];
  assert.ok(headers);
  assert.match(headers, /판매 1개당 광고비/);
  assert.doesNotMatch(headers, /전환가치|전환수|CPA/);
});
