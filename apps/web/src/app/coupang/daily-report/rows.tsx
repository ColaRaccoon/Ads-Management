import React from "react";
import { ChevronRight } from "lucide-react";
import {
  dailyRowNotes,
  formatDailyMoney,
  formatDailyProfit,
  formatDailyQuantity,
  formatDailyRatio,
  type DailyNote
} from "../../../lib/coupang-daily-report";
import type {
  CoupangDailyGroupRow,
  CoupangDailyProductRow,
  CoupangDailyReportRow
} from "@/types/coupang";

export function CoupangDailyGroupBody({
  row,
  expanded,
  onToggle
}: {
  row: CoupangDailyGroupRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const notes = dailyRowNotes(row);
  const collapsedClass = expanded ? "" : " coupang-daily-collapsed";

  return (
    <tbody className="coupang-daily-product-body">
      <tr
        className={`coupang-daily-group-row${expanded ? "" : " coupang-daily-group-collapsed"}${incompleteClass(row)}`}
        title={rowWarningTitle(row)}
      >
        <th scope="row">
          <div className="coupang-daily-product-cell">
            <button
              className="coupang-daily-group-toggle"
              type="button"
              aria-expanded={expanded}
              aria-label={`${row.productName} 옵션 ${expanded ? "접기" : "펼치기"}`}
              onClick={onToggle}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
            <ProductName row={row} />
          </div>
        </th>
        <MetricCells row={row} />
      </tr>
      {row.children.map((child) => (
        <tr
          key={child.productId}
          className={`coupang-daily-detail-row coupang-daily-option-row${collapsedClass}${incompleteClass(child)}`}
          title={rowWarningTitle(child)}
        >
          <th scope="row">
            <div className="coupang-daily-option-cell">
              <span title={rowCategoryTitle(child)}>{child.productName}</span>
            </div>
          </th>
          <MetricCells row={child} />
        </tr>
      ))}
      {notes.length > 0 ? (
        <tr
          className={`coupang-daily-detail-row coupang-daily-memo-row${collapsedClass}`}
        >
          <td colSpan={8}>
            <span className="coupang-daily-memo-label">기타사항</span>
            <span className="coupang-daily-screen-notes">
              <GroupMemoNotes notes={notes} />
            </span>
            <span className="coupang-daily-print-notes">
              <GroupMemoNotes notes={notes} />
            </span>
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}

export function CoupangDailySingleBody({
  row
}: {
  row: CoupangDailyProductRow;
}) {
  const notes = dailyRowNotes(row);
  return (
    <tbody className="coupang-daily-product-body">
      <tr
        className={`coupang-daily-single-row${incompleteClass(row)}`}
        title={rowWarningTitle(row)}
      >
        <th scope="row">
          <div className="coupang-daily-product-cell coupang-daily-single-name">
            <ProductName row={row} />
          </div>
        </th>
        <MetricCells row={row} />
      </tr>
      {notes.length > 0 ? (
        <tr className="coupang-daily-memo-row">
          <td colSpan={8}>
            <span className="coupang-daily-memo-label">기타사항</span>
            {notes[0]?.memo}
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}

function GroupMemoNotes({ notes }: { notes: DailyNote[] }) {
  return notes.map((note, index) => (
    <span key={`${note.productName ?? ""}-${index}`}>
      {index > 0 ? <span className="coupang-daily-memo-separator">·</span> : null}
      <span className="coupang-daily-memo-option">{note.productName}</span>{" "}
      {note.memo}
    </span>
  ));
}

function ProductName({ row }: { row: CoupangDailyReportRow }) {
  return (
    <div className="coupang-daily-product-name" title={rowCategoryTitle(row)}>
      <span>{row.productName}</span>
    </div>
  );
}

function rowCategoryTitle(row: CoupangDailyReportRow) {
  const categoryTitle = row.reportCategories.map((category) => category.displayName).join(" · ");
  return categoryTitle ? `${row.productName} · ${categoryTitle}` : row.productName;
}

function MetricCells({ row }: { row: CoupangDailyReportRow }) {
  return (
    <>
      <MetricCell value={row.reportedSalesKrw} format={formatDailyMoney} />
      <MetricCell
        value={row.reportedSalesQuantity}
        previous={row.previous.reportedSalesQuantity}
        format={formatDailyQuantity}
      />
      <MetricCell value={row.manualPurchaseQuantity} format={formatDailyQuantity} />
      <MetricCell
        value={row.adSpendKrw}
        previous={row.previous.adSpendKrw}
        format={formatDailyMoney}
      />
      <MetricCell
        value={row.roas}
        previous={row.previous.roas}
        format={formatDailyRatio}
        tone={row.roas === 0 ? "zero" : "roas"}
      />
      <MetricCell value={row.organicSalesKrw} format={formatDailyMoney} />
      <MetricCell
        value={row.marginKrw}
        previous={row.previous.marginKrw}
        format={formatDailyProfit}
        tone={profitTone(row.marginKrw)}
      />
    </>
  );
}

function MetricCell({
  value,
  previous,
  format,
  tone
}: {
  value: number | null;
  previous?: number | null;
  format: (value: number | null) => string;
  tone?: "roas" | "positive" | "negative" | "zero";
}) {
  const currentText = format(value);
  const toneClass = tone ? ` coupang-daily-${tone}` : value === 0 ? " coupang-daily-zero" : "";
  return (
    <td className={toneClass.trim() || undefined}>
      {previous === undefined ? currentText : (
        <span className="coupang-daily-metric-inline">
          <span>{currentText}</span>
          <small>(전일 {format(previous)})</small>
        </span>
      )}
    </td>
  );
}

function rowWarningTitle(row: CoupangDailyReportRow) {
  const warningDetails = row.warnings.map(formatRowWarning).join(" · ");
  if (row.calculationStatus === "INCOMPLETE") {
    return warningDetails
      ? `순이익 계산 불완전: ${warningDetails}`
      : "순이익 계산이 불완전합니다.";
  }
  return warningDetails ? `계산 경고: ${warningDetails}` : undefined;
}

function formatRowWarning(warning: string) {
  if (warning === "AD_CONVERSION_EXCEEDS_NET_SALES") {
    return "광고 전환매출이 실제 순매출을 초과합니다. (AD_CONVERSION_EXCEEDS_NET_SALES)";
  }
  return warning;
}

function incompleteClass(row: CoupangDailyReportRow) {
  return row.calculationStatus === "INCOMPLETE" ? " coupang-daily-incomplete-row" : "";
}

function profitTone(value: number | null): "positive" | "negative" | "zero" | undefined {
  if (value === null) return undefined;
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "zero";
}
