export type MetaVideoMetricTotals = {
  reach: number;
  videoPlay3sCount: number | null;
  videoPlay25Count: number | null;
  videoPlay50Count: number | null;
  videoPlay75Count: number | null;
  videoPlay100Count: number | null;
  videoPlay3sRatePct: number | null;
  videoPlay25RatePct: number | null;
  videoPlay50RatePct: number | null;
  videoPlay75RatePct: number | null;
  videoPlay100RatePct: number | null;
};

export type MetaCreativeMetricTotals = MetaVideoMetricTotals & {
  spendUsd: number;
  spendKrw: number | null;
  purchaseCount: number;
  cpaUsd: number | null;
  cpaKrw: number | null;
  ctrLinkPct: number | null;
  cpmUsd: number | null;
  roas: number | null;
  revenueKrw: number | null;
  marginKrw: number | null;
};

export type MetaCreativePerformanceRow = {
  creativeKey: string;
  displayName: string;
  productName: string | null;
  productId: string | null;
  materialNo: string | null;
  deliveryStatus: string | null;
  totals: MetaCreativeMetricTotals;
  dataDays: number;
};

export type MetaVideoRateKey =
  | "videoPlay3sRatePct"
  | "videoPlay25RatePct"
  | "videoPlay50RatePct"
  | "videoPlay75RatePct"
  | "videoPlay100RatePct";
