import { describe, expect, it } from "vitest";
import { formatPercent, percentToRatio } from "./meta-video-display";

describe("Meta percentage display", () => {
  it("distinguishes unavailable values from real zero and keeps two decimals", () => {
    expect(formatPercent(null)).toBe("-");
    expect(formatPercent(Number.NaN)).toBe("-");
    expect(formatPercent(0)).toBe("0.00%");
    expect(formatPercent(48.8095238)).toBe("48.81%");
  });

  it("converts API percentage numbers to XLSX ratios", () => {
    expect(percentToRatio(48.81)).toBeCloseTo(0.4881, 10);
    expect(percentToRatio(0)).toBe(0);
    expect(percentToRatio(null)).toBeNull();
  });
});
