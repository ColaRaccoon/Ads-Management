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
        salesFeeRate: 0.1,
        sellerShippingFeeKrw: 2_500,
        hanaroShippingFeeKrw: 300,
        growthInboundFeeKrw: 700,
        growthShippingFeeKrw: 1_300,
        returnRate: 0,
        extraCostKrw: 0
      },
      ads: { adSpendKrw: 10_000, adConversionSalesKrw: 120_000 },
      feeMode: "RATE"
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

  it("preserves per-unit fee totals and accepts a zero seller shipping setting", () => {
    const result = calculateCoupangProfitBySegments({
      segments: [
        { fulfillmentMethod: "SELLER", netSalesKrw: 30_000, salesQuantity: 3 },
        { fulfillmentMethod: "GROWTH", netSalesKrw: 20_000, salesQuantity: 2 }
      ],
      cost: {
        productCostKrw: 0,
        salesFeeKrw: 500,
        sellerShippingFeeKrw: 0,
        hanaroShippingFeeKrw: 0,
        growthInboundFeeKrw: 0,
        growthShippingFeeKrw: 0
      },
      ads: { adSpendKrw: 0, adConversionSalesKrw: 0 },
      feeMode: "PER_UNIT"
    });

    expect(result.salesFeeKrw).toBe(2_500);
    expect(result.sellerShippingCostKrw).toBe(0);
    expect(result.shippingCostKrw).toBe(0);
  });

  it.each([
    ["SELLER", "판매자배송"],
    ["GROWTH", "로켓그로스"]
  ] as const)("preserves the legacy single-%s calculation result", (fulfillmentMethod, saleMethod) => {
    const cost = {
      productCostKrw: 1_000,
      salesFeeRate: 0.1,
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
      { feeMode: "RATE", includeReturnCost: true }
    );
    const segmented = calculateCoupangProfitBySegments({
      segments: [{ fulfillmentMethod, netSalesKrw: 50_000, salesQuantity: 2 }],
      cost,
      ads,
      feeMode: "RATE",
      includeReturnCost: true
    });

    expect(segmented).toMatchObject(legacy);
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

  it("uses Hanaro, growth inbound, and growth shipping fees for rocket growth sale methods", () => {
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
        hanaroShippingFeeKrw: 300,
        growthInboundFeeKrw: 700,
        growthShippingFeeKrw: 1_300
      }
    });

    expect(result.coupangSalesFeeKrw).toBe(2_000);
    expect(result.shippingCostKrw).toBe(4_600);
    expect(result.vatKrw).toBeCloseTo(40_000 / 11);
    expect(result.productCostKrw).toBe(20_000);
    expect(result.totalCostKrw).toBeCloseTo(32_964 + 40_000 / 11);
  });
});
