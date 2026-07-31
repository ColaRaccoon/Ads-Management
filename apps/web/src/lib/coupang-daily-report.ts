import type {
  CoupangDailyReportResponse,
  CoupangDailyReportRow
} from "@/types/coupang";
import type { CsvColumn } from "./csv";

export type DailyNote = {
  productName: string | null;
  memo: string;
};

export type CoupangDailyExportRowKind =
  | "전체합계"
  | "선택합계"
  | "그룹합계"
  | "옵션"
  | "단일제품"
  | "기타사항";

type DailyExportNumber = number | null | "";

export type CoupangDailyExportRow = {
  date: string;
  filterLabel: string;
  query: string;
  reportCategories: string;
  rowKind: CoupangDailyExportRowKind;
  productName: string;
  reportedSalesKrw: DailyExportNumber;
  previousReportedSalesKrw: DailyExportNumber;
  reportedSalesQuantity: DailyExportNumber;
  previousReportedSalesQuantity: DailyExportNumber;
  manualPurchaseQuantity: DailyExportNumber;
  previousManualPurchaseQuantity: DailyExportNumber;
  adSpendKrw: DailyExportNumber;
  previousAdSpendKrw: DailyExportNumber;
  roas: DailyExportNumber;
  previousRoas: DailyExportNumber;
  organicSalesKrw: DailyExportNumber;
  marginKrw: DailyExportNumber;
  previousMarginKrw: DailyExportNumber;
  visualBlockKey: string | null;
  visualBlockIndex: number | null;
  indentLevel: 0 | 1;
  visualChildProductCount: number | null;
};

export const COUPANG_DAILY_CSV_COLUMNS: CsvColumn<CoupangDailyExportRow>[] = [
  { header: "조회일", value: (row) => row.date },
  { header: "선택 필터", value: (row) => row.filterLabel },
  { header: "검색어", value: (row) => row.query },
  { header: "소속 리포트 카테고리", value: (row) => row.reportCategories },
  { header: "행구분", value: (row) => row.rowKind },
  { header: "제품/옵션", value: (row) => row.productName },
  { header: "쿠팡 원본매출", value: (row) => row.reportedSalesKrw },
  { header: "원본 판매수량", value: (row) => row.reportedSalesQuantity },
  { header: "전일 원본 판매수량", value: (row) => row.previousReportedSalesQuantity },
  { header: "가구매수량", value: (row) => row.manualPurchaseQuantity },
  { header: "광고비(집행상품 기준)", value: (row) => row.adSpendKrw },
  { header: "전일 광고비(집행상품 기준)", value: (row) => row.previousAdSpendKrw },
  { header: "광고수익률(집행상품 기준)", value: (row) => row.roas },
  { header: "전일 광고수익률(집행상품 기준)", value: (row) => row.previousRoas },
  { header: "오가닉 매출(판매상품 기준)", value: (row) => row.organicSalesKrw },
  { header: "최종 순이익", value: (row) => row.marginKrw },
  { header: "전일 최종 순이익", value: (row) => row.previousMarginKrw }
];

export function dailyRowNotes(row: CoupangDailyReportRow): DailyNote[] {
  if (row.rowType === "PRODUCT") {
    const memo = normalizeMemo(row.memo);
    return memo === null ? [] : [{ productName: null, memo }];
  }

  return row.children.flatMap((child) => {
    const memo = normalizeMemo(child.memo);
    return memo === null ? [] : [{ productName: child.productName, memo }];
  });
}

export function flattenDailyReportExportRows(
  response: CoupangDailyReportResponse
): CoupangDailyExportRow[] {
  const summary = response.summary;
  const rows = response.rows;
  const metadata = {
    date: response.date,
    filterLabel: response.appliedFilter.label,
    query: response.appliedFilter.query ?? ""
  };
  const exportRows: CoupangDailyExportRow[] = [
    {
      ...metadata,
      reportCategories: "",
      rowKind: response.appliedFilter.mode === "FILTERED" ? "선택합계" : "전체합계",
      productName: summary.current.isComplete
        ? "전체 합계"
        : "계산 가능한 상품 부분 합계 (일부 상품 제외)",
      reportedSalesKrw: summary.current.reportedSalesKrw,
      previousReportedSalesKrw: summary.previous.reportedSalesKrw,
      reportedSalesQuantity: summary.current.reportedSalesQuantity,
      previousReportedSalesQuantity: summary.previous.reportedSalesQuantity,
      manualPurchaseQuantity: summary.current.manualPurchaseQuantity,
      previousManualPurchaseQuantity: summary.previous.manualPurchaseQuantity,
      adSpendKrw: summary.current.adSpendKrw,
      previousAdSpendKrw: summary.previous.adSpendKrw,
      roas: summary.current.roas,
      previousRoas: summary.previous.roas,
      organicSalesKrw: summary.current.organicSalesKrw,
      marginKrw: displayedCurrentSummaryMargin(summary.current),
      previousMarginKrw: confirmedPreviousSummaryMargin(summary.previous),
      visualBlockKey: null,
      visualBlockIndex: null,
      indentLevel: 0,
      visualChildProductCount: null
    }
  ];

  for (const [visualBlockIndex, row] of rows.entries()) {
    const visualBlockKey = row.rowType === "GROUP"
      ? `group:${row.groupId}`
      : `product:${row.productId}`;
    if (row.rowType === "GROUP") {
      exportRows.push(toExportMetricRow("그룹합계", row.productName, row, metadata, {
        visualBlockKey,
        visualBlockIndex,
        indentLevel: 0,
        visualChildProductCount: row.childProductCount
      }));
      exportRows.push(
        ...row.children.map((child) => toExportMetricRow(
          "옵션",
          child.productName,
          child,
          metadata,
          {
            visualBlockKey,
            visualBlockIndex,
            indentLevel: 1,
            visualChildProductCount: null
          }
        ))
      );
    } else {
      exportRows.push(toExportMetricRow("단일제품", row.productName, row, metadata, {
        visualBlockKey,
        visualBlockIndex,
        indentLevel: 0,
        visualChildProductCount: null
      }));
    }

    const notes = dailyRowNotes(row);
    if (notes.length > 0) {
      exportRows.push({
        ...metadata,
        reportCategories: row.reportCategories.map((category) => category.displayName).join(" · "),
        rowKind: "기타사항",
        productName: `기타사항: ${notes
          .map((note) => note.productName ? `${note.productName} ${note.memo}` : note.memo)
          .join(" · ")}`,
        reportedSalesKrw: "",
        previousReportedSalesKrw: "",
        reportedSalesQuantity: "",
        previousReportedSalesQuantity: "",
        manualPurchaseQuantity: "",
        previousManualPurchaseQuantity: "",
        adSpendKrw: "",
        previousAdSpendKrw: "",
        roas: "",
        previousRoas: "",
        organicSalesKrw: "",
        marginKrw: "",
        previousMarginKrw: "",
        visualBlockKey,
        visualBlockIndex,
        indentLevel: 0,
        visualChildProductCount: null
      });
    }
  }

  return exportRows;
}

export function isDailyGroupExpanded(
  groupId: string,
  collapsed: Set<string>,
  hasQuery: boolean
) {
  return hasQuery || !collapsed.has(groupId);
}

export function formatDailyMoney(value: number | null) {
  if (!isFiniteNumber(value)) return "-";
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

export function formatDailyProfit(value: number | null) {
  if (!isFiniteNumber(value)) return "-";
  const rounded = Math.round(value);
  const prefix = rounded > 0 ? "+" : "";
  return `${prefix}${rounded.toLocaleString("ko-KR")}원`;
}

export function formatDailyQuantity(value: number | null) {
  if (!isFiniteNumber(value)) return "-";
  return `${Math.round(value).toLocaleString("ko-KR")}개`;
}

export function formatDailyRatio(value: number | null) {
  if (!isFiniteNumber(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function toExportMetricRow(
  rowKind: Exclude<CoupangDailyExportRowKind, "전체합계" | "선택합계" | "기타사항">,
  productName: string,
  row: CoupangDailyReportRow,
  metadata: Pick<CoupangDailyExportRow, "date" | "filterLabel" | "query">,
  visual: Pick<
    CoupangDailyExportRow,
    "visualBlockKey" | "visualBlockIndex" | "indentLevel" | "visualChildProductCount"
  >
): CoupangDailyExportRow {
  return {
    ...metadata,
    ...visual,
    reportCategories: row.reportCategories.map((category) => category.displayName).join(" · "),
    rowKind,
    productName,
    reportedSalesKrw: row.reportedSalesKrw,
    previousReportedSalesKrw: row.previous.reportedSalesKrw,
    reportedSalesQuantity: row.reportedSalesQuantity,
    previousReportedSalesQuantity: row.previous.reportedSalesQuantity,
    manualPurchaseQuantity: row.manualPurchaseQuantity,
    previousManualPurchaseQuantity: row.previous.manualPurchaseQuantity,
    adSpendKrw: row.adSpendKrw,
    previousAdSpendKrw: row.previous.adSpendKrw,
    roas: row.roas,
    previousRoas: row.previous.roas,
    organicSalesKrw: row.organicSalesKrw,
    marginKrw: row.marginKrw,
    previousMarginKrw: row.previous.marginKrw
  };
}

function displayedCurrentSummaryMargin(summary: CoupangDailyReportResponse["summary"]["current"]) {
  return summary.isComplete ? summary.marginKrw : summary.knownMarginKrw;
}

function confirmedPreviousSummaryMargin(summary: CoupangDailyReportResponse["summary"]["previous"]) {
  return summary.isComplete ? summary.marginKrw : null;
}

function normalizeMemo(value: string | null | undefined) {
  const memo = value?.trim() ?? "";
  return memo.length > 0 ? memo : null;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
