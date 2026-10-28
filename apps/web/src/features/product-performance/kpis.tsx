import { KpiCard } from "@/components/kpi-card";
import { decimal, metricLabel, money, time } from "./model";
import type { Envelope, Metric } from "./types";

export function PerformanceKpis({ data }: { data: Envelope }) {
  const empty = data.metricAvailability.state === "EMPTY_SELECTION";
  const applicable = (["revenue", "adSpend", "profitBeforeAds", "estimatedProfit"] as Metric[]).filter(metric => data.metricAvailability[metric]);
  const complete = applicable.length > 0 && applicable.every(metric => data.completeTotals[metric] !== null);
  const hasKnown = applicable.some(metric => data.knownTotals[metric] !== null);
  const currentSources = data.asOfBySource.filter(source => source.date >= data.selection.from && source.date <= data.selection.to);
  const sourceTimes = currentSources.map(source => source.sourceAsOf).filter((value): value is string => value !== null && Number.isFinite(Date.parse(value))).sort();
  const metricValue = (metric: Metric) => !data.metricAvailability[metric] ? "해당 없음"
    : data.completeTotals[metric] ?? data.knownTotals[metric];
  const card = (metric: Metric) => {
    const raw = metricValue(metric);
    const value = raw === "해당 없음" ? raw : metric === "mer" ? raw === null ? "—" : `${decimal(raw)}배` : money(raw);
    const partial = data.metricAvailability[metric] && data.completeTotals[metric] === null && data.knownTotals[metric] !== null;
    return <KpiCard key={metric} label={`${metricLabel(metric, data)}${partial ? " · 확인된 부분" : ""}`} value={empty ? "—" : value}
      helper={empty ? "플랫폼을 선택하세요." : !data.metricAvailability[metric] ? "선택 범위에 적용되지 않는 지표" : partial ? "확인된 부분 금액 기준 · 완전 합계 미확정" : data.completeTotals[metric] === null ? metric === "mer" ? "누락 입력 또는 광고비 비양수 · 비율 계산 불가" : "필수 입력 확인 전 미확정" : data.isEstimate ? "수치 계산 완료 · 추정 데이터 포함" : "선택 범위 수치 계산 완료"} />;
  };
  return <div className="grid kpi" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))" }} aria-label="제품 성과 요약">
    {card("revenue")}
    <KpiCard label={data.selectedPlatforms.length === 5 ? "전체 적용 광고비" : "선택 광고비"}
      value={empty ? "—" : !data.metricAvailability.adSpend ? "해당 없음" : money(data.completeTotals.adSpend)}
      helper={empty ? "플랫폼을 선택하세요." : !data.metricAvailability.adSpend ? "선택 범위에 광고 매체 없음" : data.completeTotals.adSpend === null ? "누락·미매핑 확인 전 완전 합계 미확정" : "선택 범위의 완전 광고비 합계"} />
    <KpiCard label="확인된 광고비" value={empty ? "—" : !data.metricAvailability.adSpend ? "해당 없음" : money(data.knownTotals.adSpend)}
      helper={empty ? "플랫폼을 선택하세요." : !data.metricAvailability.adSpend ? "선택 범위에 광고 매체 없음" : data.completeTotals.adSpend === null ? "확인 가능한 부분 금액 · 완전 합계와 구분" : "선택 범위 완전 광고비와 동일"} />
    {card("profitBeforeAds")}
    {card("estimatedProfit")}
    {card("mer")}
    <KpiCard label="데이터 상태" value={empty ? "선택 없음" : !hasKnown ? "발행 데이터 없음" : complete ? "수치 계산 완료" : "부분 금액"}
      helper={`${data.isEstimate ? "추정 데이터 포함 · " : ""}${data.provisional ? "당일 이후 포함 · 잠정 · " : ""}가장 오래된 당기 원천 기준 ${time(sourceTimes[0] ?? null)}${currentSources.some(source => source.sourceAsOf === null) ? " · 일부 기준시각 미확인" : ""}${currentSources.some(source => source.stale) ? " · 갱신 확인 필요" : ""}`} />
  </div>;
}
