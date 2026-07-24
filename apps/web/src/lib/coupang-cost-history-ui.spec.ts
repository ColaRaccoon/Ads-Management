import { describe, expect, it } from "vitest";
import { koreaTodayDateInput, previewCoupangCostHistory } from "./coupang-cost-history-ui";

describe("Coupang cost-history UI preview", () => {
  const rules = [
    { id: "old", effectiveFrom: "2026-07-01", effectiveTo: "2026-07-21", createdAt: "2026-07-01T01:00:00Z" },
    { id: "current", effectiveFrom: "2026-07-22", effectiveTo: null, createdAt: "2026-07-22T01:00:00Z" }
  ];

  it("derives the calendar date in Asia/Seoul instead of the browser timezone", () => {
    expect(koreaTodayDateInput(new Date("2026-07-22T14:59:59.000Z"))).toBe("2026-07-22");
    expect(koreaTodayDateInput(new Date("2026-07-22T15:00:00.000Z"))).toBe("2026-07-23");
  });

  it("shows current, basis, same-date, next, expected end, and historical impact", () => {
    const preview = previewCoupangCostHistory(rules, "2026-07-10", "2026-07-23");

    expect(preview).toMatchObject({
      currentRule: { id: "current" },
      basisRule: { id: "old" },
      sameDateRule: null,
      dateCollisionRule: null,
      nextRule: { id: "current" },
      expectedEffectiveTo: "2026-07-21",
      currentValueImpact: "HISTORICAL"
    });
  });

  it("identifies same-date update and a value that becomes current today", () => {
    const preview = previewCoupangCostHistory(rules, "2026-07-22", "2026-07-23");

    expect(preview.sameDateRule?.id).toBe("current");
    expect(preview.dateCollisionRule).toBeNull();
    expect(preview.basisRule?.id).toBe("current");
    expect(preview.nextRule).toBeNull();
    expect(preview.expectedEffectiveTo).toBeNull();
    expect(preview.currentValueImpact).toBe("CURRENT");
  });

  it("marks future starts without claiming today's value will change", () => {
    const preview = previewCoupangCostHistory(rules, "2026-08-01", "2026-07-23");

    expect(preview.basisRule?.id).toBe("current");
    expect(preview.currentValueImpact).toBe("FUTURE");
  });

  it("excludes a moved correction row when checking date collision and next history", () => {
    const preview = previewCoupangCostHistory(rules, "2026-07-15", "2026-07-23", "current");

    expect(preview.basisRule?.id).toBe("current");
    expect(preview.sameDateRule).toBeNull();
    expect(preview.dateCollisionRule).toBeNull();
    expect(preview.nextRule).toBeNull();
    expect(preview.currentValueImpact).toBe("CURRENT");
  });

  it("marks another correction row on the target date as a rejected collision", () => {
    const preview = previewCoupangCostHistory(rules, "2026-07-01", "2026-07-23", "current");

    expect(preview.sameDateRule?.id).toBe("old");
    expect(preview.dateCollisionRule?.id).toBe("old");
    expect(preview.currentValueImpact).toBe("REJECTED_DATE_COLLISION");
  });
});
