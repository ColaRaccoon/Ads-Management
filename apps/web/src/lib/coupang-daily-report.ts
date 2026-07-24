import type {
  CoupangDailyProductRow,
  CoupangDailyReportResponse,
  CoupangDailyReportRow
} from "@/types/coupang";

export type DailyNote = {
  productName: string | null;
  memo: string;
};

export type CoupangDailyExportRowKind =
  | "전체합계"
  | "그룹합계"
  | "옵션"
  | "단일제품"
  | "기타사항";

type DailyExportNumber = number | null | "";

export type CoupangDailyExportRow = {
  rowKind: CoupangDailyExportRowKind;
  productName: string;
  reportedSalesKrw: DailyExportNumber;
  reportedSalesQuantity: DailyExportNumber;
  previousReportedSalesQuantity: DailyExportNumber;
  manualPurchaseQuantity: DailyExportNumber;
  adSpendKrw: DailyExportNumber;
  previousAdSpendKrw: DailyExportNumber;
  roas: DailyExportNumber;
  previousRoas: DailyExportNumber;
  organicSalesKrw: DailyExportNumber;
  marginKrw: DailyExportNumber;
  previousMarginKrw: DailyExportNumber;
};

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

export function filterDailyReportRowsWithSales(
  rows: CoupangDailyReportRow[]
): CoupangDailyReportRow[] {
  const filteredRows: CoupangDailyReportRow[] = [];

  for (const row of rows) {
    if (row.rowType === "PRODUCT") {
      if (row.reportedSalesQuantity !== 0) filteredRows.push(row);
      continue;
    }

    const children = row.children.filter((child) => child.reportedSalesQuantity !== 0);
    if (children.length === 0) continue;

    filteredRows.push(children.length === row.children.length
      ? row
      : { ...row, children, childProductCount: children.length });
  }

  return filteredRows;
}

export function filterDailyReportRows(
  rows: CoupangDailyReportRow[],
  query: string
): CoupangDailyReportRow[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return rows;

  const filteredRows: CoupangDailyReportRow[] = [];
  for (const row of rows) {
    if (row.rowType === "PRODUCT") {
      if (productMatches(row, normalizedQuery)) filteredRows.push(row);
      continue;
    }

    if (
      normalizeSearchText(row.groupName).includes(normalizedQuery)
      || normalizeSearchText(row.productName).includes(normalizedQuery)
    ) {
      filteredRows.push(row);
      continue;
    }

    const children = row.children.filter((child) => productMatches(child, normalizedQuery));
    if (children.length > 0) {
      filteredRows.push({ ...row, children, childProductCount: children.length });
    }
  }
  return filteredRows;
}

export function flattenDailyReportExportRows(
  summary: CoupangDailyReportResponse["summary"],
  rows: CoupangDailyReportRow[]
): CoupangDailyExportRow[] {
  const exportRows: CoupangDailyExportRow[] = [
    {
      rowKind: "전체합계",
      productName: summary.current.isComplete
        ? "전체 합계"
        : "계산 가능한 상품 부분 합계 (일부 상품 제외)",
      reportedSalesKrw: summary.current.reportedSalesKrw,
      reportedSalesQuantity: summary.current.reportedSalesQuantity,
      previousReportedSalesQuantity: summary.previous.reportedSalesQuantity,
      manualPurchaseQuantity: summary.current.manualPurchaseQuantity,
      adSpendKrw: summary.current.adSpendKrw,
      previousAdSpendKrw: summary.previous.adSpendKrw,
      roas: summary.current.roas,
      previousRoas: summary.previous.roas,
      organicSalesKrw: summary.current.organicSalesKrw,
      marginKrw: displayedCurrentSummaryMargin(summary.current),
      previousMarginKrw: confirmedPreviousSummaryMargin(summary.previous)
    }
  ];

  for (const row of rows) {
    if (row.rowType === "GROUP") {
      exportRows.push(toExportMetricRow("그룹합계", row.productName, row));
      exportRows.push(
        ...row.children.map((child) => toExportMetricRow("옵션", child.productName, child))
      );
    } else {
      exportRows.push(toExportMetricRow("단일제품", row.productName, row));
    }

    const notes = dailyRowNotes(row);
    if (notes.length > 0) {
      exportRows.push({
        rowKind: "기타사항",
        productName: `기타사항: ${notes
          .map((note) => note.productName ? `${note.productName} ${note.memo}` : note.memo)
          .join(" · ")}`,
        reportedSalesKrw: "",
        reportedSalesQuantity: "",
        previousReportedSalesQuantity: "",
        manualPurchaseQuantity: "",
        adSpendKrw: "",
        previousAdSpendKrw: "",
        roas: "",
        previousRoas: "",
        organicSalesKrw: "",
        marginKrw: "",
        previousMarginKrw: ""
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
  rowKind: Exclude<CoupangDailyExportRowKind, "전체합계" | "기타사항">,
  productName: string,
  row: CoupangDailyReportRow
): CoupangDailyExportRow {
  return {
    rowKind,
    productName,
    reportedSalesKrw: row.reportedSalesKrw,
    reportedSalesQuantity: row.reportedSalesQuantity,
    previousReportedSalesQuantity: row.previous.reportedSalesQuantity,
    manualPurchaseQuantity: row.manualPurchaseQuantity,
    adSpendKrw: row.adSpendKrw,
    previousAdSpendKrw: row.previous.adSpendKrw,
    roas: row.roas,
    previousRoas: row.previous.roas,
    organicSalesKrw: row.organicSalesKrw,
    marginKrw: row.marginKrw,
    previousMarginKrw: row.previous.marginKrw
  };
}

function productMatches(row: CoupangDailyProductRow, normalizedQuery: string) {
  return normalizeSearchText(row.productName).includes(normalizedQuery)
    || normalizeSearchText(row.memo).includes(normalizedQuery);
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

function normalizeSearchText(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase("ko-KR") ?? "";
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
