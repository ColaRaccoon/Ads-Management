import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRange, defaultRangeForPath, presetRange } from "./date-range";

afterEach(() => {
  vi.useRealTimers();
});

describe("date range defaults", () => {
  it("defaults every page to yesterday in Korea", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T15:30:00.000Z"));

    const yesterday = { from: "2026-07-27", to: "2026-07-27" };
    expect(defaultRange()).toEqual(yesterday);
    expect(defaultRangeForPath("/dashboard")).toEqual(yesterday);
    expect(defaultRangeForPath("/ads")).toEqual(yesterday);
    expect(defaultRangeForPath("/change-logs")).toEqual(yesterday);
  });

  it("keeps presets anchored to the Korea date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T15:30:00.000Z"));

    expect(presetRange(0)).toEqual({ from: "2026-07-28", to: "2026-07-28" });
    expect(presetRange(1)).toEqual({ from: "2026-07-27", to: "2026-07-27" });
    expect(presetRange(3)).toEqual({ from: "2026-07-25", to: "2026-07-27" });
  });
});
