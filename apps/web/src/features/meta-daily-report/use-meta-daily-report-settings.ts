"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_META_DAILY_REPORT_SETTINGS,
  META_DAILY_REPORT_SETTINGS_V1_KEY,
  META_DAILY_REPORT_SETTINGS_V2_KEY,
  migrateMetaDailyReportSettingsV1,
  normalizeMetaDailyReportSettings
} from "@/lib/meta-daily-settings";
import { toggleColumn } from "./report-model";
import type { DailyReportSettings, DeliveryStatusFilter } from "./types";

export function useMetaDailyReportSettings() {
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [query, setQuery] = useState(DEFAULT_META_DAILY_REPORT_SETTINGS.query);
  const [deliveryStatus, setDeliveryStatus] = useState<DeliveryStatusFilter>(
    DEFAULT_META_DAILY_REPORT_SETTINGS.deliveryStatus
  );
  const [visibleColumns, setVisibleColumns] = useState(
    DEFAULT_META_DAILY_REPORT_SETTINGS.visibleColumns
  );

  useEffect(() => {
    const settings = readDailyReportSettings();
    setQuery(settings.query);
    setDeliveryStatus(settings.deliveryStatus);
    setVisibleColumns(settings.visibleColumns);
    setSettingsLoaded(true);
  }, []);

  useEffect(() => {
    if (settingsLoaded) {
      writeDailyReportSettings({ query, deliveryStatus, visibleColumns });
    }
  }, [deliveryStatus, query, settingsLoaded, visibleColumns]);

  return {
    settingsLoaded,
    query,
    setQuery,
    deliveryStatus,
    setDeliveryStatus,
    visibleColumns,
    toggleVisibleColumn: (key: Parameters<typeof toggleColumn>[1]) => {
      setVisibleColumns((columns) => toggleColumn(columns, key));
    }
  };
}

function readDailyReportSettings(): DailyReportSettings {
  if (typeof window === "undefined") return DEFAULT_META_DAILY_REPORT_SETTINGS;
  try {
    const v2 = window.localStorage.getItem(META_DAILY_REPORT_SETTINGS_V2_KEY);
    if (v2) return normalizeMetaDailyReportSettings(JSON.parse(v2));
    const v1 = window.localStorage.getItem(META_DAILY_REPORT_SETTINGS_V1_KEY);
    if (!v1) return DEFAULT_META_DAILY_REPORT_SETTINGS;
    const migrated = migrateMetaDailyReportSettingsV1(JSON.parse(v1));
    window.localStorage.setItem(META_DAILY_REPORT_SETTINGS_V2_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return DEFAULT_META_DAILY_REPORT_SETTINGS;
  }
}

function writeDailyReportSettings(settings: DailyReportSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(META_DAILY_REPORT_SETTINGS_V2_KEY, JSON.stringify(settings));
}
