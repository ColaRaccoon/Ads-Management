import { describe, expect, it } from "vitest";
import { currentMetaProductCostRuleMap, type MetaProductCostRule } from "./meta-product-cost";

describe("Meta product current cost settings", () => {
  it("selects the rule that is effective today and ignores future and expired rules", () => {
    const rules = [
      rule("expired", "product-1", "2026-07-01", "2026-07-31"),
      rule("current", "product-1", "2026-08-01", null),
      rule("future", "product-1", "2026-09-01", null)
    ];

    expect(currentMetaProductCostRuleMap(rules, "2026-08-04").get("product-1")?.id).toBe("current");
  });

  it("uses the newest creation when overlapping rules start on the same date", () => {
    const older = { ...rule("older", "product-1", "2026-08-01", null), createdAt: "2026-08-01T01:00:00Z" };
    const newer = { ...rule("newer", "product-1", "2026-08-01", null), createdAt: "2026-08-01T02:00:00Z" };

    expect(currentMetaProductCostRuleMap([older, newer], "2026-08-04").get("product-1")?.id).toBe("newer");
  });

  it("does not invent a zero-cost rule for an unconfigured product", () => {
    expect(currentMetaProductCostRuleMap([], "2026-08-04").has("product-1")).toBe(false);
  });
});

function rule(
  id: string,
  productId: string,
  effectiveFrom: string,
  effectiveTo: string | null
): MetaProductCostRule {
  return {
    id,
    productId,
    salePriceKrw: 50000,
    vatKrw: 5000,
    productCostKrw: 12000,
    shippingKrw: 3000,
    extraCostKrw: 500,
    effectiveFrom,
    effectiveTo
  };
}
