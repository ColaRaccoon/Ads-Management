"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { dashboardError, decimal, label, money, percent } from "./model";
import { availableAnalysisMedia, loadRelationships, relationshipCoordinates, relationshipKey, relationshipReason, selectedAnalysisMedia, validChangeDate,
  type AnalysisMedium, type RelationshipLag, type RelationshipMetric, type RelationshipPair, type Relationships, type RelationshipValue } from "./relationships-model";
import type { Envelope, Filters } from "./types";

const VALUE_LABELS: Record<RelationshipValue, string> = { adSpend: "분석 광고비", otherAdSpend: "나머지 매체 광고비", revenue: "매출", profitBeforeAds: "광고 전 이익" };
const lagLabel = (lag: number) => lag === 0 ? "같은 날" : `${lag}일 뒤 결과`;
const weekday = (date: string) => ["일", "월", "화", "수", "목", "금", "토"][new Date(`${date}T00:00:00Z`).getUTCDay()];
const reasons = (values: string[]) => values.length ? values.map(relationshipReason).join(" · ") : "표시 기준 충족";

export function RelationshipTooltip({ pair, outcomeLabel }: { pair: RelationshipPair; outcomeLabel: string }) {
  return <div style={{ padding: 12, background: "white", border: "1px solid #d8dfdf", borderRadius: 8 }}>
    <strong>{pair.adDate} 광고 → {pair.outcomeDate} ({weekday(pair.outcomeDate)}) 결과</strong>
    <p>분석 광고비: {money(pair.adSpend)}</p><p>{outcomeLabel}: {money(pair.outcome)}</p>
    <p>나머지 매체 광고비 (광고일): {money(pair.otherAdSpend)}</p>
    <p>{pair.isEstimate ? "추정 데이터 포함" : "원천 보고"}</p>
    {pair.issues.length ? <p>{pair.issues.map(label).join(" · ")}</p> : null}
  </div>;
}

export function RelationshipResults({ data, metric, lagDays }: { data: Relationships; metric: RelationshipMetric; lagDays: number }) {
  const a = data.analysis, lag = a.lags.find(row => row.metric === metric && row.lagDays === lagDays);
  const outcomeLabel = metric === "revenue" ? a.outcomeLabel : "선택 범위 광고 전 이익";
  if (!lag) return <p>이 시차의 분석 자료가 없습니다.</p>;
  const points = relationshipCoordinates(lag.pairs);
  return <>
    <p><strong>{outcomeLabel}</strong> · 결과일 {lag.from} ~ {lag.to} · 광고일은 결과일보다 {lagDays}일 전입니다. 추가 조회 시작일: {a.lookbackFrom}</p>
    <p>{lag.isEstimate ? "추정 데이터 포함 · " : ""}유효 {lag.usedDays}쌍 / 제외 {lag.excludedDays}일 / 대상 {lag.expectedDays}일. {reasons(lag.reasons)}</p>
    <p>상관계수: {decimal(lag.coefficient)} · 분석 광고비 표준편차: {money(lag.volatility.adSpendStdDev)} · 결과 표준편차: {money(lag.volatility.outcomeStdDev)}</p>
    {lag.issues.length ? <p>데이터 품질: {lag.issues.map(label).join(" · ")}</p> : null}
    <div style={{ height: 320, minWidth: 0 }} aria-label={`${lagLabel(lagDays)} 분석 광고비와 ${outcomeLabel} 산점도`}>
      {points.length ? <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 16, right: 28, left: 22, bottom: 28 }}>
        <CartesianGrid strokeDasharray="3 3" /><XAxis type="number" dataKey="x" name="분석 광고비" unit="원" label={{ value: "분석 광고비 (원)", position: "bottom", offset: 12 }} />
        <YAxis type="number" dataKey="y" name={outcomeLabel} unit="원" width={90} />
        <Tooltip cursor={{ strokeDasharray: "3 3" }} content={({ active, payload }) => active && payload?.[0]?.payload ? <RelationshipTooltip pair={payload[0].payload as RelationshipPair} outcomeLabel={outcomeLabel} /> : null} />
        <Scatter name={outcomeLabel} data={points} fill="#146c63" isAnimationActive={false} />
      </ScatterChart></ResponsiveContainer> : <p>표시할 유효 좌표가 없습니다. 누락일을 0원으로 채우지 않습니다.</p>}
    </div>
    {points.length !== lag.pairs.length ? <p>일부 금액은 그래프 좌표의 안전 범위를 넘어 생략했습니다. 아래 표에 정확한 원금액을 보존합니다.</p> : null}
    <div className="table-wrap"><table><caption>시차별 관측 비교 · 일별 원자료 기준</caption><thead><tr><th>시차</th><th>상관계수</th><th>사용 / 제외 / 대상</th><th>분석 광고비 표준편차</th><th>결과 표준편차</th><th>표시 기준·품질</th></tr></thead>
      <tbody>{a.lags.filter(row => row.metric === metric).map(row => <tr key={row.lagDays}><td>{lagLabel(row.lagDays)}</td><td>{decimal(row.coefficient)}</td>
        <td>{row.usedDays} / {row.excludedDays} / {row.expectedDays}</td><td>{money(row.volatility.adSpendStdDev)}</td><td>{money(row.volatility.outcomeStdDev)}</td>
        <td>{reasons(row.reasons)}{row.isEstimate ? " · 추정 데이터" : ""}</td></tr>)}</tbody></table></div>
    <details style={{ marginTop: 12 }}><summary>산점도 원금액과 사용·제외 날짜</summary>
      <div className="table-wrap" style={{ maxHeight: 420 }}><table><thead><tr><th>광고일</th><th>결과일·요일</th><th>분석 광고비</th><th>{outcomeLabel}</th><th>나머지 매체 광고비 (광고일)</th><th>품질</th></tr></thead><tbody>
        {lag.pairs.map(row => <tr key={row.outcomeDate}><td>{row.adDate}</td><td>{row.outcomeDate} ({weekday(row.outcomeDate)})</td><td>{money(row.adSpend)}</td><td>{money(row.outcome)}</td><td>{money(row.otherAdSpend)}</td><td>{row.isEstimate ? "추정 데이터" : "원천 보고"}{row.issues.length ? ` · ${row.issues.map(label).join(" · ")}` : ""}</td></tr>)}
      </tbody></table></div>
      <p>제외 날짜는 결과일 기준입니다.</p><ul>{lag.excludedDates.map(row => <li key={row.outcomeDate}>{row.outcomeDate} (광고일 {row.adDate}): {reasons(row.reasons)}</li>)}</ul>
    </details>
    {a.beforeAfter.length ? <div className="table-wrap" style={{ marginTop: 16 }}><table><caption>변경일 전후 일평균 · 변경일은 이후 구간에 포함</caption>
      <thead><tr><th>창</th><th>항목</th><th>변경 전 기간·평균</th><th>변경 후 기간·평균</th><th>평균 증감</th><th>증감률</th><th>사용·제외 / 확보 상태</th></tr></thead>
      <tbody>{a.beforeAfter.flatMap(row => (["adSpend", "otherAdSpend", "revenue", "profitBeforeAds"] as const).map(value => {
        const before = row.before.metrics[value], after = row.after.metrics[value], change = row.changes[value];
        return <tr key={`${row.windowDays}:${value}`}><td>전후 {row.windowDays}일</td><td>{value === "revenue" ? a.outcomeLabel : VALUE_LABELS[value]}</td>
          <td>{row.before.from} ~ {row.before.to}<br />{money(before.mean)}</td><td>{row.after.from} ~ {row.after.to}<br />{money(after.mean)}</td><td>{money(change.change)}</td><td>{percent(change.changePct)}{change.reason ? ` · ${relationshipReason(change.reason)}` : ""}</td>
          <td>전 {before.usedDays}·{before.excludedDays} / 후 {after.usedDays}·{after.excludedDays}<br />{before.complete && after.complete ? "전체 창 확보" : "부분 창 · 유효일 평균"}</td></tr>;
      }))}</tbody></table></div> : <p>변경일을 지정하면 전후 7일·14일의 일평균을 비교합니다.</p>}
    {a.beforeAfter.length ? <p>전후 비교는 관측된 유효일의 평균입니다. 부분 창은 전체 기간의 변화로 일반화하지 않습니다. 나머지 매체도 함께 변했다면 매체별 영향을 구분할 수 없습니다.</p> : null}
    <details style={{ marginTop: 12 }}><summary>일별 맥락 · 요일·다른 매체·7일 이동평균</summary>
      <p>7일 이동평균은 연속된 완료 일별 값의 시각화 참고입니다. 계수의 독립 표본으로 사용하지 않습니다.</p>
      <div className="table-wrap" style={{ maxHeight: 420 }}><table><thead><tr><th>날짜·요일</th><th>분석 광고비</th><th>나머지 매체 광고비</th><th>{a.outcomeLabel}</th><th>광고 전 이익</th><th>광고비 7일 이동평균</th><th>매출 7일 이동평균</th><th>품질</th></tr></thead>
        <tbody>{a.daily.map(row => <tr key={row.date}><td>{row.date} ({weekday(row.date)})</td><td>{money(row.adSpend)}</td><td>{money(row.otherAdSpend)}</td><td>{money(row.revenue)}</td><td>{money(row.profitBeforeAds)}</td><td>{money(row.movingAverage7.adSpend)}</td><td>{money(row.movingAverage7.revenue)}</td><td>{row.isEstimate ? "추정 데이터" : "원천 보고"}{row.issues.length ? ` · ${row.issues.map(label).join(" · ")}` : ""}</td></tr>)}</tbody>
      </table></div>
    </details>
    <p>{a.events.message}</p>
    {a.warnings.length ? <p role="status">{a.warnings.map(relationshipReason).join(" · ")}</p> : null}
  </>;
}

export function RelationshipPanel({ filters, identity, anchor, onRefresh }: { filters: Filters; identity: string; anchor: Envelope; onRefresh: () => void }) {
  const available = availableAnalysisMedia(filters.platforms);
  const [selected, setSelected] = useState<AnalysisMedium[] | null>(null);
  const media = selectedAnalysisMedia(filters.platforms, selected);
  const platformKey = filters.platforms.join(",");
  useEffect(() => { setSelected(current => current === null ? null : selectedAnalysisMedia(filters.platforms, current)); }, [platformKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [metric, setMetric] = useState<RelationshipMetric>("revenue"), [lagDays, setLagDays] = useState(0), [changeDate, setChangeDate] = useState("");
  const valid = validChangeDate(changeDate, filters);
  const canAnalyze = anchor.metricAvailability.revenue && anchor.metricAvailability.adSpend && media.length > 0;
  const query = useQuery({ queryKey: relationshipKey(identity, filters, media, changeDate, anchor), retry: false, staleTime: 0,
    refetchOnWindowFocus: false, refetchOnReconnect: false, enabled: canAnalyze && valid,
    queryFn: ({ signal }) => loadRelationships(filters, media, changeDate, anchor, undefined, signal) });
  const data = canAnalyze && valid && !query.isFetching && !query.isError ? query.data : undefined;
  return <section className="panel" style={{ marginTop: 16 }} aria-label="광고비 변화 관계 분석"><h2>광고비 변화와 매출의 관측 관계</h2>
    <p>광고비 증가 기간에 매출이 증가하는지 함께 관찰합니다. 상관계수와 전후 차이는 인과효과를 뜻하지 않습니다. 순이익은 광고비를 직접 차감하므로 결과값은 매출 또는 광고 전 이익으로 비교합니다.</p>
    <fieldset style={{ border: 0, padding: 0 }}><legend>분석 광고 매체 · 상단 플랫폼 선택 안에서 분석 대상만 변경</legend><div className="toolbar" style={{ flexWrap: "wrap" }}>
      {available.map(medium => <label key={medium}><input type="checkbox" checked={media.includes(medium)} onChange={() => setSelected(media.includes(medium) ? media.filter(value => value !== medium) : [...media, medium])} /> {label(medium)}</label>)}
    </div></fieldset>
    <div className="toolbar" style={{ flexWrap: "wrap", marginTop: 12 }}>
      <label>결과값 <select value={metric} onChange={event => setMetric(event.target.value as RelationshipMetric)}><option value="revenue">매출</option><option value="profitBeforeAds">광고 전 이익</option></select></label>
      <label>시차 <select value={lagDays} onChange={event => setLagDays(Number(event.target.value))}>{[0, 1, 3, 7, 14].map(lag => <option key={lag} value={lag}>{lagLabel(lag)}</option>)}</select></label>
      <label>광고비 변경일 (선택) <input type="date" value={changeDate} min={filters.from} max={filters.to} onChange={event => setChangeDate(event.target.value)} /></label>
      <button type="button" onClick={() => setChangeDate("")} disabled={!changeDate}>변경일 해제</button>
    </div>
    <p>상관계수는 유효 일별 쌍 60개 이상·양쪽 변동성 확보·제외율 20% 이하일 때 표시합니다. 이 표시 기준은 통계적 보장이 아닙니다. 여러 시차 중 큰 계수만으로 효과 발생일을 확정하지 않습니다.</p>
    {!anchor.metricAvailability.revenue ? <p>판매 플랫폼을 선택하면 매출·광고 전 이익과 비교할 수 있습니다.</p> : !anchor.metricAvailability.adSpend || !available.length ? <p>광고 플랫폼을 선택하면 관계를 비교할 수 있습니다.</p> : !media.length ? <p>분석할 광고 매체를 선택하세요. 상단 플랫폼의 매출·총광고비·이익은 그대로 유지됩니다.</p> : !valid ? <p role="alert">변경일은 조회 기간 안의 유효한 날짜로 지정하세요.</p> : query.isFetching || query.isPending ? <p role="status">선택 범위의 일별 관계 분석을 읽고 있습니다.</p> : query.isError ? <div role="alert"><p>{dashboardError(query.error)}</p><button type="button" onClick={onRefresh}>성과·관계 분석 다시 조회</button></div> : data ? <RelationshipResults data={data} metric={metric} lagDays={lagDays} /> : null}
  </section>;
}
