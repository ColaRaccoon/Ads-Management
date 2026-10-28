"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { bucketLabel, chartNumber, chartRows, movingAverages } from "./chart-model";
import { decimal, difference, label, money, percent, ratioPercent } from "./model";
import type { Availability, Bucket, DashboardData, Metric } from "./types";

const COLORS = ["#146c63", "#4686c6", "#9b65b2", "#d58b2e", "#bf5564"];
const MEDIUM_COLORS: Record<string, string> = { META: "#4686c6", GOOGLE: "#d58b2e", NAVER_DA: "#146c63", COUPANG_ADS: "#9b65b2" };
const mediumColor = (medium: string, index: number) => MEDIUM_COLORS[medium] ?? COLORS[index % COLORS.length];
const axisAmount = (value: number) => Math.abs(value) >= 100000000 ? `${(value / 100000000).toFixed(1)}억` : Math.abs(value) >= 10000 ? `${(value / 10000).toFixed(0)}만` : String(value);
const box = { height: 280, minWidth: 0 };

export function BucketTooltip({ bucket, average, availability, profitLabel = "추정이익" }: { bucket: Bucket; average?: string | null; availability?: Availability; profitLabel?: string }) {
  const metricText = (metric: Metric) => availability?.[metric] === false ? "해당 없음" : `${money(bucket.completeTotals[metric])}${bucket.completeTotals[metric] === null ? ` · 확인된 부분 금액 ${money(bucket.knownTotals[metric])}` : ""}`;
  return <div style={{ background: "white", border: "1px solid #d8dfdf", padding: 12, borderRadius: 8, maxWidth: 420 }}>
    <strong>{bucketLabel(bucket)}</strong>
    {bucket.isEstimate ? <p>추정 데이터 포함</p> : null}
    <p>매출: {metricText("revenue")}</p>
    <p>광고 전 이익: {metricText("profitBeforeAds")}</p>
    <p>{profitLabel}: {metricText("estimatedProfit")}</p>
    <p>광고비 합계: {metricText("adSpend")}</p>
    <p>MER: {availability?.mer === false ? "해당 없음" : bucket.completeTotals.mer === null ? `— · 확인된 부분 금액 기준 ${decimal(bucket.knownTotals.mer)} 배` : `${decimal(bucket.completeTotals.mer)} 배`}</p>
    {bucket.byMedium.map(row => <p key={row.medium}>{label(row.medium)}: {money(row.adSpend)} · {percent(row.share)}{bucket.completeTotals.adSpend === null ? " (부분 금액 기준)" : ""}</p>)}
    {average !== undefined ? <p>7일 이동평균: {money(average)}</p> : null}
  </div>;
}

export function PerformanceCharts({ data }: { data: DashboardData }) {
  const { summary, timeseries } = data;
  const buckets = timeseries.items;
  const media = [...new Set(buckets.flatMap(bucket => bucket.byMedium.map(row => row.medium)))].sort();
  const [hidden, setHidden] = useState<string[]>([]);
  const [average, setAverage] = useState(false);
  const rows = chartRows(buckets, media);
  const averages = movingAverages(buckets);
  // Points keep single-day reports and complete days surrounded by missing inputs visible.
  const point = { r: buckets.length === 1 ? 4 : buckets.length <= 31 ? 2.5 : 1.5 };
  const syncId = `product-performance:${summary.selection.selectionHash}`;
  const tooltip = ({ active, label: date }: { active?: boolean; label?: string | number }) => {
    if (!active) return null;
    const index = buckets.findIndex(row => row.date === date);
    return index < 0 ? null : <BucketTooltip bucket={buckets[index]} average={average ? averages[index] : undefined} availability={summary.metricAvailability} profitLabel={summary.profitLabel} />;
  };
  const unsafe = buckets.some(bucket => Object.values(bucket.knownTotals).some(value => value !== null && chartNumber(value) === null) ||
    bucket.byMedium.some(row => row.adSpend !== null && chartNumber(row.adSpend) === null));
  const toggle = (medium: string) => setHidden(current => current.includes(medium) ? current.filter(item => item !== medium) : [...current, medium]);
  const previousMarkets = summary.comparison.previousByMarketplace;
  const markets = [...new Set([...summary.byMarketplace, ...previousMarkets].map(row => row.marketplace))];
  const marketplaceRows = markets.map(marketplace => {
    const current = summary.byMarketplace.find(row => row.marketplace === marketplace)?.revenue ?? null;
    const previous = previousMarkets.find(row => row.marketplace === marketplace)?.revenue ?? null;
    return { marketplace, current, previous, coordinate: chartNumber(current) };
  });
  if (!buckets.length) return <section className="panel"><h2>기간별 그래프</h2><p>선택 기간에 표시할 집계가 없습니다.</p></section>;
  return <>
    <section className="panel" style={{ marginTop: 16 }} aria-label="그래프 표시 설정">
      <p>날짜축과 툴팁을 공유합니다. 금액 축은 원입니다. 누락·미완전 구간은 선을 끊고, 완료가 확인된 0원만 0으로 표시합니다.</p>
      <fieldset style={{ border: 0, padding: 0 }}><legend>차트 범례 · 계열 표시만 변경 (합계·비중 분모 유지)</legend>
        <div className="toolbar" style={{ flexWrap: "wrap" }}>{media.map((medium, index) => <label key={medium} style={{ color: mediumColor(medium, index) }}>
          <input type="checkbox" checked={!hidden.includes(medium)} onChange={() => toggle(medium)} /> {label(medium)} 표시
        </label>)}</div>
      </fieldset>
      {summary.selection.grain === "day" ? <label><input type="checkbox" checked={average} onChange={event => setAverage(event.target.checked)} /> 광고비 7일 이동평균 (완료된 연속 7일)</label> : null}
      {unsafe ? <p role="status">일부 금액은 그래프의 안전한 숫자 범위를 넘어 좌표를 생략했습니다. 아래 표와 툴팁은 원래 금액을 보존합니다.</p> : null}
    </section>
    <div className="grid two" style={{ marginTop: 16 }}>
      <section className="panel"><h2>매체별 광고비 추이</h2><p>선택 광고비 · 원{summary.completeTotals.adSpend === null ? " · 확인된 부분 금액은 아래 표에서 확인" : ""}</p>
        {summary.metricAvailability.adSpend ? <div style={box}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={rows} syncId={syncId} syncMethod="value" margin={{ left: 18, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={date => String(date).slice(5)} minTickGap={30} /><YAxis tickFormatter={axisAmount} width={72} /><Tooltip content={tooltip} />
          {media.map((medium, index) => <Bar key={medium} dataKey={`ad${index}`} name={label(medium)} stackId="ads" fill={mediumColor(medium, index)} hide={hidden.includes(medium)} isAnimationActive={false} />)}
          <Line dataKey="adTotal" name="선택 광고비 합계" stroke="#263b42" strokeWidth={2} dot={point} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
          {average && summary.selection.grain === "day" ? <Line dataKey="movingAverage" name="7일 이동평균" stroke="#b06535" strokeDasharray="5 3" dot={point} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} /> : null}
        </ComposedChart></ResponsiveContainer></div> : <p>광고비가 적용되는 플랫폼을 선택하세요.</p>}
      </section>
      <section className="panel"><h2>매출·이익 추이</h2><p>매출(파랑) · 광고 전 이익(초록) · {summary.profitLabel}(보라) · 원</p>
        {summary.metricAvailability.revenue ? <div style={box}><ResponsiveContainer width="100%" height="100%"><LineChart data={rows} syncId={syncId} syncMethod="value" margin={{ left: 18, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={date => String(date).slice(5)} minTickGap={30} /><YAxis tickFormatter={axisAmount} width={72} /><Tooltip content={tooltip} />
          <Line dataKey="revenue" name="매출" stroke="#4686c6" dot={point} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
          <Line dataKey="profitBeforeAds" name="광고 전 이익" stroke="#146c63" dot={point} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
          <Line dataKey="estimatedProfit" name={summary.profitLabel} stroke="#9b65b2" dot={point} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
        </LineChart></ResponsiveContainer></div> : <p>매출·이익은 해당 없음입니다. 판매 플랫폼을 선택하세요.</p>}
      </section>
      <section className="panel"><h2>광고비 구성 · 100%</h2><p>각 기간의 선택 광고비 합계가 분모입니다. 0분모·음수 정정·미완전 구간은 구성비를 그리지 않습니다.</p>
        {summary.metricAvailability.adSpend ? <div style={box}><ResponsiveContainer width="100%" height="100%"><BarChart data={rows} syncId={syncId} syncMethod="value" margin={{ left: 18, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={date => String(date).slice(5)} minTickGap={30} /><YAxis domain={[0, 100]} tickFormatter={value => `${value}%`} width={72} /><Tooltip content={tooltip} />
          {media.map((medium, index) => <Bar key={medium} dataKey={`share${index}`} name={label(medium)} stackId="shares" fill={mediumColor(medium, index)} hide={hidden.includes(medium)} isAnimationActive={false} />)}
        </BarChart></ResponsiveContainer></div> : <p>광고비 구성은 해당 없음입니다.</p>}
      </section>
      <section className="panel"><h2>판매처 매출 구성</h2><p>선택 판매처의 확인된 매출 · 원. Meta·Google의 전환매출을 더하지 않습니다.</p>
        {summary.metricAvailability.revenue ? <><div style={box}><ResponsiveContainer width="100%" height="100%"><BarChart data={marketplaceRows} layout="vertical" margin={{ left: 18, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" /><XAxis type="number" tickFormatter={axisAmount} /><YAxis type="category" dataKey="marketplace" tickFormatter={label} width={115} />
          <Tooltip formatter={(_value, _name, item) => [money((item.payload as typeof marketplaceRows[number]).current), "확인된 매출"]} labelFormatter={value => label(String(value))} />
          <Bar dataKey="coordinate" fill="#146c63" name="확인된 매출" isAnimationActive={false} />
        </BarChart></ResponsiveContainer></div>
        <div className="table-wrap"><table><thead><tr><th>판매처</th><th>전기 확인 매출</th><th>당기 확인 매출</th><th>증감액</th><th>매출 비중</th></tr></thead><tbody>{marketplaceRows.map(row => <tr key={row.marketplace}>
          <td>{label(row.marketplace)}</td><td>{money(row.previous)}</td><td>{money(row.current)}</td><td>{money(difference(row.current, row.previous))}</td><td>{percent(ratioPercent(row.current, summary.knownTotals.revenue))}</td>
        </tr>)}</tbody></table></div><p>미완전 기간의 판매처 금액·비중은 확인된 부분 금액 기준입니다.</p></> : <p>판매처 매출은 해당 없음입니다.</p>}
      </section>
    </div>
    <details className="panel" style={{ marginTop: 16 }}><summary>그래프 원금액·부분기간 확인</summary>
      <p>—는 미확인입니다. 합계와 확인된 부분 금액을 구분하며, 추정 여부만으로 계산 가능한 숫자를 숨기지 않습니다.</p>
      <div className="table-wrap" style={{ maxHeight: 480 }}><table><thead><tr><th>실제 합산 날짜</th><th>매출 합계 / 확인 금액</th><th>광고비 합계 / 확인 금액</th><th>광고 전 이익 합계 / 확인 금액</th><th>{summary.profitLabel} 합계 / 확인 금액</th>{media.map(medium => <th key={medium}>{label(medium)} · 확인 광고비 / 비중</th>)}<th>추정</th></tr></thead>
        <tbody>{buckets.map(bucket => <tr key={bucket.date}><td>{bucketLabel(bucket)}</td>
          {(["revenue", "adSpend", "profitBeforeAds", "estimatedProfit"] as const).map(metric => <td key={metric}>{summary.metricAvailability[metric] ? `${money(bucket.completeTotals[metric])} / ${money(bucket.knownTotals[metric])}` : "해당 없음"}</td>)}
          {media.map(medium => { const own = bucket.byMedium.find(row => row.medium === medium); return <td key={medium}>{money(own?.adSpend)} / {percent(own?.share)}</td>; })}<td>{bucket.isEstimate ? "추정 데이터" : "원천 보고"}</td>
        </tr>)}</tbody></table></div>
      <p>비율은 기간 금액을 먼저 합산한 서버 응답입니다. 일별 비율의 평균을 사용하지 않습니다. MER 단위는 배, 비중은 %, 비중 변화는 %p입니다.</p>
    </details>
  </>;
}
