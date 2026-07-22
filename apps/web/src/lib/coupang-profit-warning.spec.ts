import { describe, expect, it } from "vitest";
import { formatCoupangIncompleteReasons } from "./coupang-profit-warning";

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
});
