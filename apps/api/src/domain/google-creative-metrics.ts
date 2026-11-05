/** Ad-level facts are additive. Asset links are metadata, never additional spend. */
export type GoogleCreativeAsset = {
  id: string; type: "IMAGE" | "YOUTUBE_VIDEO"; name: string;
  imageUrl: string | null; videoId: string | null;
};
export type GoogleCreativeMetric = {
  adGroupId: string; adGroupName: string; adId: string; adName: string; adType: string; status: string;
  costMicros: string; impressions: number; clicks: number;
  purchaseCount: number; purchaseValue: number;
  videoViews: number | null; videoViewRate: number | null;
  videoP25: number | null; videoP50: number | null; videoP75: number | null; videoP100: number | null;
  assets: GoogleCreativeAsset[];
};
export type GoogleCampaignCreatives = { schemaVersion: 1; ads: GoogleCreativeMetric[] };
const MAX_INT64 = 9_223_372_036_854_775_807n;
export function validGoogleCreatives(value: unknown, parent: { costMicros: bigint; impressions: bigint; clicks: bigint }): value is GoogleCampaignCreatives {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as GoogleCampaignCreatives;
  if (v.schemaVersion !== 1 || !Array.isArray(v.ads) || v.ads.length > 10_000) return false;
  const ids = new Set<string>(); let spend = 0n, impressions = 0n, clicks = 0n;
  for (const row of v.ads) {
    if (!row || !/^\d{1,20}$/.test(row.adId) || !/^\d{1,20}$/.test(row.adGroupId) ||
      [row.adName, row.adGroupName, row.adType, row.status].some(s => typeof s !== "string" || s.length > 1024) ||
      typeof row.costMicros !== "string" || !/^(0|[1-9]\d*)$/.test(row.costMicros) || BigInt(row.costMicros) > MAX_INT64 ||
      !Number.isSafeInteger(row.impressions) || row.impressions < 0 || !Number.isSafeInteger(row.clicks) || row.clicks < 0 ||
      !Number.isFinite(row.purchaseCount) || !Number.isFinite(row.purchaseValue) ||
      [row.videoViews, row.videoViewRate, row.videoP25, row.videoP50, row.videoP75, row.videoP100].some(n => n !== null && (!Number.isFinite(n) || n < 0)) ||
      !Array.isArray(row.assets) || row.assets.length > 100) return false;
    for (const asset of row.assets) {
      if (!asset || !/^\d{1,20}$/.test(asset.id) || !["IMAGE", "YOUTUBE_VIDEO"].includes(asset.type) ||
        typeof asset.name !== "string" || asset.name.length > 4096 ||
        (asset.imageUrl !== null && (typeof asset.imageUrl !== "string" || !/^https:\/\//.test(asset.imageUrl) || asset.imageUrl.length > 8192)) ||
        (asset.videoId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(asset.videoId))) return false;
    }
    const key = `${row.adGroupId}/${row.adId}`;
    if (ids.has(key)) return false;
    ids.add(key); spend += BigInt(row.costMicros); impressions += BigInt(row.impressions); clicks += BigInt(row.clicks);
  }
  return spend === parent.costMicros && impressions === parent.impressions && clicks === parent.clicks;
}
