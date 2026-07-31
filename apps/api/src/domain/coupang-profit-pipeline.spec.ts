import { describe, expect, it } from "vitest";
import {
  adjustReportedSalesForManualPurchase,
  aggregateManualPurchasesByProductDate,
  aggregateReportedSalesByProductDate,
  calculateManualPurchaseProfitAdjustment,
  calculateNormalCoupangProfit,
  combineCoupangProfitParts,
  emptyReportedSalesFacts,
  productDateKey,
  resolveManualPurchaseSalesAmount
} from "./coupang-profit-pipeline";

const DATE = "2026-07-15";

describe("Coupang product-date profit pipeline", () => {
  it("keeps reported values unchanged when no manual purchase exists", () => {
    const reported = reportedFacts({ salesKrw: 100_000, netSalesKrw: 90_000, salesQuantity: 4 });
    const actual = adjustReportedSalesForManualPurchase(reported, null);
    const normal = calculateNormalCoupangProfit({
      reported,
      actual,
      cost: costInput(),
      ads: adInput(5_000, 30_000),
      salesFeeRate: 0.1
    });
    const combined = combineCoupangProfitParts({ normal, manual: calculateManualPurchaseProfitAdjustment(null) });

    expect(actual).toMatchObject({ salesKrw: 100_000, netSalesKrw: 90_000, salesQuantity: 4, isValid: true });
    expect(combined.marginKrw).toBe(normal.calculated?.marginKrw);
    expect(normal.calculated?.adSpendKrw).toBe(5_000);
  });

  it("separates recognized sales from incurred costs, then charges the vendor fee once", () => {
    const reported = reportedFacts({ salesKrw: 100_000, netSalesKrw: 90_000, salesQuantity: 4 });
    const manual = manualFacts({ quantity: 1, salesAmountKrw: 25_000, totalCostKrw: 15_000 });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);
    const normal = calculateNormalCoupangProfit({
      reported,
      actual,
      cost: costInput(),
      ads: adInput(5_000, 30_000),
      salesFeeRate: 0.1
    });
    const combined = combineCoupangProfitParts({ normal, manual: calculateManualPurchaseProfitAdjustment(manual) });

    expect(actual).toMatchObject({ salesKrw: 75_000, netSalesKrw: 65_000, salesQuantity: 3 });
    expect(normal.calculated).toMatchObject({
      netSalesKrw: 65_000,
      productCostKrw: 40_000,
      salesFeeKrw: 9_000,
      shippingCostKrw: 4_000,
      vatKrw: 90_000 / 11,
      adSpendKrw: 5_000
    });
    expect(combined.marginKrw).toBeCloseTo(
      65_000 - 40_000 - 9_000 - 4_000 - 90_000 / 11 - 5_000 - 15_000
    );
  });

  it("reduces margin by exactly the manual sales adjustment plus vendor fee", () => {
    const reported = reportedFacts({
      salesKrw: 100_000,
      netSalesKrw: 100_000,
      salesQuantity: 4
    });
    const ads = adInput(5_000, 30_000);
    const baselineNormal = calculateNormalCoupangProfit({
      reported,
      actual: adjustReportedSalesForManualPurchase(reported, null),
      cost: costInput(),
      ads,
      salesFeeRate: 0.1
    });
    const baseline = combineCoupangProfitParts({
      normal: baselineNormal,
      manual: calculateManualPurchaseProfitAdjustment(null)
    });
    const manual = manualFacts({
      quantity: 1,
      salesAmountKrw: 25_000,
      vendorFeeKrw: 3_182,
      totalCostKrw: 3_182
    });
    const adjustedNormal = calculateNormalCoupangProfit({
      reported,
      actual: adjustReportedSalesForManualPurchase(reported, manual),
      cost: costInput(),
      ads,
      salesFeeRate: 0.1
    });
    const adjusted = combineCoupangProfitParts({
      normal: adjustedNormal,
      manual: calculateManualPurchaseProfitAdjustment(manual)
    });

    expect(baseline.marginKrw).not.toBeNull();
    expect(adjusted.marginKrw).not.toBeNull();
    expect(Number(baseline.marginKrw) - Number(adjusted.marginKrw))
      .toBeCloseTo(25_000 + 3_182);
    expect(adjustedNormal.calculated).toMatchObject({
      productCostKrw: 40_000,
      salesFeeKrw: 10_000,
      sellerSalesQuantity: 4,
      sellerShippingCostKrw: 4_000,
      vatKrw: 100_000 / 11,
      adSpendKrw: 5_000
    });
  });

  it("keeps VAT on reported net sales and charges only the vendor fee as the manual cost", () => {
    const reported = reportedFacts({
      salesKrw: 110_000,
      netSalesKrw: 110_000,
      salesQuantity: 10
    });
    const manual = manualFacts({
      quantity: 1,
      salesAmountKrw: 11_000,
      vendorFeeKrw: 3_080,
      totalCostKrw: 3_080
    });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);
    const normal = calculateNormalCoupangProfit({
      reported,
      actual,
      cost: {
        productCostKrw: 0,
        sellerShippingFeeKrw: 0,
        returnRate: 0,
        returnCostPerUnitKrw: 0,
        extraCostKrw: 0
      },
      ads: adInput(),
      salesFeeRate: 0
    });
    const combined = combineCoupangProfitParts({
      normal,
      manual: calculateManualPurchaseProfitAdjustment(manual)
    });

    expect(actual.netSalesKrw).toBe(99_000);
    expect(normal.calculated?.vatKrw).toBe(10_000);
    expect(normal.calculated?.marginKrw).toBe(89_000);
    expect(manual.totalCostKrw).toBe(3_080);
    expect(manual).not.toHaveProperty("vatKrw");
    expect(combined.marginKrw).toBe(85_920);
  });

  it("keeps the actual sales adjustment and normal profit valid when only the manual cost snapshot is incomplete", () => {
    const reported = reportedFacts({ salesKrw: 100_000, netSalesKrw: 100_000, salesQuantity: 4 });
    const manual = manualFacts({
      quantity: 1,
      salesAmountKrw: 25_000,
      vendorFeeKrw: null,
      totalCostKrw: 15_000
    });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);
    const normal = calculateNormalCoupangProfit({
      reported,
      actual,
      cost: costInput(),
      ads: adInput(),
      salesFeeRate: 0.1
    });
    const manualPart = calculateManualPurchaseProfitAdjustment(manual);
    const combined = combineCoupangProfitParts({ normal, manual: manualPart });

    expect(actual).toMatchObject({ salesKrw: 75_000, netSalesKrw: 75_000, salesQuantity: 3, isValid: true });
    expect(actual.warnings).toContain("MANUAL_PURCHASE_COST_SNAPSHOT_INCOMPLETE");
    expect(normal.status).toBe("COMPLETE");
    expect(normal.calculated?.productCostKrw).toBe(40_000);
    expect(manualPart.status).toBe("INCOMPLETE");
    expect(combined).toMatchObject({ calculationStatus: "INCOMPLETE", totalCostKrw: null, marginKrw: null });
  });

  it("blocks a manual-only row when its cost snapshot is also incomplete", () => {
    const reported = emptyReportedSalesFacts("product-1", DATE, "상품");
    const manual = manualFacts({
      quantity: 1,
      salesAmountKrw: 25_000,
      vendorFeeKrw: null,
      totalCostKrw: 15_000
    });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);
    const normal = calculateNormalCoupangProfit({
      reported,
      actual,
      cost: null,
      ads: adInput(3_000),
      salesFeeRate: 0.1
    });
    const manualPart = calculateManualPurchaseProfitAdjustment(manual);

    expect(actual).toMatchObject({ netSalesKrw: 0, salesQuantity: 0, isValid: false, isManualOnly: true });
    expect(actual.warnings).toContain("MANUAL_PURCHASE_WITHOUT_REPORTED_SALES");
    expect(normal).toMatchObject({ status: "INCOMPLETE", calculated: null });
    expect(manualPart.status).toBe("INCOMPLETE");
    expect(combineCoupangProfitParts({ normal, manual: manualPart }).marginKrw).toBeNull();
  });

  it("charges ad spend exactly once when manual purchases are present", () => {
    const reported = reportedFacts({ salesKrw: 50_000, netSalesKrw: 50_000, salesQuantity: 2 });
    const manual = manualFacts({ quantity: 1, salesAmountKrw: 25_000, totalCostKrw: 10_000 });
    const normal = calculateNormalCoupangProfit({
      reported,
      actual: adjustReportedSalesForManualPurchase(reported, manual),
      cost: costInput(),
      ads: adInput(7_000),
      salesFeeRate: 0.1
    });
    const combined = combineCoupangProfitParts({ normal, manual: calculateManualPurchaseProfitAdjustment(manual) });

    expect(normal.calculated?.totalCostKrw).toBeCloseTo(20_000 + 5_000 + 2_000 + 50_000 / 11 + 7_000);
    expect(combined.totalCostKrw).toBeCloseTo(20_000 + 5_000 + 2_000 + 50_000 / 11 + 7_000 + 10_000);
  });

  it("keeps all reported costs when manual purchases remove every recognized sale", () => {
    const reported = reportedFacts({
      salesKrw: 25_000,
      netSalesKrw: 25_000,
      salesQuantity: 1
    });
    const manual = manualFacts({
      quantity: 1,
      salesAmountKrw: 25_000,
      vendorFeeKrw: 3_182,
      totalCostKrw: 3_182
    });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);
    const normal = calculateNormalCoupangProfit({
      reported,
      actual,
      cost: costInput(),
      ads: adInput(),
      salesFeeRate: 0.1
    });
    const combined = combineCoupangProfitParts({
      normal,
      manual: calculateManualPurchaseProfitAdjustment(manual)
    });

    expect(actual).toMatchObject({
      netSalesKrw: 0,
      salesQuantity: 0,
      isValid: true
    });
    expect(normal.status).toBe("COMPLETE");
    expect(normal.calculated).toMatchObject({
      netSalesKrw: 0,
      productCostKrw: 10_000,
      salesFeeKrw: 2_500,
      shippingCostKrw: 1_000,
      vatKrw: 25_000 / 11
    });
    expect(normal.calculated?.marginKrw)
      .toBeCloseTo(-10_000 - 2_500 - 1_000 - 25_000 / 11);
    expect(combined.marginKrw)
      .toBeCloseTo(-10_000 - 2_500 - 1_000 - 25_000 / 11 - 3_182);
  });

  it("fails closed for a manual-only date even when the vendor-fee snapshot is complete", () => {
    const reported = emptyReportedSalesFacts("product-1", DATE, "상품");
    const manual = manualFacts({ quantity: 2, salesAmountKrw: 50_000, totalCostKrw: 20_000 });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);
    const normal = calculateNormalCoupangProfit({
      reported,
      actual,
      cost: null,
      ads: adInput(3_000),
      salesFeeRate: null
    });
    const combined = combineCoupangProfitParts({ normal, manual: calculateManualPurchaseProfitAdjustment(manual) });

    expect(actual).toMatchObject({ salesKrw: 0, netSalesKrw: 0, salesQuantity: 0, isManualOnly: true, isValid: false });
    expect(actual.warnings).toContain("MANUAL_PURCHASE_WITHOUT_REPORTED_SALES");
    expect(normal).toMatchObject({ status: "INCOMPLETE", calculated: null });
    expect(combined).toMatchObject({
      calculationStatus: "INCOMPLETE",
      totalCostKrw: null,
      marginKrw: null
    });
  });

  it("fails closed for an ads-only product-date when no global sales fee rule applies", () => {
    const reported = emptyReportedSalesFacts("product-1", DATE, "상품");
    const normal = calculateNormalCoupangProfit({
      reported,
      actual: adjustReportedSalesForManualPurchase(reported, null),
      cost: null,
      ads: adInput(3_000),
      salesFeeRate: null
    });

    expect(normal).toEqual({
      status: "INCOMPLETE",
      calculated: null,
      warnings: ["COUPANG_GLOBAL_SALES_FEE_RATE_MISSING"]
    });
  });

  it.each([
    [5, 2, 20_000, 10_000, -3, -10_000, "MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED"],
    [1, 2, 30_000, 20_000, 1, -10_000, "MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED"]
  ] as const)("rejects invalid adjustment without producing negative segments", (
    manualQuantity,
    reportedQuantity,
    manualSales,
    reportedSales,
    expectedQuantity,
    expectedSales,
    warning
  ) => {
    const reported = reportedFacts({ salesKrw: reportedSales, netSalesKrw: reportedSales, salesQuantity: reportedQuantity });
    const manual = manualFacts({ quantity: manualQuantity, salesAmountKrw: manualSales, totalCostKrw: 1_000 });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);

    expect(actual.isValid).toBe(false);
    expect(actual.warnings).toContain(warning);
    expect(actual.salesQuantity).toBe(expectedQuantity);
    expect(actual.salesKrw).toBe(expectedSales);
    expect(actual.segments.every((segment) => segment.salesQuantity >= 0)).toBe(true);
  });

  it.each([0.01, 0.02, 0.03, 0.04])(
    "fails closed for a stored total that differs from the vendor fee by %s KRW",
    (difference) => {
      const manual = aggregateManualPurchasesByProductDate([manualInput({
        vendorFeeKrw: 10,
        totalCostKrw: 10 + difference
      })]).get(productDateKey("p", DATE))!;
      const adjustment = calculateManualPurchaseProfitAdjustment(manual);

      expect(manual.totalCostKrw).toBe(10);
      expect(manual.isCostSnapshotComplete).toBe(false);
      expect(manual.warnings).toContain("MANUAL_PURCHASE_TOTAL_COST_MISMATCH");
      expect(adjustment).toMatchObject({
        status: "INCOMPLETE",
        totalCostKrw: 10,
        marginAdjustmentKrw: null
      });
    }
  );

  it("does not subtract cancellation twice from adjusted net sales", () => {
    const reported = reportedFacts({ salesKrw: 100_000, netSalesKrw: 90_000, cancelAmountKrw: 10_000, salesQuantity: 4 });
    const actual = adjustReportedSalesForManualPurchase(
      reported,
      manualFacts({ quantity: 1, salesAmountKrw: 25_000, totalCostKrw: 10_000 })
    );
    expect(actual.netSalesKrw).toBe(65_000);
  });

  it("uses only the legacy base-price snapshot and leaves promotion-only data incomplete", () => {
    expect(resolveManualPurchaseSalesAmount({ quantity: 0, salesAmountKrw: null, salePriceKrw: null, promotionPriceKrw: null, baseSalePriceKrw: null }))
      .toEqual({ salesAmountKrw: 0, source: "STORED", warnings: [] });
    expect(resolveManualPurchaseSalesAmount({ quantity: 2, salesAmountKrw: null, salePriceKrw: 11_000, promotionPriceKrw: 10_000, baseSalePriceKrw: 12_000 }))
      .toMatchObject({ salesAmountKrw: 24_000, source: "BASE_PRICE" });
    expect(resolveManualPurchaseSalesAmount({ quantity: 2, salesAmountKrw: null, salePriceKrw: 11_000, promotionPriceKrw: 10_000, baseSalePriceKrw: null }))
      .toMatchObject({ salesAmountKrw: null, source: "MISSING", warnings: ["MANUAL_PURCHASE_SALES_AMOUNT_MISSING"] });
    expect(resolveManualPurchaseSalesAmount({ quantity: 2, salesAmountKrw: null, salePriceKrw: null, promotionPriceKrw: null, baseSalePriceKrw: null }))
      .toMatchObject({ salesAmountKrw: null, source: "MISSING", warnings: ["MANUAL_PURCHASE_SALES_AMOUNT_MISSING"] });
  });

  it("treats a zero-quantity memo snapshot as a valid zero financial fact", () => {
    const manual = manualFacts({
      quantity: 0,
      salesAmountKrw: 0,
      vendorFeeKrw: 0,
      totalCostKrw: 0
    });

    expect(manual).toMatchObject({
      quantity: 0,
      salesAmountKrw: 0,
      vendorFeeKrw: 0,
      totalCostKrw: 0,
      warnings: [],
      isCostSnapshotComplete: true
    });
  });

  it("aggregates facts by product and date instead of combining a whole range", () => {
    const reported = aggregateReportedSalesByProductDate([
      { productId: "p", productName: "P", date: "2026-07-14", salesKrw: 10, cancelAmountKrw: 0, netSalesKrw: 10, salesQuantity: 1, orderCount: 1 },
      { productId: "p", productName: "P", date: "2026-07-15", salesKrw: 20, cancelAmountKrw: 0, netSalesKrw: 20, salesQuantity: 1, orderCount: 1 }
    ]);
    const manual = aggregateManualPurchasesByProductDate([
      manualInput({ date: "2026-07-15", salesAmountKrw: 20 })
    ]);

    expect(reported.get(productDateKey("p", "2026-07-14"))?.netSalesKrw).toBe(10);
    expect(reported.get(productDateKey("p", "2026-07-15"))?.netSalesKrw).toBe(20);
    expect(manual.get(productDateKey("p", "2026-07-15"))?.salesAmountKrw).toBe(20);
  });

  it("preserves seller and growth segments and keeps their totals synchronized", () => {
    const reported = mixedReportedFacts();

    expect(reported.segments).toEqual([
      expect.objectContaining({
        fulfillmentMethod: "SELLER",
        sourceSaleMethods: ["판매자배송"],
        netSalesKrw: 60_000,
        salesQuantity: 3,
        lineCount: 1
      }),
      expect.objectContaining({
        fulfillmentMethod: "GROWTH",
        sourceSaleMethods: ["로켓그로스"],
        netSalesKrw: 40_000,
        salesQuantity: 2,
        lineCount: 1
      })
    ]);
    expect(reported).toMatchObject({
      salesKrw: 100_000,
      netSalesKrw: 100_000,
      salesQuantity: 5,
      orderCount: 5,
      lineCount: 2
    });
  });

  it("calculates mixed normal sales without a sale-method conflict and subtracts ads once", () => {
    const reported = mixedReportedFacts();
    const normal = calculateNormalCoupangProfit({
      reported,
      actual: adjustReportedSalesForManualPurchase(reported, null),
      cost: {
        ...costInput(),
        productCostKrw: 1_000,
        sellerShippingFeeKrw: 2_500,
        hanaroShippingFeeKrw: 300,
        growthInboundFeeKrw: 700,
        growthShippingFeeKrw: 1_300
      },
      ads: adInput(10_000, 30_000),
      salesFeeRate: 0.1
    });

    expect(normal.status).toBe("COMPLETE");
    expect(normal.warnings).not.toContain("NORMAL_SALE_METHOD_CONFLICT");
    expect(normal.calculated).toMatchObject({
      sellerSalesQuantity: 3,
      growthSalesQuantity: 2,
      sellerShippingCostKrw: 7_500,
      hanaroShippingCostKrw: 600,
      growthInboundCostKrw: 1_400,
      growthShippingCostKrw: 2_600,
      totalLogisticsCostKrw: 12_100,
      shippingCostKrw: 12_100,
      adSpendKrw: 10_000
    });
    expect(normal.calculated?.totalCostKrw).toBeCloseTo(37_100 + 100_000 / 11);
  });

  it("marks only active fulfillment segments incomplete when their required shipping fee is unset", () => {
    const reported = mixedReportedFacts();
    const missing = calculateNormalCoupangProfit({
      reported,
      actual: adjustReportedSalesForManualPurchase(reported, null),
      cost: {
        ...costInput(),
        sellerShippingFeeKrw: null,
        hanaroShippingFeeKrw: null
      },
      ads: adInput(),
      salesFeeRate: 0.1
    });

    expect(missing).toEqual({
      status: "INCOMPLETE",
      calculated: null,
      warnings: ["SELLER_SHIPPING_FEE_MISSING", "HANARO_SHIPPING_FEE_MISSING"]
    });

    const sellerOnly = aggregateReportedSalesByProductDate([{
      productId: "seller-only",
      productName: "판매자 전용",
      date: DATE,
      salesKrw: 10_000,
      cancelAmountKrw: 0,
      netSalesKrw: 10_000,
      salesQuantity: 1,
      orderCount: 1,
      saleMethod: "판매자배송"
    }]).get(productDateKey("seller-only", DATE))!;
    const explicitZero = calculateNormalCoupangProfit({
      reported: sellerOnly,
      actual: adjustReportedSalesForManualPurchase(sellerOnly, null),
      cost: {
        ...costInput(),
        sellerShippingFeeKrw: 0,
        hanaroShippingFeeKrw: null
      },
      ads: adInput(),
      salesFeeRate: 0.1
    });

    expect(explicitZero.status).toBe("COMPLETE");
    expect(explicitZero.warnings).not.toContain("HANARO_SHIPPING_FEE_MISSING");
  });

  it("validates logistics against reported fulfillment even when recognition removes that segment", () => {
    const reported = mixedReportedFacts();
    const manual = manualFacts({
      quantity: 3,
      salesAmountKrw: 60_000,
      totalCostKrw: 3_182
    });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);
    const normal = calculateNormalCoupangProfit({
      reported,
      actual,
      cost: {
        ...costInput(),
        sellerShippingFeeKrw: null,
        hanaroShippingFeeKrw: 300
      },
      ads: adInput(),
      salesFeeRate: 0.1
    });

    expect(actual.segments).toEqual([
      expect.objectContaining({
        fulfillmentMethod: "SELLER",
        netSalesKrw: 0,
        salesQuantity: 0
      }),
      expect.objectContaining({
        fulfillmentMethod: "GROWTH",
        netSalesKrw: 40_000,
        salesQuantity: 2
      })
    ]);
    expect(normal).toEqual({
      status: "INCOMPLETE",
      calculated: null,
      warnings: ["SELLER_SHIPPING_FEE_MISSING"]
    });
  });

  it("calculates segment costs when offsetting mixed sales have zero aggregate activity", () => {
    const reported = aggregateReportedSalesByProductDate([
      {
        productId: "offset-product",
        productName: "상쇄 혼합 상품",
        date: DATE,
        salesKrw: 12_800,
        cancelAmountKrw: 0,
        netSalesKrw: 12_800,
        salesQuantity: 1,
        orderCount: 1,
        saleMethod: "판매자배송"
      },
      {
        productId: "offset-product",
        productName: "상쇄 혼합 상품",
        date: DATE,
        salesKrw: -12_800,
        cancelAmountKrw: 0,
        netSalesKrw: -12_800,
        salesQuantity: -1,
        orderCount: 1,
        saleMethod: "로켓그로스"
      }
    ]).get(productDateKey("offset-product", DATE))!;
    const normal = calculateNormalCoupangProfit({
      reported,
      actual: adjustReportedSalesForManualPurchase(reported, null),
      cost: {
        productCostKrw: 0,
        sellerShippingFeeKrw: 250,
        hanaroShippingFeeKrw: 300,
        growthInboundFeeKrw: 1_000,
        growthShippingFeeKrw: 1_800,
        returnRate: 0,
        extraCostKrw: 0
      },
      ads: adInput(),
      salesFeeRate: 0
    });

    expect(reported).toMatchObject({ netSalesKrw: 0, salesQuantity: 0 });
    expect(normal.status).toBe("COMPLETE");
    expect(normal.calculated).toMatchObject({
      sellerShippingCostKrw: 250,
      hanaroShippingCostKrw: -300,
      growthInboundCostKrw: -1_000,
      growthShippingCostKrw: -1_800,
      shippingCostKrw: -2_850,
      totalCostKrw: -2_850,
      marginKrw: 2_850
    });
  });

  it("deducts mixed-sale manual purchases from seller fulfillment first", () => {
    const reported = mixedReportedFacts();
    const manual = {
      ...manualFacts({ quantity: 1, salesAmountKrw: 20_000, totalCostKrw: 10_000 }),
      saleMethods: ["로켓그로스"]
    };
    const actual = adjustReportedSalesForManualPurchase(reported, manual);

    expect(actual.isValid).toBe(true);
    expect(actual).toMatchObject({ salesKrw: 80_000, netSalesKrw: 80_000, salesQuantity: 4 });
    expect(actual.segments).toEqual([
      expect.objectContaining({ fulfillmentMethod: "SELLER", netSalesKrw: 40_000, salesQuantity: 2 }),
      expect.objectContaining({ fulfillmentMethod: "GROWTH", netSalesKrw: 40_000, salesQuantity: 2 })
    ]);
  });

  it("deducts mixed recognition from seller first but preserves both reported fulfillment costs", () => {
    const reported = mixedReportedFacts();
    const manual = manualFacts({
      quantity: 1,
      salesAmountKrw: 20_000,
      vendorFeeKrw: 3_182,
      totalCostKrw: 3_182
    });
    const normal = calculateNormalCoupangProfit({
      reported,
      actual: adjustReportedSalesForManualPurchase(reported, manual),
      cost: {
        ...costInput(),
        productCostKrw: 1_000,
        sellerShippingFeeKrw: 2_500,
        hanaroShippingFeeKrw: 300,
        growthInboundFeeKrw: 700,
        growthShippingFeeKrw: 1_300
      },
      ads: adInput(10_000, 30_000),
      salesFeeRate: 0.1
    });
    const combined = combineCoupangProfitParts({
      normal,
      manual: calculateManualPurchaseProfitAdjustment(manual)
    });

    expect(normal.calculated).toMatchObject({
      netSalesKrw: 80_000,
      productCostKrw: 5_000,
      salesFeeKrw: 10_000,
      sellerSalesQuantity: 3,
      growthSalesQuantity: 2,
      sellerShippingCostKrw: 7_500,
      hanaroShippingCostKrw: 600,
      growthInboundCostKrw: 1_400,
      growthShippingCostKrw: 2_600,
      shippingCostKrw: 12_100,
      adSpendKrw: 10_000
    });
    expect(normal.calculated?.vatKrw).toBeCloseTo(100_000 / 11);
    expect(combined.marginKrw).toBeCloseTo(
      80_000 - 5_000 - 10_000 - 12_100 - 100_000 / 11 - 10_000 - 3_182
    );
  });

  it.each([
    [[]],
    [["판매자배송", "로켓그로스"]],
    [["알수없음"]]
  ])("does not require a manual sale method for mixed reported sales", (saleMethods) => {
    const reported = mixedReportedFacts();
    const manual = {
      ...manualFacts({ quantity: 1, salesAmountKrw: 20_000, totalCostKrw: 10_000 }),
      saleMethods
    };
    const actual = adjustReportedSalesForManualPurchase(reported, manual);

    expect(actual.isValid).toBe(true);
    expect(actual.warnings).not.toContain("MANUAL_PURCHASE_SALE_METHOD_REQUIRED_FOR_MIXED_SALES");
    expect(actual).toMatchObject({ salesKrw: 80_000, netSalesKrw: 80_000, salesQuantity: 4 });
  });

  it("continues the deduction in growth after exhausting seller fulfillment", () => {
    const reported = mixedReportedFacts();
    const manual = manualFacts({ quantity: 4, salesAmountKrw: 80_000, totalCostKrw: 10_000 });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);

    expect(actual.isValid).toBe(true);
    expect(actual.segments).toEqual([
      expect.objectContaining({ fulfillmentMethod: "SELLER", netSalesKrw: 0, salesQuantity: 0 }),
      expect.objectContaining({ fulfillmentMethod: "GROWTH", netSalesKrw: 20_000, salesQuantity: 1 })
    ]);
    expect(actual).toMatchObject({ salesKrw: 20_000, netSalesKrw: 20_000, salesQuantity: 1 });
  });

  it("redistributes a seller sales shortfall to growth while deducting the exact manual sales amount", () => {
    const reported = aggregateReportedSalesByProductDate([
      {
        productId: "product-1",
        productName: "불균등 단가 상품",
        date: DATE,
        salesKrw: 10_000,
        cancelAmountKrw: 0,
        netSalesKrw: 10_000,
        salesQuantity: 2,
        orderCount: 2,
        saleMethod: "판매자배송"
      },
      {
        productId: "product-1",
        productName: "불균등 단가 상품",
        date: DATE,
        salesKrw: 100_000,
        cancelAmountKrw: 0,
        netSalesKrw: 100_000,
        salesQuantity: 10,
        orderCount: 10,
        saleMethod: "로켓그로스"
      }
    ]).get(productDateKey("product-1", DATE))!;
    const actual = adjustReportedSalesForManualPurchase(
      reported,
      manualFacts({ quantity: 5, salesAmountKrw: 50_000, totalCostKrw: 10_000 })
    );

    expect(actual).toMatchObject({ salesKrw: 60_000, netSalesKrw: 60_000, salesQuantity: 7, isValid: true });
    expect(actual.segments).toEqual([
      expect.objectContaining({ fulfillmentMethod: "SELLER", salesKrw: 0, netSalesKrw: 0, salesQuantity: 0 }),
      expect.objectContaining({ fulfillmentMethod: "GROWTH", salesKrw: 60_000, netSalesKrw: 60_000, salesQuantity: 7 })
    ]);
  });

  it("keeps seller and growth segments non-negative when manual quantity exceeds all reported quantity", () => {
    const reported = mixedReportedFacts();
    const manual = manualFacts({ quantity: 8, salesAmountKrw: 160_000, totalCostKrw: 10_000 });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);

    expect(actual).toMatchObject({ salesKrw: -60_000, netSalesKrw: -60_000, salesQuantity: -3, isValid: false });
    expect(actual.warnings).toContain("MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED");
    expect(actual.segments).toEqual([
      expect.objectContaining({ fulfillmentMethod: "SELLER", salesQuantity: 0 }),
      expect.objectContaining({ fulfillmentMethod: "GROWTH", salesKrw: -60_000, netSalesKrw: -60_000, salesQuantity: 0 })
    ]);
  });
});

function mixedReportedFacts(sellerSaleMethod = "판매자배송") {
  return aggregateReportedSalesByProductDate([
    {
      productId: "product-1",
      productName: "혼합 상품",
      date: DATE,
      salesKrw: 60_000,
      cancelAmountKrw: 0,
      netSalesKrw: 60_000,
      salesQuantity: 3,
      orderCount: 3,
      saleMethod: sellerSaleMethod
    },
    {
      productId: "product-1",
      productName: "혼합 상품",
      date: DATE,
      salesKrw: 40_000,
      cancelAmountKrw: 0,
      netSalesKrw: 40_000,
      salesQuantity: 2,
      orderCount: 2,
      saleMethod: "로켓그로스"
    }
  ]).get(productDateKey("product-1", DATE))!;
}

function reportedFacts(overrides: Partial<ReturnType<typeof emptyReportedSalesFacts>>) {
  return {
    ...emptyReportedSalesFacts("product-1", DATE, "상품"),
    hasReportedRows: true,
    lineCount: 1,
    saleMethods: ["판매자배송"],
    ...overrides
  };
}

function manualFacts(overrides: Partial<NonNullable<ReturnType<typeof aggregateManualPurchasesByProductDate> extends Map<string, infer T> ? T : never>>) {
  const input = manualInput(overrides);
  return aggregateManualPurchasesByProductDate([input]).get(productDateKey("p", input.date))!;
}

function manualInput(overrides: Partial<Parameters<typeof aggregateManualPurchasesByProductDate>[0][number]> = {}) {
  const totalCostKrw = overrides.totalCostKrw ?? 10_000;
  return {
    productId: "p",
    date: DATE,
    quantity: 1,
    salesAmountKrw: 25_000,
    productCostKrw: 0,
    vendorFeeKrw: totalCostKrw,
    coupangSalesFeeKrw: 0,
    shippingCostKrw: 0,
    otherCostKrw: 0,
    totalCostKrw,
    saleMethod: "판매자배송",
    ...overrides
  };
}

function costInput() {
  return {
    productCostKrw: 10_000,
    sellerShippingFeeKrw: 1_000,
    returnRate: 0,
    returnCostPerUnitKrw: 0,
    extraCostKrw: 0
  };
}

function adInput(
  adSpendKrw = 0,
  adGeneratedSalesKrw = 0,
  attributedConversionSalesKrw = adGeneratedSalesKrw
) {
  return {
    adSpendKrw,
    adGeneratedSalesKrw,
    attributedConversionSalesKrw
  };
}
