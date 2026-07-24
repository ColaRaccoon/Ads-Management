"use client";

import { Download, Printer, Search, TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import {
  filterDailyReportRows,
  filterDailyReportRowsWithSales,
  flattenDailyReportExportRows,
  formatDailyMoney,
  formatDailyProfit,
  formatDailyQuantity,
  formatDailyRatio,
  isDailyGroupExpanded,
  type CoupangDailyExportRow
} from "@/lib/coupang-daily-report";
import {
  CoupangDailyGroupBody,
  CoupangDailySingleBody
} from "./rows";
import { downloadCsv } from "@/lib/csv";
import { buildXlsxWorkbook, downloadXlsx, type XlsxCell, type XlsxCellStyle } from "@/lib/xlsx";
import type {
  CoupangDailyReportResponse,
  CoupangDailyReportRow,
  CoupangDailySummary
} from "@/types/coupang";

type DailyExportColumn = {
  header: string;
  style: XlsxCellStyle;
  width: number;
  value: (row: CoupangDailyExportRow) => string | number | null | undefined;
};

const exportColumns: DailyExportColumn[] = [
  { header: "행구분", style: "Text", width: 13, value: (row) => row.rowKind },
  { header: "제품/옵션", style: "Text", width: 30, value: (row) => row.productName },
  { header: "쿠팡 원본매출", style: "Krw", width: 17, value: (row) => row.reportedSalesKrw },
  { header: "원본 판매수량", style: "Number", width: 17, value: (row) => row.reportedSalesQuantity },
  { header: "전일 원본 판매수량", style: "Number", width: 20, value: (row) => row.previousReportedSalesQuantity },
  { header: "가구매수량", style: "Number", width: 14, value: (row) => row.manualPurchaseQuantity },
  { header: "광고비", style: "Krw", width: 15, value: (row) => row.adSpendKrw },
  { header: "전일 광고비", style: "Krw", width: 16, value: (row) => row.previousAdSpendKrw },
  { header: "광고수익률", style: "Ratio", width: 16, value: (row) => row.roas },
  { header: "전일 광고수익률", style: "Ratio", width: 18, value: (row) => row.previousRoas },
  { header: "오가닉 매출", style: "Krw", width: 16, value: (row) => row.organicSalesKrw },
  { header: "최종 순이익", style: "Krw", width: 16, value: (row) => row.marginKrw },
  { header: "전일 최종 순이익", style: "Krw", width: 19, value: (row) => row.previousMarginKrw }
];

export default function CoupangDailyReportPage() {
  const [date, setDate] = useState(todayInputValue());
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const report = useQuery({
    queryKey: ["coupang-daily-report", date],
    queryFn: () => apiGet<CoupangDailyReportResponse>(
      `/coupang/daily-report?date=${encodeURIComponent(date)}`
    )
  });
  const rows = useMemo(
    () => filterDailyReportRowsWithSales(report.data?.rows ?? []),
    [report.data?.rows]
  );
  const normalizedSearchQuery = searchQuery.trim();
  const visibleRows = useMemo(
    () => filterDailyReportRows(rows, searchQuery),
    [rows, searchQuery]
  );
  const counts = useMemo(() => reportCounts(rows), [rows]);
  const visibleCounts = useMemo(() => reportCounts(visibleRows), [visibleRows]);
  const visibleRowsByKey = useMemo(
    () => new Map(visibleRows.map((row) => [rowKey(row), row])),
    [visibleRows]
  );
  const groupIds = useMemo(
    () => rows.flatMap((row) => row.rowType === "GROUP" ? [row.groupId] : []),
    [rows]
  );
  const allGroupsExpanded = groupIds.every((groupId) => !collapsedGroupIds.has(groupId));
  const exportRows = useMemo(
    () => report.data
      ? flattenDailyReportExportRows(report.data.summary, report.data.rows)
      : [],
    [report.data]
  );

  useEffect(() => {
    if (!report.data) return;
    const availableGroupIds = new Set(
      report.data.rows.flatMap((row) => row.rowType === "GROUP" ? [row.groupId] : [])
    );
    setCollapsedGroupIds((current) => {
      const next = new Set([...current].filter((groupId) => availableGroupIds.has(groupId)));
      return setsEqual(current, next) ? current : next;
    });
  }, [report.data]);

  const toggleGroup = (groupId: string) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const toggleAllGroups = () => {
    setCollapsedGroupIds(allGroupsExpanded ? new Set(groupIds) : new Set());
  };

  const exportXlsx = () => {
    const workbook = buildXlsxWorkbook({
      sheetName: "Coupang Daily Report",
      columns: exportColumns.map((column) => ({ width: column.width })),
      freezeRow: 1,
      autoFilter: { fromRow: 1 },
      rows: [
        exportColumns.map((column): XlsxCell => ({ value: column.header, style: "Header" })),
        ...exportRows.map((row) =>
          exportColumns.map((column): XlsxCell => ({
            value: column.value(row),
            style: row.rowKind === "전체합계"
              ? totalCellStyle(column.style)
              : column.style
          }))
        )
      ]
    });
    downloadXlsx(`${date}_쿠팡_데일리리포트.xlsx`, workbook);
  };

  return (
    <section className="page coupang-daily-report-page">
      <div className="coupang-daily-heading">
        <div>
          <p className="coupang-daily-eyebrow">COUPANG · DAILY REPORT</p>
          <h1>Coupang Daily Report</h1>
          <p className="coupang-daily-subtitle">
            {report.data
              ? `${report.data.date} 실적과 ${report.data.previousDate} 전일 값을 비교합니다. 제품 ${counts.topLevelCount}개 · 옵션 ${counts.optionCount}개`
              : "선택 날짜의 제품 실적과 전일 값을 비교합니다."}
          </p>
        </div>
        <div className="coupang-daily-print-meta" aria-hidden="true">
          조회일 {report.data?.date ?? date} · 쿠팡 데일리 리포트
        </div>
        <div className="coupang-daily-actions coupang-daily-no-print">
          <label className="coupang-daily-visually-hidden" htmlFor="coupang-daily-date">
            조회 날짜
          </label>
          <input
            id="coupang-daily-date"
            className="input coupang-daily-date-input"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <button
            className="button coupang-daily-action"
            type="button"
            onClick={() => window.print()}
          >
            <Printer size={14} aria-hidden="true" /> 인쇄
          </button>
          <button
            className="button coupang-daily-action"
            type="button"
            disabled={exportRows.length === 0}
            onClick={() =>
              downloadCsv(`${date}_쿠팡_데일리리포트.csv`, exportColumns, exportRows)
            }
          >
            <Download size={14} aria-hidden="true" /> CSV
          </button>
          <button
            className="button primary coupang-daily-action"
            type="button"
            disabled={exportRows.length === 0}
            onClick={exportXlsx}
          >
            <Download size={14} aria-hidden="true" /> XLSX
          </button>
        </div>
      </div>

      {report.data ? (
        <>
          <SummaryStrip
            current={report.data.summary.current}
            previous={report.data.summary.previous}
            counts={counts}
          />
          {report.data.summary.current.isComplete ? null : (
            <div className="coupang-daily-warning" role="alert">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                일부 상품 {report.data.summary.current.incompleteProductCount}개의 계산이 불완전하여
                최종 순이익은 계산 가능한 상품의 부분 합계입니다. 제외 순매출{" "}
                {formatDailyMoney(report.data.summary.current.excludedNetSalesKrw)} · 제외 수량{" "}
                {formatDailyQuantity(report.data.summary.current.excludedSalesQuantity)}
              </span>
            </div>
          )}
          {report.data.summary.previous.isComplete ? null : (
            <div className="coupang-daily-warning" role="status">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                전일 일부 상품의 계산이 불완전하여 전일 최종 순이익은 표시하지 않습니다.
              </span>
            </div>
          )}
        </>
      ) : null}

      <section
        className="coupang-daily-panel"
        aria-busy={report.isLoading}
        aria-label="쿠팡 데일리 리포트 상세"
      >
        <div className="coupang-daily-table-toolbar coupang-daily-no-print">
          <div className="coupang-daily-result-copy" aria-live="polite">
            <span className="coupang-daily-legend-dot" aria-hidden="true" />
            <strong>제품 {visibleCounts.topLevelCount}개</strong>
            <span>
              그룹 {visibleCounts.groupCount}개 · 단일 {visibleCounts.singleCount}개 · 옵션{" "}
              {visibleCounts.optionCount}개
            </span>
          </div>
          <div className="coupang-daily-table-tools">
            <label className="coupang-daily-search">
              <Search size={13} aria-hidden="true" />
              <span className="coupang-daily-visually-hidden">상품명, 옵션명 또는 메모 검색</span>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="상품명·옵션명·메모 검색"
              />
            </label>
            <button
              className="button coupang-daily-action"
              type="button"
              disabled={groupIds.length === 0}
              onClick={toggleAllGroups}
            >
              {allGroupsExpanded ? "모두 접기" : "모두 펼치기"}
            </button>
          </div>
        </div>

        <div className="coupang-daily-table-wrap">
          <table className="coupang-daily-table">
            <caption className="coupang-daily-visually-hidden">
              선택일 및 전일 쿠팡 제품과 옵션별 실적
            </caption>
            <thead>
              <tr>
                <th scope="col">제품 / 옵션</th>
                <th scope="col">쿠팡 원본매출</th>
                <th scope="col">원본 판매수량</th>
                <th scope="col">가구매수량</th>
                <th scope="col">광고비</th>
                <th scope="col">광고수익률</th>
                <th scope="col" title="가구매 조정 후 실제 순매출에서 광고 전환매출을 차감한 값">
                  오가닉 매출
                </th>
                <th scope="col">최종 순이익</th>
              </tr>
            </thead>
            {report.isLoading ? (
              <TableMessage message="데일리 리포트를 불러오는 중입니다." />
            ) : report.isError ? (
              <TableMessage
                isError
                message={`데일리 리포트를 불러오지 못했습니다.${
                  report.error instanceof Error ? ` ${report.error.message}` : ""
                }`}
              />
            ) : (
              <>
                {rows.map((row) => {
                  const visibleRow = visibleRowsByKey.get(rowKey(row));
                  return row.rowType === "GROUP" ? (
                    <CoupangDailyGroupBody
                      key={row.groupId}
                      row={row}
                      visibleRow={visibleRow?.rowType === "GROUP" ? visibleRow : undefined}
                      hasQuery={normalizedSearchQuery.length > 0}
                      expanded={isDailyGroupExpanded(
                        row.groupId,
                        collapsedGroupIds,
                        normalizedSearchQuery.length > 0
                      )}
                      onToggle={() => toggleGroup(row.groupId)}
                    />
                  ) : (
                    <CoupangDailySingleBody
                      key={row.productId}
                      row={row}
                      searchHidden={normalizedSearchQuery.length > 0 && !visibleRow}
                    />
                  );
                })}
                {visibleRows.length === 0 ? (
                  <TableMessage
                    printHidden={rows.length > 0}
                    message={normalizedSearchQuery
                      ? "검색 결과가 없습니다."
                      : "선택 날짜에 표시할 실적이 없습니다."}
                  />
                ) : null}
              </>
            )}
          </table>
        </div>
      </section>

      <p className="coupang-daily-footnote coupang-daily-no-print">
        그룹 행은 옵션 합계이며, 검색과 화면의 접힘 상태와 관계없이 인쇄 및 내보내기에는 모든
        옵션이 포함됩니다.
      </p>
    </section>
  );
}

function SummaryStrip({
  current,
  previous,
  counts
}: {
  current: CoupangDailySummary;
  previous: CoupangDailySummary;
  counts: ReturnType<typeof reportCounts>;
}) {
  const currentMargin = current.isComplete ? current.marginKrw : current.knownMarginKrw;
  const previousMargin = previous.isComplete ? previous.marginKrw : null;

  return (
    <section className="coupang-daily-summary" aria-label="전체 합계">
      <div className="coupang-daily-summary-title">
        <strong>전체 합계</strong>
        <span>
          제품 {counts.topLevelCount}개 · 옵션 {counts.optionCount}개 · 단일 {counts.singleCount}개
        </span>
      </div>
      <SummaryItem label="쿠팡 원본매출" value={formatDailyMoney(current.reportedSalesKrw)} />
      <SummaryItem
        label="원본 판매수량"
        value={formatDailyQuantity(current.reportedSalesQuantity)}
        previous={formatDailyQuantity(previous.reportedSalesQuantity)}
      />
      <SummaryItem label="가구매수량" value={formatDailyQuantity(current.manualPurchaseQuantity)} />
      <SummaryItem
        label="광고비"
        value={formatDailyMoney(current.adSpendKrw)}
        previous={formatDailyMoney(previous.adSpendKrw)}
      />
      <SummaryItem
        label="광고수익률"
        value={formatDailyRatio(current.roas)}
        previous={formatDailyRatio(previous.roas)}
        tone={current.roas === 0 ? "zero" : "roas"}
      />
      <SummaryItem label="오가닉 매출" value={formatDailyMoney(current.organicSalesKrw)} />
      <SummaryItem
        label="최종 순이익"
        value={formatDailyProfit(currentMargin)}
        previous={formatDailyProfit(previousMargin)}
        tone={profitTone(currentMargin)}
      />
    </section>
  );
}

function SummaryItem({
  label,
  value,
  previous,
  tone
}: {
  label: string;
  value: string;
  previous?: string;
  tone?: "roas" | "positive" | "negative" | "zero";
}) {
  return (
    <div className="coupang-daily-summary-item">
      <span>{label}</span>
      {previous === undefined ? (
        <strong className={tone ? `coupang-daily-${tone}` : undefined}>{value}</strong>
      ) : (
        <strong className={`coupang-daily-metric-inline${tone ? ` coupang-daily-${tone}` : ""}`}>
          <span>{value}</span>
          <small>(전일 {previous})</small>
        </strong>
      )}
    </div>
  );
}

function TableMessage({
  message,
  isError = false,
  printHidden = false
}: {
  message: string;
  isError?: boolean;
  printHidden?: boolean;
}) {
  return (
    <tbody className={printHidden ? "coupang-daily-no-print" : undefined}>
      <tr>
        <td
          className={`coupang-daily-empty${isError ? " coupang-daily-empty-error" : ""}`}
          colSpan={8}
          role={isError ? "alert" : undefined}
        >
          {message}
        </td>
      </tr>
    </tbody>
  );
}

function reportCounts(rows: CoupangDailyReportRow[]) {
  let groupCount = 0;
  let singleCount = 0;
  let optionCount = 0;
  for (const row of rows) {
    if (row.rowType === "GROUP") {
      groupCount += 1;
      optionCount += row.children.length;
    } else {
      singleCount += 1;
    }
  }
  return {
    groupCount,
    singleCount,
    optionCount,
    topLevelCount: groupCount + singleCount
  };
}

function rowKey(row: CoupangDailyReportRow) {
  return row.rowType === "GROUP" ? `group:${row.groupId}` : `product:${row.productId}`;
}

function profitTone(value: number | null): "positive" | "negative" | "zero" | undefined {
  if (value === null) return undefined;
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "zero";
}

function totalCellStyle(style: XlsxCellStyle): XlsxCellStyle {
  switch (style) {
    case "Text":
      return "TotalText";
    case "Number":
      return "TotalNumber";
    case "Krw":
      return "TotalKrw";
    case "Ratio":
      return "TotalRatio";
    case "Percent":
      return "TotalPercent";
    case "Usd":
      return "TotalUsd";
    default:
      return style;
  }
}

function setsEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function todayInputValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}
