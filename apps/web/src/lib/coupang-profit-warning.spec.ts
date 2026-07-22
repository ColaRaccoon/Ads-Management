import { describe, expect, it } from "vitest";
import { formatCoupangIncompleteReasons, hasCoupangLogisticsMissingWarning } from "./coupang-profit-warning";

describe("Coupang incomplete profit warning summary", () => {
  it("deduplicates reason codes and includes representative product names", () => {
    expect(formatCoupangIncompleteReasons([
      {
        productName: "옵션 A",
        calculationStatus: "INCOMPLETE",
        warnings: ["NORMAL_COST_RULE_MISSING"],
        ruleStatus: "MISSING_COST_RULE"
      },
      {
        productName: "옵션 B",
        calculationStatus: "INCOMPLETE",
        warnings: ["NORMAL_COST_RULE_MISSING"],
        ruleStatus: "MISSING_COST_RULE"
      },
      {
        productName: "정상 옵션",
        calculationStatus: "COMPLETE",
        warnings: ["IGNORED_WARNING"],
        ruleStatus: "OK"
      }
    ])).toBe("주요 원인: NORMAL_COST_RULE_MISSING (옵션 A, 옵션 B) · MISSING_COST_RULE (옵션 A, 옵션 B)");
  });

  it("shows actionable Korean labels for independently missing shipping fields", () => {
    expect(formatCoupangIncompleteReasons([{
      productName: "혼합 옵션",
      calculationStatus: "INCOMPLETE",
      warnings: ["SELLER_SHIPPING_FEE_MISSING", "HANARO_SHIPPING_FEE_MISSING"],
      ruleStatus: "OK"
    }])).toBe(
      "주요 원인: 판매자 배송비가 설정되지 않았습니다 (혼합 옵션) · 하나로 배송비가 설정되지 않았습니다 (혼합 옵션)"
    );
  });

  it("identifies rows that need a product-settings logistics fix", () => {
    expect(hasCoupangLogisticsMissingWarning(["SELLER_SHIPPING_FEE_MISSING"])).toBe(true);
    expect(hasCoupangLogisticsMissingWarning(["NORMAL_COST_RULE_MISSING"])).toBe(false);
  });
});
