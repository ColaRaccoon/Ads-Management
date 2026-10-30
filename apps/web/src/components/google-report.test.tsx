import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GoogleCampaignRow, GoogleMappings, GoogleOptions, GoogleReportResponse } from "../types/google";
import type { AuthContextValue } from "../features/auth/auth-context";
import type { GoogleView } from "./google-performance-page";

// The browser auth coordinator must not open Node's real cross-thread channel in SSR tests.
const originalChannel = globalThis.BroadcastChannel;
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true, writable: true });
const { GoogleReport } = await import("./google-report");
const { GoogleMappingEditor } = await import("./google-mapping-editor");
const { GoogleMappingDiagnostics } = await import("./google-mapping-diagnostics");
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
function render(data: GoogleReportResponse, query = "", view: Exclude<GoogleView, "mappings"> = "profit") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const endpoint = view === "dashboard" ? "summary" : view === "campaigns" ? "campaigns" : "profit";
  client.setQueryData(["google", endpoint, query, view === "profit" || view === "dashboard" ? "all-products" : 1], data);
  if (view === "diagnostics") client.setQueryData(["google", "campaigns", query, 1], data);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><GoogleReport view={view} query={query} options={options} /></QueryClientProvider>);
  client.clear(); return html;
}

function productTable(html: string) {
  const table = html.match(/<table(?:\s[^>]*)?>(.*?)<\/table>/s)?.[1];
  assert.ok(table, "product performance table is present");
  return table;
}

function tableRowValues(html: string, part: "tbody" | "tfoot") {
  const table = productTable(html);
  const headers = [...(table.match(/<thead>(.*?)<\/thead>/s)?.[1] ?? "").matchAll(/<th[^>]*>(.*?)<\/th>/gs)].map((cell) => cell[1].replace(/<[^>]*>/g, ""));
  const section = table.match(new RegExp(`<${part}>(.*?)<\\/${part}>`, "s"))?.[1];
  assert.ok(section, `${part} exists`);
  const cells = [...section.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((cell) => cell[1].replace(/<[^>]*>/g, ""));
  return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
}

function bottomSummary(html: string) {
  const index = html.lastIndexOf('aria-label="Google 전체 마진 요약"');
  assert.ok(index >= 0, "bottom Google margin summary is present");
  return html.slice(index);
}

function renderMapping(manage: boolean, mappings: GoogleMappings = { campaignMappings: [], salesMappings: [], audit: [], pagination: { page: 1, pageSize: 50, total: 0 } }, campaignReport?: GoogleReportResponse, settings: { diagnostics?: boolean; canRead?: boolean; query?: string } = {}) {
  const client = new QueryClient();
  const query = settings.query ?? "", canRead = settings.canRead !== false;
  client.setQueryData(["google", "mappings", query, 1], mappings);
  if (campaignReport) client.setQueryData(["google", "campaigns", query, 1], campaignReport);
  const unused = async (): Promise<never> => { throw new Error("Auth mutation not expected"); };
  const auth: AuthContextValue = { user: null, permissions: canRead ? manage ? ["data.read", "mappings.manage"] : ["data.read"] : [], isLoading: false, isAuthenticated: true, status: "authenticated", login: unused, acceptInvitation: unused, completeInvitation: unused, logout: unused, can: (permission) => (canRead && permission === "data.read") || (manage && permission === "mappings.manage"), refreshAuth: async () => null };
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><AuthContext.Provider value={auth}>{settings.diagnostics ? <GoogleMappingDiagnostics options={options} query={query} /> : <GoogleMappingEditor options={options} query={query} />}</AuthContext.Provider></QueryClientProvider>);
  client.clear(); return html;
}

test("profit retains integer server totals and exports while technical details move to diagnostics", () => {
  const html = render({ ...fixture, summary: { ...fixture.summary, adSpendKrwExact: "20000.5" } });
  for (const value of ["35,000 원", "20,001 원", "35%", "5배", "상품A", "2026-10-25", "엑셀 출력"]) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /현재 페이지 CSV/);
  assert.ok(!html.includes("35.00%"));
  assert.ok(!html.includes("20,000.5 원"));
  const diagnostics = render(fixture, "", "diagnostics");
  for (const value of ["동일 기준 일별 전체 CSV", "수집가 금액", "Google 계정", "최근 성공", "상품A", "35,000 원"]) {
    assert.ok(diagnostics.includes(value), value);
  }
  for (const view of ["profit", "dashboard", "campaigns"] as const) {
    const operational = render(fixture, "", view);
    for (const label of ["매출·비용 계산 기준 및 상세 합계", "수집 완료 및 누락", "광고비 배분 대사", "상품·일자별 상세", "미연결 유튜브 판매"]) {
      assert.ok(!operational.includes(label), `${view} excludes ${label}`);
      assert.ok(diagnostics.includes(label), `diagnostics retains ${label}`);
    }
  }
});

test("incomplete collection does not display a zero or final profit", () => {
  const data = { ...fixture, summary: { ...fixture.summary, marginKrw: null, adSpendKrwExact: null, complete: false, warningCodes: ["GOOGLE_COLLECTION_INCOMPLETE"] }, completeness: { ...fixture.completeness, complete: false, missingGoogleDates: ["2026-10-25"], warningCodes: ["GOOGLE_COLLECTION_INCOMPLETE"] } };
  const query = "from=2026-10-23&to=2026-10-25&connectionId=google-1&cafe24ConnectionId=cafe24-1&productId=product-1";
  for (const view of ["profit", "dashboard", "campaigns"] as const) {
    const html = render(data, query, view);
    assert.match(html, /마진이 미확정/);
    assert.doesNotMatch(html, /광고비 미수집/);
    assert.ok(html.includes(`href="/google/diagnostics?${query.replaceAll("&", "&amp;")}"`));
    if (view !== "campaigns") assert.match(bottomSummary(html), /미확정/);
  }
  const diagnostics = render(data, query, "diagnostics");
  assert.ok(diagnostics.includes("잠정 / 미확정"));
  assert.ok(diagnostics.includes("광고비 미수집"));
  assert.match(diagnostics, /전체 확정 상품마진<\/span><strong>—<\/strong>/);
});

test("diagnostics preserve incomplete daily rows, unmapped sales, collection failures and exact reconciliation", () => {
  const data: GoogleReportResponse = {
    ...fixture,
    summary: { ...fixture.summary, marginKrw: null, complete: false, unmappedSalesCount: 1, warningCodes: ["UNMAPPED_SALES", "GOOGLE_COLLECTION_INCOMPLETE"] },
    campaigns: [{ connectionId: "google-1", customerId: "raw-account-123", campaignId: "raw-campaign-456", campaignName: "연결 보류 캠페인", currencyCode: "KRW", productIds: [], hasUnmapped: true, costMicros: "20000500000", adSpendKrw: 20000.5, adSpendKrwExact: "20000.5", impressions: 1000, clicks: 10, ctr: 0.01, cpcKrw: 2000.05, warningCodes: ["AMBIGUOUS_CAMPAIGN_PRODUCT"] }],
    daily: [{ ...row, date: "2026-10-24", marginKrw: null, complete: false, warningCodes: ["MISSING_COST_RULE"] }],
    completeness: { ...fixture.completeness, complete: false, missingGoogleDates: ["2026-10-24"], warningCodes: ["UNMAPPED_SALES", "GOOGLE_COLLECTION_INCOMPLETE"] },
    unmappedSales: [{ id: "sale-unmapped", date: "2026-10-24", connectionId: null, orderNo: "unmapped-order-123", productNo: "181", optionName: "1+1", productName: "[유튜브] 미연결상품", quantity: 1, collectedRevenueKrw: 34900 }],
    reconciliation: { ...fixture.reconciliation, byCurrency: [{ currencyCode: "KRW", allocatedCostMicros: "20000000001", unallocatedCostMicros: "1000000", collectedCostMicros: "20001000001", balanced: true }] }
  };
  const html = render(data, "from=2026-10-24&to=2026-10-25", "diagnostics");
  for (const value of ["Google 누락: 2026-10-24", "원가 규칙 누락", "미연결 유튜브 판매 1건", "unmapped-order-123", "[유튜브] 미연결상품", "34,900 원", "20000000001", "20001000001", "동일 기준 일별 전체 CSV", "raw-account-123", "raw-campaign-456", "캠페인명에 여러 상품이 포함되어 자동 연결 보류", "캠페인 현재 페이지 CSV", ...data.notices]) {
    assert.ok(html.includes(value), value);
  }
  const operational = render(data);
  assert.match(operational, /마진이 미확정/);
  assert.doesNotMatch(operational, /unmapped-order-123|20001000001|원가 규칙 누락|미연결 유튜브 판매 1건/);
  const campaigns = render(data, "from=2026-10-24&to=2026-10-25", "campaigns");
  assert.match(campaigns, /연결 보류 캠페인/);
  assert.match(campaigns, /20,001 원/);
  assert.match(campaigns, /확인 필요/);
  assert.doesNotMatch(campaigns, /raw-account-123|raw-campaign-456|캠페인명에 여러 상품이 포함/);
});

test("profit and dashboard render all 51 products in a scrollable table without paging and preserve server totals", () => {
  const products = Array.from({ length: 51 }, (_, index) => ({ ...row, productId: `product-${index + 1}` }));
  const data = { ...fixture, products, summary: { ...fixture.summary, marginKrw: -123816.197719, adSpendKrwExact: "216456.197719" }, pagination: { page: 1, pageSize: 50, total: 51 } };
  for (const view of ["profit", "dashboard"] as const) {
    const html = render(data, "from=2026-10-25&to=2026-10-25", view);
    const table = productTable(html);
    const body = table.match(/<tbody>(.*?)<\/tbody>/s)?.[1];
    assert.ok(body);
    assert.equal((body.match(/<tr(?:\s[^>]*)?>/g) ?? []).length, 51, `${view} retains every loaded product`);
    assert.match(body, /product-51/);
    assert.match(html, /class="table-wrap"/);
    assert.doesNotMatch(html, /<button[^>]*>(?:이전|다음)<\/button>|\d+ \/ \d+ 페이지/);
    const footer = table.match(/<tfoot>(.*?)<\/tfoot>/s)?.[1];
    assert.ok(footer, "the product table has a total footer");
    assert.match(footer, /합계/);
    assert.match(footer, /-123,816 원/);
    assert.match(footer, /216,456 원/);
    assert.doesNotMatch(footer, /35,000 원/);
    assert.match(bottomSummary(html), /최종 순마진<\/span><strong>-123,816 원<\/strong>/);
    assert.match(html, /엑셀 출력/);
  }
});

test("campaigns and diagnostics retain their existing paged tables", () => {
  const data = { ...fixture, pagination: { page: 1, pageSize: 50, total: 51 } };
  for (const view of ["campaigns", "diagnostics"] as const) {
    const html = render(data, "from=2026-10-25&to=2026-10-25", view);
    assert.match(html, /1 \/ 2 페이지 · 51건/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>이전<\/button>/);
    assert.match(html, /<button[^>]*>다음<\/button>/);
  }
});

test("unknown total margin stays pending in the footer and bottom summary despite calculable product profits", () => {
  const html = render({ ...fixture, summary: { ...fixture.summary, marginKrw: null, calculatedMarginKrw: 35000, calculatedProductsMarginKrw: 35000, complete: false, warningCodes: ["UNALLOCATED_AD_SPEND"] } });
  const footer = html.match(/<tfoot>(.*?)<\/tfoot>/s)?.[1];
  const bottom = bottomSummary(html);
  assert.ok(footer);
  assert.equal(tableRowValues(html, "tfoot")["최종 순마진"], "미확정");
  assert.doesNotMatch(footer, /35,000 원/);
  assert.match(bottom, /최종 순마진<\/span><strong>미확정<\/strong>/);
  assert.doesNotMatch(bottom, /잠정 마진 합계/);
  assert.match(render({ ...fixture, summary: { ...fixture.summary, marginKrw: null } }, "", "diagnostics"), /잠정 마진 합계: 35,000 원/);
  assert.doesNotMatch(bottom, /google-margin-positive/);
});

test("product, Google account and storefront filters label totals as the selected scope", () => {
  for (const filter of ["productId=product-1", "connectionId=google-1", "cafe24ConnectionId=cafe24-1"]) {
    const html = render(fixture, `from=2026-10-25&to=2026-10-25&${filter}`);
    assert.equal(tableRowValues(html, "tfoot")["제품"], "선택 범위 합계전체 상품 포함");
    assert.match(html, /<h2>Google 선택 범위 마진<\/h2>/);
    assert.doesNotMatch(html, /<h2>Google 전체 마진<\/h2>/);
  }
  assert.match(render(fixture, "from=2026-10-25&to=2026-10-25"), /<h2>Google 전체 마진<\/h2>/);
});

test("individual product margins precede the final overall margin without embedded diagnostics", () => {
  const html = render(fixture);
  const tableIndex = html.indexOf('<table');
  assert.ok(tableIndex >= 0);
  const bottom = html.lastIndexOf('aria-label="Google 전체 마진 요약"');
  assert.ok(bottom > tableIndex);
  assert.match(html.slice(bottom), /<h2>Google 전체 마진<\/h2>/);
  assert.match(html.slice(bottom), /최종 순마진<\/span><strong>35,000 원<\/strong>/);
  assert.ok(html.endsWith("</section>"));
});

test("Google profit follows Meta's product column order and cost definitions while keeping Google metrics", () => {
  const html = render(fixture);
  const cells = tableRowValues(html, "tbody");
  assert.deepEqual(Object.keys(cells), ["제품", "수량", "매출", "쿠폰 차감", "광고비", "총비용", "쿠폰 적용 전 마진", "최종 순마진", "광고수익률", "판매 1개당 광고비", "마진율", "노출수", "클릭수", "클릭률", "클릭당 비용", "상태"]);
  assert.equal(cells["총비용"], "65,000 원", "total cost includes sales cost, ad spend and coupon");
  assert.equal(cells["쿠폰 적용 전 마진"], "40,000 원");
  assert.equal(cells["최종 순마진"], "35,000 원");
  assert.doesNotMatch(html, /google-profit-table|google-margin-value|google-profit-total-amount/);
});

test("zero and negative product profits remain numeric while missing costs keep derived amounts unknown", () => {
  const cases = [
    { overrides: { revenueKrw: 0, grossCostKrw: 0, couponDeductionKrw: 0, adSpendKrw: 0, adSpendKrwExact: "0", marginKrw: 0 }, cost: "0 원", before: "0 원", final: "0 원" },
    { overrides: { revenueKrw: 10000, grossCostKrw: 40000, couponDeductionKrw: 5000, adSpendKrw: 20000, adSpendKrwExact: "20000", marginKrw: -55000 }, cost: "65,000 원", before: "-50,000 원", final: "-55,000 원" },
    { overrides: { grossCostKrw: null, marginKrw: null, complete: false }, cost: "—", before: "미확정", final: "미확정" },
    { overrides: { adSpendKrw: null, adSpendKrwExact: null, marginKrw: null, complete: false }, cost: "—", before: "미확정", final: "미확정" },
    { overrides: { couponDeductionKrw: null, marginKrw: null, complete: false }, cost: "—", before: "40,000 원", final: "미확정" }
  ];
  for (const item of cases) {
    const sample = { ...row, ...item.overrides };
    const html = render({ ...fixture, products: [sample], summary: { ...fixture.summary, ...item.overrides } });
    for (const part of ["tbody", "tfoot"] as const) {
      const cells = tableRowValues(html, part);
      assert.equal(cells["총비용"], item.cost, `${part} cost`);
      assert.equal(cells["쿠폰 적용 전 마진"], item.before, `${part} before coupon`);
      assert.equal(cells["최종 순마진"], item.final, `${part} final`);
    }
    assert.ok(bottomSummary(html).includes(`최종 순마진</span><strong>${item.final}</strong>`));
  }
});

test("Google sale settings direct readers and managers to shared product/option settings", () => {
  for (const canManage of [false, true]) {
    const html = renderMapping(canManage);
    assert.match(html, /캠페인명 자동 연결/);
    assert.match(html, /유튜브 판매 공통 설정/);
    assert.match(html, /href="\/mappings"/);
    assert.match(html, /상품번호가 달라도/);
    assert.doesNotMatch(html, /<form|변경 영향 미리보기|Google 전용 판매 구성/);
  }
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
  assert.doesNotMatch(html, /상품명 인식 기준|원본 상품A/);
  assert.doesNotMatch(html, /<form/);
});

test("mapping diagnostics retain aliases, legacy IDs and audits with read permission while sales use shared settings", () => {
  const common = { productId: "product-1", productName: "상품A", startDate: "2026-10-25", endDate: null, updatedAt: "2026-10-26T01:00:00Z" };
  const mappings: GoogleMappings = {
    campaignMappingMode: "CAMPAIGN_NAME", nameAutomaticProducts: [{ id: "product-1", displayName: "상품A", name: "원본 상품A" }],
    campaignMappings: [{ ...common, id: "old-mapping", kind: "CAMPAIGN", connectionId: "google-1", campaignId: "legacy-campaign", productNo: null }],
    salesMappings: [{ ...common, id: "sale-mapping", kind: "SALE", connectionId: "cafe24-1", campaignId: null, productNo: "181", optionScope: "PRODUCT", saleUnitLabel: "1+1 세트", salePriceKrwOverride: 34900, productCostKrwOverride: 9000, shippingKrwOverride: 0, extraCostKrwOverride: 0 }],
    audit: [{ id: "audit-1", createdAt: "2026-10-26T01:00:00Z", actorUserId: "audit-user", before: { productId: null }, after: { productId: "product-1" } }], pagination: { page: 1, pageSize: 50, total: 2 }
  };
  const html = renderMapping(true, mappings, fixture);
  assert.doesNotMatch(html, /legacy-campaign|원본 상품A|audit-user|이전 \/ 변경 값/);
  assert.doesNotMatch(html, /<form|수정 \/ 연결 해제|저장된 유튜브 판매 연결/);
  assert.match(html, /유튜브 판매 공통 설정/);
  const query = "from=2026-10-25&to=2026-10-25&productId=product-1";
  const diagnostics = renderMapping(false, mappings, undefined, { diagnostics: true, query });
  for (const value of ["legacy-campaign", "상품A / 원본 상품A", "audit-user", "이전 / 변경 값", "2026-10-25"]) assert.ok(diagnostics.includes(value), value);
  assert.doesNotMatch(diagnostics, /<form|수정 \/ 연결 해제|변경 영향 미리보기/);
  const denied = renderMapping(false, mappings, undefined, { diagnostics: true, canRead: false, query });
  assert.match(denied, /데이터 조회 권한이 없습니다/);
  assert.doesNotMatch(denied, /legacy-campaign|원본 상품A|audit-user/);
});

test("Google navigation respects data.read while keeping legacy Meta and Coupang entries", () => {
  assert.equal(visibleNavGroups(() => false).length, 0);
  const groups = visibleNavGroups((permission) => permission === "data.read");
  assert.equal(groups.find((group) => group.label === "Google")?.items.length, 6);
  assert.ok(groups.find((group) => group.label === "Google")?.items.some((item) => item.href === "/google/daily-report" && item.requiredPermission === "data.read"));
  assert.equal(groups.find((group) => group.label === "Google")?.items.find((item) => item.href === "/google/profit")?.label, "Google 마진");
  assert.ok(groups.find((group) => group.label === "Google")?.items.some((item) => item.href === "/google/diagnostics" && item.requiredPermission === "data.read"));
  assert.ok(groups.some((group) => group.items.some((item) => item.href === "/dashboard")));
  assert.ok(groups.some((group) => group.items.some((item) => item.href === "/coupang/dashboard")));
});

test("profit table displays one complete set with the unchanged server revenue", () => {
  const setRow = { ...row, quantity: 1, saleUnitLabel: "1+1 세트", saleUnitLabels: ["1+1 세트"], revenueKrw: 21900 };
  const html = render({ ...fixture, products: [setRow], daily: [setRow] });
  assert.ok(html.includes("1+1 세트"));
  assert.ok(html.includes("21,900 원"));
  assert.equal(tableRowValues(html, "tbody")["수량"], "1");
  assert.match(html, /title="1\+1 세트"/);
});

test("Google margin displays server aggregate advertising ratios rather than averaging visible products", () => {
  const product = { ...row, impressions: 1000, clicks: 10, ctr: 0.01, cpcKrw: 2000, costPerSaleKrw: 10000 };
  const summary = { ...fixture.summary, impressions: 9000, clicks: 333, ctr: 0.037, cpcKrw: 123.456789, costPerSaleKrw: 4567.891234 };
  const html = render({ ...fixture, products: [product], summary });
  const body = tableRowValues(html, "tbody");
  const footer = tableRowValues(html, "tfoot");
  for (const [header, value] of Object.entries({ "노출수": "1,000", "클릭수": "10", "클릭률": "1%", "클릭당 비용": "2,000 원", "판매 1개당 광고비": "10,000 원" })) assert.equal(body[header], value, header);
  for (const [header, value] of Object.entries({ "노출수": "9,000", "클릭수": "333", "클릭률": "4%", "클릭당 비용": "123 원", "판매 1개당 광고비": "4,568 원" })) assert.equal(footer[header], value, header);
  const bottom = bottomSummary(html);
  assert.match(bottom, /노출수 \/ 클릭수<\/span><strong>9,000 \/ 333<\/strong>/);
  assert.match(bottom, /클릭률<\/span><strong>4%<\/strong>/);
  assert.match(bottom, /클릭당 비용<\/span><strong>123 원<\/strong>/);
  assert.match(bottom, /판매 1개당 광고비<\/span><strong>4,568 원<\/strong>/);
});

test("absent legacy or null advertising metrics remain unknown instead of becoming zero", () => {
  for (const metrics of [{}, { impressions: null, clicks: null, ctr: null, cpcKrw: null, costPerSaleKrw: null }]) {
    const html = render({ ...fixture, products: [{ ...row, ...metrics }], summary: { ...fixture.summary, ...metrics } });
    for (const part of ["tbody", "tfoot"] as const) {
      const cells = tableRowValues(html, part);
      for (const header of ["노출수", "클릭수", "클릭률", "클릭당 비용", "판매 1개당 광고비"]) assert.equal(cells[header], "—", `${part} ${header}`);
      assert.equal(cells["광고비"], "20,000 원");
      assert.equal(cells["광고수익률"], "5배");
    }
    const bottom = bottomSummary(html);
    assert.match(bottom, /노출수 \/ 클릭수<\/span><strong>— \/ —<\/strong>/);
    for (const label of ["클릭률", "클릭당 비용", "판매 1개당 광고비"]) {
      assert.ok(bottom.includes(`${label}</span><strong>—</strong>`), label);
    }
  }
});

test("Google Ads conversion metrics are disclosed as uncollected and sale cost uses Cafe24 units", () => {
  const html = render(fixture, "", "diagnostics");
  assert.match(html, /Google Ads 전환수·전환당 비용·전환가치는 현재 미수집/);
  assert.match(html, /설정가 매출을 Google Ads 전환가치로 표시하지 않습니다/);
  assert.match(html, /판매 1개당 광고비는 카페24 \[유튜브\] 판매수량 기준/);
  assert.match(html, /1\+1은 1세트로 계산/);
  assert.match(html, /Google Ads의 전환당 비용\(CPA\)과 다릅니다/);
  const operational = render(fixture);
  assert.doesNotMatch(operational, /Google Ads 전환수|Google Ads의 전환당 비용/);
  const headers = productTable(operational).match(/<thead>(.*?)<\/thead>/s)?.[1];
  assert.ok(headers);
  assert.match(headers, /판매 1개당 광고비/);
  assert.doesNotMatch(headers, /전환가치|전환수|CPA/);
});
