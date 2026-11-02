import { ApiError } from "@/lib/api";
import { assertResponse, filterParams, readPerformance, shiftDate, validateFilters, type Reader } from "./model";
import { buildDailyProductsReport, type DailyProductsReport, type DailyProductsResponse } from "./daily-products-model";
import type { DashboardData, Filters } from "./types";

export type DailyProductsData = DailyProductsResponse & DashboardData & { report: DailyProductsReport };

const changed = () => new ApiError(409, "전체 제품 보고서의 조회 범위 또는 발행 버전이 바뀌었습니다. 다시 조회해 주세요.", "UNIFIED_DAILY_PRODUCTS_CHANGED");

/** One response owns the selected-product summary and the entire product appendix. */
export function validateDailyProductsResponse(data: DailyProductsResponse, filters: Filters) {
  assertResponse(data.summary, filters);
  assertResponse(data.timeseries, filters, data.summary);
  if (data.reportDate !== filters.to || data.previousDate !== shiftDate(filters.to, -1) ||
      !Number.isSafeInteger(data.totalProducts) || data.totalProducts < 0 ||
      data.nextCursor !== null || !Array.isArray(data.products) || data.products.length !== data.totalProducts ||
      data.timeseries.nextCursor !== null || data.timeseries.total !== 2 || data.timeseries.items.length !== 2 ||
      !data.allProducts?.current || !data.allProducts?.previous) throw changed();
  const dates = new Set(data.timeseries.items.map(row => row.date));
  if (dates.size !== 2 || !dates.has(data.reportDate) || !dates.has(data.previousDate) ||
      data.timeseries.items.some(row => row.date !== row.bucketFrom || row.date !== row.bucketTo)) throw changed();
  const keys = new Set<string>();
  for (const row of data.products) {
    if (typeof row.productKey !== "string" || !row.productKey || keys.has(row.productKey) ||
        typeof row.productName !== "string" || !row.productName || !row.current || !row.previous) throw changed();
    keys.add(row.productKey);
  }
}

export async function loadDailyProducts(filters: Filters, read: Reader = readPerformance, signal?: AbortSignal): Promise<DailyProductsData> {
  const invalid = validateFilters(filters);
  if (invalid) throw new Error(invalid);
  if (filters.grain !== "day" || filters.from !== shiftDate(filters.to, -1) ||
      filters.compareFrom !== filters.from || filters.compareTo !== filters.from) {
    throw new Error("데일리 보고는 보고일과 바로 전날을 조회해야 합니다.");
  }
  const params = filterParams(filters);
  for (let attempt = 0; ; attempt++) {
    try {
      signal?.throwIfAborted();
      const data = await read<DailyProductsResponse>(`/unified-performance/daily-products?${params}`, signal);
      signal?.throwIfAborted();
      validateDailyProductsResponse(data, filters);
      const report = buildDailyProductsReport(data, filters.to, filters);
      return { ...data, report, diagnostics: { ...data.summary, items: [], total: 0, nextCursor: null } };
    } catch (error) {
      if (attempt === 0 && error instanceof ApiError &&
          ["UNIFIED_DAILY_PRODUCTS_CHANGED", "UNIFIED_DASHBOARD_CHANGED", "UNIFIED_CURSOR_CHANGED"].includes(error.code ?? "")) continue;
      throw error;
    }
  }
}
