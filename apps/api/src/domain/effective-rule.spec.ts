import { describe, expect, it } from "vitest";
import { findEffectiveRuleForDate, previousUtcDate } from "./effective-rule";

describe("effective rule selection", () => {
  it("uses effectiveFrom, createdAt, and id descending in that order", () => {
    const date = new Date("2026-08-21T00:00:00.000Z");
    const sameCreatedAt = new Date("2026-06-01T02:00:00.000Z");
    const rules = [
      rule("z-older-start", "2026-08-01", "2026-06-02T00:00:00.000Z"),
      rule("a", "2026-08-21", sameCreatedAt),
      rule("b", "2026-08-21", sameCreatedAt),
      rule("old-created", "2026-08-21", "2026-06-01T01:00:00.000Z")
    ];

    expect(findEffectiveRuleForDate(rules, date)?.id).toBe("b");
    expect(findEffectiveRuleForDate([...rules].reverse(), date)?.id).toBe("b");
  });

  it("returns the previous UTC calendar date", () => {
    expect(previousUtcDate(new Date("2026-03-01T00:00:00.000Z"))).toEqual(
      new Date("2026-02-28T00:00:00.000Z")
    );
  });
});

function rule(id: string, effectiveFrom: string, createdAt: string | Date) {
  return {
    id,
    effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`),
    effectiveTo: null,
    createdAt: new Date(createdAt)
  };
}
