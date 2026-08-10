import { META_VIDEO_RATE_COLUMNS } from "./meta-video-display";

export const META_DAILY_COLUMNS = [
  { key: "creative", label: "소재" },
  { key: "status", label: "활성상태" },
  { key: "dataDays", label: "집계일수" },
  { key: "spendUsd", label: "광고비 USD" },
  { key: "spendKrw", label: "광고비 KRW" },
  { key: "purchaseCount", label: "구매건수" },
  { key: "cpa", label: "CPA" },
  { key: "ctr", label: "CTR" },
  { key: "cpm", label: "CPM" },
  { key: "reach", label: "도달" },
  ...META_VIDEO_RATE_COLUMNS,
  { key: "roas", label: "ROAS" }
] as const;

export type MetaDailyColumnKey = (typeof META_DAILY_COLUMNS)[number]["key"];

export const META_DAILY_NEW_VIDEO_COLUMN_KEYS = [
  "reach",
  ...META_VIDEO_RATE_COLUMNS.map((column) => column.key)
] as const satisfies readonly MetaDailyColumnKey[];
