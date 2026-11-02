"use client";

import { useQuery } from "@tanstack/react-query";
import { koreaTodayDateInput } from "@/lib/korea-date";
import { buildDailyReport, latestPublishedDate, type DailyMetric } from "./daily-report-model";
import { dashboardError, filterParams, loadDashboard, readPerformance, responseMatches, shiftDate } from "./model";
import { availableAnalysisMedia } from "./relationships-model";
import { PLATFORM_LABELS, type DashboardData, type Filters, type SelectionOptions } from "./types";

const CHANNELS = [{ id: "CAFE24", platform: "CAFE24", name: "자사몰 Cafe24" }, { id: "NAVER_SMARTSTORE", platform: "NAVER", name: "네이버 스마트스토어" }, { id: "COUPANG", platform: "COUPANG", name: "쿠팡" }] as const;
const MEDIA: Record<string, string> = { META: "Meta 광고", GOOGLE: "Google 광고", NAVER_DA: "네이버 DA", COUPANG_ADS: "쿠팡 광고" };
const EMPTY: DailyMetric = { current: null, previous: null, change: null, changePct: null, currentState: "UNAVAILABLE", previousState: "UNAVAILABLE", missingSources: [], currentMissingSources: [], previousMissingSources: [] };
const won = (n: number | null) => n === null ? "—" : Math.round(n).toLocaleString("ko-KR") + "원";
const signedWon = (n: number | null) => n === null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${won(Math.abs(n))}`;
const tone = (n: number | null) => n === null || n === 0 ? "neutral" : n > 0 ? "up" : "down";
export function dailyChangeLabel(metric: DailyMetric) {
  if (metric.current === null && metric.previous === null) return "전일·당일 자료 없음";
  if (metric.previous === null) return "전일 자료 없음";
  if (metric.current === null) return "당일 자료 없음";
  if (metric.previous < 0) return "전일 음수 · 증감액 비교";
  if (metric.previous === 0) return metric.current > 0 && metric.previousState === "COMPLETE" ? "0원에서 증가" : "전일 기준 0원";
  if (metric.changePct === null) return "증감률 계산 불가";
  const pct = metric.changePct;
  return pct !== 0 && Math.abs(pct) < .5 ? `${pct > 0 ? "+" : "−"}1% 미만` : `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.round(Math.abs(pct))}%`;
}
function Basis({ metric }: { metric: DailyMetric }) {
  if (metric.currentState === "PARTIAL" || metric.previousState === "PARTIAL") return <small className="integrated-daily-partial">확인된 금액 기준{metric.currentState === "PARTIAL" && metric.previousState === "PARTIAL" ? " · 전일·당일" : metric.currentState === "PARTIAL" ? " · 당일" : " · 전일"}</small>;
  return null;
}
function Result({ metric }: { metric: DailyMetric }) {
  return <div className="integrated-daily-result"><strong>{won(metric.current)}</strong><span className={`integrated-daily-${tone(metric.change)}`}>{dailyChangeLabel(metric)}{metric.change !== null ? ` · ${signedWon(metric.change)}` : ""}</span><Basis metric={metric} /></div>;
}
export function dailyReportFilters(filters: Filters, date: string): Filters {
  const previous = shiftDate(date, -1);
  return { ...filters, from: previous, to: date, grain: "day", compareMode: "custom", compareFrom: previous, compareTo: previous };
}
export const dailyReportKey = (identity: string, filters: Filters) => ["product-performance-daily", identity, filterParams(filters).toString()] as const;
function validDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + "T00:00:00Z")) && new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date;
}
export function DailyReport({ identity, filters, options, requestedDate, onDateChange, onRefreshLatest }: { identity: string; filters: Filters; options?: SelectionOptions; requestedDate: string; onDateChange: (date: string) => void; onRefreshLatest?: () => void }) {
  const today = koreaTodayDateInput();
  const latest = options ? latestPublishedDate(options.availableDateRanges, filters, today) : null;
  const date = requestedDate || latest || "";
  const valid = validDate(date) && date <= today;
  const dailyFilters = dailyReportFilters(filters, valid ? date : today);
  const query = useQuery({ queryKey: dailyReportKey(identity, dailyFilters), enabled: valid,
    queryFn: ({ signal }) => loadDashboard(dailyFilters, readPerformance, signal), retry: false, staleTime: 30_000, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const data = valid && !query.isError && query.data && responseMatches(query.data.summary, dailyFilters) ? query.data : undefined;
  return <section className="integrated-daily-root" id="performance-daily-panel" role="tabpanel" aria-labelledby="performance-daily-tab">
    <div className="integrated-daily-controls"><div><label>보고일 <input type="date" aria-label="데일리 보고일" value={valid ? date : ""} max={today} onChange={event => { if (event.target.value) onDateChange(event.target.value); }} /></label><button type="button" disabled={!valid} onClick={() => onDateChange(shiftDate(date, -1))}>이전 날</button><button type="button" disabled={!valid || date >= today} onClick={() => onDateChange(shiftDate(date, 1))}>다음 날</button><button type="button" disabled={!latest || (!requestedDate && latest === date)} onClick={() => onDateChange("")}>최신 발행일{latest ? ` ${latest}` : ""}</button></div><div><button type="button" disabled={!valid || query.isFetching} onClick={() => { onRefreshLatest?.(); void query.refetch(); }}>다시 조회</button><button type="button" className="integrated-daily-print-button" disabled={!data || query.isFetching} onClick={() => window.print()}>A4 인쇄 / PDF 저장</button></div></div>
    <p className="integrated-daily-help">보고일과 바로 전날의 성과를 비교합니다. 최신 발행일은 선택한 플랫폼·계정 범위의 최근 발행 기준이며, 모든 원천의 수집 완료를 뜻하지 않습니다.</p>
    {requestedDate && !valid ? <p role="alert">보고일을 확인해 주세요. 한국시간 오늘까지의 유효한 날짜를 선택할 수 있습니다.</p> : !date ? <p role="status">{options ? "선택 범위의 발행일이 없습니다. 보고일을 직접 선택해 확인할 수 있습니다." : "최신 발행일을 확인하고 있습니다."}</p> : null}
    {valid && query.isPending ? <p role="status">선택일과 전일의 데일리 성과를 읽고 있습니다.</p> : null}
    {query.isError ? <p role="alert">{dashboardError(query.error)}</p> : null}
    {data ? <><DailyReportSheet data={data} date={date} filters={filters} options={options} />{query.isFetching ? <p role="status">최신 금액을 확인하고 있습니다.</p> : null}</> : null}
  </section>;
}
export function DailyReportSheet({ data, date, filters, options }: { data: DashboardData; date: string; filters: Filters; options?: SelectionOptions }) {
  const report = buildDailyReport(data.timeseries.items, date);
  const sources = filters.platforms.map(platform => PLATFORM_LABELS[platform]).join(" · ");
  const scopes = filters.scopeKeys === undefined ? "전체 계정·스토어" : `${filters.scopeKeys.length}개 계정·스토어 선택`;
  const scopeLabels = filters.scopeKeys?.map(key => options?.scopes.find(scope => scope.scopeKey === key)?.label ?? key) ?? [];
  const scopeDetail = scopeLabels.slice(0, 2).join(" · ").slice(0, 90) + (scopeLabels.length > 2 ? ` 외 ${scopeLabels.length - 2}개` : "");
  const channels = CHANNELS.filter(channel => filters.platforms.includes(channel.platform));
  const media = availableAnalysisMedia(filters.platforms);
  const metrics = [{ key: "revenue", title: "매출" }, { key: "estimatedProfit", title: "추정 순이익" }, { key: "adSpend", title: "광고비" }] as const;
  const allMetrics = [...Object.values(report.totals), ...report.marketplaces.flatMap(row => [row.revenue, row.estimatedProfit]), ...report.media.map(row => row.adSpend)];
  const partial = allMetrics.some(value => value.currentState === "PARTIAL" || value.previousState === "PARTIAL");
  const missing = [...new Set(allMetrics.flatMap(value => value.missingSources))].map(source => PLATFORM_LABELS[source as keyof typeof PLATFORM_LABELS] ?? source).join(" · ");
  const noCurrent = Object.values(report.totals).every(value => value.current === null);
  return <article className="integrated-daily-report" aria-label="A4 데일리 성과 보고서">
    <header className="integrated-daily-heading"><div><span>PATIMAGROUP / PERFORMANCE REPORT</span><h2>제품 통합 데일리 보고</h2></div><div><strong>{report.date}</strong><small>전일 비교 {report.previousDate} · 한국시간</small></div></header>
    <section className="integrated-daily-scope" aria-label="보고서 조회 범위"><div><span>제품</span><strong>{filters.productName || "전체 제품"}</strong></div><div><span>포함 플랫폼</span><p>{sources || "선택 없음"}</p></div><div><span>계정·스토어</span><p>{scopes}{scopeDetail ? ` · ${scopeDetail}` : ""}</p></div></section>
    {noCurrent ? <p className="integrated-daily-empty" role="status">선택일 {date}에 확인 가능한 금액이 없습니다. 미수집 금액은 0원으로 표시하지 않습니다.</p> : null}
    <section className="integrated-daily-kpis" aria-label="데일리 성과 요약">{metrics.map(metric => <div className="integrated-daily-kpi" key={metric.key}><span>{metric.title}</span><Result metric={report.totals[metric.key]} /><small>전일 {won(report.totals[metric.key].previous)}</small></div>)}</section>
    <section className="integrated-daily-section"><div className="integrated-daily-section-title"><h3>판매처별 매출 · 이익</h3><span>당일 금액 / 전일 대비 변화</span></div><table><thead><tr><th scope="col">판매처</th><th scope="col">매출</th><th scope="col">추정 순이익</th></tr></thead><tbody>{channels.map(channel => { const row = report.marketplaces.find(item => item.marketplace === channel.id); return <tr key={channel.id}><th scope="row">{channel.name}</th><td><Result metric={row?.revenue ?? EMPTY} /></td><td><Result metric={row?.estimatedProfit ?? EMPTY} /></td></tr>; })}</tbody></table>{!channels.length ? <p className="integrated-daily-empty">선택한 범위에 판매 플랫폼이 없습니다.</p> : null}</section>
    <section className="integrated-daily-section"><div className="integrated-daily-section-title"><h3>광고 매체별 집행비</h3><span>당일 금액 / 전일 대비 변화</span></div><table><thead><tr><th scope="col">광고 매체</th><th scope="col">당일 광고비</th><th scope="col">전일 광고비</th><th scope="col">증감률 · 증감액</th></tr></thead><tbody>{media.map(medium => { const metric = report.media.find(item => item.medium === medium)?.adSpend ?? EMPTY; return <tr key={medium}><th scope="row">{MEDIA[medium]}</th><td>{won(metric.current)}<Basis metric={metric} /></td><td>{won(metric.previous)}</td><td className={`integrated-daily-${tone(metric.change)}`}>{dailyChangeLabel(metric)}<small>{signedWon(metric.change)}</small></td></tr>; })}</tbody></table>{!media.length ? <p className="integrated-daily-empty">선택한 범위에 광고 매체가 없습니다.</p> : null}</section>
    <footer className="integrated-daily-basis"><strong>집계 기준</strong>{data.summary.provisional || report.isEstimate ? <p>{data.summary.provisional ? "잠정 자료 · 한국시간 오늘을 포함한 집계입니다. " : ""}{report.isEstimate ? "추정 데이터 포함. " : ""}발행된 금액이며 모든 원천의 수집 완료를 뜻하지 않습니다.</p> : null}<p>{partial ? "일부 수집·매핑·원가 입력이 미완료되어 확인된 금액 기준입니다. " : "선택 범위에 저장된 일별 집계 기준입니다. "}{missing ? `일부 미확인 원천: ${missing}. ` : ""}—는 미확인, 0원은 확인된 0원입니다. 전일 자료가 없거나 0원·음수 기준이면 증감률 대신 상태와 증감액을 표시합니다.</p><p>추정 순이익은 저장된 원가·수수료·배송비·광고비 등 비용과 배분 기준을 반영합니다. Meta·Google 전환매출은 판매처 매출에 중복 합산하지 않습니다. 전일 비교는 관측 변화이며 광고의 인과효과를 뜻하지 않습니다.</p><div>제품 통합 성과 · 데일리 보고<span>A4 · 1 page</span></div></footer>
  </article>;
}
