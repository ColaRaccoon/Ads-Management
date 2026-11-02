import React from "react";
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
function ProductRow({ row, total = false }: { row: DailyProductRow; total?: boolean }) {
  return <tr className={total ? "daily-products-total" : undefined} data-product-key={row.productKey}>
    <th scope="row">{row.productName}{row.historical ? <small>과거 제품</small> : !row.active ? <small>비활성</small> : null}</th>
    {DAILY_PRODUCT_GROUPS.flatMap(group => DAILY_PRODUCT_METRICS.map((metric, i) => <td key={`${group.key}-${metric.key}`} className={`${i === 0 ? "daily-products-group-start " : ""}${group.key === "TOTAL" ? "daily-products-overall" : ""}`}><Value metric={row.groups[group.key][metric.key]} /></td>))}
  </tr>;
}
export function DailyProductsTable({ report }: { report: DailyProductsReport }) {
  const estimates = report.rows.some(row => DAILY_PRODUCT_GROUPS.some(group => DAILY_PRODUCT_METRICS.some(metric => row.groups[group.key][metric.key].current.isEstimate || row.groups[group.key][metric.key].previous.isEstimate)));
  return <article className="daily-products-report" aria-label="전체 제품 데일리 상세표">
    <header className="daily-products-heading"><div><span>PRODUCT DAILY DETAIL</span><h2>전체 제품 상세</h2></div><p>{report.date}<small>전일 {report.previousDate} · 한국시간</small></p></header>
    <p className="daily-products-scope">{report.scopeLabel}</p>
    <div className="daily-products-meta"><span>전체 {report.rows.length.toLocaleString("ko-KR")}개 제품 · 금액 단위: 원</span><span>금액 / 전일 대비 증감률 · A4 가로</span></div>
    <div className="daily-products-scroll"><table className="daily-products-table">
      <caption className="daily-products-sr-only">전체 제품의 자사몰, 쿠팡, 네이버, 구글 및 통합 광고비·매출·순이익과 전일 대비 증감률</caption>
      <colgroup><col className="daily-products-name-col" />{Array.from({ length: 15 }, (_, i) => <col key={i} className="daily-products-number-col" />)}</colgroup>
      <thead><tr><th rowSpan={2} scope="col">제품</th>{DAILY_PRODUCT_GROUPS.map(group => <th key={group.key} scope="colgroup" colSpan={3} className={`daily-products-group-start${group.key === "TOTAL" ? " daily-products-overall" : ""}`}>{group.label}</th>)}</tr>
        <tr>{DAILY_PRODUCT_GROUPS.flatMap(group => DAILY_PRODUCT_METRICS.map((metric, i) => <th scope="col" key={`${group.key}-${metric.key}`} className={`${i === 0 ? "daily-products-group-start " : ""}${group.key === "TOTAL" ? "daily-products-overall" : ""}`}>{metric.label}<small>(증감%)</small></th>))}</tr></thead>
      <tbody>{report.rows.map(row => <ProductRow key={row.productKey} row={row} />)}{!report.rows.length ? <tr><td colSpan={16} className="daily-products-empty">등록되거나 발행된 제품이 없습니다.</td></tr> : null}<ProductRow row={report.totals} total /></tbody>
    </table></div>
    <footer className="daily-products-basis">
      <p><strong>표시 기준</strong> —는 미확인, 0은 확인된 0원입니다. *는 당일 또는 전일의 부분 금액 기준입니다. 전일이 0·음수이거나 자료가 없으면 증감률 대신 상태를 표시합니다. 증감률은 소수점 한 자리로 반올림합니다. 색은 증감 방향이며 광고비 증가가 수익 개선을 뜻하지는 않습니다.</p>
      <p>순이익은 기존 플랫폼별 계산 기준의 추정 순이익입니다. 자사몰은 채널별 집계에서 Meta 판매, 구글은 Cafe24 유튜브 판매 기준입니다. 전체 열과 합계는 통합 결과를 사용하며, 그룹 금액이나 제품 증감률을 더하지 않습니다.</p>
      {report.provisional || estimates ? <p className="daily-products-warning">{report.provisional ? "잠정 자료 · 오늘을 포함한 발행 결과입니다. " : ""}{estimates ? "추정 데이터가 포함되어 있습니다." : ""}</p> : null}
      {report.warnings.map(warning => <p className="daily-products-warning" key={warning}>{warning}</p>)}
      <p><strong>제품 미귀속 금액</strong> 전체 합계에 포함될 수 있는 미분류·미배분 원천입니다. 아래 값은 서로 다른 항목이므로 합산하지 않습니다.</p>
      <dl className="daily-products-balances">{report.reconciliation.map(row => <div key={row.key}><dt>{row.label}</dt><dd>{dailyProductMoney(row.current)}원 <span>전일 {dailyProductMoney(row.previous)}원</span></dd></div>)}</dl>
      <p className="daily-products-end">제품 통합 성과 · 전체 제품 상세 · {report.date}</p>
    </footer>
  </article>;
}
