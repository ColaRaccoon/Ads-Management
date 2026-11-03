import type { DailyProductsReport } from "./daily-products-model";

export const DAILY_EXCEL_PRODUCT_FILTERS = [
  { value: "ALL", label: "전체 제품" }, { value: "STOREFRONT", label: "자사몰" },
  { value: "GOOGLE", label: "구글" }, { value: "COUPANG", label: "쿠팡" }, { value: "NAVER", label: "네이버" }
] as const;
export type DailyExcelProductFilter = typeof DAILY_EXCEL_PRODUCT_FILTERS[number]["value"];
export const DAILY_EXCEL_FILTER_BASIS = "보고일·전일의 원본 보고서 저장 데이터 기준 (0원 포함)";

export function hasDailyExcelProductMembership(report: DailyProductsReport): boolean {
  return report.rows.every(row => Array.isArray(row.exportPlatforms) && row.exportPlatforms.every(platform =>
    DAILY_EXCEL_PRODUCT_FILTERS.some(option => option.value !== "ALL" && option.value === platform)));
}

/** Only the workbook receives this shallow copy. No amount or screen report is changed. */
export function filterDailyProductsForExcel(report: DailyProductsReport, platform: DailyExcelProductFilter): DailyProductsReport {
  if (platform === "ALL") return report;
  const option = DAILY_EXCEL_PRODUCT_FILTERS.find(option => option.value === platform);
  if (!option || !hasDailyExcelProductMembership(report)) throw new Error("플랫폼별 제품 정보를 확인하지 못했습니다. 다시 조회해 주세요.");
  return { ...report, rows: report.rows.filter(row => row.exportPlatforms!.includes(platform)),
    exportSelection: { platform, label: option.label, totalProducts: report.rows.length, basis: DAILY_EXCEL_FILTER_BASIS } };
}

export function dailyExcelFileName(report: DailyProductsReport): string {
  const selection = report.exportSelection;
  return `제품통합_데일리_${selection ? `${selection.label}제품` : "전체제품"}_${report.date}.xlsx`;
}
