/** Missing conditional measurements are never certified zeros. Codes contain no provider text. */
export const META_UNAVAILABLE_REASONS = ["UNSUPPORTED_FIELD", "RESULT_MAPPING_UNVERIFIED",
  "ATTRIBUTION_UNVERIFIED", "ATTRIBUTION_MISMATCH", "MIXED_ATTRIBUTION", "MIXED_RESULT",
  "AMBIGUOUS_ACTION", "NOT_APPLICABLE", "PARTIAL_METRIC"] as const;
export type MetaUnavailableReason = typeof META_UNAVAILABLE_REASONS[number];
export type MetaUnavailableReasons = Record<string, MetaUnavailableReason>;

export function sumComplete(values: readonly (number | null | undefined)[]): number | null {
  return values.some((value) => value == null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);
}

export function hasMixedMetaAttribution(rows: readonly {
  source?: string; attributionSetting?: string | null; actionReportTime?: string | null;
  attributionWindows?: readonly string[];
}[]): boolean {
  if (!rows.some((row) => row.source === "API")) return false;
  return new Set(rows.map((row) => JSON.stringify([row.attributionSetting, row.actionReportTime,
    [...(row.attributionWindows ?? [])].sort()]))).size > 1;
}

export function aggregateMetricReasons(rows: readonly { metricUnavailableReasons?: unknown }[]) {
  const reasons: Record<string, string> = {};
  for (const row of rows) {
    if (!row.metricUnavailableReasons || typeof row.metricUnavailableReasons !== "object" ||
        Array.isArray(row.metricUnavailableReasons)) continue;
    for (const [field, reason] of Object.entries(row.metricUnavailableReasons)) {
      if (typeof reason === "string" && META_UNAVAILABLE_REASONS.includes(reason as MetaUnavailableReason))
        reasons[field] = reasons[field] && reasons[field] !== reason ? "PARTIAL_METRIC" : reason;
    }
  }
  return reasons;
}
