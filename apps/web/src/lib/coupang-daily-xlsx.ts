import type { CoupangDailyExportRow } from "./coupang-daily-report";
import {
  buildXlsxWorkbook,
  type XlsxBorderTone,
  type XlsxCell,
  type XlsxCellFill,
  type XlsxCellStyle,
  type XlsxFontTone,
  type XlsxMergeRange,
  type XlsxRow,
  type XlsxWorkbookInput
} from "./xlsx";

export const DAILY_SALES_INCREASE_HIGHLIGHT_THRESHOLD = 10;
export const DAILY_SALES_DECREASE_HIGHLIGHT_THRESHOLD = 10;
export const DAILY_SALES_DECREASE_RATIO_THRESHOLD = 0.5;

export type DailySalesQuantityHighlight =
  | "INCREASE"
  | "SIGNIFICANT_DECREASE"
  | "NONE";

type CoupangDailyXlsxColumnKey =
  | "productName"
  | "reportedSalesKrw"
  | "previousReportedSalesKrw"
  | "reportedSalesQuantity"
  | "previousReportedSalesQuantity"
  | "manualPurchaseQuantity"
  | "roas"
  | "organicSalesKrw"
  | "marginKrw"
  | "previousMarginKrw";

export type CoupangDailyXlsxColumn = {
  key: CoupangDailyXlsxColumnKey;
  header: string;
  style: XlsxCellStyle;
  width: number;
  value: (row: CoupangDailyExportRow) => string | number | null | undefined;
};

export const COUPANG_DAILY_XLSX_COLUMNS: CoupangDailyXlsxColumn[] = [
  { key: "productName", header: "제품명", style: "Text", width: 34, value: xlsxProductName },
  { key: "reportedSalesKrw", header: "매출", style: "Krw", width: 16, value: (row) => row.reportedSalesKrw },
  {
    key: "previousReportedSalesKrw",
    header: "직전 기간 매출",
    style: "Krw",
    width: 17,
    value: (row) => row.previousReportedSalesKrw
  },
  {
    key: "reportedSalesQuantity",
    header: "판매수",
    style: "Number",
    width: 11,
    value: (row) => row.reportedSalesQuantity
  },
  {
    key: "previousReportedSalesQuantity",
    header: "직전 기간 판매수",
    style: "Number",
    width: 15,
    value: (row) => row.previousReportedSalesQuantity
  },
  {
    key: "manualPurchaseQuantity",
    header: "가구매 수",
    style: "Number",
    width: 12,
    value: (row) => row.manualPurchaseQuantity
  },
  {
    key: "roas",
    header: "광고수익률(집행상품 기준)",
    style: "Percent1",
    width: 25,
    value: (row) => row.roas
  },
  {
    key: "organicSalesKrw",
    header: "오가닉매출(판매상품 기준)",
    style: "Krw",
    width: 25,
    value: (row) => row.organicSalesKrw
  },
  { key: "marginKrw", header: "최종순이익", style: "Krw", width: 18, value: (row) => row.marginKrw },
  {
    key: "previousMarginKrw",
    header: "직전 기간 최종 순이익",
    style: "Krw",
    width: 20,
    value: (row) => row.previousMarginKrw
  }
];

const PRODUCT_BANDS: XlsxCellFill[] = [
  "GROUP_MINT",
  "GROUP_BLUE",
  "GROUP_SAND",
  "GROUP_LILAC"
];
const NOTE_ROW_MIN_HEIGHT = 42;
const NOTE_ROW_MAX_HEIGHT = 120;
const NOTE_ROW_LINE_HEIGHT = 18;
const NOTE_ROW_HORIZONTAL_UNITS = 140;

export function classifyDailySalesQuantityHighlight(
  row: CoupangDailyExportRow
): DailySalesQuantityHighlight {
  if (row.rowKind !== "그룹합계" && row.rowKind !== "옵션" && row.rowKind !== "단일제품") {
    return "NONE";
  }

  const currentSales = finiteExportNumber(row.reportedSalesQuantity);
  const currentManualPurchases = finiteExportNumber(row.manualPurchaseQuantity);
  const previousSales = finiteExportNumber(row.previousReportedSalesQuantity);
  const previousManualPurchases = finiteExportNumber(row.previousManualPurchaseQuantity);
  if (
    currentSales === null ||
    currentManualPurchases === null ||
    previousSales === null ||
    previousManualPurchases === null
  ) {
    return "NONE";
  }

  const adjustedDelta =
    currentSales -
    currentManualPurchases -
    previousSales +
    previousManualPurchases;
  if (adjustedDelta > DAILY_SALES_INCREASE_HIGHLIGHT_THRESHOLD) {
    return "INCREASE";
  }

  const decreaseAmount = -adjustedDelta;
  const isLargeAbsoluteDecrease =
    decreaseAmount >= DAILY_SALES_DECREASE_HIGHLIGHT_THRESHOLD;
  const isLargeRelativeDecrease =
    previousSales > 0 &&
    decreaseAmount >= previousSales * DAILY_SALES_DECREASE_RATIO_THRESHOLD;
  if (isLargeAbsoluteDecrease || isLargeRelativeDecrease) {
    return "SIGNIFICANT_DECREASE";
  }
  return "NONE";
}

export function buildCoupangDailyXlsxInput(
  exportRows: CoupangDailyExportRow[]
): XlsxWorkbookInput {
  const filteredRows = filterCoupangDailyXlsxRows(exportRows);
  const rows: Array<XlsxCell[] | XlsxRow> = [
    COUPANG_DAILY_XLSX_COLUMNS.map((column): XlsxCell => ({
      value: column.header,
      style: "Header",
      fill: "REPORT_HEADER",
      fontTone: "INVERSE",
      bold: true,
      borderTone: "GRID"
    }))
  ];
  const merges: XlsxMergeRange[] = [];

  for (const row of filteredRows) {
    if (row.rowKind === "기타사항") {
      const excelRow = rows.length + 1;
      rows.push(noteRow(row));
      merges.push({
        fromRow: excelRow,
        fromColumn: 1,
        toRow: excelRow,
        toColumn: COUPANG_DAILY_XLSX_COLUMNS.length
      });
    } else {
      rows.push(COUPANG_DAILY_XLSX_COLUMNS.map((column) => toXlsxCell(row, column)));
    }
  }

  return {
    sheetName: "Coupang Daily Report",
    columns: COUPANG_DAILY_XLSX_COLUMNS.map((column) => ({ width: column.width })),
    rows,
    merges,
    freezeRow: 1,
    autoFilter: { fromRow: 1, toRow: rows.length }
  };
}

export function buildCoupangDailyXlsxWorkbook(exportRows: CoupangDailyExportRow[]) {
  return buildXlsxWorkbook(buildCoupangDailyXlsxInput(exportRows));
}

export function filterCoupangDailyXlsxRows(
  exportRows: CoupangDailyExportRow[]
): CoupangDailyExportRow[] {
  const filteredRows: CoupangDailyExportRow[] = [];
  let visualBlockIndex = 0;

  for (let rowIndex = 0; rowIndex < exportRows.length;) {
    const row = exportRows[rowIndex];
    if (row.visualBlockKey === null) {
      filteredRows.push(row);
      rowIndex += 1;
      continue;
    }

    const blockKey = row.visualBlockKey;
    const blockRows: CoupangDailyExportRow[] = [];
    while (
      rowIndex < exportRows.length &&
      exportRows[rowIndex]?.visualBlockKey === blockKey
    ) {
      blockRows.push(exportRows[rowIndex]);
      rowIndex += 1;
    }

    const visibleBlockRows = filterSalesActiveBlock(blockRows);
    if (visibleBlockRows.length === 0) continue;
    filteredRows.push(...visibleBlockRows.map((blockRow) => ({
      ...blockRow,
      visualBlockIndex
    })));
    visualBlockIndex += 1;
  }

  return filteredRows;
}

function filterSalesActiveBlock(blockRows: CoupangDailyExportRow[]) {
  const groupTotal = blockRows.find((row) => row.rowKind === "그룹합계");
  if (groupTotal) {
    const visibleOptions = blockRows.filter(
      (row) => row.rowKind === "옵션" && hasReportableSalesActivity(row)
    );
    if (!hasReportableSalesActivity(groupTotal) && visibleOptions.length === 0) {
      return [];
    }
    return blockRows
      .filter((row) => row.rowKind !== "옵션" || hasReportableSalesActivity(row))
      .map((row) => row === groupTotal
        ? { ...row, visualChildProductCount: visibleOptions.length }
        : row);
  }

  const singleProduct = blockRows.find((row) => row.rowKind === "단일제품");
  if (singleProduct) {
    return hasReportableSalesActivity(singleProduct) ? blockRows : [];
  }

  const visibleProducts = blockRows.filter(
    (row) => row.rowKind === "옵션" && hasReportableSalesActivity(row)
  );
  return visibleProducts.length > 0
    ? blockRows.filter((row) => row.rowKind !== "옵션" || hasReportableSalesActivity(row))
    : [];
}

function hasReportableSalesActivity(row: CoupangDailyExportRow) {
  return [
    row.reportedSalesQuantity,
    row.manualPurchaseQuantity,
    row.previousManualPurchaseQuantity
  ].some((value) => {
    const quantity = finiteExportNumber(value);
    return quantity !== null && quantity !== 0;
  });
}

function toXlsxCell(
  row: CoupangDailyExportRow,
  column: CoupangDailyXlsxColumn
): XlsxCell {
  const isTotal = row.rowKind === "전체합계" || row.rowKind === "선택합계";
  const isBlockHeader = row.rowKind === "그룹합계" || row.rowKind === "단일제품";
  const cell: XlsxCell = {
    value: column.value(row),
    style: column.style,
    fill: isTotal ? "REPORT_TOTAL" : fillForBlockIndex(row.visualBlockIndex),
    fontTone: "DEFAULT",
    bold: isTotal || isBlockHeader,
    indent: column.key === "productName" ? row.indentLevel : 0,
    borderTone: isBlockHeader ? "BLOCK_START" : "GRID"
  };

  if (column.key === "reportedSalesQuantity" && !isTotal) {
    const highlight = classifyDailySalesQuantityHighlight(row);
    if (highlight === "INCREASE") {
      applySalesHighlight(cell, "SALES_INCREASE", "INCREASE", "INCREASE");
    } else if (highlight === "SIGNIFICANT_DECREASE") {
      applySalesHighlight(cell, "SALES_DECREASE", "DECREASE", "DECREASE");
    }
  }

  if (!isTotal && (column.key === "marginKrw" || column.key === "previousMarginKrw")) {
    cell.fontTone = profitFontTone(column.value(row)) ?? cell.fontTone;
  }

  return cell;
}

function applySalesHighlight(
  cell: XlsxCell,
  fill: XlsxCellFill,
  fontTone: XlsxFontTone,
  borderTone: XlsxBorderTone
) {
  cell.fill = fill;
  cell.fontTone = fontTone;
  cell.bold = true;
  cell.borderTone = borderTone;
}

function noteRow(row: CoupangDailyExportRow): XlsxRow {
  const lastColumnIndex = COUPANG_DAILY_XLSX_COLUMNS.length - 1;
  const fill = fillForBlockIndex(row.visualBlockIndex);
  return {
    height: noteRowHeight(row.productName),
    cells: COUPANG_DAILY_XLSX_COLUMNS.map((_, columnIndex): XlsxCell => ({
      value: columnIndex === 0 ? row.productName : "",
      style: "Text",
      fill,
      fontTone: "DEFAULT",
      wrapText: columnIndex === 0,
      borderTone: columnIndex === 0
        ? "MERGED_START"
        : columnIndex === lastColumnIndex
          ? "MERGED_END"
          : "MERGED_MIDDLE"
    }))
  };
}

function noteRowHeight(text: string) {
  const lineCount = text.split(/\r\n?|\n/).reduce((total, line) => {
    const horizontalUnits = Array.from(line).reduce(
      (sum, character) => sum + (/^[\x00-\x7F]$/.test(character) ? 1 : 2),
      0
    );
    return total + Math.max(1, Math.ceil(horizontalUnits / NOTE_ROW_HORIZONTAL_UNITS));
  }, 0);
  const estimatedHeight = 12 + lineCount * NOTE_ROW_LINE_HEIGHT;
  return Math.min(
    NOTE_ROW_MAX_HEIGHT,
    Math.max(NOTE_ROW_MIN_HEIGHT, estimatedHeight)
  );
}

function fillForBlockIndex(blockIndex: number | null) {
  return blockIndex === null
    ? undefined
    : PRODUCT_BANDS[blockIndex % PRODUCT_BANDS.length];
}

function xlsxProductName(row: CoupangDailyExportRow) {
  if (row.rowKind === "그룹합계") {
    return `Σ ${row.productName} (그룹 합계 · 옵션 ${row.visualChildProductCount ?? 0}개)`;
  }
  return row.productName;
}

function profitFontTone(value: string | number | null | undefined): XlsxFontTone | undefined {
  const amount = finiteExportNumber(value);
  if (amount === null || amount === 0) return undefined;
  return amount > 0 ? "POSITIVE" : "NEGATIVE";
}

function finiteExportNumber(value: string | number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
