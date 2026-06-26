import { describe, expect, it } from "vitest";
import { CoupangProductMatcher, CoupangRuleInput, normalizeCoupangText } from "./coupang-product-matcher";

describe("CoupangProductMatcher", () => {
  const matcher = new CoupangProductMatcher();

  it("requires all include keywords and excludes when any exclude keyword is present", () => {
    const rules = [
      rule({ id: "single", productId: "single", includeKeywords: ["zero", "black"], excludeKeywords: ["2pack"] }),
      rule({ id: "two-pack", productId: "two-pack", includeKeywords: ["zero", "2pack"] })
    ];

    expect(matcher.matchText("Zero Bar Black", rules).productId).toBe("single");
    expect(matcher.matchText("Zero Bar Black 2pack", rules).productId).toBe("two-pack");
  });

  it("uses priority, include keyword count, and include keyword length before ambiguous", () => {
    const priorityResult = matcher.matchText("alpha beta gamma", [
      rule({ id: "slow", productId: "slow", includeKeywords: ["alpha"], priority: 20 }),
      rule({ id: "fast", productId: "fast", includeKeywords: ["alpha"], priority: 10 })
    ]);
    const keywordCountResult = matcher.matchText("alpha beta gamma", [
      rule({ id: "one", productId: "one", includeKeywords: ["alpha"], priority: 10 }),
      rule({ id: "two", productId: "two", includeKeywords: ["alpha", "beta"], priority: 10 })
    ]);
    const ambiguousResult = matcher.matchText("alpha beta", [
      rule({ id: "a", productId: "a", includeKeywords: ["alpha"], priority: 10 }),
      rule({ id: "b", productId: "b", includeKeywords: ["alpha"], priority: 10 })
    ]);

    expect(priorityResult.productId).toBe("fast");
    expect(keywordCountResult.productId).toBe("two");
    expect(ambiguousResult.reason).toBe("AMBIGUOUS_MATCH");
    expect(ambiguousResult.productId).toBeNull();
  });

  it("normalizes whitespace and case", () => {
    expect(normalizeCoupangText("  Zero   BAR ")).toBe("zerobar");
  });
});

function rule(overrides: Partial<CoupangRuleInput>): CoupangRuleInput {
  return {
    id: "rule",
    productId: "product",
    includeKeywords: [],
    excludeKeywords: [],
    priority: 100,
    isActive: true,
    ...overrides
  };
}
