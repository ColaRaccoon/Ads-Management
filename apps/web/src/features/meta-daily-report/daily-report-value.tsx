import { money, numberFmt } from "@/lib/date-range";
import { formatMetaDeliveryStatus, formatPercent } from "@/lib/meta-video-display";
import { deliveryStatusClass } from "./report-model";
import type { ColumnDefinition, CreativePerformanceRow } from "./types";

export function renderColumnValue(
  column: ColumnDefinition,
  row: CreativePerformanceRow,
  previous: CreativePerformanceRow | null
) {
  switch (column.key) {
    case "creative":
      return <CreativeNameCell row={row} />;
    case "status":
      return (
        <span className={`status-pill ${deliveryStatusClass(row.deliveryStatus)}`}>
          {formatMetaDeliveryStatus(row.deliveryStatus)}
        </span>
      );
    case "dataDays":
      return numberFmt(row.dataDays);
    case "spendUsd":
      return metric(
        money(row.totals.spendUsd, "USD"),
        previous ? money(previous.totals.spendUsd, "USD") : "-"
      );
    case "spendKrw":
      return metric(
        money(row.totals.spendKrw, "KRW"),
        previous ? money(previous.totals.spendKrw, "KRW") : "-"
      );
    case "purchaseCount":
      return metric(
        numberFmt(row.totals.purchaseCount),
        previous ? numberFmt(previous.totals.purchaseCount) : "-"
      );
    case "cpa":
      return metric(formatCpa(row.totals), previous ? formatCpa(previous.totals) : "-");
    case "ctr":
      return metric(
        formatPercent(row.totals.ctrLinkPct),
        previous ? formatPercent(previous.totals.ctrLinkPct) : "-"
      );
    case "cpm":
      return metric(
        money(row.totals.cpmUsd, "USD"),
        previous ? money(previous.totals.cpmUsd, "USD") : "-"
      );
    case "reach":
      return metric(
        numberFmt(row.totals.reach),
        previous ? numberFmt(previous.totals.reach) : "-"
      );
    case "videoPlay3sRatePct":
    case "videoPlay25RatePct":
    case "videoPlay50RatePct":
    case "videoPlay75RatePct":
    case "videoPlay100RatePct":
      return metric(
        formatPercent(row.totals[column.key]),
        previous ? formatPercent(previous.totals[column.key]) : "-"
      );
    case "roas":
      return metric(formatRoas(row.totals.roas), previous ? formatRoas(previous.totals.roas) : "-");
  }
}

export function formatMarginRate(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${numberFmt(value * 100, 2)}%`;
}

export function formatCpa(totals: { cpaKrw?: number | null; cpaUsd?: number | null }) {
  if (totals.cpaKrw !== null && totals.cpaKrw !== undefined) {
    return money(totals.cpaKrw, "KRW");
  }
  return money(totals.cpaUsd, "USD");
}

export function formatRoas(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${numberFmt(value * 100, 2)}%`;
}

function CreativeNameCell({ row }: { row: CreativePerformanceRow }) {
  return (
    <div className="daily-creative-name">
      <strong>{row.materialNo ?? row.displayName}</strong>
      {row.materialNo ? <span>{row.displayName}</span> : null}
    </div>
  );
}

function MetricWithPrevious({ current, previous }: { current: string; previous: string }) {
  return (
    <span className="metric-with-previous">
      <strong>{current}</strong>
      <small>전일 {previous}</small>
    </span>
  );
}

function metric(current: string, previous: string) {
  return <MetricWithPrevious current={current} previous={previous} />;
}
