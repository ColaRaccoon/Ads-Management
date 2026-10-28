import { DataTable } from "@/components/data-table";
import { comparisonReason, decimal, label, metricLabel, money, percent, percentagePoints } from "./model";
import type { Envelope, Metric, MetricComparison } from "./types";

const metrics: Metric[] = ["revenue", "adSpend", "profitBeforeAds", "estimatedProfit", "mer"];
const ratio = (value: string | null) => value === null ? "—" : `${decimal(value)}배`;
function metricDisplay(metric: Metric, value: string | null) { return metric === "mer" ? ratio(value) : money(value); }
function comparisonFor(data: Envelope, metric: Metric) {
  const complete = data.comparison.complete[metric];
  return { value: complete.current !== null && complete.previous !== null ? complete : data.comparison.known[metric],
    partial: complete.current === null || complete.previous === null };
}
function mediumReason(row: { current: string | null; previous: string | null; reason: string | null }) {
  if (row.reason === "MISSING_INPUT") return "입력 누락";
  if (row.reason === "ZERO_BASE") return row.current !== null && /^0(?:\.0+)?$/.test(row.current) ? "양기 0 · 증감률 해당 없음" : row.previous !== null && /^0(?:\.0+)?$/.test(row.previous) ? "신규 집행 · 전기 0" : "전기 비양수 · 증감률 해당 없음";
  return "";
}

export function ComparisonTable({ data }: { data: Envelope }) {
  const rows = metrics.filter(metric => data.metricAvailability[metric]).map(metric => ({ metric, ...comparisonFor(data, metric) }));
  const partialMedia = data.metricAvailability.adSpend && (data.completeTotals.adSpend === null || data.comparison.complete.adSpend.previous === null);
  return <section className="panel" aria-label="기간 변화 비교">
    <h2>기간 변화 비교</h2>
    <p>{data.selection.from} ~ {data.selection.to} ({data.comparison.currentDays}일) / 비교 {data.selection.compareFrom} ~ {data.selection.compareTo} ({data.comparison.previousDays}일)</p>
    {data.comparison.unequalPeriods ? <p className="warning-strip" role="status">기간 길이가 다릅니다. 합계와 함께 일평균을 확인하세요.</p> : null}
    <DataTable rows={rows} getRowKey={row => row.metric} empty="선택 범위에 비교할 지표가 없습니다." columns={[
      { key: "metric", header: "지표 / 계산 범위", render: row => <>{metricLabel(row.metric, data)}{row.partial ? <small> · 확인된 부분 기준</small> : null}</> },
      { key: "previous", header: "전기", render: row => metricDisplay(row.metric, row.value.previous) },
      { key: "current", header: "당기", render: row => metricDisplay(row.metric, row.value.current) },
      { key: "change", header: "증감액 / MER 차이", render: row => metricDisplay(row.metric, row.value.change) },
      { key: "pct", header: "증감률", render: row => <>{percent(row.value.changePct)}{row.value.reason ? <small> · {comparisonReason(row.value)}</small> : null}</> },
      ...(data.comparison.unequalPeriods ? [
        { key: "previousAverage", header: "전기 일평균", render: (row: { metric: Metric; value: MetricComparison }) => row.metric === "mer" ? "해당 없음" : money(row.value.previousDailyAverage) },
        { key: "currentAverage", header: "당기 일평균", render: (row: { metric: Metric; value: MetricComparison }) => row.metric === "mer" ? "해당 없음" : money(row.value.currentDailyAverage) }
      ] : [])
    ]} />
    <h3 style={{ marginTop: 20 }}>매체별 광고비와 구성 변화{partialMedia ? " · 확인된 부분 기준" : ""}</h3>
    <p className="field-help">비중은 선택 광고비 합계 기준입니다. 비중 변화와 전체 광고비 증감 기여는 %p, 매체 자체 증감률은 %입니다.</p>
    <DataTable rows={data.comparison.byMedium} getRowKey={row => row.medium} empty="선택 범위에 광고 매체가 없습니다." columns={[
      { key: "medium", header: "광고 매체", render: row => label(row.medium) },
      { key: "previous", header: "전기 광고비", render: row => money(row.previous) },
      { key: "current", header: "당기 광고비", render: row => money(row.current) },
      { key: "change", header: "증감액", render: row => money(row.change) },
      { key: "pct", header: "매체 증감률", render: row => <>{percent(row.changePct)}{mediumReason(row) ? <small> · {mediumReason(row)}</small> : null}</> },
      { key: "previousShare", header: "전기 비중", render: row => percent(row.previousShare) },
      { key: "share", header: "당기 비중", render: row => percent(row.share) },
      { key: "shareChange", header: "비중 변화 (%p)", render: row => percentagePoints(row.shareChangePp) },
      { key: "contribution", header: "전체 광고비 증감 기여 (%p)", render: row => percentagePoints(row.spendChangeContributionPp) }
    ]} />
  </section>;
}
