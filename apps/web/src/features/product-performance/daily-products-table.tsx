import React from "react";
import { NativeResultPublicationTimes } from "./native-result-basis";
import { NATIVE_RESULT_HELP } from "./native-result-metadata";
import { DAILY_PRODUCT_GROUPS, DAILY_PRODUCT_METRICS, dailyProductChange, dailyProductMoney, dailyProductStateLabel, dailyProductTone,
  type ComparedMetric, type DailyProductRow, type DailyProductsReport } from "./daily-products-model";

function Value({ metric }: { metric: ComparedMetric }) {
  const current = metric.current, unavailable = current.state === "EXCLUDED" || current.state === "NOT_APPLICABLE";
  const partial = current.state === "PARTIAL", comparisonPartial = partial || metric.previous.state === "PARTIAL";
  const title = `당일 ${dailyProductStateLabel(current)} · 전일 ${dailyProductMoney(metric.previous.value)}원 (${dailyProductStateLabel(metric.previous)})${current.isEstimate ? " · 추정 자료" : ""}`;
  return <div className="daily-products-value" title={title}>
    <span className="daily-products-money">{unavailable ? dailyProductStateLabel(current) : dailyProductMoney(current.value)}{partial ? "*" : ""}</span>
    <span className={`daily-products-change daily-products-${dailyProductTone(metric)}`}>{unavailable ? "" : `(${dailyProductChange(metric)}${comparisonPartial ? "*" : ""})`}</span>
  </div>;
}
function ProductRow({ row, total = false, printHidden = false }: { row: DailyProductRow; total?: boolean; printHidden?: boolean }) {
  return <tr className={total ? "daily-products-total" : undefined} data-product-key={row.productKey} data-print-hidden={printHidden ? "true" : undefined}>
    <th scope="row">{row.productName}{row.historical ? <small>과거 제품</small> : !row.active ? <small>비활성</small> : null}</th>
    {DAILY_PRODUCT_GROUPS.flatMap(group => DAILY_PRODUCT_METRICS.map((metric, i) => <td key={`${group.key}-${metric.key}`} className={`${i === 0 ? "daily-products-group-start " : ""}${group.key === "TOTAL" ? "daily-products-overall" : ""}`}><Value metric={row.groups[group.key][metric.key]} /></td>))}
  </tr>;
}
export type DailyProductsTableProps = { report: DailyProductsReport; printReport?: DailyProductsReport };

/** One table preserves the screen's original amounts; print filtering changes visibility only. */
export function DailyProductsTable({ report, printReport }: DailyProductsTableProps) {
  const printKeys = printReport ? new Set(printReport.rows.map(row => row.productKey)) : undefined;
  const printSelection = printReport?.exportSelection;
  const printLabel = printSelection?.platform !== "ALL" && printSelection?.label ? `${printSelection.label} 제품 상세` : "전체 제품 상세";
  const estimates = report.rows.some(row => DAILY_PRODUCT_GROUPS.some(group => DAILY_PRODUCT_METRICS.some(metric => row.groups[group.key][metric.key].current.isEstimate || row.groups[group.key][metric.key].previous.isEstimate)));
  return <article className="daily-products-report" aria-label="전체 제품 데일리 상세표" data-print-filtered={printReport ? "true" : "false"} data-print-count={printReport?.rows.length ?? report.rows.length}>
    <header className="daily-products-heading"><div><span>PRODUCT DAILY DETAIL</span><h2><span className="daily-products-screen-only">전체 제품 상세</span><span className="daily-products-print-only">{printLabel}</span></h2></div><p>{report.date}<small>전일 {report.previousDate} · 한국시간</small></p></header>
    <p className="daily-products-scope">{report.scopeLabel}</p>
    <p className="daily-products-screen-only"><a href="/products/mappings">플랫폼 통합 제품 매핑 관리</a></p>
    <div className="daily-products-meta daily-products-screen-only"><span>전체 {report.rows.length.toLocaleString("ko-KR")}개 제품 · 금액 단위: 원</span><span>금액 / 전일 대비 증감률 · 인쇄 A4 세로</span></div>
    <div className="daily-products-meta daily-products-print-only"><span>출력 {String(printReport?.rows.length ?? report.rows.length)} / 전체 {report.rows.length.toLocaleString("ko-KR")}개 제품 · 금액 단위: 원</span><span>금액 / 전일 대비 증감률 · A4 세로</span></div>
    {printSelection ? <p className="daily-products-print-basis daily-products-print-only">출력 제품 필터: {printSelection.label} · {printSelection.basis}</p> : null}
    <div className="daily-products-scroll"><table className="daily-products-table">
      <caption className="daily-products-sr-only">전체 제품의 자사몰, 쿠팡, 네이버, 구글 및 통합 광고비·매출·순이익과 전일 대비 증감률</caption>
      <colgroup><col className="daily-products-name-col" />{Array.from({ length: 15 }, (_, i) => <col key={i} className="daily-products-number-col" />)}</colgroup>
      <thead><tr><th rowSpan={2} scope="col">제품</th>{DAILY_PRODUCT_GROUPS.map(group => <th key={group.key} scope="colgroup" colSpan={3} className={`daily-products-group-start${group.key === "TOTAL" ? " daily-products-overall" : ""}`}>{group.label}</th>)}</tr>
        <tr>{DAILY_PRODUCT_GROUPS.flatMap(group => DAILY_PRODUCT_METRICS.map((metric, i) => <th scope="col" key={`${group.key}-${metric.key}`} className={`${i === 0 ? "daily-products-group-start " : ""}${group.key === "TOTAL" ? "daily-products-overall" : ""}`}>{metric.label}<small>(증감%)</small></th>))}</tr></thead>
      <tbody>{report.rows.map(row => <ProductRow key={row.productKey} row={row} printHidden={printKeys !== undefined && !printKeys.has(row.productKey)} />)}{!report.rows.length ? <tr data-print-hidden={printReport ? "true" : undefined}><td colSpan={16} className="daily-products-empty">등록되거나 발행된 제품이 없습니다.</td></tr> : null}
        {printReport && !printReport.rows.length ? <tr className="daily-products-print-only"><td colSpan={16} className="daily-products-empty">출력 조건에 해당하는 제품이 없습니다.</td></tr> : null}<ProductRow row={report.totals} total printHidden={Boolean(printReport)} /></tbody>
    </table></div>
    <footer className="daily-products-basis">
      <p><strong>표시 기준</strong> —는 미확인, 0은 확인된 0원입니다. *는 당일 또는 전일의 부분 금액 기준입니다. 전일이 0·음수이거나 자료가 없으면 증감률 대신 상태를 표시합니다. 증감률은 소수점 한 자리로 반올림합니다. 색은 증감 방향이며 광고비 증가가 수익 개선을 뜻하지는 않습니다.</p>
      {report.resultBasis === "NATIVE_FINAL" ? <><p>{NATIVE_RESULT_HELP} 순이익의 비용 포함 범위와 추정 여부는 각 원본 보고서 기준을 유지합니다.</p><NativeResultPublicationTimes date={report.date} sources={report.sourcePublicationTimes ?? []} /></> : <p>순이익은 기존 플랫폼별 계산 기준의 추정 순이익입니다. 자사몰은 채널별 집계에서 Meta 판매, 구글은 Cafe24 유튜브 판매 기준입니다. 전체 열과 합계는 통합 결과를 사용하며, 그룹 금액이나 제품 증감률을 더하지 않습니다.</p>}
      {report.provisional || estimates ? <p className="daily-products-warning">{report.provisional ? "잠정 자료 · 오늘을 포함한 발행 결과입니다. " : ""}{estimates ? "추정 데이터가 포함되어 있습니다." : ""}</p> : null}
      {report.warnings.map(warning => <p className="daily-products-warning" key={warning}>{warning}</p>)}
      <p data-print-hidden={printReport ? "true" : undefined}><strong>제품 미귀속 금액</strong> 전체 합계에 포함될 수 있는 미분류·미배분 원천입니다. 아래 값은 서로 다른 항목이므로 합산하지 않습니다.</p>
      <dl className="daily-products-balances" data-print-hidden={printReport ? "true" : undefined}>{report.reconciliation.map(row => <div key={row.key}><dt>{row.label}</dt><dd>{dailyProductMoney(row.current)}원 <span>전일 {dailyProductMoney(row.previous)}원</span></dd></div>)}</dl>
      {printReport ? <p className="daily-products-print-only">제품 필터가 적용된 상세 출력에는 전체 제품 합계와 미귀속 조정을 포함하지 않습니다. 제품별 금액과 앞의 요약 보고 금액은 원본 그대로입니다.</p> : null}
      <p className="daily-products-end">제품 통합 성과 · <span className="daily-products-screen-only">전체 제품 상세</span><span className="daily-products-print-only">{printLabel}</span> · {report.date}</p>
    </footer>
  </article>;
}
