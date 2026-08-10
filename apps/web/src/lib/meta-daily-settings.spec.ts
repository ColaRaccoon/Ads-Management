import { describe, expect, it } from "vitest";
import { META_DAILY_NEW_VIDEO_COLUMN_KEYS } from "./meta-daily-columns";
import {
  migrateMetaDailyReportSettingsV1,
  normalizeMetaDailyReportSettings
} from "./meta-daily-settings";

describe("Meta daily report settings migration", () => {
  it("preserves v1 filters and appends every new video column once", () => {
    const migrated = migrateMetaDailyReportSettingsV1({
      query: "웨이브",
      deliveryStatus: "hasSpend",
      visibleColumns: ["creative", "spendUsd", "creative", "unknown"]
    });

    expect(migrated.query).toBe("웨이브");
    expect(migrated.deliveryStatus).toBe("hasSpend");
    expect(migrated.visibleColumns).toEqual([
      "creative",
      "spendUsd",
      ...META_DAILY_NEW_VIDEO_COLUMN_KEYS
    ]);
    expect(new Set(migrated.visibleColumns).size).toBe(migrated.visibleColumns.length);
  });

  it("does not re-enable video columns explicitly hidden in v2", () => {
    expect(normalizeMetaDailyReportSettings({
      query: "",
      deliveryStatus: "active",
      visibleColumns: ["creative", "reach"]
    }).visibleColumns).toEqual(["creative", "reach"]);
  });
});
