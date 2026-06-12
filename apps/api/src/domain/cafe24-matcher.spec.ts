import { describe, expect, it } from "vitest";
import { Cafe24ProductMatcher, Cafe24RuleInput, normalizeCafe24Text, normalizeProductNo } from "./cafe24-matcher";
import { toDateOnly } from "./date-number";

describe("Cafe24ProductMatcher", () => {
  const matcher = new Cafe24ProductMatcher();

  it("matches wavebar single and 1+1 by option plus keyword, not sale price", () => {
    const rules: Cafe24RuleInput[] = [
      rule({
        id: "wavebar-single-rule",
        productId: "wavebar-single",
        productNumbers: ["120"],
        productNameAliases: ["버닝 웨이브 바"],
        optionExcludeKeywords: ["+"],
        priority: 10
      }),
      rule({
        id: "wavebar-plus-rule",
        productId: "wavebar-plus",
        productNumbers: ["120"],
        productNameAliases: ["버닝 웨이브 바"],
        optionIncludeKeywords: ["+"],
        priority: 5
      })
    ];

    expect(
      matcher.match(
        row({ productNo: "120", optionName: "버닝 웨이브 바 [옵션: 블랙]" }),
        rules
      )
    ).toMatchObject({ productId: "wavebar-single", matchRuleId: "wavebar-single-rule", reason: "MATCHED" });
    expect(
      matcher.match(
        row({ productNo: "120", optionName: "버닝 웨이브 바 [옵션: 블랙+그레이]" }),
        rules
      )
    ).toMatchObject({ productId: "wavebar-plus", matchRuleId: "wavebar-plus-rule", reason: "MATCHED" });
  });

  it("matches slide and ushield 1+1 rules with include/exclude keywords", () => {
    const rules: Cafe24RuleInput[] = [
      rule({ id: "slide", productId: "slide", productNumbers: ["121"], productNameAliases: ["버닝 슬라이드"] }),
      rule({
        id: "ushield-single",
        productId: "ushield-single",
        productNumbers: ["119"],
        productNameAliases: ["유쉴드마스크"],
        optionExcludeKeywords: ["1+1"],
        priority: 10
      }),
      rule({
        id: "ushield-plus",
        productId: "ushield-plus",
        productNumbers: ["119"],
        productNameAliases: ["유쉴드마스크"],
        optionIncludeKeywords: ["1+1"],
        priority: 5
      })
    ];

    expect(matcher.match(row({ productNo: "121", productName: "버닝 슬라이드" }), rules).productId).toBe("slide");
    expect(matcher.match(row({ productNo: "119", productName: "유쉴드마스크", optionName: "유쉴드마스크 1+1" }), rules).productId).toBe(
      "ushield-plus"
    );
    expect(matcher.match(row({ productNo: "119.0", productName: "유쉴드마스크", optionName: "유쉴드마스크 단품" }), rules).productId).toBe(
      "ushield-single"
    );
  });

  it("returns ambiguous when multiple active rules match", () => {
    const result = matcher.match(row({ productNo: "120" }), [
      rule({ id: "a", productId: "a", productNumbers: ["120"] }),
      rule({ id: "b", productId: "b", productNumbers: ["120"] })
    ]);

    expect(result.reason).toBe("AMBIGUOUS_MATCH");
    expect(result.productId).toBeNull();
    expect(result.candidates).toEqual(["a", "b"]);
  });

  it("normalizes Cafe24 text and product numbers", () => {
    expect(normalizeCafe24Text(" 버닝  웨이브 바 ")).toBe("버닝웨이브바");
    expect(normalizeProductNo("120.0")).toBe("120");
  });
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    productNo: "120",
    productName: "버닝 웨이브 바 배틀로프",
    optionName: "버닝 웨이브 바 배틀로프 [옵션: 블랙]",
    orderDate: toDateOnly("2026-06-11"),
    ...overrides
  };
}

function rule(overrides: Partial<Cafe24RuleInput>): Cafe24RuleInput {
  return {
    id: "rule",
    productId: "product",
    displayName: overrides.id,
    productNumbers: [],
    productNameAliases: [],
    optionIncludeKeywords: [],
    optionExcludeKeywords: [],
    priority: 100,
    isActive: true,
    ...overrides
  };
}
