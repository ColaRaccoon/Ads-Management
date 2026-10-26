import type { ReactNode } from "react";
import type { MetaCreativePerformanceRow } from "@/types/meta";
import type { MetaAdsSortKey } from "@/lib/meta-ads-sort";
import { formatMetaMetricReasons } from "@/lib/meta-conditional-display";
import { formatMetaCurrentObservations } from "@/lib/meta-current-metadata-display";
import { money, numberFmt } from "@/lib/date-range";
import { formatMetaDeliveryStatus, formatPercent, META_VIDEO_RATE_COLUMNS } from "@/lib/meta-video-display";

type SortableColumn = {
  key: MetaAdsSortKey;
  header: string;
  render: (row: MetaCreativePerformanceRow) => ReactNode;
};

export const META_ADS_COLUMNS: SortableColumn[] = [
  { key: "product", header: "제품", render: (row) => row.productName ?? "-" },
  { key: "material", header: "소재", render: (row) => <span title={formatMetaMetricReasons(row.totals.metricUnavailableReasons)}>{row.materialNo ?? row.displayName}</span> },
  { key: "status", header: "활성상태", render: (row) => <span title={formatMetaCurrentObservations(row.currentMetadataObservations)}>{formatMetaDeliveryStatus(row.deliveryStatus)}</span> },
  { key: "dataDays", header: "집계일수", render: (row) => <span title="저장된 최초 관측일부터 조회 종료일 이전의 마지막 관측일까지의 일수 (중간 공백 포함)">{numberFmt(row.dataDays)}</span> },
  { key: "spend", header: "광고비", render: (row) => money(row.totals.spendUsd, "USD") },
  { key: "purchase", header: "구매", render: (row) => numberFmt(row.totals.purchaseCount) },
  { key: "providerPurchase", header: "Meta ROAS", render: (row) => <span title="Meta 구매전환금액 ÷ 광고비 · 공급자 기본 기여 기준">{formatPercent(row.totals.providerPurchaseRoas == null ? null : row.totals.providerPurchaseRoas * 100)}</span> },
  { key: "profit", header: "순이익", render: (row) => money(row.totals.marginKrw, "KRW") },
  { key: "cpa", header: "CPA (원)", render: (row) => money(row.totals.cpaKrw, "KRW") },
  { key: "ctr", header: "CTR", render: (row) => formatPercent(row.totals.ctrLinkPct) },
  { key: "cpm", header: "CPM", render: (row) => money(row.totals.cpmUsd, "USD") },
  { key: "reach", header: "도달", render: (row) => numberFmt(row.totals.reach) },
  ...META_VIDEO_RATE_COLUMNS.map((column): SortableColumn => ({
    key: column.key,
    header: column.label,
    render: (row) => formatPercent(row.totals[column.key])
  }))
];

