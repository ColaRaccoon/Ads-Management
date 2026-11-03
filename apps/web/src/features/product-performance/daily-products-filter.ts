import type { DailyProductsReport } from "./daily-products-model";

export const DAILY_EXCEL_PRODUCT_FILTERS = [
  { value: "ALL", label: "전체 제품" }, { value: "STOREFRONT", label: "자사몰" },
  { value: "GOOGLE", label: "구글" }, { value: "COUPANG", label: "쿠팡" }, { value: "NAVER", label: "네이버" }
] as const;
export type DailyExcelProductFilter = typeof DAILY_EXCEL_PRODUCT_FILTERS[number]["value"];
export const DAILY_EXCEL_FILTER_BASIS = "보고일 당일 판매 0건·광고비 0원 제품 제외 (미확정은 0으로 보지 않음)";

export function hasDailyExcelProductMembership(report: DailyProductsReport): boolean {
  return report.exportActivityVersion === 2 && report.rows.every(row => Array.isArray(row.exportPlatforms) && row.exportPlatforms.every(platform =>
    DAILY_EXCEL_PRODUCT_FILTERS.some(option => option.value !== "ALL" && option.value === platform)));
}

/** Only the workbook receives this shallow copy. No amount or screen report is changed. */
export function filterDailyProductsForExcel(report: DailyProductsReport, platform: DailyExcelProductFilter): DailyProductsReport {
  const option = DAILY_EXCEL_PRODUCT_FILTERS.find(option => option.value === platform);
  if (!option || !hasDailyExcelProductMembership(report)) throw new Error("플랫폼별 제품 정보를 확인하지 못했습니다. 다시 조회해 주세요.");
  return { ...report, rows: report.rows.filter(row => platform === "ALL" ? row.exportPlatforms!.length > 0 : row.exportPlatforms!.includes(platform)),
    exportSelection: { platform, label: platform === "ALL" ? "전체" : option.label, totalProducts: report.rows.length, basis: DAILY_EXCEL_FILTER_BASIS } };
}

export function dailyExcelFileName(report: DailyProductsReport): string {
  const selection = report.exportSelection;
  return `제품통합_데일리_${selection && selection.platform !== "ALL" ? `${selection.label}제품` : "전체제품"}_${report.date}.xlsx`;
}
