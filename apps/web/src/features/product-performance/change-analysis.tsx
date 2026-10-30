"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { analyzeChanges, type ChangeMetric } from "./change-analysis-model";
import { dayCount, shiftDate } from "./model";
import { availableAnalysisMedia, type AnalysisMedium } from "./relationships-model";
import { PLATFORM_LABELS, type Platform, type DashboardData, type Filters } from "./types";
const styles = {"badge": "changeAnalysis-badge", "beforeAfter": "changeAnalysis-beforeAfter", "bigAmount": "changeAnalysis-bigAmount", "bigPct": "changeAnalysis-bigPct", "change": "changeAnalysis-change", "channel": "changeAnalysis-channel", "chart": "changeAnalysis-chart", "chartCaption": "changeAnalysis-chartCaption", "chartMeta": "changeAnalysis-chartMeta", "chartPanel": "changeAnalysis-chartPanel", "compare": "changeAnalysis-compare", "controls": "changeAnalysis-controls", "decrease": "changeAnalysis-decrease", "delta": "changeAnalysis-delta", "detailBody": "changeAnalysis-detailBody", "empty": "changeAnalysis-empty", "eyebrow": "changeAnalysis-eyebrow", "increase": "changeAnalysis-increase", "insight": "changeAnalysis-insight", "legend": "changeAnalysis-legend", "logo": "changeAnalysis-logo", "lower": "changeAnalysis-lower", "neutral": "changeAnalysis-neutral", "partial": "changeAnalysis-partial", "periods": "changeAnalysis-periods", "results": "changeAnalysis-results", "resultsFoot": "changeAnalysis-resultsFoot", "root": "changeAnalysis-root", "sectionHead": "changeAnalysis-sectionHead", "segmented": "changeAnalysis-segmented", "selected": "changeAnalysis-selected", "source": "changeAnalysis-source", "sourceAmount": "changeAnalysis-sourceAmount", "sourceName": "changeAnalysis-sourceName", "sources": "changeAnalysis-sources", "spendCard": "changeAnalysis-spendCard", "tableWrap": "changeAnalysis-tableWrap", "tag": "changeAnalysis-tag", "tooltip": "changeAnalysis-tooltip", "unavailable": "changeAnalysis-unavailable"};

const MEDIA: { id: AnalysisMedium; name: string; logo: string; color: string }[] = [
  { id: "META", name: "Meta", logo: "∞", color: "#577ed1" }, { id: "GOOGLE", name: "Google", logo: "G", color: "#b38c43" },
  { id: "NAVER_DA", name: "네이버 DA", logo: "N", color: "#589d53" }, { id: "COUPANG_ADS", name: "쿠팡", logo: "C", color: "#ba7061" },
];
const CHANNELS = [{ id: "CAFE24", name: "자사몰", sub: "Cafe24", color: "#2a947e" },
  { id: "NAVER_SMARTSTORE", name: "네이버", sub: "스마트스토어", color: "#6587cf" },
  { id: "COUPANG", name: "쿠팡", sub: "마켓플레이스", color: "#ad83bf" }];
type Change = ChangeMetric;
const isPartial = (value: Change) => value.beforeDays < value.expectedDays || value.afterDays < value.expectedDays || value.beforePartialDays > 0 || value.afterPartialDays > 0;
const sourceNames = (sources: string[]) => sources.map(source => PLATFORM_LABELS[source as Platform] ?? source).join(", ");
const coverageLabel = (value: Change) => `${isPartial(value) ? "확인된 금액 · " : ""}전${value.beforeDays}/후${value.afterDays}일`;
const won = (n: number | null) => n === null ? "—" : `${Math.round(n).toLocaleString("ko-KR")}원`;
const delta = (n: number | null) => n === null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${won(Math.abs(n))}`;
const percentage = (n: number | null) => n === null ? "비교 불가" : n !== 0 && Math.abs(n) < 0.5 ? `${n > 0 ? "+" : "−"}1% 미만` : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.round(Math.abs(n))}%`;
const tone = (n: number | null) => n === null || n === 0 ? styles.neutral : n > 0 ? styles.increase : styles.decrease;
const shortDate = (s: string) => s.slice(5).replace("-", ".");
const rangeText = (r: [string, string]) => r.map(shortDate).join("–");

function ChangeCell({ value, reason }: { value: Change; reason?: string | null }) {
  return value.before === null || value.after === null ? <><span className={styles.unavailable}>— {reason === "CROSS_MARKET_AD_ALLOCATION_UNKNOWN" ? "배분 기준 확인 필요" : "비교 자료 부족"}</span><small>변경 전 {won(value.before)} · 변경 후 {won(value.after)}</small><small>{coverageLabel(value)}</small></> : <>
    <strong className={`${styles.change} ${tone(value.change)}`}>{percentage(value.changePct)}</strong>
    <span className={`${styles.delta} ${tone(value.change)}`}>{delta(value.change)} / 일</span>
    {isPartial(value) ? <small className={styles.partial} title={`대상 전후 각각 ${value.expectedDays}일${value.missingSources.length ? ` · 일부 미확인: ${sourceNames(value.missingSources)}` : ""}`}>{coverageLabel(value)}</small> : null}
    {value.changePct === null ? <small>변경 전 기준이 0 이하 · 증감액으로 비교</small> : null}
  </>;
}

export function ChangeAnalysis({ data, filters }: { data: DashboardData; filters: Filters }) {
  const available = availableAnalysisMedia(filters.platforms);
  const [selection, setSelection] = useState<AnalysisMedium>(available[0] ?? "META");
  const medium = available.includes(selection) ? selection : available[0] ?? "META";
  const initialDate = shiftDate(filters.from, Math.floor((dayCount(filters.from, filters.to) - 1) / 2));
  const [date, setDate] = useState(initialDate);
  const changeDate = date >= filters.from && date <= filters.to ? date : initialDate;
  const [windowDays, setWindowDays] = useState(7);
  const [lagDays, setLagDays] = useState(0);
  const [metric, setMetric] = useState<"revenue" | "estimatedProfit">("revenue");
  const buckets = data.timeseries.items;
  const options = { medium, changeDate, windowDays, lagDays };
  const analysis = useMemo(() => analyzeChanges(buckets, options), [buckets, medium, changeDate, windowDays, lagDays]); // eslint-disable-line react-hooks/exhaustive-deps
  const mediaResults = MEDIA.map(item => ({ ...item, spend: analyzeChanges(buckets, { ...options, medium: item.id }).spend }));
  const source = MEDIA.find(item => item.id === medium)!;
  const channels = CHANNELS.filter(item => data.summary.selectedPlatforms.includes((item.id === "NAVER_SMARTSTORE" ? "NAVER" : item.id) as "CAFE24" | "NAVER" | "COUPANG"));
  const results = channels.map(item => ({ ...item, value: analysis.marketplaces.find(value => value.marketplace === item.id) }));
  const baselines = new Map(results.map(row => [row.id, row.value?.[metric].before ?? null]));
  const graphRows = analysis.series.map(row => {
    const result: Record<string, string | number | null> = { date: row.date, adSpend: analysis.spend.before !== null && analysis.spend.before > 0 && row.adSpend !== null ? row.adSpend / analysis.spend.before * 100 : null, adRaw: row.adSpend, adPartial: row.adPartial ? 1 : 0 };
    for (const channel of channels) { const base = baselines.get(channel.id), raw = row.marketplaces.find(m => m.marketplace === channel.id)?.[metric] ?? null;
      result[channel.id] = base != null && base > 0 && raw !== null ? raw / base * 100 : null; result[`${channel.id}Raw`] = raw; result[`${channel.id}Partial`] = row.marketplaces.find(m => m.marketplace === channel.id)?.[metric === "revenue" ? "revenuePartial" : "estimatedProfitPartial"] ? 1 : 0; }
    return result;
  });
  const completeResult = results.filter(row => row.value?.revenue.changePct != null).sort((a, b) => Math.abs(b.value!.revenue.changePct!) - Math.abs(a.value!.revenue.changePct!))[0];
  const rawRows = [{ label: `${source.name} 광고비`, value: analysis.spend }, ...results.flatMap(row => row.value ? [{ label: `${row.name} 매출`, value: row.value.revenue }, { label: `${row.name} 추정 순이익`, value: row.value.estimatedProfit }] : [])];
  const partial = rawRows.some(row => isPartial(row.value));
  const concurrent = mediaResults.filter(row => row.id !== medium && available.includes(row.id) && row.spend.changePct !== null && Math.abs(row.spend.changePct) >= 5);
  const exportCsv = () => {
    const rows = [["제품", filters.productName || "전체 제품"], ["광고 매체", source.name], ["광고비 비교", analysis.periods.adBefore.join(" ~ "), analysis.periods.adAfter.join(" ~ ")],
      ["판매 결과 비교", analysis.periods.outcomeBefore.join(" ~ "), analysis.periods.outcomeAfter.join(" ~ ")], ["항목", "변경 전 일평균(원)", "변경 후 일평균(원)", "증감액(원)", "증감률", "전 확보일", "후 확보일", "대상일", "금액 기준", "일부 미확인 원천"],
      ...rawRows.map(row => [row.label, row.value.before === null ? "" : Math.round(row.value.before), row.value.after === null ? "" : Math.round(row.value.after), row.value.change === null ? "" : Math.round(row.value.change), percentage(row.value.changePct), row.value.beforeDays, row.value.afterDays, windowDays, isPartial(row.value) ? "확인된 금액" : "완전 금액", sourceNames(row.value.missingSources)])];
    const url = URL.createObjectURL(new Blob(["\ufeff" + rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `광고비변화_성과비교_${changeDate}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (filters.grain !== "day") return <div className={styles.empty} role="status">광고비 변경 전후 비교는 일별 자료가 필요합니다. 조회 범위 설정에서 집계 간격을 ‘일’로 선택해 주세요.</div>;
  return <div className={styles.root}>
    <div className={styles.eyebrow}>01 &nbsp; 변화를 확인할 광고 매체</div>
    <div className={styles.sources} role="group" aria-label="분석할 광고 매체">{mediaResults.map(item => <button type="button" key={item.id} className={`${styles.source} ${item.id === medium ? styles.selected : ""}`} disabled={!available.includes(item.id)} aria-pressed={item.id === medium} onClick={() => setSelection(item.id)}>
      <span className={styles.sourceName}><span className={styles.logo} style={{ color: item.color }}>{item.logo}</span>{item.name} 광고{item.id === medium ? <small>선택됨 ✓</small> : null}</span>
      <strong className={tone(item.spend.change)}>{available.includes(item.id) ? percentage(item.spend.changePct) : "선택 범위 제외"}</strong><span className={styles.sourceAmount}>{available.includes(item.id) ? `${delta(item.spend.change)} / 일` : "조회 범위 설정에서 포함할 수 있습니다."}</span>{available.includes(item.id) && isPartial(item.spend) ? <small className={styles.partial}>{coverageLabel(item.spend)}</small> : null}
    </button>)}</div>
    <section className={styles.controls} aria-label="변경 전후 비교 조건"><label>광고비 변경일 <input type="date" value={changeDate} min={filters.from} max={filters.to} onChange={e => { if (e.target.value) setDate(e.target.value); }} /></label><label>비교 범위 <select value={windowDays} onChange={e => setWindowDays(Number(e.target.value))}><option value={7}>변경 전후 7일</option><option value={14}>변경 전후 14일</option></select></label><label>매출 반영 시차 <select value={lagDays} onChange={e => setLagDays(Number(e.target.value))}><option value={0}>당일부터</option><option value={3}>3일 뒤부터</option><option value={7}>7일 뒤부터</option></select></label><span className={styles.periods}>판매 결과 비교 &nbsp; 전 {rangeText(analysis.periods.outcomeBefore)} / 후 {rangeText(analysis.periods.outcomeAfter)}</span></section>
    <div className={styles.eyebrow}>02 &nbsp; 광고비 변화와 판매처별 결과 <span>일평균 기준</span></div>
    <section className={styles.compare} aria-label="광고비와 판매처별 성과의 전후 변화"><div className={styles.spendCard}><span className={styles.tag}>AD SPEND CHANGE</span><h2>{source.name} 광고비</h2><strong className={`${styles.bigPct} ${tone(analysis.spend.change)}`}>{available.length ? percentage(analysis.spend.changePct) : "매체 선택 필요"}</strong><span className={`${styles.bigAmount} ${tone(analysis.spend.change)}`}>{delta(analysis.spend.change)} <small>/ 일</small></span><div className={styles.beforeAfter}><div>변경 전 <b>{won(analysis.spend.before)}</b></div><div>변경 후 <b>{won(analysis.spend.after)}</b></div></div><p>{coverageLabel(analysis.spend)} · 전후 각각 {windowDays}일 대상<br />{rangeText(analysis.periods.adBefore)} → {rangeText(analysis.periods.adAfter)}</p></div>
      <div className={styles.results}><div className={styles.sectionHead}><div><h2>판매처별로 얼마나 달라졌을까?</h2><p>변경 전후 같은 일수의 일평균을 비교합니다.</p></div><span className={styles.badge}>매출 · 추정 순이익</span></div><div className={styles.tableWrap}><table><thead><tr><th>판매처</th><th>매출 변화</th><th>추정 순이익 변화</th></tr></thead><tbody>{results.map(row => <tr key={row.id}><td className={styles.channel}><span style={{ background: row.color }} /><b>{row.name}</b><small>{row.sub}</small></td><td>{row.value ? <ChangeCell value={row.value.revenue} /> : <span className={styles.unavailable}>— 입력 확인 필요</span>}</td><td>{row.value ? <ChangeCell value={row.value.estimatedProfit} reason={row.value.profitUnavailableReason} /> : <span className={styles.unavailable}>— 원가·배분 확인 필요</span>}</td></tr>)}</tbody></table></div>{!results.length ? <p className={styles.empty}>조회 범위 설정에서 판매 플랫폼을 포함해 주세요.</p> : null}<div className={styles.resultsFoot}>금액은 원 단위 반올림 · 증감률은 정수 표시 · 전후 원금액은 ‘비교 금액 자세히 보기’에서 확인</div></div>
    </section>
    <div className={styles.insight} role="status"><span>↗</span><div><strong>{completeResult && available.length && analysis.spend.changePct !== null ? `${source.name} 광고비 ${percentage(analysis.spend.changePct)} 변화 구간에서, ${completeResult.name} 매출은 ${percentage(completeResult.value!.revenue.changePct)} (${delta(completeResult.value!.revenue.change)} / 일) 변했습니다.` : "현재 조회 범위에서 비교 가능한 일별 자료를 확인해 주세요."}</strong><small>{partial ? "미확인 금액만 제외하고, 각 항목에 확인된 금액이 있는 날의 평균을 표시합니다. " : ""}{concurrent.length ? `같은 구간 ${concurrent.map(row => `${row.name} 광고비 ${percentage(row.spend.changePct)}`).join(", ")}도 변했습니다. ` : ""}전후 관측 비교이며, 선택 매체만의 광고 효과를 뜻하지 않습니다.</small></div></div>
    <section className={styles.chartPanel} aria-label="규모를 맞춘 광고비와 판매처별 추이"><div className={styles.sectionHead}><div><h2>규모가 달라도, 변화의 방향은 한눈에</h2><p>각 판매처의 변경 전 {metric === "revenue" ? "매출" : "추정 순이익"} 일평균 = 100 · 광고비는 광고 변경 전 평균 = 100</p></div><div className={styles.segmented} role="group" aria-label="추이 결과 지표"><button type="button" aria-pressed={metric === "revenue"} onClick={() => setMetric("revenue")}>매출</button><button type="button" aria-pressed={metric === "estimatedProfit"} onClick={() => setMetric("estimatedProfit")}>추정 순이익</button></div></div>
      <div className={styles.chartMeta}><span>100보다 높으면 증가, 낮으면 감소</span><div className={styles.legend}><span><i style={{ background: "#7f8d84" }} />{source.name} 광고비</span>{channels.map(row => <span key={row.id}><i style={{ background: row.color }} />{row.name}</span>)}</div></div><div className={styles.chart}>
        {graphRows.some(row => row.adSpend !== null || channels.some(c => row[c.id] !== null)) ? <ResponsiveContainer width="100%" height="100%"><LineChart data={graphRows} margin={{ top: 16, right: 24, bottom: 4, left: 0 }}><CartesianGrid vertical={false} stroke="#e9eee9" /><XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: "#8a988e" }} minTickGap={32} /><YAxis domain={["auto", "auto"]} tickFormatter={v => String(Math.round(v))} tick={{ fontSize: 11, fill: "#8a988e" }} width={45} /><ReferenceLine y={100} stroke="#aabdae" strokeDasharray="4 4" /><ReferenceLine x={analysis.periods.outcomeAfter[0]} stroke="#aabdae" strokeDasharray="4 4" label={{ value: "변경 후", position: "insideTopRight", fill: "#839788", fontSize: 11 }} /><Tooltip labelFormatter={date => String(date)} content={({ active, payload, label }) => active && payload?.length ? <div className={styles.tooltip}><strong>{String(label)}</strong>{payload.map(item => <p key={String(item.dataKey)} style={{ color: item.color }}>{item.name}: 지수 {Math.round(Number(item.value))} · {won(item.payload[`${String(item.dataKey) === "adSpend" ? "ad" : String(item.dataKey)}Raw`] ?? null)}{item.payload[`${String(item.dataKey) === "adSpend" ? "ad" : String(item.dataKey)}Partial`] ? " · 확인된 금액" : ""}</p>)}</div> : null} /><Line type="linear" dataKey="adSpend" name={`${source.name} 광고비`} stroke="#7f8d84" strokeDasharray="5 5" dot={false} connectNulls={false} isAnimationActive={false} />{channels.map(row => <Line key={row.id} type="linear" dataKey={row.id} name={row.name} stroke={row.color} strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />)}</LineChart></ResponsiveContainer> : <p className={styles.empty}>표시할 일별 금액이 없습니다. 조회 범위와 원가·배분 입력을 확인해 주세요.</p>}
      </div><p className={styles.chartCaption}>{partial ? "확인된 금액 기준 · 미확인 금액만 제외합니다. " : ""}원금액의 크기 대신 변화의 크기를 비교합니다. 변경 전 평균이 0 이하이거나 입력이 없는 항목은 표시하지 않습니다. 누락일은 선을 끊습니다.</p></section>
    <div className={styles.lower}><details><summary>비교 금액 자세히 보기</summary><div className={styles.detailBody}><button type="button" onClick={exportCsv}>CSV 다운로드 ↓</button><div className={styles.tableWrap}><table><thead><tr><th>항목</th><th>변경 전</th><th>변경 후</th><th>증감액</th><th>확보일 전 / 후</th><th>금액 기준 · 일부 미확인 원천</th></tr></thead><tbody>{rawRows.map(row => <tr key={row.label}><td>{row.label}</td><td>{won(row.value.before)}</td><td>{won(row.value.after)}</td><td>{delta(row.value.change)}</td><td>{row.value.beforeDays} / {row.value.afterDays}일</td><td>{isPartial(row.value) ? "확인된 금액" : "완전 금액"}{row.value.missingSources.length ? ` · ${sourceNames(row.value.missingSources)}` : ""}</td></tr>)}</tbody></table></div></div></details><details><summary>데이터 확인 · 계산 기준</summary><div className={styles.detailBody}><p>일평균 = 확인된 일별 금액의 합계 ÷ 해당 금액이 있는 날의 수. 원천의 일부가 미확인이면 그 부분만 제외하고 해당 원천과 다른 원천의 확인된 금액은 유지합니다. 전후 각각 {windowDays}일을 대상으로 하며 확보일이 부족하면 부분 기간으로 표시합니다.</p><p>증감률 = (변경 후 − 변경 전) ÷ 변경 전 × 100. 변경 전이 0 이하이면 증감률을 표시하지 않습니다.</p><p>매출 반영 시차 {lagDays}일. 광고비는 변경일 전후, 판매 결과는 시차를 적용한 날짜 전후를 비교합니다. 기간은 위 조건에 표시됩니다.</p><p>추정 순이익은 저장된 원가·수수료·비용·배송수입·광고비 배분을 반영합니다. 원가나 광고비 일부가 누락된 경우 확인된 입력으로 계산한 금액을 표시하고 ‘확인된 금액’으로 구분합니다. 광고 전 이익을 계산할 수 없는 판매 행은 제외합니다. 계산할 금액이 없는 날은 평균에서 제외하며, 미확인 금액을 0원으로 채우지 않습니다.</p><p>Meta·Google 전환매출을 실제 판매 매출에 중복 합산하지 않습니다. 순이익에는 광고비 차감 효과가 포함됩니다. 가격·행사·품절 등도 함께 변했을 수 있습니다.</p></div></details></div>
  </div>;
}
