import type { MetaCreativePerformanceRow, MetaVideoRateKey } from "@/types/meta";
import { formatMetaDeliveryStatus, META_VIDEO_RATE_COLUMNS } from "./meta-video-display";

export type MetaAdsSortKey =
  | "product"
  | "material"
  | "status"
  | "dataDays"
  | "spend"
  | "purchase"
  | "cpa"
  | "ctr"
  | "cpm"
  | "reach"
  | MetaVideoRateKey;

export type MetaAdsSortDirection = "asc" | "desc";

export const META_ADS_SORT_KEYS: readonly MetaAdsSortKey[] = [
  "product",
  "material",
  "status",
  "dataDays",
  "spend",
  "purchase",
  "cpa",
  "ctr",
  "cpm",
  "reach",
  ...META_VIDEO_RATE_COLUMNS.map((column) => column.key)
];

export function sortMetaCreativeRows(
  rows: MetaCreativePerformanceRow[],
  key: MetaAdsSortKey,
  direction: MetaAdsSortDirection
) {
  return [...rows].sort((a, b) => compareValues(sortValue(a, key), sortValue(b, key), direction));
}

export function isMetaAdsSortKey(value: unknown): value is MetaAdsSortKey {
  return META_ADS_SORT_KEYS.some((key) => key === value);
}

function sortValue(row: MetaCreativePerformanceRow, key: MetaAdsSortKey) {
  switch (key) {
    case "product":
      return row.productName;
    case "material":
      return row.materialNo ?? row.displayName;
    case "status":
      return formatMetaDeliveryStatus(row.deliveryStatus);
    case "dataDays":
      return row.dataDays;
    case "spend":
      return row.totals.spendUsd;
    case "purchase":
      return row.totals.purchaseCount;
    case "cpa":
      return row.totals.cpaUsd;
    case "ctr":
      return row.totals.ctrLinkPct;
    case "cpm":
      return row.totals.cpmUsd;
    case "reach":
      return row.totals.reach;
    default:
      return row.totals[key];
  }
}

function compareValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  direction: MetaAdsSortDirection
) {
  const aEmpty = a === null || a === undefined || a === "-";
  const bEmpty = b === null || b === undefined || b === "-";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const result = typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b), "ko-KR", { numeric: true, sensitivity: "base" });
  return direction === "asc" ? result : -result;
}
