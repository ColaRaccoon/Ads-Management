import type { GoogleProfitRow, GoogleReportResponse } from "../types/google";
import { loadGoogleProfitProducts } from "./google-profit-data";
import { googleProfitView } from "./google-profit-view";
import { buildXlsxWorkbook, type XlsxCell, type XlsxCellStyle, type XlsxRow } from "./xlsx";

const EXPORT_CHANGED_MESSAGE = "조회 중 Google 데이터가 변경되었거나 일부 상품을 읽지 못했습니다. 다시 다운로드해 주세요.";

export function loadGoogleProfitExport(query: string, fetchReport: (query: string) => Promise<GoogleReportResponse>) {
  return loadGoogleProfitProducts(query, fetchReport, EXPORT_CHANGED_MESSAGE);
}

function numberCell(value: number | null | undefined, style: XlsxCellStyle): XlsxCell {
  // A missing value stays visibly blank, distinct from a measured zero.
  return { value: value != null && Number.isFinite(value) ? value : "", style };
}

function profitCells(row: GoogleProfitRow, label: string, total = false): XlsxCell[] {
  const view = googleProfitView(row);
  const money: XlsxCellStyle = total ? "TotalKrw" : "Krw";
  const number: XlsxCellStyle = total ? "TotalNumber" : "Number";
  const percent: XlsxCellStyle = total ? "TotalPercent0" : "Percent0";
  const text: XlsxCellStyle = total ? "TotalText" : "Text";
  return [
    { value: label, style: text },
    numberCell(row.quantity, number),
    numberCell(row.revenueKrw, money),
    numberCell(row.couponDeductionKrw, money),
    numberCell(row.adSpendKrw, money),
    numberCell(view.totalCostKrw, money),
    numberCell(view.marginBeforeCouponKrw, money),
    numberCell(row.marginKrw, money),
    numberCell(row.roas, percent),
    numberCell(row.costPerSaleKrw, money),
    numberCell(row.marginRate, percent),
    numberCell(row.impressions, number),
    numberCell(row.clicks, number),
    numberCell(row.ctr, percent),
    numberCell(row.cpcKrw, money),
    { value: row.complete ? "확정" : "미확정", style: text }
  ];
}

export function googleProfitExcelFileName(range: GoogleReportResponse["range"]) {
  const datePart = range.from === range.to ? range.from : `${range.from}~${range.to}`;
  return `${datePart}_Google_마진.xlsx`;
}

export function buildGoogleProfitExcel(
  data: GoogleReportResponse,
  productName: (id: string | null) => string,
  options: { generatedAt?: Date; filterLabel?: string } = {}
): Uint8Array {
  if (data.products.length !== data.pagination.total ||
    new Set(data.products.map((row) => row.productId)).size !== data.products.length) {
    throw new Error(EXPORT_CHANGED_MESSAGE);
  }
  const datePart = data.range.from === data.range.to ? data.range.from : `${data.range.from}~${data.range.to}`;
  const headerRow = 4;
  const rows: Array<XlsxCell[] | XlsxRow> = [
    { height: 48, cells: [
      { value: "조회 기간", style: "Header" },
      { value: datePart, style: "Text", wrapText: true },
      { value: "생성 시각", style: "Header" },
      { value: (options.generatedAt ?? new Date()).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }), style: "Text", wrapText: true }
    ] },
    { height: 36, cells: [{ value: "조회 조건", style: "Header" }, { value: options.filterLabel ?? "전체", style: "Text", wrapText: true }] },
    [],
    ["제품", "수량", "매출", "쿠폰 차감", "광고비", "총비용", "쿠폰 적용 전 마진", "최종 순마진", "광고수익률", "판매 1개당 광고비", "마진율", "노출수", "클릭수", "클릭률", "클릭당 비용", "상태"].map((value) => ({ value, style: "Header" })),
    ...data.products.map((row) => profitCells(row, productName(row.productId))),
    profitCells(data.summary, "합계", true)
  ];
  return buildXlsxWorkbook({
    sheetName: "Google 마진",
    columns: [28, 11, 15, 15, 15, 15, 19, 15, 13, 19, 13, 15, 15, 13, 15, 13].map((width) => ({ width })),
    rows,
    merges: [{ fromRow: 2, fromColumn: 2, toRow: 2, toColumn: 8 }],
    freezeRow: headerRow,
    autoFilter: { fromRow: headerRow, toRow: headerRow + data.products.length }
  });
}
