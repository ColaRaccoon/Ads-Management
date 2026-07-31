import { describe, expect, it } from "vitest";
import { Prisma, RowValidationStatus, UploadStatus } from "@prisma/client";
import { SalesMetricsService } from "./sales-metrics.service";
import { toDateOnly } from "../domain/date-number";

describe("SalesMetricsService", () => {
  it("combines Cafe24 quantities with current Meta ad spend by productId", async () => {
    const prisma = fakePrisma();
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });

    expect(prisma.cafe24OrderLine.findManyCalls[0].where.isCurrent).toBe(true);
    expect(prisma.cafe24OrderLine.findManyCalls[0].where.batch).toBeUndefined();
    expect(prisma.cafe24OrderLine.findManyCalls[0].where.uploadBatchId).toEqual({ in: ["batch-1"] });
    expect(prisma.metaAdsetDailyMetric.findManyCalls[0].where.deliveryStatus).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      productId: "product-wavebar",
      quantity: 3,
      revenueKrw: 150000,
      totalPaidKrw: 100000,
      adSpendUsd: 10,
      adSpendKrw: 13000,
      grossCostKrw: 63000,
      totalCostKrw: 76000,
      marginKrw: 74000,
      matchedSalesLineCount: 2,
      ruleStatus: "OK"
    });
    expect(result.summary.salesUnmatchedCount).toBe(0);
    expect(result.summary.adUnmatchedMetricCount).toBe(1);
    expect(result.summary.adUnmatchedSpendUsd).toBe(5);
    expect(result.summary.adUnmatchedSpendKrw).toBe(6500);
  });

  it("optionally filters Meta ad spend by deliveryStatus for daily report reuse", async () => {
    const prisma = fakePrisma();
    const service = new SalesMetricsService(prisma as never);

    await service.productPerformance({ from: "2026-06-11", to: "2026-06-11", deliveryStatus: "active" });

    expect(prisma.metaAdsetDailyMetric.findManyCalls[0].where.deliveryStatus).toEqual({
      equals: "active",
      mode: "insensitive"
    });

    await service.productPerformance({ from: "2026-06-11", to: "2026-06-11", deliveryStatus: "all" });

    expect(prisma.metaAdsetDailyMetric.findManyCalls[1].where.deliveryStatus).toBeUndefined();
  });

  it("does not aggregate sales or ad spend under inactive products", async () => {
    const inactiveProduct = { ...product(), id: "product-air-stepper-deleted", code: "air-stepper__deleted__", isActive: false };
    const prisma = fakePrisma({
      salesLines: [cafe24Line({ productId: inactiveProduct.id, product: inactiveProduct, quantity: new Prisma.Decimal(6) })],
      adMetrics: [adMetric({ productId: inactiveProduct.id, product: inactiveProduct, spendUsd: new Prisma.Decimal(7) })],
      costRules: []
    });
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });

    expect(result.rows).toHaveLength(0);
    expect(result.summary.salesUnmatchedCount).toBe(1);
    expect(result.summary.adUnmatchedMetricCount).toBe(1);
    expect(result.summary.adUnmatchedSpendUsd).toBe(7);
    expect(result.summary.adUnmatchedSpendKrw).toBe(9100);
  });

  it("counts 1+1 Cafe24 orders as two sold units while using bundle override revenue and costs", async () => {
    const prisma = fakePrisma({
      salesLines: [
        cafe24Line({
          quantity: new Prisma.Decimal(1),
          salePriceKrw: new Prisma.Decimal(38900),
          totalPaidKrw: new Prisma.Decimal(67800),
          matchRule: {
            id: "rule-wavebar-plus",
            displayName: "Wavebar 1+1",
            productNameAliases: ["wavebar"],
            optionIncludeKeywords: ["+"],
            salePriceKrwOverride: new Prisma.Decimal(67800),
            productCostKrwOverride: new Prisma.Decimal(12000),
            shippingKrwOverride: new Prisma.Decimal(2800),
            extraCostKrwOverride: new Prisma.Decimal(0)
          }
        })
      ],
      adMetrics: []
    });
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      productId: "product-wavebar",
      quantity: 2,
      revenueKrw: 67800,
      grossCostKrw: 21580,
      totalCostKrw: 21580,
      marginKrw: 46220,
      priceMismatchCount: 0
    });
  });

  it("deducts one exact product coupon after calculating the existing margin", async () => {
    const prisma = fakePrisma({
      salesLines: [
        cafe24Line({
          totalOrderKrw: new Prisma.Decimal(50000),
          totalPaidKrw: new Prisma.Decimal(45000),
          paymentMethod: "쿠폰,신용카드"
        })
      ],
      adMetrics: [],
      couponRules: [couponRule()]
    });
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });

    expect(result.rows[0]).toMatchObject({
      revenueKrw: 50000,
      grossCostKrw: 21000,
      marginBeforeCouponKrw: 29000,
      couponDeductionKrw: 5000,
      totalCostKrw: 26000,
      marginKrw: 24000,
      couponOrderCount: 1,
      couponExactOrderCount: 1,
      couponEstimatedOrderCount: 0,
      couponUnmatchedOrderCount: 0,
      couponIgnoredResidualKrw: 0,
      couponStatus: "EXACT",
      roas: null,
      cpaKrw: 0
    });
    expect(result.summary).toMatchObject({
      couponDetectedOrderCount: 1,
      couponAppliedOrderCount: 1,
      couponExactOrderCount: 1,
      couponEstimatedOrderCount: 0,
      couponUnmatchedOrderCount: 0,
      couponDeductionKrw: 5000,
      couponIgnoredResidualKrw: 0,
      couponMissingTotalOrderCount: 0
    });
  });

  it("deducts only the selected coupon and exposes an ignored residual for estimated matches", async () => {
    const prisma = fakePrisma({
      salesLines: [
        cafe24Line({
          totalOrderKrw: new Prisma.Decimal(50500),
          totalPaidKrw: new Prisma.Decimal(45000),
          paymentMethod: "적립금,쿠폰,신용카드"
        })
      ],
      adMetrics: [],
      couponRules: [couponRule()]
    });
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });

    expect(result.rows[0]).toMatchObject({
      couponDeductionKrw: 5000,
      couponEstimatedOrderCount: 1,
      couponIgnoredResidualKrw: 500,
      totalCostKrw: 26000,
      marginKrw: 24000,
      couponStatus: "ESTIMATED"
    });
    expect(result.summary).toMatchObject({
      couponEstimatedOrderCount: 1,
      couponDeductionKrw: 5000,
      couponIgnoredResidualKrw: 500
    });
  });

  it("applies a coupon only once when the same order has multiple lines", async () => {
    const shared = {
      orderNo: "20260611-000010",
      totalOrderKrw: new Prisma.Decimal(100000),
      totalPaidKrw: new Prisma.Decimal(95000),
      paymentMethod: "쿠폰,신용카드"
    };
    const prisma = fakePrisma({
      salesLines: [
        cafe24Line(shared),
        cafe24Line({ ...shared, id: "line-2", rowNumber: 3, lineOrderNo: "20260611-000010-02" })
      ],
      adMetrics: [],
      couponRules: [couponRule()]
    });
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });

    expect(result.rows[0]).toMatchObject({
      quantity: 2,
      revenueKrw: 100000,
      couponDeductionKrw: 5000,
      couponOrderCount: 1,
      couponExactOrderCount: 1,
      totalCostKrw: 47000,
      marginKrw: 53000
    });
    expect(result.summary.couponAppliedOrderCount).toBe(1);
    expect(result.summary.couponDeductionKrw).toBe(5000);
  });

  it("allocates one global coupon across every matched product without changing the total deduction", async () => {
    const secondProduct = product({
      id: "product-air-stepper",
      code: "air-stepper",
      name: "air-stepper",
      displayName: "에어스텝퍼"
    });
    const shared = {
      orderNo: "20260611-000020",
      totalOrderKrw: new Prisma.Decimal(100000),
      totalPaidKrw: new Prisma.Decimal(99000),
      paymentMethod: "쿠폰,신용카드"
    };
    const prisma = fakePrisma({
      salesLines: [
        cafe24Line(shared),
        cafe24Line({
          ...shared,
          id: "line-2",
          rowNumber: 3,
          lineOrderNo: "20260611-000020-02",
          productId: secondProduct.id,
          product: secondProduct
        })
      ],
      adMetrics: [],
      costRules: [costRule(), costRule({ id: "cost-rule-air", productId: secondProduct.id })],
      couponRules: [couponRule({ id: "coupon-global", scope: "GLOBAL", productId: null, discountKrw: new Prisma.Decimal(1000) })]
    });
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.couponDeductionKrw)).toEqual([500, 500]);
    expect(result.rows.every((row) => row.couponExactOrderCount === 1)).toBe(true);
    expect(result.summary.couponDeductionKrw).toBe(1000);
    expect(result.rows.reduce((sum, row) => sum + row.couponDeductionKrw, 0)).toBe(1000);
  });

  it("uses the same nonnegative largest-remainder allocator for coupon and residual totals", async () => {
    const products = [
      product({ id: "product-a", code: "a", name: "a", displayName: "A" }),
      product({ id: "product-b", code: "b", name: "b", displayName: "B" }),
      product({ id: "product-c", code: "c", name: "c", displayName: "C" })
    ];
    const shared = {
      orderNo: "20260611-000021",
      totalOrderKrw: new Prisma.Decimal(10000),
      totalPaidKrw: new Prisma.Decimal(7998),
      paymentMethod: "쿠폰,신용카드"
    };
    const salesLines = products.map((currentProduct, index) =>
      cafe24Line({
        ...shared,
        id: `line-${index + 1}`,
        rowNumber: index + 2,
        lineOrderNo: `20260611-000021-0${index + 1}`,
        salePriceKrw: new Prisma.Decimal(index === 2 ? 0 : 5000),
        productId: currentProduct.id,
        product: currentProduct
      })
    );
    const prisma = fakePrisma({
      salesLines,
      adMetrics: [],
      costRules: products.map((currentProduct, index) =>
        costRule({ id: `cost-${index}`, productId: currentProduct.id })
      ),
      couponRules: [
        couponRule({
          id: "coupon-global-1001",
          scope: "GLOBAL",
          productId: null,
          discountKrw: new Prisma.Decimal(1001)
        })
      ]
    });
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });
    const byProductId = new Map(result.rows.map((row) => [row.productId, row]));

    expect(products.map((currentProduct) => byProductId.get(currentProduct.id)?.couponDeductionKrw)).toEqual([
      501,
      500,
      0
    ]);
    expect(products.map((currentProduct) => byProductId.get(currentProduct.id)?.couponIgnoredResidualKrw)).toEqual([
      501,
      500,
      0
    ]);
    expect(result.rows.every((row) => row.couponDeductionKrw >= 0 && row.couponIgnoredResidualKrw >= 0)).toBe(true);
    expect(result.rows.reduce((sum, row) => sum + row.couponDeductionKrw, 0)).toBe(1001);
    expect(result.rows.reduce((sum, row) => sum + row.couponIgnoredResidualKrw, 0)).toBe(1001);
  });

  it("keeps legacy coupon orders unmatched and returns a PII-safe audit row", async () => {
    const prisma = fakePrisma({
      salesLines: [
        cafe24Line({
          totalOrderKrw: null,
          totalPaidKrw: new Prisma.Decimal(45000),
          paymentMethod: "쿠폰,신용카드"
        })
      ],
      adMetrics: [],
      couponRules: [couponRule()]
    });
    const service = new SalesMetricsService(prisma as never);

    const performance = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });
    const audit = await service.couponMatches({
      from: "2026-06-11",
      to: "2026-06-11",
      status: "UNMATCHED"
    });

    expect(performance.rows[0]).toMatchObject({
      couponDeductionKrw: 0,
      couponUnmatchedOrderCount: 1,
      couponStatus: "UNMATCHED",
      marginBeforeCouponKrw: 29000,
      marginKrw: 29000
    });
    expect(performance.summary).toMatchObject({
      couponDetectedOrderCount: 1,
      couponAppliedOrderCount: 0,
      couponUnmatchedOrderCount: 1,
      couponMissingTotalOrderCount: 1,
      couponDeductionKrw: 0
    });
    expect(audit.rows).toEqual([
      expect.objectContaining({
        orderNo: "20260611-000001",
        productIds: ["product-wavebar"],
        productNames: ["버닝 웨이브바"],
        paymentMethod: "쿠폰,신용카드",
        totalOrderKrw: null,
        couponDeductionKrw: 0,
        status: "UNMATCHED",
        confidence: "NONE",
        warningCodes: ["MISSING_TOTAL_ORDER"]
      })
    ]);
  });

  it("does not apply a coupon when the same upload batch contains an error row for the order", async () => {
    const prisma = fakePrisma({
      salesLines: [
        cafe24Line({
          totalOrderKrw: new Prisma.Decimal(50000),
          totalPaidKrw: new Prisma.Decimal(45000),
          paymentMethod: "신용카드"
        })
      ],
      errorLines: [
        cafe24Line({
          id: "line-error",
          rowNumber: 3,
          lineOrderNo: "20260611-000001-02",
          validationStatus: RowValidationStatus.ERROR,
          isCurrent: false,
          totalOrderKrw: null,
          paymentMethod: "쿠폰,신용카드",
          productId: null,
          product: null,
          matchRule: null
        })
      ],
      adMetrics: [],
      couponRules: [couponRule()]
    });
    const service = new SalesMetricsService(prisma as never);

    const performance = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });
    const audit = await service.couponMatches({ from: "2026-06-11", to: "2026-06-11" });

    expect(performance.rows[0]).toMatchObject({
      couponDeductionKrw: 0,
      couponUnmatchedOrderCount: 1,
      couponStatus: "UNMATCHED",
      marginBeforeCouponKrw: 29000,
      marginKrw: 29000
    });
    expect(performance.summary).toMatchObject({
      couponDetectedOrderCount: 1,
      couponAppliedOrderCount: 0,
      couponUnmatchedOrderCount: 1
    });
    expect(audit.rows[0]).toMatchObject({
      paymentMethod: "신용카드 / 쿠폰,신용카드",
      status: "UNMATCHED",
      warningCodes: ["INCOMPLETE_ORDER_DATA"]
    });
  });

  it("loads every current sibling for selected batch-order keys without an orderNo IN filter", async () => {
    const selectedLine = cafe24Line({
      totalOrderKrw: new Prisma.Decimal(50000),
      totalPaidKrw: new Prisma.Decimal(45000),
      paymentMethod: "쿠폰,신용카드"
    });
    const outsideRangeSibling = cafe24Line({
      id: "line-next-date",
      rowNumber: 3,
      lineOrderNo: "20260611-000001-02",
      orderDate: date("2026-06-12"),
      orderedAt: date("2026-06-12"),
      totalOrderKrw: new Prisma.Decimal(50000),
      totalPaidKrw: new Prisma.Decimal(45000),
      paymentMethod: "쿠폰,신용카드"
    });
    const prisma = fakePrisma({
      salesLines: [selectedLine],
      couponLines: [selectedLine, outsideRangeSibling],
      adMetrics: [],
      couponRules: [couponRule()]
    });
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });
    const audit = await service.couponMatches({ from: "2026-06-11", to: "2026-06-11" });

    expect(prisma.cafe24OrderLine.findManyCalls[0].where.orderDate).toEqual({
      gte: date("2026-06-11"),
      lte: date("2026-06-11")
    });
    expect(prisma.cafe24OrderLine.findManyCalls[1].where.orderDate).toBeUndefined();
    expect(prisma.cafe24OrderLine.findManyCalls[1].where.orderNo).toBeUndefined();
    expect(prisma.cafe24OrderLine.findManyCalls[1].where.OR).toEqual([
      { isCurrent: true },
      { validationStatus: RowValidationStatus.ERROR }
    ]);
    expect(result.summary.salesLineCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      quantity: 1,
      couponDeductionKrw: 0,
      couponUnmatchedOrderCount: 1,
      couponStatus: "UNMATCHED"
    });
    expect(audit.rows[0]).toMatchObject({
      status: "UNMATCHED",
      warningCodes: ["INCONSISTENT_ORDER_DATE"]
    });
  });

  it("blocks a coupon when an included current sibling has no product mapping", async () => {
    const selectedLine = cafe24Line({
      totalOrderKrw: new Prisma.Decimal(50000),
      totalPaidKrw: new Prisma.Decimal(45000),
      paymentMethod: "쿠폰,신용카드"
    });
    const unmappedSibling = cafe24Line({
      id: "line-unmapped",
      rowNumber: 3,
      lineOrderNo: "20260611-000001-02",
      totalOrderKrw: new Prisma.Decimal(50000),
      totalPaidKrw: new Prisma.Decimal(45000),
      paymentMethod: "쿠폰,신용카드",
      productId: null,
      product: null,
      matchRule: null
    });
    const prisma = fakePrisma({
      salesLines: [selectedLine],
      couponLines: [selectedLine, unmappedSibling],
      adMetrics: [],
      couponRules: [couponRule()]
    });
    const service = new SalesMetricsService(prisma as never);

    const audit = await service.couponMatches({ from: "2026-06-11", to: "2026-06-11" });

    expect(audit.rows[0]).toMatchObject({
      status: "UNMATCHED",
      warningCodes: ["PARTIAL_PRODUCT_MAPPING"],
      couponDeductionKrw: 0
    });
  });

  it("reports a detected coupon as unmatched when no active rule is available", async () => {
    const prisma = fakePrisma({
      salesLines: [
        cafe24Line({
          totalOrderKrw: new Prisma.Decimal(50000),
          totalPaidKrw: new Prisma.Decimal(45000),
          paymentMethod: "쿠폰,신용카드"
        })
      ],
      adMetrics: [],
      couponRules: []
    });
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });
    const audit = await service.couponMatches({ from: "2026-06-11", to: "2026-06-11" });

    expect(result.rows[0]).toMatchObject({
      couponDeductionKrw: 0,
      couponUnmatchedOrderCount: 1,
      couponStatus: "UNMATCHED",
      marginKrw: 29000
    });
    expect(result.summary.couponUnmatchedOrderCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({
      observedGapKrw: 5000,
      status: "UNMATCHED",
      warningCodes: ["NO_ACTIVE_COUPON_RULE"]
    });
  });

  it("preserves the existing null margin policy when exchange-rate data is unavailable", async () => {
    const prisma = fakePrisma({
      salesLines: [
        cafe24Line({
          totalOrderKrw: new Prisma.Decimal(50000),
          totalPaidKrw: new Prisma.Decimal(45000),
          paymentMethod: "쿠폰,신용카드"
        })
      ],
      adMetrics: [adMetric({ spendUsd: new Prisma.Decimal(10) })],
      costRules: [costRule({ fxRateKrwPerUsd: new Prisma.Decimal(0) })],
      exchangeRates: [],
      couponRules: [couponRule()]
    });
    const service = new SalesMetricsService(prisma as never);

    const result = await service.productPerformance({ from: "2026-06-11", to: "2026-06-11" });

    expect(result.rows[0]).toMatchObject({
      adSpendUsd: 10,
      adSpendKrw: null,
      grossCostKrw: 21000,
      couponDeductionKrw: 5000,
      marginBeforeCouponKrw: null,
      totalCostKrw: null,
      marginKrw: null,
      roas: null,
      cpaKrw: null,
      ruleStatus: "MISSING_EXCHANGE_RATE"
    });
  });
});

function fakePrisma(overrides: {
  salesLines?: ReturnType<typeof cafe24Line>[];
  couponLines?: ReturnType<typeof cafe24Line>[];
  errorLines?: ReturnType<typeof cafe24Line>[];
  adMetrics?: ReturnType<typeof adMetric>[];
  costRules?: any[];
  exchangeRates?: any[];
  couponRules?: any[];
} = {}) {
  const cafe24FindManyCalls: any[] = [];
  const cafe24BatchFindManyCalls: any[] = [];
  const metaAdsetFindManyCalls: any[] = [];
  return {
    cafe24UploadBatch: {
      findManyCalls: cafe24BatchFindManyCalls,
      findMany: async (args: unknown) => {
        cafe24BatchFindManyCalls.push(args);
        return [
          {
            id: "batch-1",
            status: UploadStatus.IMPORTED,
            rowCount: 2,
            importedAt: null,
            _count: { rows: 2 }
          },
          {
            id: "batch-incomplete",
            status: UploadStatus.PARTIAL,
            rowCount: 196,
            importedAt: null,
            _count: { rows: 56 }
          }
        ];
      }
    },
    cafe24OrderLine: {
      findManyCalls: cafe24FindManyCalls,
      findMany: async (args: any) => {
        cafe24FindManyCalls.push(args);
        const salesLines = overrides.salesLines ?? [
          cafe24Line({ quantity: new Prisma.Decimal(1), totalPaidKrw: new Prisma.Decimal(0) }),
          cafe24Line({ id: "line-2", rowNumber: 3, quantity: new Prisma.Decimal(2), totalPaidKrw: new Prisma.Decimal(100000) })
        ];
        if (args?.where?.OR) {
          return overrides.couponLines ?? [...salesLines, ...(overrides.errorLines ?? [])];
        }
        return salesLines;
      }
    },
    metaAdsetDailyMetric: {
      findManyCalls: metaAdsetFindManyCalls,
      findMany: async (args: unknown) => {
        metaAdsetFindManyCalls.push(args);
        return overrides.adMetrics ?? [
          adMetric({ productId: "product-wavebar", product: product(), spendUsd: new Prisma.Decimal(10) }),
          adMetric({ id: "metric-unmatched", productId: null, product: null, spendUsd: new Prisma.Decimal(5) })
        ];
      }
    },
    productCostRule: {
      findMany: async () => overrides.costRules ?? [costRule()]
    },
    cafe24CouponRule: {
      findMany: async () => overrides.couponRules ?? []
    },
    exchangeRate: {
      findMany: async () => overrides.exchangeRates ?? [
        {
          rateDate: date("2026-06-11"),
          rate: new Prisma.Decimal(1300)
        }
      ]
    }
  };
}

function cafe24Line(overrides: Record<string, unknown> = {}) {
  return {
    id: "line-1",
    uploadBatchId: "batch-1",
    rowNumber: 2,
    sourceRowHash: "hash",
    orderLineKey: "20260611-000001:20260611-000001-01:120:wavebar",
    orderNo: "20260611-000001",
    lineOrderNo: "20260611-000001-01",
    productNo: "120",
    productName: "버닝 웨이브 바",
    optionName: "버닝 웨이브 바 [옵션: 블랙]",
    quantity: new Prisma.Decimal(1),
    salePriceKrw: new Prisma.Decimal(50000),
    totalOrderKrw: null,
    totalPaidKrw: new Prisma.Decimal(0),
    paymentMethod: "카드",
    orderedAt: date("2026-06-11"),
    orderDate: date("2026-06-11"),
    productId: "product-wavebar",
    cafe24ProductRuleId: "rule-wavebar",
    matchSource: "RULE",
    validationStatus: RowValidationStatus.VALID,
    validationErrors: [],
    rawRow: {},
    importVersion: 1,
    isCurrent: true,
    supersededByOrderLineId: null,
    createdAt: date("2026-06-11"),
    product: product(),
    matchRule: {
      id: "rule-wavebar",
      salePriceKrwOverride: null,
      productCostKrwOverride: null,
      shippingKrwOverride: null,
      extraCostKrwOverride: null
    },
    ...overrides
  };
}

function adMetric(overrides: Record<string, unknown> = {}) {
  return {
    id: "metric-1",
    metricDate: date("2026-06-11"),
    spendUsd: new Prisma.Decimal(10),
    productId: "product-wavebar",
    product: product(),
    ...overrides
  };
}

function costRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "cost-rule",
    productId: "product-wavebar",
    salePriceKrw: new Prisma.Decimal(50000),
    vatKrw: new Prisma.Decimal(5000),
    productCostKrw: new Prisma.Decimal(12000),
    shippingKrw: new Prisma.Decimal(3000),
    extraCostKrw: new Prisma.Decimal(1000),
    fxRateKrwPerUsd: new Prisma.Decimal(1200),
    effectiveFrom: date("2026-01-01"),
    effectiveTo: null,
    ...overrides
  };
}

function couponRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "coupon-product-5000",
    name: "상품 5천원 쿠폰",
    scope: "PRODUCT",
    productId: "product-wavebar",
    discountKrw: new Prisma.Decimal(5000),
    priority: 100,
    validFrom: date("2026-01-01"),
    validTo: null,
    isActive: true,
    note: null,
    createdAt: date("2026-01-01"),
    updatedAt: date("2026-01-01"),
    ...overrides
  };
}

type TestProduct = {
  id: string;
  code: string;
  name: string;
  displayName: string;
  isActive: boolean;
};

function product(overrides: Partial<TestProduct> = {}): TestProduct {
  return {
    id: "product-wavebar",
    code: "wavebar",
    name: "wavebar",
    displayName: "버닝 웨이브바",
    isActive: true,
    ...overrides
  };
}

function date(value: string) {
  const parsed = toDateOnly(value);
  if (!parsed) {
    throw new Error(`Invalid test date: ${value}`);
  }
  return parsed;
}
