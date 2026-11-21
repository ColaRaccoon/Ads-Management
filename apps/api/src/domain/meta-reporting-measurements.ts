/** Optional report measurements, kept separate from verified purchase semantics. */
const ORIGINAL_FIELDS = {
  landingPageViews: "landing_page_view",
  shopClicks: "shop_clicks",
  addToCartCount: "omni_add_to_cart",
  videoPlay25Count: "video_p25_watched_actions",
  videoPlay50Count: "video_p50_watched_actions",
  videoPlay75Count: "video_p75_watched_actions",
  videoPlay100Count: "video_p100_watched_actions"
} as const;
export const META_REPORTING_FIELDS = {
  ...ORIGINAL_FIELDS,
  outboundClicks: "outbound_clicks",
  outboundCtrPct: "outbound_clicks_ctr"
} as const;
export type ReportingProfile = "REPORTING_V2" | "REPORTING_V3";
export function isReportingProfile(profile: unknown): profile is ReportingProfile {
  return profile === "REPORTING_V2" || profile === "REPORTING_V3";
}
export type MetaReportingField = keyof typeof META_REPORTING_FIELDS;
export const META_REPORTING_PARENT_FIELDS = ["landingPageViews", "shopClicks"] as const;
export function metaReportingFields(isAd: boolean, profile: ReportingProfile = "REPORTING_V2"): readonly MetaReportingField[] {
  const original = isAd ? Object.keys(ORIGINAL_FIELDS) as MetaReportingField[] : META_REPORTING_PARENT_FIELDS;
  return profile === "REPORTING_V3" ? [...original, "outboundClicks", "outboundCtrPct"] : original;
}
export type MetaReportingMeasurement = {
  profile: ReportingProfile;
  rawRowFingerprint: string;
  values: Partial<Record<MetaReportingField, number | null>>;
};
export function validMetaReportingMeasurement(value: unknown, isAd: boolean): value is MetaReportingMeasurement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "profile,rawRowFingerprint,values" ||
      !isReportingProfile(row.profile) || typeof row.rawRowFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.rawRowFingerprint) || !row.values ||
      typeof row.values !== "object" || Array.isArray(row.values)) return false;
  const values = row.values as Record<string, unknown>;
  return Object.keys(values).sort().join() === [...metaReportingFields(isAd, row.profile)].sort().join() &&
    Object.entries(values).every(([field, v]) => v === null || typeof v === "number" && v >= 0 &&
      (field === "outboundCtrPct" ? Number.isFinite(v) : Number.isSafeInteger(v) && v <= 2147483647));
}
