import { describe, expect, it } from "vitest";
import {
  canSaveCoupangProductForm,
  COUPANG_SALES_FEE_DEPENDENT_QUERY_KEYS,
  coupangCostCorrectionSuccessLabel,
  coupangCostRuleTodayImpactLabel,
  coupangMoneyLabel,
  coupangProductCreationSuccessLabel,
  coupangRateLabel,
  currentCoupangSalesFeeLabel
} from "./coupang-sales-fee-ui";

describe("Coupang sales-fee UI contracts", () => {
  it("invalidates normal-profit caches without coupling manual-purchase options to the global fee", () => {
    expect(COUPANG_SALES_FEE_DEPENDENT_QUERY_KEYS).toEqual([
      "coupang-product-profit",
      "coupang-dashboard",
      "coupang-daily-report"
    ]);
  });

  it("allows exact cost correction without requiring mapping keywords", () => {
    expect(canSaveCoupangProductForm({
      displayName: "상품",
      isEditing: true,
      isCorrectingCostRule: true,
      includeKeywordCount: 0
    })).toBe(true);
    expect(canSaveCoupangProductForm({
      displayName: "상품",
      isEditing: true,
      isCorrectingCostRule: false,
      includeKeywordCount: 0
    })).toBe(false);
  });

  it("renders explicit 0% and keeps the current rule's actual start date visible", () => {
    expect(coupangRateLabel(0)).toBe("0%");
    expect(coupangRateLabel(null)).toBe("-");
    expect(currentCoupangSalesFeeLabel({ salesFeePercent: 11.88, effectiveFrom: "2026-07-01" }))
      .toBe("11.88% (2026-07-01부터)");
  });

  it("renders explicit zero won while reserving a dash for missing values", () => {
    expect(coupangMoneyLabel(0)).toBe("0원");
    expect(coupangMoneyLabel("0")).toBe("0원");
    expect(coupangMoneyLabel(null)).toBe("-");
    expect(coupangMoneyLabel(undefined)).toBe("-");
  });

  it("confirms the saved legacy percentage and original effective date after exact correction", () => {
    expect(coupangCostCorrectionSuccessLabel({
      salesFeeRate: 0,
      effectiveFrom: "2026-07-01T00:00:00.000Z",
      effectiveTo: "2026-07-21T00:00:00.000Z",
      productCostKrw: 12_800,
      supplyPriceKrw: 15_000,
      sellerShippingFeeKrw: 2_800,
      hanaroShippingFeeKrw: 260
    }, "2026-07-23")).toBe("비용 이력 정정 완료: 2026-07-01~2026-07-21, 상품원가 12,800원, 공급가 15,000원, 판매자 배송비 2,800원, 하나로 배송비 260원, 레거시 판매 수수료율 0%. 과거 기간 이력이므로 오늘 현재값은 바뀌지 않습니다.");
  });

  it("distinguishes current, past, and future cost-rule effects using the KST date", () => {
    expect(coupangCostRuleTodayImpactLabel({ effectiveFrom: "2026-07-23", effectiveTo: null }, "2026-07-23"))
      .toBe("오늘의 현재 비용값으로 적용됩니다.");
    expect(coupangCostRuleTodayImpactLabel({ effectiveFrom: "2026-07-24", effectiveTo: null }, "2026-07-23"))
      .toBe("미래 시작 이력이므로 오늘 현재값은 바뀌지 않습니다.");
    expect(coupangCostRuleTodayImpactLabel({ effectiveFrom: "2026-07-01", effectiveTo: "2026-07-22" }, "2026-07-23"))
      .toBe("과거 기간 이력이므로 오늘 현재값은 바뀌지 않습니다.");
  });

  it("confirms creation values and whether a future cost rule affects today", () => {
    expect(coupangProductCreationSuccessLabel({
      displayName: "테스트 상품",
      costRules: [{
        effectiveFrom: "2026-07-24T00:00:00.000Z",
        effectiveTo: null,
        productCostKrw: 12_800,
        supplyPriceKrw: 15_000,
        sellerShippingFeeKrw: 2_800,
        hanaroShippingFeeKrw: 260
      }]
    }, "2026-07-23")).toBe("상품 생성 및 비용 저장 완료: 테스트 상품, 2026-07-24부터, 상품원가 12,800원, 공급가 15,000원, 판매자 배송비 2,800원, 하나로 배송비 260원. 미래 시작 이력이므로 오늘 현재값은 바뀌지 않습니다.");

    expect(coupangProductCreationSuccessLabel({ displayName: "비용 없는 상품", costRules: [] }, "2026-07-23"))
      .toBe("상품 생성 완료: 비용 없는 상품. 저장된 비용 이력은 없습니다.");
  });
});
