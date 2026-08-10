import type { MetaVideoRateKey } from "@/types/meta";

export const META_VIDEO_RATE_COLUMNS = [
  { key: "videoPlay3sRatePct", label: "3초 재생률" },
  { key: "videoPlay25RatePct", label: "25% 재생률" },
  { key: "videoPlay50RatePct", label: "50% 재생률" },
  { key: "videoPlay75RatePct", label: "75% 재생률" },
  { key: "videoPlay100RatePct", label: "100% 재생률" }
] as const satisfies readonly { key: MetaVideoRateKey; label: string }[];

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
