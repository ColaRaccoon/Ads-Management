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
});

function fakePrisma() {
  const cafe24FindManyCalls: any[] = [];
  const cafe24BatchFindManyCalls: any[] = [];
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
      findMany: async (args: unknown) => {
        cafe24FindManyCalls.push(args);
        return [
          cafe24Line({ quantity: new Prisma.Decimal(1), totalPaidKrw: new Prisma.Decimal(0) }),
          cafe24Line({ id: "line-2", rowNumber: 3, quantity: new Prisma.Decimal(2), totalPaidKrw: new Prisma.Decimal(100000) })
        ];
      }
    },
    metaAdsetDailyMetric: {
      findMany: async () => [
        adMetric({ productId: "product-wavebar", product: product(), spendUsd: new Prisma.Decimal(10) }),
        adMetric({ id: "metric-unmatched", productId: null, product: null, spendUsd: new Prisma.Decimal(5) })
      ]
    },
    productCostRule: {
      findMany: async () => [
        {
          id: "cost-rule",
          productId: "product-wavebar",
          salePriceKrw: new Prisma.Decimal(50000),
          vatKrw: new Prisma.Decimal(5000),
          productCostKrw: new Prisma.Decimal(12000),
          shippingKrw: new Prisma.Decimal(3000),
          extraCostKrw: new Prisma.Decimal(1000),
          fxRateKrwPerUsd: new Prisma.Decimal(1200),
          effectiveFrom: date("2026-01-01"),
          effectiveTo: null
        }
      ]
    },
    exchangeRate: {
      findMany: async () => [
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

function product() {
  return {
    id: "product-wavebar",
    code: "wavebar",
    name: "wavebar",
    displayName: "버닝 웨이브바"
  };
}

function date(value: string) {
  const parsed = toDateOnly(value);
  if (!parsed) {
    throw new Error(`Invalid test date: ${value}`);
  }
  return parsed;
}
