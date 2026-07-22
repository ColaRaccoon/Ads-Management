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
          unitTotalCostKrw: 10_000,
          isCalculable: true,
          warnings: []
        },
        {
          coupangProductId: "legacy",
          unitSalesAmountKrw: null,
          unitTotalCostKrw: null,
          isCalculable: false,
          warnings: ["COUPANG_COST_RULE_MISSING"]
        }
      ]
    );

    expect(summary).toEqual({
      selectedOptionCount: 2,
      totalQuantity: 3,
      expectedSalesAmountKrw: null,
      expectedCostKrw: null,
      uncalculableCount: 1,
      uncalculableReasons: ["COUPANG_COST_RULE_MISSING"]
    });
  });
});
