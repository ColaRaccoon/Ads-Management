import { describe, expect, it } from "vitest";
import {
  formatCoupangDailyRowStatus,
  formatCoupangDailySummaryExportStatus,
  summarizeCoupangCalculationPartStatuses
} from "./coupang-report-status";

describe("Coupang daily export part statuses", () => {
  it("preserves a manual NOT_APPLICABLE status for ordinary sales without manual purchases", () => {
    expect(summarizeCoupangCalculationPartStatuses([
      { normalCalculationStatus: "COMPLETE", manualCalculationStatus: "NOT_APPLICABLE" }
    ])).toEqual({ normalCalculationStatus: "COMPLETE", manualCalculationStatus: "NOT_APPLICABLE" });
  });

  it("preserves a normal NOT_APPLICABLE status for manual-only activity", () => {
    expect(summarizeCoupangCalculationPartStatuses([
      { normalCalculationStatus: "NOT_APPLICABLE", manualCalculationStatus: "COMPLETE" }
    ])).toEqual({ normalCalculationStatus: "NOT_APPLICABLE", manualCalculationStatus: "COMPLETE" });
  });

  it("uses INCOMPLETE before COMPLETE before NOT_APPLICABLE when rows are mixed", () => {
    expect(summarizeCoupangCalculationPartStatuses([
      { normalCalculationStatus: "NOT_APPLICABLE", manualCalculationStatus: "NOT_APPLICABLE" },
      { normalCalculationStatus: "COMPLETE", manualCalculationStatus: "INCOMPLETE" }
    ])).toEqual({ normalCalculationStatus: "COMPLETE", manualCalculationStatus: "INCOMPLETE" });
  });

  it("writes preserved part statuses into the summary status shared by CSV and XLSX", () => {
    expect(formatCoupangDailySummaryExportStatus({
      isComplete: true,
      incompleteProductCount: 0,
      excludedNetSalesKrw: 0,
      excludedSalesQuantity: 0,
      normalCalculationStatus: "COMPLETE",
      manualCalculationStatus: "NOT_APPLICABLE"
    })).toBe("COMPLETE | NORMAL:COMPLETE | MANUAL:NOT_APPLICABLE");
  });

  it("writes incomplete child product names into the status shared by the table, CSV, and XLSX", () => {
    expect(formatCoupangDailyRowStatus({
      calculationStatus: "INCOMPLETE",
      normalCalculationStatus: "INCOMPLETE",
      manualCalculationStatus: "NOT_APPLICABLE",
      incompleteProductNames: ["누락 옵션 A", "누락 옵션 B"],
      warnings: ["GROUP_HAS_MISSING_COST_RULE"]
    })).toContain("INCOMPLETE_PRODUCTS:누락 옵션 A, 누락 옵션 B");
  });
  it("translates shipping warning codes in the table and exported status", () => {
    const status = formatCoupangDailyRowStatus({
      calculationStatus: "INCOMPLETE",
      normalCalculationStatus: "INCOMPLETE",
      manualCalculationStatus: "NOT_APPLICABLE",
      incompleteProductNames: [],
      warnings: ["SELLER_SHIPPING_FEE_MISSING", "HANARO_SHIPPING_FEE_MISSING"]
    });

    expect(status).toContain("판매자 배송비가 설정되지 않았습니다");
    expect(status).toContain("하나로 배송비가 설정되지 않았습니다");
    expect(status).not.toContain("SELLER_SHIPPING_FEE_MISSING");
  });
});
