import { describe, expect, it } from "vitest";
import { calculateCoupangProfit } from "./coupang-profit-calculator";

describe("calculateCoupangProfit", () => {
  it("includes return-rate cost and ad spend in total cost", () => {
    const result = calculateCoupangProfit(
      { netSalesKrw: 100_000, salesQuantity: 10, saleMethod: "seller" },
      {
        salePriceKrw: 10_000,
        productCostKrw: 3_000,
        salesFeeKrw: 500,
        sellerShippingFeeKrw: 1_000,
        returnRate: 0.1,
        returnCostPerUnitKrw: 2_000,
        extraCostKrw: 100
      },
      { adSpendKrw: 8_000, adConversionSalesKrw: 60_000 },
      { includeReturnCost: true }
    );

    expect(result.returnCostKrw).toBe(2_000);
    expect(result.totalCostKrw).toBe(56_000);
    expect(result.marginKrw).toBe(44_000);
    expect(result.roas).toBe(7.5);
  });

  it("does not clamp negative organic sales and returns a warning", () => {
    const result = calculateCoupangProfit(
      { netSalesKrw: 50_000, salesQuantity: 1, saleMethod: "growth" },
      {
        salePriceKrw: 50_000,
        productCostKrw: 10_000,
        salesFeeKrw: 1_000,
        growthInboundFeeKrw: 2_000,
        growthShippingFeeKrw: 3_000,
        returnRate: 0,
        returnCostPerUnitKrw: 0
      },
      { adSpendKrw: 10_000, adConversionSalesKrw: 70_000 }
    );

    expect(result.shippingCostKrw).toBe(5_000);
    expect(result.organicSalesKrw).toBe(-20_000);
    expect(result.warnings).toContain("AD_CONVERSION_EXCEEDS_NET_SALES");
  });

  it("calculates sales fee from net sales in RATE mode", () => {
    const result = calculateCoupangProfit(
      { netSalesKrw: 100_000, salesQuantity: 4, saleMethod: "seller" },
      {
        salePriceKrw: 25_000,
        productCostKrw: 0,
        salesFeeRate: 0.108,
        salesFeeKrw: 9_999,
        sellerShippingFeeKrw: 0,
        returnRate: 0,
        returnCostPerUnitKrw: 0
      },
      { adSpendKrw: 0, adConversionSalesKrw: 0 },
      { feeMode: "RATE" }
    );

    expect(result.salesFeeKrw).toBe(10_800);
  });

  it("falls back to per-unit sales fee when PER_UNIT mode is used", () => {
    const result = calculateCoupangProfit(
      { netSalesKrw: 100_000, salesQuantity: 4, saleMethod: "seller" },
      {
        salePriceKrw: 25_000,
        productCostKrw: 0,
        salesFeeRate: 0.108,
        salesFeeKrw: 500,
        sellerShippingFeeKrw: 0,
        returnRate: 0,
        returnCostPerUnitKrw: 0
      },
      { adSpendKrw: 0, adConversionSalesKrw: 0 },
      { feeMode: "PER_UNIT" }
    );

    expect(result.salesFeeKrw).toBe(2_000);
  });
});
