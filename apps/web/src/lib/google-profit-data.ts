import type { GoogleProfitRow, GoogleReportResponse } from "../types/google";

const PRODUCT_PAGE_SIZE = 50;
const PRODUCTS_CHANGED_MESSAGE = "조회 중 Google 데이터가 변경되었거나 일부 상품을 읽지 못했습니다. 새로고침해 주세요.";

/** Load all products for the scroll table or export; reject partial or inconsistent reports. */
export async function loadGoogleProfitProducts(
  query: string,
  fetchReport: (query: string) => Promise<GoogleReportResponse>,
  changedMessage = PRODUCTS_CHANGED_MESSAGE
): Promise<GoogleReportResponse> {
  const params = new URLSearchParams(query);
  params.set("pageSize", String(PRODUCT_PAGE_SIZE));
  let first: GoogleReportResponse | undefined;
  const products: GoogleProfitRow[] = [];
  const seen = new Set<string | null>();
  for (let page = 1; ; page += 1) {
    params.set("page", String(page));
    const data = await fetchReport(params.toString());
    const { pagination } = data;
    const total = pagination.total;
    if (!Number.isSafeInteger(total) || total < 0 || pagination.page !== page || pagination.pageSize !== PRODUCT_PAGE_SIZE) {
      throw new Error(changedMessage);
    }
    const expectedCount = Math.min(PRODUCT_PAGE_SIZE, Math.max(0, total - (page - 1) * PRODUCT_PAGE_SIZE));
    if (data.products.length !== expectedCount ||
      (params.get("from") && data.range.from !== params.get("from")) ||
      (params.get("to") && data.range.to !== params.get("to"))) {
      throw new Error(changedMessage);
    }
    if (first && (total !== first.pagination.total ||
      JSON.stringify(data.range) !== JSON.stringify(first.range) ||
      JSON.stringify(data.summary) !== JSON.stringify(first.summary) ||
      JSON.stringify(data.completeness) !== JSON.stringify(first.completeness) ||
      JSON.stringify(data.reconciliation) !== JSON.stringify(first.reconciliation))) {
      throw new Error(changedMessage);
    }
    first ??= data;
    for (const row of data.products) {
      if (seen.has(row.productId)) throw new Error(changedMessage);
      seen.add(row.productId);
      products.push(row);
    }
    if (products.length === total) {
      return { ...first, products, pagination: { page: 1, pageSize: Math.max(total, 1), total } };
    }
  }
}

