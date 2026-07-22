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
      ads: { adSpendKrw: 5_000, adConversionSalesKrw: 30_000 },
      feeMode: "RATE"
    });
    const combined = combineCoupangProfitParts({ normal, manual: calculateManualPurchaseProfitAdjustment(null) });

    expect(actual).toMatchObject({ salesKrw: 100_000, netSalesKrw: 90_000, salesQuantity: 4, isValid: true });
    expect(combined.marginKrw).toBe(normal.calculated?.marginKrw);
    expect(normal.calculated?.adSpendKrw).toBe(5_000);
  });

  it("separates manual-purchase sales and quantity before normal costs, then charges snapshots once", () => {
    const reported = reportedFacts({ salesKrw: 100_000, netSalesKrw: 90_000, salesQuantity: 4 });
    const manual = manualFacts({ quantity: 1, salesAmountKrw: 25_000, totalCostKrw: 15_000 });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);
    const normal = calculateNormalCoupangProfit({
      reported,
      actual,
      cost: costInput(),
      ads: { adSpendKrw: 5_000, adConversionSalesKrw: 30_000 },
      feeMode: "RATE"
    });
    const combined = combineCoupangProfitParts({ normal, manual: calculateManualPurchaseProfitAdjustment(manual) });

    expect(actual).toMatchObject({ salesKrw: 75_000, netSalesKrw: 65_000, salesQuantity: 3 });
    expect(normal.calculated?.productCostKrw).toBe(30_000);
    expect(normal.calculated?.salesFeeKrw).toBe(6_500);
    expect(combined.marginKrw).toBeCloseTo(
      65_000 - 30_000 - 6_500 - 3_000 - 65_000 / 11 - 5_000 - 15_000
    );
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
      ads: { adSpendKrw: 0, adConversionSalesKrw: 0 },
      feeMode: "RATE"
    });
    const manualPart = calculateManualPurchaseProfitAdjustment(manual);
    const combined = combineCoupangProfitParts({ normal, manual: manualPart });

    expect(actual).toMatchObject({ salesKrw: 75_000, netSalesKrw: 75_000, salesQuantity: 3, isValid: true });
    expect(actual.warnings).toContain("MANUAL_PURCHASE_COST_SNAPSHOT_INCOMPLETE");
    expect(normal.status).toBe("COMPLETE");
    expect(normal.calculated?.productCostKrw).toBe(30_000);
    expect(manualPart.status).toBe("INCOMPLETE");
    expect(combined).toMatchObject({ calculationStatus: "INCOMPLETE", totalCostKrw: null, marginKrw: null });
  });

  it("keeps normal activity not applicable for a manual-only row with an incomplete cost snapshot", () => {
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
      ads: { adSpendKrw: 3_000, adConversionSalesKrw: 0 }
    });
    const manualPart = calculateManualPurchaseProfitAdjustment(manual);

    expect(actual).toMatchObject({ netSalesKrw: 0, salesQuantity: 0, isValid: true, isManualOnly: true });
    expect(normal.status).toBe("NOT_APPLICABLE");
    expect(normal.calculated?.marginKrw).toBe(-3_000);
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
      ads: { adSpendKrw: 7_000, adConversionSalesKrw: 0 }
    });
    const combined = combineCoupangProfitParts({ normal, manual: calculateManualPurchaseProfitAdjustment(manual) });

    expect(normal.calculated?.totalCostKrw).toBeCloseTo(10_000 + 1_000 + 1_000 + 25_000 / 11 + 7_000);
    expect(combined.totalCostKrw).toBeCloseTo(10_000 + 1_000 + 1_000 + 25_000 / 11 + 7_000 + 10_000);
  });

  it("calculates a manual-only date from stored cost snapshots and emits an informational warning", () => {
    const reported = emptyReportedSalesFacts("product-1", DATE, "상품");
    const manual = manualFacts({ quantity: 2, salesAmountKrw: 50_000, totalCostKrw: 20_000 });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);
    const normal = calculateNormalCoupangProfit({
      reported,
      actual,
      cost: null,
      ads: { adSpendKrw: 3_000, adConversionSalesKrw: 0 }
    });
    const combined = combineCoupangProfitParts({ normal, manual: calculateManualPurchaseProfitAdjustment(manual) });

    expect(actual).toMatchObject({ salesKrw: 0, netSalesKrw: 0, salesQuantity: 0, isManualOnly: true, isValid: true });
    expect(actual.warnings).toContain("MANUAL_PURCHASE_WITHOUT_REPORTED_SALES");
    expect(normal.status).toBe("NOT_APPLICABLE");
    expect(combined.marginKrw).toBe(-23_000);
  });

  it.each([
    [5, 2, 20_000, 10_000, "MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED"],
    [1, 2, 30_000, 20_000, "MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED"]
  ] as const)("rejects invalid adjustment without clamping", (manualQuantity, reportedQuantity, manualSales, reportedSales, warning) => {
    const reported = reportedFacts({ salesKrw: reportedSales, netSalesKrw: reportedSales, salesQuantity: reportedQuantity });
    const manual = manualFacts({ quantity: manualQuantity, salesAmountKrw: manualSales, totalCostKrw: 1_000 });
    const actual = adjustReportedSalesForManualPurchase(reported, manual);

    expect(actual.isValid).toBe(false);
    expect(actual.warnings).toContain(warning);
    expect(actual.salesQuantity).toBe(reportedQuantity - manualQuantity);
    expect(actual.salesKrw).toBe(reportedSales - manualSales);
  });

  it("does not subtract cancellation twice from adjusted net sales", () => {
    const reported = reportedFacts({ salesKrw: 100_000, netSalesKrw: 90_000, cancelAmountKrw: 10_000, salesQuantity: 4 });
    const actual = adjustReportedSalesForManualPurchase(
      reported,
      manualFacts({ quantity: 1, salesAmountKrw: 25_000, totalCostKrw: 10_000 })
    );
    expect(actual.netSalesKrw).toBe(65_000);
  });

  it("uses legacy price snapshots in the required order and leaves missing data incomplete", () => {
    expect(resolveManualPurchaseSalesAmount({ quantity: 2, salesAmountKrw: null, salePriceKrw: 11_000, promotionPriceKrw: 10_000, baseSalePriceKrw: 12_000 }))
      .toMatchObject({ salesAmountKrw: 22_000, source: "SALE_PRICE" });
    expect(resolveManualPurchaseSalesAmount({ quantity: 2, salesAmountKrw: null, salePriceKrw: null, promotionPriceKrw: 10_000, baseSalePriceKrw: 12_000 }))
      .toMatchObject({ salesAmountKrw: 20_000, source: "PROMOTION_PRICE" });
    expect(resolveManualPurchaseSalesAmount({ quantity: 2, salesAmountKrw: null, salePriceKrw: null, promotionPriceKrw: null, baseSalePriceKrw: 12_000 }))
      .toMatchObject({ salesAmountKrw: 24_000, source: "BASE_PRICE" });
    expect(resolveManualPurchaseSalesAmount({ quantity: 2, salesAmountKrw: null, salePriceKrw: null, promotionPriceKrw: null, baseSalePriceKrw: null }))
      .toMatchObject({ salesAmountKrw: null, source: "MISSING", warnings: ["MANUAL_PURCHASE_SALES_AMOUNT_MISSING"] });
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
});

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
    productCostKrw: totalCostKrw,
    vendorFeeKrw: 0,
    coupangSalesFeeKrw: 0,
    shippingCostKrw: 0,
    vatKrw: 0,
    otherCostKrw: 0,
    totalCostKrw,
    saleMethod: "판매자배송",
    ...overrides
  };
}

function costInput() {
  return {
    productCostKrw: 10_000,
    salesFeeRate: 0.1,
    salesFeeKrw: 1_000,
    sellerShippingFeeKrw: 1_000,
    returnRate: 0,
    returnCostPerUnitKrw: 0,
    extraCostKrw: 0
  };
}
