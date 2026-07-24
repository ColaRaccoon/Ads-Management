import { describe, expect, it } from "vitest";
import {
  calculateCoupangManualPurchaseCost,
  calculateCoupangProfit,
  calculateCoupangProfitBySegments,
  normalizeCoupangFulfillmentMethod,
  parseExplicitCoupangFulfillmentMethod
} from "./coupang-profit-calculator";

describe("calculateCoupangProfit", () => {
  it("includes return-rate cost and ad spend in total cost", () => {
    const result = calculateCoupangProfit(
      { netSalesKrw: 100_000, salesQuantity: 10, saleMethod: "seller" },
      {
        salePriceKrw: 10_000,
        productCostKrw: 3_000,
        sellerShippingFeeKrw: 1_000,
        returnRate: 0.1,
        returnCostPerUnitKrw: 2_000,
        extraCostKrw: 100
      },
      { adSpendKrw: 8_000, adConversionSalesKrw: 60_000 },
      { salesFeeRate: 0.05, includeReturnCost: true }
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
        growthInboundFeeKrw: 2_000,
        growthShippingFeeKrw: 3_000,
        returnRate: 0,
        returnCostPerUnitKrw: 0
      },
      { adSpendKrw: 10_000, adConversionSalesKrw: 70_000 },
      { salesFeeRate: 0.02 }
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
        sellerShippingFeeKrw: 0,
        returnRate: 0,
        returnCostPerUnitKrw: 0
      },
      { adSpendKrw: 0, adConversionSalesKrw: 0 },
      { salesFeeRate: 0.108 }
    );

    expect(result.salesFeeKrw).toBe(10_800);
  });

  it("keeps a global 0% fee at zero", () => {
    const result = calculateCoupangProfit(
      { netSalesKrw: 100_000, salesQuantity: 4, saleMethod: "seller" },
      {
        salePriceKrw: 25_000,
        productCostKrw: 0,
        sellerShippingFeeKrw: 0,
        returnRate: 0,
        returnCostPerUnitKrw: 0
      },
      { adSpendKrw: 0, adConversionSalesKrw: 0 },
      { salesFeeRate: 0 }
    );

    expect(result.salesFeeKrw).toBe(0);
  });
});

describe("calculateCoupangProfitBySegments", () => {
  it("normalizes fulfillment labels without changing the source value", () => {
    expect(normalizeCoupangFulfillmentMethod("로켓그로스")).toBe("GROWTH");
    expect(normalizeCoupangFulfillmentMethod(" Rocket Growth ")).toBe("GROWTH");
    expect(normalizeCoupangFulfillmentMethod("판매자배송")).toBe("SELLER");
    expect(normalizeCoupangFulfillmentMethod("알수없음")).toBe("SELLER");
    expect(parseExplicitCoupangFulfillmentMethod("알수없음")).toBeNull();
  });

  it("sums seller and growth costs while charging product-date ads exactly once", () => {
    const result = calculateCoupangProfitBySegments({
      segments: [
        { fulfillmentMethod: "SELLER", netSalesKrw: 60_000, salesQuantity: 3 },
        { fulfillmentMethod: "GROWTH", netSalesKrw: 40_000, salesQuantity: 2 }
      ],
      cost: {
        productCostKrw: 1_000,
        sellerShippingFeeKrw: 2_500,
        hanaroShippingFeeKrw: 300,
        growthInboundFeeKrw: 700,
        growthShippingFeeKrw: 1_300,
        returnRate: 0,
        extraCostKrw: 0
      },
      ads: { adSpendKrw: 10_000, adConversionSalesKrw: 120_000 },
      salesFeeRate: 0.1
    });

    expect(result).toMatchObject({
      sellerSalesQuantity: 3,
      growthSalesQuantity: 2,
      sellerShippingCostKrw: 7_500,
      hanaroShippingCostKrw: 600,
      growthInboundCostKrw: 1_400,
      growthShippingCostKrw: 2_600,
      totalLogisticsCostKrw: 12_100,
      shippingCostKrw: 12_100,
      productCostKrw: 5_000,
      salesFeeKrw: 10_000,
      adSpendKrw: 10_000,
      organicSalesKrw: -20_000,
      warnings: ["AD_CONVERSION_EXCEEDS_NET_SALES"]
    });
    expect(result.totalCostKrw).toBeCloseTo(37_100 + 100_000 / 11);
  });

  it("uses global zero percent and accepts a zero seller shipping setting", () => {
    const result = calculateCoupangProfitBySegments({
      segments: [
        { fulfillmentMethod: "SELLER", netSalesKrw: 30_000, salesQuantity: 3 },
        { fulfillmentMethod: "GROWTH", netSalesKrw: 20_000, salesQuantity: 2 }
      ],
      cost: {
        productCostKrw: 0,
        sellerShippingFeeKrw: 0,
        hanaroShippingFeeKrw: 0,
        growthInboundFeeKrw: 0,
        growthShippingFeeKrw: 0
      },
      ads: { adSpendKrw: 0, adConversionSalesKrw: 0 },
      salesFeeRate: 0
    });

    expect(result.salesFeeKrw).toBe(0);
    expect(result.sellerShippingCostKrw).toBe(0);
    expect(result.shippingCostKrw).toBe(0);
  });

  it.each([
    ["SELLER", "판매자배송"],
    ["GROWTH", "로켓그로스"]
  ] as const)("preserves the legacy single-%s calculation result", (fulfillmentMethod, saleMethod) => {
    const cost = {
      productCostKrw: 1_000,
      sellerShippingFeeKrw: 2_500,
      hanaroShippingFeeKrw: 300,
      growthInboundFeeKrw: 700,
      growthShippingFeeKrw: 1_300,
      returnRate: 0.1,
      returnCostPerUnitKrw: 500,
      extraCostKrw: 100
    };
    const ads = { adSpendKrw: 4_000, adConversionSalesKrw: 25_000 };
    const legacy = calculateCoupangProfit(
      { saleMethod, netSalesKrw: 50_000, salesQuantity: 2 },
      cost,
      ads,
      { salesFeeRate: 0.1, includeReturnCost: true }
    );
    const segmented = calculateCoupangProfitBySegments({
      segments: [{ fulfillmentMethod, netSalesKrw: 50_000, salesQuantity: 2 }],
      cost,
      ads,
      salesFeeRate: 0.1,
      includeReturnCost: true
    });

    expect(segmented).toMatchObject(legacy);
  });
});

describe("calculateCoupangManualPurchaseCost", () => {
  it("charges only the vendor fee", () => {
    const result = calculateCoupangManualPurchaseCost({
      quantity: 2,
      vendorFeePerUnitKrw: 3_182
    });

    expect(result).toEqual({
      productCostKrw: 0,
      vendorFeeTotalKrw: 6_364,
      coupangSalesFeeKrw: 0,
      shippingCostKrw: 0,
      otherCostKrw: 0,
      totalCostKrw: 6_364
    });
    expect(result).not.toHaveProperty("vatKrw");
  });

  it("accepts zero quantity without manufacturing a cost", () => {
    expect(calculateCoupangManualPurchaseCost({
      quantity: 0,
      vendorFeePerUnitKrw: 3_182
    })).toEqual({
      productCostKrw: 0,
      vendorFeeTotalKrw: 0,
      coupangSalesFeeKrw: 0,
      shippingCostKrw: 0,
      otherCostKrw: 0,
      totalCostKrw: 0
    });
  });

  it.each([-1, 1.5])("rejects an invalid quantity of %s", (quantity) => {
    expect(() => calculateCoupangManualPurchaseCost({
      quantity,
      vendorFeePerUnitKrw: 3_182
    })).toThrow("non-negative integer");
  });

  it("rounds the vendor fee and total cost to two decimal places", () => {
    const result = calculateCoupangManualPurchaseCost({
      quantity: 3,
      vendorFeePerUnitKrw: 3_182.125
    });

    expect(result.vendorFeeTotalKrw).toBe(9_546.38);
    expect(result.totalCostKrw).toBe(9_546.38);
  });

  it("matches the 2026-07-22 five-product accounting fixture", () => {
    const rows = [
      [9_900, 10],
      [14_320, 10],
      [24_150, 5],
      [38_600, 5],
      [29_800, 10]
    ].map(([baseSalePriceKrw, quantity]) => ({
      salesAmountKrw: baseSalePriceKrw * quantity,
      ...calculateCoupangManualPurchaseCost({
        quantity,
        vendorFeePerUnitKrw: 3_182
      })
    }));

    expect(rows.reduce((sum, row) => sum + row.salesAmountKrw, 0)).toBe(853_950);
    expect(rows.reduce((sum, row) => sum + row.vendorFeeTotalKrw, 0)).toBe(127_280);
    expect(rows.every((row) => !("vatKrw" in row))).toBe(true);
    expect(rows.reduce((sum, row) => sum + row.totalCostKrw, 0)).toBe(127_280);
  });
});
