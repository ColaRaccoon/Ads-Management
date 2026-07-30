"use client";

import { Download, Printer, Search, TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import {
  COUPANG_DAILY_CSV_COLUMNS,
  flattenDailyReportExportRows,
  formatDailyMoney,
  formatDailyProfit,
  formatDailyQuantity,
  formatDailyRatio,
  isDailyGroupExpanded
} from "@/lib/coupang-daily-report";
import { koreaYesterdayDateInput } from "@/lib/korea-date";
import {
  CoupangDailyGroupBody,
  CoupangDailySingleBody
} from "./rows";
import { downloadCsv } from "@/lib/csv";
import { buildCoupangDailyXlsxWorkbook } from "@/lib/coupang-daily-xlsx";
import { downloadXlsx } from "@/lib/xlsx";
import type {
  CoupangDailyReportResponse,
  CoupangDailyReportRow,
  CoupangDailySummary
} from "@/types/coupang";
import type { CoupangDailyReportCategorySummary } from "@/types/coupang";
import {
  buildCoupangDailyReportUrl,
  canonicalDailyCategoryIds,
  dailyReportFilenameSlug,
  normalizeDailyReportQuery,
  planDailyCategoryDeactivation
} from "@/lib/coupang-daily-category";
import { DailyCategoryFilter } from "./category-filter";
import { DailyCategoryManager } from "./category-manager";

export default function CoupangDailyReportPage() {
  const [date, setDate] = useState(koreaYesterdayDateInput);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<string>>(new Set());
  const [includeUncategorized, setIncludeUncategorized] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const categoryManageButtonRef = useRef<HTMLButtonElement>(null);
  const canonicalIds = canonicalDailyCategoryIds(selectedCategoryIds);
  const categories = useQuery({
    queryKey: ["coupang-daily-report-categories"],
    queryFn: () => apiGet<CoupangDailyReportCategorySummary[]>("/coupang/daily-report/categories")
  });
  useEffect(() => {
    if (!categories.data) return;
    const activeIds = new Set(categories.data.map((category) => category.id));
    setSelectedCategoryIds((current) => {
      const next = new Set([...current].filter((id) => activeIds.has(id)));
      return setsEqual(current, next) ? current : next;
    });
  }, [categories.data]);
  useEffect(() => { const timer = window.setTimeout(() => setDebouncedQuery(searchQuery), 300); return () => window.clearTimeout(timer); }, [searchQuery]);
  const normalizedDebouncedQuery = normalizeDailyReportQuery(debouncedQuery);
  const report = useQuery({
    queryKey: ["coupang-daily-report", date, canonicalIds.join(","), includeUncategorized, normalizedDebouncedQuery],
    queryFn: () => apiGet<CoupangDailyReportResponse>(buildCoupangDailyReportUrl({
      date, categoryIds: canonicalIds, includeUncategorized, query: normalizedDebouncedQuery
    }))
  });
  const rows = report.data?.rows ?? [];
  const normalizedSearchQuery = normalizedDebouncedQuery;
  const counts = useMemo(() => reportCounts(rows), [rows]);
  const groupIds = useMemo(
    () => rows.flatMap((row) => row.rowType === "GROUP" ? [row.groupId] : []),
    [rows]
  );
  const allGroupsExpanded = groupIds.every((groupId) => !collapsedGroupIds.has(groupId));
  const exportRows = useMemo(
    () => report.data
      ? flattenDailyReportExportRows(report.data)
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
    const workbook = buildCoupangDailyXlsxWorkbook(exportRows);
    const slug = dailyReportFilenameSlug(report.data?.appliedFilter.label ?? "전체", report.data?.appliedFilter.categories.length ?? 0);
    downloadXlsx(`${date}_쿠팡_데일리리포트_${slug}.xlsx`, workbook);
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
          조회일 {report.data?.date ?? date} · 범위 {report.data?.appliedFilter.label ?? "전체 제품"} · 검색 {report.data?.appliedFilter.query ?? "없음"}
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
            disabled={!report.data}
            onClick={() =>
              downloadCsv(`${date}_쿠팡_데일리리포트_${dailyReportFilenameSlug(report.data?.appliedFilter.label ?? "전체", report.data?.appliedFilter.categories.length ?? 0)}.csv`, COUPANG_DAILY_CSV_COLUMNS, exportRows)
            }
          >
            <Download size={14} aria-hidden="true" /> CSV
          </button>
          <button
            className="button primary coupang-daily-action"
            type="button"
            disabled={!report.data}
            onClick={exportXlsx}
          >
            <Download size={14} aria-hidden="true" /> XLSX
          </button>
        </div>
      </div>
      <DailyCategoryFilter
        categories={categories.data ?? []}
        selected={selectedCategoryIds}
        includeUncategorized={includeUncategorized}
        hasQuery={searchQuery.trim().length > 0}
        loading={categories.isLoading}
        error={categories.isError}
        manageButtonRef={categoryManageButtonRef}
        onSelectedChange={setSelectedCategoryIds}
        onIncludeUncategorizedChange={setIncludeUncategorized}
        onReset={() => {
          setSelectedCategoryIds(new Set());
          setIncludeUncategorized(false);
          setSearchQuery("");
        }}
        onRetry={() => categories.refetch()}
        onManage={() => setCategoryManagerOpen(true)}
      />
      <DailyCategoryManager
        open={categoryManagerOpen}
        onClose={() => setCategoryManagerOpen(false)}
        returnFocusRef={categoryManageButtonRef}
        onCategoryDeactivated={(categoryId) => {
          const plan = planDailyCategoryDeactivation(selectedCategoryIds, categoryId);
          if (plan.selectionChanged) setSelectedCategoryIds(plan.selected);
          return { invalidateCurrentReport: plan.invalidateCurrentReport };
        }}
      />
      {categories.isError ? <p className="coupang-daily-warning" role="status">카테고리 목록을 불러오지 못했습니다. 전체 리포트는 계속 사용할 수 있습니다.</p> : null}
      {report.data ? (
        <div className="coupang-daily-applied-filter" aria-live="polite">
          <strong>적용 범위 {report.data.appliedFilter.label}</strong>
          {report.data.appliedFilter.query ? <span>검색 {report.data.appliedFilter.query}</span> : null}
          <span>카탈로그 제품 {report.data.appliedFilter.matchedCatalogProductCount}개 · 활동 제품 {report.data.appliedFilter.activityProductCount}개</span>
          {report.isFetching ? <span>필터 결과 갱신 중…</span> : null}
        </div>
      ) : null}

      {report.data ? (
        <>
          <SummaryStrip
            current={report.data.summary.current}
            previous={report.data.summary.previous}
            counts={counts}
            filtered={report.data.appliedFilter.mode === "FILTERED"}
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
        aria-busy={report.isLoading || report.isFetching}
        aria-label="쿠팡 데일리 리포트 상세"
      >
        <div className="coupang-daily-table-toolbar coupang-daily-no-print">
          <div className="coupang-daily-result-copy" aria-live="polite">
            <span className="coupang-daily-legend-dot" aria-hidden="true" />
            <strong>제품 {counts.topLevelCount}개</strong>
            <span>
              그룹 {counts.groupCount}개 · 단일 {counts.singleCount}개 · 옵션{" "}
              {counts.optionCount}개
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
                  return row.rowType === "GROUP" ? (
                    <CoupangDailyGroupBody
                      key={row.groupId}
                      row={row}
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
                    />
                  );
                })}
                {rows.length === 0 ? (
                  <TableMessage
                    message="선택한 카테고리와 검색 조건에 해당하는 실적이 없습니다."
                  />
                ) : null}
              </>
            )}
          </table>
        </div>
      </section>

      <p className="coupang-daily-footnote coupang-daily-no-print">
        그룹 행은 현재 필터에 남은 옵션의 합계이며, 화면에서 접어도 인쇄 및 내보내기에는 그 옵션이 모두 포함됩니다.
      </p>
    </section>
  );
}

function SummaryStrip({
  current,
  previous,
  counts,
  filtered
}: {
  current: CoupangDailySummary;
  previous: CoupangDailySummary;
  counts: ReturnType<typeof reportCounts>;
  filtered: boolean;
}) {
  const currentMargin = current.isComplete ? current.marginKrw : current.knownMarginKrw;
  const previousMargin = previous.isComplete ? previous.marginKrw : null;

  return (
    <section className="coupang-daily-summary" aria-label={filtered ? "선택 범위 합계" : "전체 합계"}>
      <div className="coupang-daily-summary-title">
        <strong>{filtered ? "선택 범위 합계" : "전체 합계"}</strong>
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
  isError = false
}: {
  message: string;
  isError?: boolean;
}) {
  return (
    <tbody>
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

function profitTone(value: number | null): "positive" | "negative" | "zero" | undefined {
  if (value === null) return undefined;
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "zero";
}

function setsEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
