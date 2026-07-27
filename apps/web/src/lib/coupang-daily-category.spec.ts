import { describe, expect, it } from "vitest";
import {
  buildCoupangDailyReportUrl,
  canonicalDailyCategoryIds,
  categoryTreeState,
  dailyReportFilenameSlug,
  normalizeDailyReportQuery,
  planDailyCategoryDeactivation,
  shouldRestoreDailyCategoryTriggerFocus
} from "./coupang-daily-category";

describe("Coupang daily category UI helpers", () => {
  it("canonicalizes category ids and builds a stable server-filter URL", () => {
    expect(canonicalDailyCategoryIds(["b", "a", "b"])).toEqual(["a", "b"]);
    expect(buildCoupangDailyReportUrl({
      date: "2026-07-24",
      categoryIds: ["b", "a"],
      includeUncategorized: true,
      query: "  웨이브   바 "
    })).toBe("/coupang/daily-report?date=2026-07-24&categoryIds=a%2Cb&includeUncategorized=true&q=%EC%9B%A8%EC%9D%B4%EB%B8%8C+%EB%B0%94");
  });

  it("normalizes query case and repeated whitespace identically for cache keys and URLs", () => {
    const normalized = normalizeDailyReportQuery("  WaVE   BAR  ");
    expect(normalized).toBe("wave bar");
    expect(buildCoupangDailyReportUrl({
      date: "2026-07-24",
      categoryIds: [],
      includeUncategorized: false,
      query: "  WaVE   BAR  "
    })).toBe(buildCoupangDailyReportUrl({
      date: "2026-07-24",
      categoryIds: [],
      includeUncategorized: false,
      query: normalized
    }));
  });

  it("derives mixed parent selection without dropping hidden members", () => {
    expect(categoryTreeState(["a", "b"], new Set(["a", "hidden"]))).toEqual({
      checked: false,
      indeterminate: true
    });
  });

  it("creates safe bounded Windows filename fragments", () => {
    expect(dailyReportFilenameSlug(' 홈:트레이닝 / "핵심" ', 1)).toBe("홈트레이닝_핵심");
    expect(dailyReportFilenameSlug("ignored", 3)).toBe("카테고리3개");
  });

  it("restores focus only when closing removes the focused popover control", () => {
    expect(shouldRestoreDailyCategoryTriggerFocus("escape")).toBe(true);
    expect(shouldRestoreDailyCategoryTriggerFocus("apply")).toBe(true);
    expect(shouldRestoreDailyCategoryTriggerFocus("outside")).toBe(false);
    expect(shouldRestoreDailyCategoryTriggerFocus("trigger")).toBe(false);
    expect(shouldRestoreDailyCategoryTriggerFocus("manage")).toBe(false);
  });

  it("removes a selected deactivated category before the report query changes", () => {
    const plan = planDailyCategoryDeactivation(new Set(["keep", "deactivate"]), "deactivate");
    expect([...plan.selected]).toEqual(["keep"]);
    expect(plan.selectionChanged).toBe(true);
    expect(plan.invalidateCurrentReport).toBe(false);
  });

  it("keeps current-report invalidation for a deactivated category outside the filter", () => {
    const selected = new Set(["keep"]);
    const plan = planDailyCategoryDeactivation(selected, "other");
    expect([...plan.selected]).toEqual(["keep"]);
    expect([...selected]).toEqual(["keep"]);
    expect(plan.selectionChanged).toBe(false);
    expect(plan.invalidateCurrentReport).toBe(true);
  });
});
