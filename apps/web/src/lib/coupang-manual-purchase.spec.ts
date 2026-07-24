import { describe, expect, it } from "vitest";
import { parseSelectedManualPurchaseQuantity, summarizeManualPurchaseDrafts } from "./coupang-manual-purchase";

describe("Coupang manual-purchase draft", () => {
  it("excludes only a blank or explicit zero quantity", () => {
    expect(parseSelectedManualPurchaseQuantity("", "상품")).toBeNull();
    expect(parseSelectedManualPurchaseQuantity("0", "상품")).toBeNull();
    expect(parseSelectedManualPurchaseQuantity("2", "상품")).toBe(2);
  });

  it("rejects a populated non-integer instead of dropping the replacement row", () => {
    expect(() => parseSelectedManualPurchaseQuantity("1.5", "기존 상품")).toThrow("수량은 1 이상의 정수");
    expect(() => parseSelectedManualPurchaseQuantity("-1", "기존 상품")).toThrow("수량은 1 이상의 정수");
  });

  it("keeps expected totals unavailable when any selected legacy option has null amounts", () => {
    const summary = summarizeManualPurchaseDrafts(
      { calculable: { quantity: "2" }, legacy: { quantity: "1" } },
      [
        {
          coupangProductId: "calculable",
          unitSalesAmountKrw: 20_000,
          unitVendorFeeKrw: 3_182,
          isCalculable: true,
          warnings: []
        },
        {
          coupangProductId: "legacy",
          unitSalesAmountKrw: null,
          unitVendorFeeKrw: null,
          isCalculable: false,
          warnings: ["COUPANG_COST_RULE_MISSING"]
        }
      ]
    );

    expect(summary).toEqual({
      selectedOptionCount: 2,
      totalQuantity: 3,
      expectedSalesAmountKrw: null,
      expectedVendorFeeKrw: null,
      expectedCostKrw: null,
      uncalculableCount: 1,
      uncalculableReasons: ["COUPANG_COST_RULE_MISSING"]
    });
  });

  it("uses the vendor fee as the entire manual-purchase cost", () => {
    const summary = summarizeManualPurchaseDrafts(
      { product: { quantity: "2" } },
      [{
        coupangProductId: "product",
        unitSalesAmountKrw: 24_000,
        unitVendorFeeKrw: 3_182,
        isCalculable: true,
        warnings: []
      }]
    );

    expect(summary.expectedSalesAmountKrw).toBe(48_000);
    expect(summary.expectedVendorFeeKrw).toBe(6_364);
    expect(summary).not.toHaveProperty("expectedVatKrw");
    expect(summary.expectedCostKrw).toBe(6_364);
  });

  it("rounds the vendor fee once per selected row like the save API", () => {
    const summary = summarizeManualPurchaseDrafts(
      { product: { quantity: "10" } },
      [{
        coupangProductId: "product",
        unitSalesAmountKrw: 14_320,
        unitVendorFeeKrw: 3_182,
        isCalculable: true,
        warnings: []
      }]
    );

    expect(summary.expectedVendorFeeKrw).toBe(31_820);
    expect(summary.expectedCostKrw).toBe(31_820);
  });

  it("matches the 2026-07-22 five-product checksum with row-level rounding", () => {
    const pricesAndQuantities = [
      ["p1", 9_900, 10],
      ["p2", 14_320, 10],
      ["p3", 24_150, 5],
      ["p4", 38_600, 5],
      ["p5", 29_800, 10]
    ] as const;
    const summary = summarizeManualPurchaseDrafts(
      Object.fromEntries(pricesAndQuantities.map(([id, , quantity]) => [id, { quantity: String(quantity) }])),
      pricesAndQuantities.map(([coupangProductId, unitSalesAmountKrw]) => ({
        coupangProductId,
        unitSalesAmountKrw,
        unitVendorFeeKrw: 3_182,
        isCalculable: true,
        warnings: []
      }))
    );

    expect(summary.totalQuantity).toBe(40);
    expect(summary.expectedSalesAmountKrw).toBe(853_950);
    expect(summary.expectedVendorFeeKrw).toBe(127_280);
    expect(summary).not.toHaveProperty("expectedVatKrw");
    expect(summary.expectedCostKrw).toBe(127_280);
  });
});
