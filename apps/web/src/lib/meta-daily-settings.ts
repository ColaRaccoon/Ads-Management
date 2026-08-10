import {
  META_DAILY_COLUMNS,
  META_DAILY_NEW_VIDEO_COLUMN_KEYS,
  type MetaDailyColumnKey
} from "./meta-daily-columns";

export type MetaDailyDeliveryStatusFilter = "active" | "inactive" | "all" | "hasSpend";

export type MetaDailyReportSettings = {
  query: string;
  deliveryStatus: MetaDailyDeliveryStatusFilter;
  visibleColumns: MetaDailyColumnKey[];
};

export const META_DAILY_REPORT_SETTINGS_V1_KEY = "meta-ads-performance:daily-report-settings:v1";
export const META_DAILY_REPORT_SETTINGS_V2_KEY = "meta-ads-performance:daily-report-settings:v2";

export const DEFAULT_META_DAILY_REPORT_SETTINGS: MetaDailyReportSettings = {
  query: "",
  deliveryStatus: "active",
  visibleColumns: META_DAILY_COLUMNS.map((column) => column.key)
};

export function normalizeMetaDailyReportSettings(value: unknown): MetaDailyReportSettings {
  return normalizeSettings(value, false);
}

export function migrateMetaDailyReportSettingsV1(value: unknown): MetaDailyReportSettings {
  return normalizeSettings(value, true);
}

function normalizeSettings(value: unknown, appendVideoColumns: boolean): MetaDailyReportSettings {
  const parsed = isRecord(value) ? value : {};
  const parsedColumns = Array.isArray(parsed.visibleColumns)
    ? parsed.visibleColumns.filter(isMetaDailyColumnKey)
    : DEFAULT_META_DAILY_REPORT_SETTINGS.visibleColumns;
  const requestedColumns = appendVideoColumns
    ? [...parsedColumns, ...META_DAILY_NEW_VIDEO_COLUMN_KEYS]
    : parsedColumns;
  const visibleColumns = META_DAILY_COLUMNS
    .map((column) => column.key)
    .filter((key) => requestedColumns.includes(key));

  return {
    query: typeof parsed.query === "string" ? parsed.query : DEFAULT_META_DAILY_REPORT_SETTINGS.query,
    deliveryStatus: isMetaDailyDeliveryStatus(parsed.deliveryStatus)
      ? parsed.deliveryStatus
      : DEFAULT_META_DAILY_REPORT_SETTINGS.deliveryStatus,
    visibleColumns: visibleColumns.length > 0
      ? visibleColumns
      : DEFAULT_META_DAILY_REPORT_SETTINGS.visibleColumns
  };
}

export function isMetaDailyColumnKey(value: unknown): value is MetaDailyColumnKey {
  return META_DAILY_COLUMNS.some((column) => column.key === value);
}

function isMetaDailyDeliveryStatus(value: unknown): value is MetaDailyDeliveryStatusFilter {
  return value === "active" || value === "inactive" || value === "all" || value === "hasSpend";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
