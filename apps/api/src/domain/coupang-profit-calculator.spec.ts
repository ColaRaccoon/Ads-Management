import { describe, expect, it } from "vitest";
import { calculateCoupangManualPurchaseCost, calculateCoupangProfit } from "./coupang-profit-calculator";

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
    expect(result.vatKrw).toBeCloseTo(100_000 / 11);
    expect(result.totalCostKrw).toBeCloseTo(56_000 + 100_000 / 11);
    expect(result.marginKrw).toBeCloseTo(44_000 - 100_000 / 11);
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
    expect(result.vatKrw).toBeCloseTo(50_000 / 11);
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

describe("calculateCoupangManualPurchaseCost", () => {
  it("calculates rate sales fee from quantity and the product cost rule", () => {
    const result = calculateCoupangManualPurchaseCost({
      quantity: 2,
      vendorFeePerUnitKrw: 3_182,
      saleMethod: "seller",
      salePriceKrw: 24_000,
      feeMode: "RATE",
      cost: {
        salePriceKrw: 24_000,
        productCostKrw: 10_000,
        salesFeeRate: 0.11,
        salesFeeKrw: 9_999,
        sellerShippingFeeKrw: 3_000,
        extraCostKrw: 250
      }
    });

    expect(result.productCostKrw).toBe(20_000);
    expect(result.vendorFeeTotalKrw).toBe(6_364);
    expect(result.coupangSalesFeeKrw).toBe(5_280);
    expect(result.shippingCostKrw).toBe(6_000);
    expect(result.vatKrw).toBeCloseTo(48_000 / 11);
    expect(result.otherCostKrw).toBe(500);
    expect(result.totalCostKrw).toBeCloseTo(38_144 + 48_000 / 11);
  });

  it("uses per-unit sales fee when rate mode is not selected", () => {
    const result = calculateCoupangManualPurchaseCost({
      quantity: 3,
      vendorFeePerUnitKrw: 3_182,
      saleMethod: "seller",
      salePriceKrw: 24_000,
      feeMode: "PER_UNIT",
      cost: {
        salePriceKrw: 24_000,
        productCostKrw: 10_000,
        salesFeeRate: 0,
        salesFeeKrw: 2_000,
        sellerShippingFeeKrw: 3_000
      }
    });

    expect(result.coupangSalesFeeKrw).toBe(6_000);
    expect(result.shippingCostKrw).toBe(9_000);
    expect(result.vatKrw).toBeCloseTo(72_000 / 11);
    expect(result.productCostKrw).toBe(30_000);
    expect(result.totalCostKrw).toBeCloseTo(54_546 + 72_000 / 11);
  });

  it("uses growth inbound and shipping fees for rocket growth sale methods", () => {
    const result = calculateCoupangManualPurchaseCost({
      quantity: 2,
      vendorFeePerUnitKrw: 3_182,
      saleMethod: "로켓그로스",
      salePriceKrw: 20_000,
      cost: {
        salePriceKrw: 20_000,
        productCostKrw: 10_000,
        salesFeeRate: 0,
        salesFeeKrw: 1_000,
        sellerShippingFeeKrw: 9_999,
        growthInboundFeeKrw: 700,
        growthShippingFeeKrw: 1_300
      }
    });

    expect(result.coupangSalesFeeKrw).toBe(2_000);
    expect(result.shippingCostKrw).toBe(4_000);
    expect(result.vatKrw).toBeCloseTo(40_000 / 11);
    expect(result.productCostKrw).toBe(20_000);
    expect(result.totalCostKrw).toBeCloseTo(32_364 + 40_000 / 11);
  });
});
