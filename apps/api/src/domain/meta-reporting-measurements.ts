/** Optional report measurements, kept separate from verified purchase semantics. */
export const META_REPORTING_FIELDS = {
  landingPageViews: "landing_page_view",
  shopClicks: "shop_clicks",
  addToCartCount: "omni_add_to_cart",
  videoPlay25Count: "video_p25_watched_actions",
  videoPlay50Count: "video_p50_watched_actions",
  videoPlay75Count: "video_p75_watched_actions",
  videoPlay100Count: "video_p100_watched_actions"
} as const;
export type MetaReportingField = keyof typeof META_REPORTING_FIELDS;
export const META_REPORTING_PARENT_FIELDS = ["landingPageViews", "shopClicks"] as const;
export function metaReportingFields(isAd: boolean): readonly MetaReportingField[] {
  return isAd ? Object.keys(META_REPORTING_FIELDS) as MetaReportingField[] : META_REPORTING_PARENT_FIELDS;
}
export type MetaReportingMeasurement = {
  profile: "REPORTING_V2";
  rawRowFingerprint: string;
  values: Partial<Record<MetaReportingField, number | null>>;
};
export function validMetaReportingMeasurement(value: unknown, isAd: boolean): value is MetaReportingMeasurement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "profile,rawRowFingerprint,values" ||
      row.profile !== "REPORTING_V2" || typeof row.rawRowFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.rawRowFingerprint) || !row.values ||
      typeof row.values !== "object" || Array.isArray(row.values)) return false;
  const values = row.values as Record<string, unknown>;
  return Object.keys(values).sort().join() === [...metaReportingFields(isAd)].sort().join() &&
    Object.values(values).every(v => v === null || Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 2147483647);
}
