import { formatMetaMetricReasons } from "@/lib/meta-conditional-display";
import { money, numberFmt } from "@/lib/date-range";
import { formatCpa, formatRoas } from "../daily-report-value";
import type { ProductGroup } from "../types";

export function ProductReportHeader({ group }: { group: ProductGroup }) {
  return (
    <div className="daily-product-header">
      <div className="daily-product-title">
        <h2>{group.productName}</h2>
        <span>{numberFmt(group.rows.length)}개 소재</span>
        {formatMetaMetricReasons(group.totals.metricUnavailableReasons) ? <small>{formatMetaMetricReasons(group.totals.metricUnavailableReasons)}</small> : null}
      </div>
      <div className="daily-product-stats">
        <ProductStat label="광고비 USD" value={money(group.totals.spendUsd, "USD")} />
        <ProductStat label="광고비 KRW" value={money(group.totals.spendKrw, "KRW")} />
        <ProductStat label="구매" value={numberFmt(group.totals.purchaseCount)} />
        <ProductStat label="CPA" value={formatCpa(group.totals)} />
        <ProductStat label="ROAS" value={formatRoas(group.totals.roas)} />
        {group.totals.providerPurchaseContext==="MCP_PROVIDER_DEFAULT_UNVERIFIED"&&<><ProductStat label="Meta 구매금액 USD · 기본 기여 조건 미검증" value={money(group.totals.providerPurchaseValueUsd,"USD")} /><ProductStat label="구매금액/광고비 ROAS(계산)" value={group.totals.providerPurchaseRoas==null?"-":`${group.totals.providerPurchaseRoas.toFixed(4)}배`} /></>}
      </div>
    </div>
  );
}

function ProductStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="daily-product-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
