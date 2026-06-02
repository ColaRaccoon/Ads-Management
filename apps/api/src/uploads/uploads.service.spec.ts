import { describe, expect, it } from "vitest";
import { toDateOnly } from "../domain/date-number";
import { findMissingSnapshotMetricIds, nextImportVersion, snapshotMetricKey } from "./uploads.service";

describe("upload snapshot helpers", () => {
  it("uses latest importVersion regardless of current row", () => {
    expect(nextImportVersion(null)).toBe(1);
    expect(nextImportVersion(0)).toBe(1);
    expect(nextImportVersion(3)).toBe(4);
  });

  it("builds stable metric snapshot keys", () => {
    expect(snapshotMetricKey(date("2026-06-01"), "adset-1")).toBe("2026-06-01:adset-1");
  });

  it("finds current metrics missing from the imported CSV snapshot", () => {
    const currentMetrics = [
      { id: "metric-a", metricDate: date("2026-06-01"), metaAdsetId: "adset-a" },
      { id: "metric-b", metricDate: date("2026-06-01"), metaAdsetId: "adset-b" },
      { id: "metric-c", metricDate: date("2026-06-01"), metaAdsetId: "adset-c" }
    ];
    const includedKeys = new Set([
      snapshotMetricKey(date("2026-06-01"), "adset-a"),
      snapshotMetricKey(date("2026-06-01"), "adset-c")
    ]);

    expect(findMissingSnapshotMetricIds(currentMetrics, includedKeys)).toEqual(["metric-b"]);
  });
});

function date(value: string) {
  const parsed = toDateOnly(value);
  if (!parsed) throw new Error(`Invalid test date: ${value}`);
  return parsed;
}
