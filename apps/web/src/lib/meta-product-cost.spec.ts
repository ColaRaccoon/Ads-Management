import { describe, expect, it } from "vitest";
import {
  currentMetaProductCostRuleMap,
  currentMetaProductRuleMap,
  META_PRODUCT_RULE_DEPENDENT_QUERY_KEYS,
  metaProductCostCorrectionPath,
  metaProductCostRulePayload,
  metaProductCostSnapshotPath,
  metaProductCpaCorrectionPath,
  metaProductCpaRulePayload,
  metaProductCpaSnapshotPath,
  metaProductRuleHistory,
  previewMetaProductRuleHistory,
  type MetaProductCostRule,
  type MetaProductEffectiveRule
} from "./meta-product-cost";

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

  it("uses id DESC as the final deterministic tie-break regardless of input order", () => {
    const createdAt = "2026-08-01T02:00:00Z";
    const a = { ...rule("a", "product-1", "2026-08-01", null), createdAt };
    const b = { ...rule("b", "product-1", "2026-08-01", null), createdAt };

    expect(currentMetaProductCostRuleMap([a, b], "2026-08-04").get("product-1")?.id).toBe("b");
    expect(currentMetaProductCostRuleMap([b, a], "2026-08-04").get("product-1")?.id).toBe("b");
  });

  it("does not invent a zero-cost rule for an unconfigured product", () => {
    expect(currentMetaProductCostRuleMap([], "2026-08-04").has("product-1")).toBe(false);
  });

  it("selects current CPA-style rules with the shared effective-period logic", () => {
    const rules: Array<MetaProductEffectiveRule & { targetRatio: number }> = [
      { id: "current", productId: "product-1", targetRatio: 0.8, effectiveFrom: "2026-08-01", effectiveTo: null },
      { id: "future", productId: "product-1", targetRatio: 0.7, effectiveFrom: "2026-09-01", effectiveTo: null }
    ];

    expect(currentMetaProductRuleMap(rules, "2026-08-04").get("product-1")?.id).toBe("current");
  });

  it("sorts a selected product history with the same descending priority", () => {
    const rules = [
      { ...rule("old", "product-1", "2026-07-01", "2026-07-31"), createdAt: "2026-07-01T00:00:00Z" },
      { ...rule("a", "product-1", "2026-08-01", null), createdAt: "2026-08-01T00:00:00Z" },
      { ...rule("b", "product-1", "2026-08-01", null), createdAt: "2026-08-01T00:00:00Z" },
      rule("other", "product-2", "2026-09-01", null)
    ];

    expect(metaProductRuleHistory(rules, "product-1").map((item) => item.id)).toEqual(["b", "a", "old"]);
  });

  it("previews basis, next range, same-date update, and today's impact", () => {
    const rules = [
      rule("old", "product-1", "2026-06-01", "2026-08-20"),
      rule("current", "product-1", "2026-08-21", null)
    ];

    expect(previewMetaProductRuleHistory(rules, "2026-07-01", "2026-08-21")).toMatchObject({
      currentRule: { id: "current" },
      basisRule: { id: "old" },
      sameDateRule: null,
      nextRule: { id: "current" },
      expectedEffectiveTo: "2026-08-20",
      currentValueImpact: "HISTORICAL"
    });
    expect(previewMetaProductRuleHistory(rules, "2026-08-21", "2026-08-21")).toMatchObject({
      sameDateRule: { id: "current" },
      currentValueImpact: "CURRENT"
    });
    expect(previewMetaProductRuleHistory(rules, "2026-09-01", "2026-08-21")).toMatchObject({
      currentValueImpact: "FUTURE"
    });
  });

  it("previews today's rule change after a correction re-normalizes neighboring ranges", () => {
    const rules = [
      rule("old", "product-1", "2026-06-01", "2026-08-20"),
      rule("current", "product-1", "2026-08-21", null)
    ];

    expect(previewMetaProductRuleHistory(rules, "2026-05-01", "2026-08-21", "current")).toMatchObject({
      currentRule: { id: "current" },
      basisRule: { id: "current" },
      nextRule: { id: "old" },
      expectedEffectiveTo: "2026-05-31",
      currentValueImpact: "CURRENT"
    });
  });

  it("sends only dirty cost and CPA snapshot fields while keeping effectiveFrom", () => {
    const costBasis = {
      salePriceKrw: "36900",
      productCostKrw: "6000",
      shippingKrw: "2800",
      extraCostKrw: "0",
      effectiveFrom: "2026-08-21",
      note: "기존"
    };
    const cpaBasis = {
      targetRatio: "0.8",
      watchRatio: "1.1",
      stopRatio: "1.25",
      effectiveFrom: "2026-08-21",
      note: ""
    };

    expect(metaProductCostRulePayload(
      { ...costBasis, shippingKrw: "3200", effectiveFrom: "2026-08-22" },
      costBasis,
      "SNAPSHOT"
    )).toEqual({ effectiveFrom: "2026-08-22", shippingKrw: "3200" });
    expect(metaProductCpaRulePayload(
      { ...cpaBasis, watchRatio: "1.2" },
      cpaBasis,
      "SNAPSHOT"
    )).toEqual({ effectiveFrom: "2026-08-21", watchRatio: "1.2" });
  });

  it("sends all required values only for a first snapshot without a basis", () => {
    expect(metaProductCostRulePayload({
      salePriceKrw: "36900",
      productCostKrw: "6000",
      shippingKrw: "2800",
      extraCostKrw: "0",
      effectiveFrom: "2026-08-21",
      note: ""
    }, null, "SNAPSHOT")).toEqual({
      effectiveFrom: "2026-08-21",
      salePriceKrw: "36900",
      productCostKrw: "6000",
      shippingKrw: "2800",
      extraCostKrw: "0"
    });
    expect(metaProductCpaRulePayload({
      targetRatio: "0.8",
      watchRatio: "1.1",
      stopRatio: "1.25",
      effectiveFrom: "2026-08-21",
      note: ""
    }, null, "SNAPSHOT")).toEqual({
      effectiveFrom: "2026-08-21",
      targetRatio: "0.8",
      watchRatio: "1.1",
      stopRatio: "1.25"
    });
  });

  it("omits unchanged correction fields and includes effectiveFrom only when changed", () => {
    const basis = {
      targetRatio: "0.8",
      watchRatio: "1.1",
      stopRatio: "1.25",
      effectiveFrom: "2026-08-21",
      note: ""
    };

    expect(metaProductCpaRulePayload(basis, basis, "CORRECTION")).toEqual({});
    expect(metaProductCpaRulePayload(
      basis,
      { ...basis, effectiveFrom: "2026-08-21T00:00:00.000Z" },
      "CORRECTION"
    )).toEqual({});
    expect(metaProductCpaRulePayload(
      { ...basis, effectiveFrom: "2026-08-20" },
      basis,
      "CORRECTION"
    )).toEqual({ effectiveFrom: "2026-08-20" });
  });

  it("does not resend unchanged sale price or note during a cost correction", () => {
    const basis = {
      salePriceKrw: "36900",
      productCostKrw: "6000",
      shippingKrw: "2800",
      extraCostKrw: "0",
      effectiveFrom: "2026-08-21",
      note: "기존 메모"
    };

    expect(metaProductCostRulePayload(
      { ...basis, shippingKrw: "3200" },
      basis,
      "CORRECTION"
    )).toEqual({ shippingKrw: "3200" });
    expect(metaProductCostRulePayload(
      { ...basis, note: "   " },
      basis,
      "CORRECTION"
    )).toEqual({ note: null });
  });

  it("separates snapshot POST and correction PATCH endpoint paths", () => {
    expect(metaProductCostSnapshotPath("product 1")).toBe("/products/product%201/cost-rule-snapshots");
    expect(metaProductCostCorrectionPath("product 1", "cost/1")).toBe("/products/product%201/cost-rules/cost%2F1/correction");
    expect(metaProductCpaSnapshotPath("product 1")).toBe("/products/product%201/cpa-rule-snapshots");
    expect(metaProductCpaCorrectionPath("product 1", "cpa/1")).toBe("/products/product%201/cpa-rules/cpa%2F1/correction");
  });

  it("invalidates rule histories and dependent sales/report queries after saving", () => {
    expect(META_PRODUCT_RULE_DEPENDENT_QUERY_KEYS).toEqual(expect.arrayContaining([
      ["products"],
      ["product-cost-rules"],
      ["product-cpa-rules"],
      ["sales-product-performance"],
      ["daily-report-sales-product-performance"]
    ]));
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
