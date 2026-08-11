import { money, numberFmt } from "@/lib/date-range";
import { formatCpa, formatRoas } from "../daily-report-value";
import type { ProductTotals } from "../types";

export function DailyReportSummary({ productCount, totals }: { productCount: number; totals: ProductTotals }) {
  return (
    <div className="daily-report-summary">
      <MetricTile label="제품수" value={`${numberFmt(productCount)}개`} />
      <MetricTile label="총 광고비 USD" value={money(totals.spendUsd, "USD")} />
      <MetricTile label="총 광고비 KRW" value={money(totals.spendKrw, "KRW")} />
      <MetricTile label="총 구매건수" value={numberFmt(totals.purchaseCount)} />
      <MetricTile label="전체 CPA" value={formatCpa(totals)} />
      <MetricTile label="전체 ROAS" value={formatRoas(totals.roas)} />
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="daily-summary-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
