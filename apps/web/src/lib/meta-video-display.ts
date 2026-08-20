import type { MetaVideoRateKey } from "@/types/meta";

export const META_VIDEO_RATE_COLUMNS = [
  { key: "videoPlay3sRatePct", label: "3초 재생률" },
  { key: "videoPlay25RatePct", label: "25% 재생률" },
  { key: "videoPlay50RatePct", label: "50% 재생률" },
  { key: "videoPlay75RatePct", label: "75% 재생률" },
  { key: "videoPlay100RatePct", label: "100% 재생률" }
] as const satisfies readonly { key: MetaVideoRateKey; label: string }[];

export const META_CREATIVE_TREND_METRICS = [
  { key: "reach", label: "도달수", unit: "count", description: "일자별 도달 인원" },
  { key: "cpmUsd", label: "CPM", unit: "usd", description: "1,000회 노출당 비용 (USD)" },
  { key: "cpcLinkUsd", label: "CPC", unit: "usd", description: "링크 클릭당 비용 (USD)" },
  { key: "ctrLinkPct", label: "CTR", unit: "percent", description: "링크 클릭률" },
  {
    key: "addToCartRatePct",
    label: "장바구니 전환율",
    unit: "percent",
    description: "도달 인원 중 장바구니에 담은 비율"
  },
  ...META_VIDEO_RATE_COLUMNS.map((column) => ({
    ...column,
    unit: "percent" as const,
    description: "일자별 재생률"
  }))
] as const;

export function formatPercent(value: number | null | undefined) {
  if (!isKnownNumber(value)) {
    return "-";
  }
  return `${value.toLocaleString("ko-KR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}%`;
}

export function percentToRatio(value: number | null | undefined) {
  return isKnownNumber(value) ? value / 100 : null;
}

export function formatMetaDeliveryStatus(value: string | null) {
  const normalized = value?.toLowerCase();
  if (!normalized) return "-";
  if (normalized === "active") return "활성";
  if (normalized === "inactive" || normalized === "not_delivering") return "비활성";
  return value ?? "-";
}

function isKnownNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}
