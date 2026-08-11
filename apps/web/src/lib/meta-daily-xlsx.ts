import {
  buildXlsxWorkbook,
  type XlsxBorderTone,
  type XlsxCell,
  type XlsxCellFill,
  type XlsxCellStyle,
  type XlsxMergeRange,
  type XlsxRow,
  type XlsxWorkbookInput
} from "./xlsx";
import { META_DAILY_COLUMNS, type MetaDailyColumnKey } from "./meta-daily-columns";
import { formatMetaDeliveryStatus, META_VIDEO_RATE_COLUMNS, percentToRatio } from "./meta-video-display";
import type { MetaCreativePerformanceRow } from "@/types/meta";

export type { MetaDailyColumnKey } from "./meta-daily-columns";
export type MetaDailyCreativeRow = MetaCreativePerformanceRow;

export type MetaDailyProductTotals = {
  spendUsd: number;
  spendKrw: number | null;
  purchaseCount: number;
  cpaUsd: number | null;
  cpaKrw: number | null;
  revenueKrw: number | null;
  roas: number | null;
};

export type MetaDailySalesRow = {
  productId: string;
  product?: { displayName?: string | null; name?: string | null; code?: string | null } | null;
  quantity: number;
  revenueKrw: number;
  totalPaidKrw: number;
  adSpendUsd?: number | null;
  adSpendKrw: number | null;
  grossCostKrw: number | null;
  totalCostKrw: number | null;
  marginBeforeCouponKrw: number | null;
  couponDeductionKrw: number;
  marginKrw: number | null;
  marginRate: number | null;
  matchedSalesLineCount: number;
  couponOrderCount: number;
  couponExactOrderCount: number;
  couponEstimatedOrderCount: number;
  couponUnmatchedOrderCount: number;
  couponIgnoredResidualKrw: number;
};

export type MetaDailyExportGroup = {
  productName: string;
  productId: string | null;
  rows: MetaDailyCreativeRow[];
  totals: MetaDailyProductTotals;
  salesRow: MetaDailySalesRow | null;
};

export type MetaDailyXlsxReport = {
  reportDate: string;
  productCount: number;
  totals: MetaDailyProductTotals;
  groups: MetaDailyExportGroup[];
  visibleColumns: MetaDailyColumnKey[];
};

type ExpandedCreativeColumn = {
  header: string;
  width: number;
  cell: (current: MetaDailyCreativeRow) => XlsxCell;
};

const META_DAILY_COLUMN_ORDER: MetaDailyColumnKey[] = META_DAILY_COLUMNS.map((column) => column.key);

const PRODUCT_BANDS: XlsxCellFill[] = [
  "GROUP_MINT",
  "GROUP_BLUE",
  "GROUP_SAND",
  "GROUP_LILAC"
];

const SALES_HEADERS = [
  "제품",
  "판매수량",
  "실매출",
  "실결제액",
  "상품 비용",
  "광고비",
  "쿠폰 차감",
  "총비용",
  "쿠폰 적용 전 마진",
  "최종 순마진",
  "마진율"
];

const SUMMARY_HEADERS = ["제품수", "총 광고비 KRW", "총 구매건수", "전체 CPA", "전체 ROAS"];
const SALES_SECTION_TITLE = "카페24 실매출 기반 마진";
const META_DAILY_MIN_COLUMN_COUNT = 13;

export function buildMetaDailyXlsxInput(report: MetaDailyXlsxReport): XlsxWorkbookInput {
  const creativeColumns = expandCreativeColumns(report.visibleColumns);
  const columnCount = Math.max(
    META_DAILY_MIN_COLUMN_COUNT,
    creativeColumns.length,
    SALES_HEADERS.length,
    SUMMARY_HEADERS.length
  );
  const widths = Array.from({ length: columnCount }, (_, index) => {
    const creativeWidth = creativeColumns[index]?.width ?? 0;
    const baseWidth = index === 0 ? 34 : 15;
    return Math.max(baseWidth, creativeWidth);
  });
  const rows: Array<XlsxCell[] | XlsxRow> = [];
  const merges: XlsxMergeRange[] = [];

  addMergedRow(
    rows,
    merges,
    `Meta Daily Report · 기준일 ${report.reportDate}`,
    columnCount,
    "REPORT_HEADER",
    "INVERSE",
    true,
    28
  );
  rows.push(padRow(summaryHeaderRow(), columnCount, summaryPaddingCell()));
  rows.push(padRow(summaryValueRow(report), columnCount, summaryPaddingCell()));

  report.groups.forEach((group, groupIndex) => {
    const fill = PRODUCT_BANDS[groupIndex % PRODUCT_BANDS.length];
    rows.push(productHeaderRow(group, fill, columnCount));

    if (group.rows.length > 0) {
      rows.push(padRow(
        creativeColumns.map((column): XlsxCell => bandCell(column.header, "Header", fill, true)),
        columnCount,
        bandCell("", "Text", fill, true)
      ));
      for (const current of group.rows) {
        rows.push(padRow(
          creativeColumns.map((column) => ({
            ...column.cell(current),
            fill,
            borderTone: "GRID"
          })),
          columnCount,
          bandCell("", "Text", fill)
        ));
      }
    } else {
      addMergedRow(
        rows,
        merges,
        "표시할 Meta 소재가 없습니다.",
        columnCount,
        fill,
        "DEFAULT"
      );
    }

    addMergedRow(rows, merges, SALES_SECTION_TITLE, columnCount, fill, "DEFAULT", true);
    if (group.salesRow) {
      rows.push(padRow(
        SALES_HEADERS.map((header) => bandCell(header, "Header", fill, true)),
        columnCount,
        bandCell("", "Text", fill, true)
      ));
      rows.push(padRow(salesDataRow(group.salesRow, fill), columnCount, bandCell("", "Text", fill)));
      for (const note of salesNotes(group.salesRow)) {
        addMergedRow(rows, merges, note, columnCount, fill, "DEFAULT");
      }
    } else {
      addMergedRow(
        rows,
        merges,
        "매칭되는 카페24 실매출 데이터가 없습니다.",
        columnCount,
        fill,
        "DEFAULT"
      );
    }

    addMergedRow(
      rows,
      merges,
      `광고 수정 기록 · ${report.reportDate} ${group.productName}에 등록된 기록이 없습니다.`,
      columnCount,
      fill,
      "DEFAULT"
    );
  });

  return {
    sheetName: "Meta Daily Report",
    columns: widths.map((width) => ({ width })),
    rows,
    merges,
    freezeRow: 3
  };
}

export function buildMetaDailyXlsxWorkbook(report: MetaDailyXlsxReport) {
  return buildXlsxWorkbook(buildMetaDailyXlsxInput(report));
}

function expandCreativeColumns(visibleColumns: MetaDailyColumnKey[]): ExpandedCreativeColumn[] {
  const selected = new Set(visibleColumns);
  if (selected.has("spendUsd")) selected.add("spendKrw");
  selected.delete("spendUsd");
  return META_DAILY_COLUMN_ORDER.flatMap((key) => selected.has(key) ? creativeColumnsFor(key) : []);
}

function creativeColumnsFor(key: MetaDailyColumnKey): ExpandedCreativeColumn[] {
  switch (key) {
    case "creative":
      return [{
        header: "소재",
        width: 34,
        cell: (current) => ({
          value: current.displayName,
          style: "Text"
        })
      }];
    case "status":
      return [{
        header: "활성상태",
        width: 12,
        cell: (current) => textCell(formatMetaDeliveryStatus(current.deliveryStatus))
      }];
    case "dataDays":
      return [{
        header: "집계일수",
        width: 11,
        cell: (current) => numberCell(current.dataDays)
      }];
    case "spendUsd":
      return [];
    case "spendKrw":
      return [metricColumn("광고비 KRW", 16, (row) => moneyCell(row.totals.spendKrw, "Krw"))];
    case "purchaseCount":
      return [metricColumn("구매건수", 12, (row) => numberCell(row.totals.purchaseCount))];
    case "cpa":
      return [metricColumn("CPA", 15, (row) => cpaCell(row.totals))];
    case "ctr":
      return [metricColumn(
        "CTR",
        12,
        (row) => percentCell(percentToRatio(row.totals.ctrLinkPct))
      )];
    case "cpm":
      return [metricColumn("CPM", 14, (row) => moneyCell(row.totals.cpmUsd, "Usd"))];
    case "reach":
      return [metricColumn("도달", 12, (row) => numberCell(row.totals.reach))];
    case "videoPlay3sRatePct":
    case "videoPlay25RatePct":
    case "videoPlay50RatePct":
    case "videoPlay75RatePct":
    case "videoPlay100RatePct": {
      const definition = META_VIDEO_RATE_COLUMNS.find((column) => column.key === key);
      if (!definition) return [];
      return [metricColumn(
        definition.label,
        13,
        (row) => percentCell(percentToRatio(row.totals[key]))
      )];
    }
    case "roas":
      return [metricColumn("ROAS", 12, (row) => percentCell(row.totals.roas))];
  }
}

function metricColumn(
  label: string,
  width: number,
  cell: (row: MetaDailyCreativeRow) => XlsxCell
): ExpandedCreativeColumn {
  return { header: label, width, cell };
}

function summaryHeaderRow(): XlsxCell[] {
  return SUMMARY_HEADERS.map((header) => ({
    value: header,
    style: "Header",
    fill: "REPORT_TOTAL",
    bold: true,
    borderTone: "GRID"
  }));
}

function summaryValueRow(report: MetaDailyXlsxReport): XlsxCell[] {
  return [
    totalCell(report.productCount, "TotalNumber"),
    totalCell(report.totals.spendKrw, "TotalKrw"),
    totalCell(report.totals.purchaseCount, "TotalNumber"),
    totalCpaCell(report.totals),
    totalCell(report.totals.roas, "TotalPercent")
  ];
}

function summaryPaddingCell(): XlsxCell {
  return {
    value: "",
    style: "Text",
    fill: "REPORT_TOTAL",
    borderTone: "GRID"
  };
}

function productHeaderRow(group: MetaDailyExportGroup, fill: XlsxCellFill, columnCount: number): XlsxCell[] {
  const cells: XlsxCell[] = [
    bandCell(group.productName, "Text", fill, true, "BLOCK_START"),
    bandCell("소재 수", "Text", fill, true, "BLOCK_START"),
    bandCell(group.rows.length, "Number", fill, true, "BLOCK_START"),
    bandCell("광고비 KRW", "Text", fill, true, "BLOCK_START"),
    bandCell(group.totals.spendKrw, "Krw", fill, true, "BLOCK_START"),
    bandCell("구매", "Text", fill, true, "BLOCK_START"),
    bandCell(group.totals.purchaseCount, "Number", fill, true, "BLOCK_START"),
    bandCell("CPA", "Text", fill, true, "BLOCK_START"),
    { ...cpaCell(group.totals), fill, bold: true, borderTone: "BLOCK_START" },
    bandCell("ROAS", "Text", fill, true, "BLOCK_START"),
    bandCell(group.totals.roas, "Percent", fill, true, "BLOCK_START")
  ];
  return padRow(cells, columnCount, bandCell("", "Text", fill, true, "BLOCK_START"));
}

function salesDataRow(row: MetaDailySalesRow, fill: XlsxCellFill): XlsxCell[] {
  return [
    { ...textCell(`${salesProductLabel(row)}\n판매 행 ${row.matchedSalesLineCount}`), wrapText: true, fill, borderTone: "GRID" },
    bandCell(row.quantity, "Number", fill),
    bandCell(row.revenueKrw, "Krw", fill),
    bandCell(row.totalPaidKrw, "Krw", fill),
    bandCell(row.grossCostKrw, "Krw", fill),
    bandCell(row.adSpendKrw, "Krw", fill),
    bandCell(row.couponDeductionKrw, "Krw", fill),
    bandCell(row.totalCostKrw, "Krw", fill),
    profitCell(row.marginBeforeCouponKrw, fill),
    profitCell(row.marginKrw, fill),
    bandCell(row.marginRate, "Percent", fill)
  ];
}

function salesNotes(row: MetaDailySalesRow) {
  const notes: string[] = [];
  if (row.couponOrderCount > 0 || row.couponIgnoredResidualKrw > 0) {
    notes.push(
      `쿠폰 적용 ${formatNumber(row.couponOrderCount)}건 · 정확 ${formatNumber(row.couponExactOrderCount)}건 · ` +
      `추정 ${formatNumber(row.couponEstimatedOrderCount)}건 · 무시 잔여 ${formatKrw(row.couponIgnoredResidualKrw)}`
    );
  }
  if (row.couponUnmatchedOrderCount > 0) {
    notes.push(`쿠폰 기록이 있으나 금액을 찾지 못한 주문 ${formatNumber(row.couponUnmatchedOrderCount)}건`);
  }
  if (row.matchedSalesLineCount === 0) {
    notes.push("해당 기준일에 매칭된 카페24 판매 행이 없어 0 기준으로 표시합니다.");
  }
  return notes;
}

function addMergedRow(
  rows: Array<XlsxCell[] | XlsxRow>,
  merges: XlsxMergeRange[],
  value: string,
  columnCount: number,
  fill: XlsxCellFill,
  fontTone: "DEFAULT" | "INVERSE",
  bold = false,
  height?: number
) {
  const excelRow = rows.length + 1;
  rows.push({
    ...(height ? { height } : {}),
    cells: Array.from({ length: columnCount }, (_, index): XlsxCell => ({
      value: index === 0 ? value : "",
      style: "Text",
      fill,
      fontTone,
      bold,
      wrapText: index === 0,
      borderTone: mergedBorder(index, columnCount)
    }))
  });
  merges.push({ fromRow: excelRow, fromColumn: 1, toRow: excelRow, toColumn: columnCount });
}

function mergedBorder(index: number, columnCount: number): XlsxBorderTone {
  if (index === 0) return "MERGED_START";
  if (index === columnCount - 1) return "MERGED_END";
  return "MERGED_MIDDLE";
}

function padRow(cells: XlsxCell[], columnCount: number, padding: XlsxCell) {
  const boundedCells = cells.slice(0, columnCount);
  return [
    ...boundedCells,
    ...Array.from({ length: Math.max(0, columnCount - boundedCells.length) }, () => ({ ...padding }))
  ];
}

function bandCell(
  value: XlsxCell["value"],
  style: XlsxCellStyle,
  fill: XlsxCellFill,
  bold = false,
  borderTone: XlsxBorderTone = "GRID"
): XlsxCell {
  return { value, style, fill, bold, borderTone };
}

function textCell(value: string): XlsxCell {
  return { value, style: "Text" };
}

function numberCell(value: number | null | undefined): XlsxCell {
  return { value, style: "Number" };
}

function moneyCell(value: number | null | undefined, style: "Krw" | "Usd"): XlsxCell {
  return { value, style };
}

function percentCell(value: number | null | undefined): XlsxCell {
  return { value, style: "Percent" };
}

function cpaCell(totals: { cpaKrw?: number | null; cpaUsd?: number | null }): XlsxCell {
  return isKnownNumber(totals.cpaKrw)
    ? moneyCell(totals.cpaKrw, "Krw")
    : moneyCell(totals.cpaUsd, "Usd");
}

function totalCpaCell(totals: MetaDailyProductTotals): XlsxCell {
  return isKnownNumber(totals.cpaKrw)
    ? totalCell(totals.cpaKrw, "TotalKrw")
    : totalCell(totals.cpaUsd, "TotalUsd");
}

function totalCell(value: XlsxCell["value"], style: XlsxCellStyle): XlsxCell {
  return {
    value,
    style,
    fill: "REPORT_TOTAL",
    bold: true,
    borderTone: "GRID"
  };
}

function profitCell(value: number | null | undefined, fill: XlsxCellFill): XlsxCell {
  return {
    value,
    style: "Krw",
    fill,
    fontTone: isKnownNumber(value) && value !== 0
      ? value > 0 ? "POSITIVE" : "NEGATIVE"
      : "DEFAULT",
    borderTone: "GRID"
  };
}

function salesProductLabel(row: MetaDailySalesRow) {
  return row.product?.displayName ?? row.product?.name ?? row.product?.code ?? row.productId;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(value);
}

function formatKrw(value: number) {
  return `${formatNumber(value)}원`;
}

function isKnownNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}
