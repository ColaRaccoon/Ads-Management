import ExcelJS from "exceljs";
import { ConflictPolicy, CoupangUploadSourceType, MatchSource, Prisma, RowValidationStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { toDateOnly } from "../domain/date-number";
import {
  buildCoupangMarginCostRuleData,
  buildCoupangPriceTextCostRuleData,
  CoupangService,
  resolveCoupangRowImportDecision,
  resolveCoupangRowStoredState
} from "./coupang.service";

describe("Coupang upload current/version policy", () => {
  it("keeps duplicate logical keys non-current on SKIP", () => {
    expect(
      resolveCoupangRowImportDecision({
        conflictPolicy: ConflictPolicy.SKIP,
        existingCurrent: { id: "row-current", importVersion: 2 },
        latestImportVersion: 4
      })
    ).toEqual({
      importVersion: 2,
      isCurrent: false,
      supersedeExisting: false,
      skippedDuplicate: true
    });
  });

  it("replaces current rows on OVERWRITE and creates max+1 on NEW_VERSION", () => {
    expect(
      resolveCoupangRowImportDecision({
        conflictPolicy: ConflictPolicy.OVERWRITE,
        existingCurrent: { id: "row-current", importVersion: 2 },
        latestImportVersion: 4
      })
    ).toMatchObject({ importVersion: 2, isCurrent: true, supersedeExisting: true });

    expect(
      resolveCoupangRowImportDecision({
        conflictPolicy: ConflictPolicy.NEW_VERSION,
        existingCurrent: { id: "row-current", importVersion: 2 },
        latestImportVersion: 4
      })
    ).toMatchObject({ importVersion: 5, isCurrent: true, supersedeExisting: true });
  });

  it("stores parsing-error rows as non-current", () => {
    const decision = resolveCoupangRowImportDecision({
      conflictPolicy: ConflictPolicy.OVERWRITE,
      existingCurrent: { id: "row-current", importVersion: 2 },
      latestImportVersion: 4
    });

    expect(resolveCoupangRowStoredState({ validationStatus: RowValidationStatus.ERROR, decision })).toMatchObject({
      importVersion: 2,
      isCurrent: false,
      supersedeExisting: false
    });
  });
});

describe("Coupang price text cost rule copy", () => {
  it("updates only sale price while preserving the latest cost fields", () => {
    const effectiveFrom = toDateOnly("2026-06-22")!;
    const data = buildCoupangPriceTextCostRuleData({
      coupangProductId: "product-1",
      salePriceKrw: 19900,
      effectiveFrom,
      latestCostRule: {
        supplyPriceKrw: new Prisma.Decimal(12000),
        productCostKrw: new Prisma.Decimal(7000),
        salesFeeRate: new Prisma.Decimal("0.108"),
        salesFeeKrw: new Prisma.Decimal(1800),
        salePriceKrw: new Prisma.Decimal(25800),
        sellerShippingFeeKrw: new Prisma.Decimal(3000),
        growthInboundFeeKrw: new Prisma.Decimal(500),
        growthShippingFeeKrw: new Prisma.Decimal(1200),
        returnRate: new Prisma.Decimal("0.04"),
        returnCostPerUnitKrw: new Prisma.Decimal(2500),
        extraCostKrw: new Prisma.Decimal(300),
        note: "base cost"
      }
    });

    expect(data).toMatchObject({
      coupangProductId: "product-1",
      effectiveFrom,
      note: "base cost"
    });
    expect(Number(data?.salePriceKrw)).toBe(19900);
    expect(Number(data?.productCostKrw)).toBe(7000);
    expect(Number(data?.sellerShippingFeeKrw)).toBe(3000);
    expect(Number(data?.returnCostPerUnitKrw)).toBe(2500);
  });

  it("does not create a cost rule when there is no previous cost baseline", () => {
    expect(
      buildCoupangPriceTextCostRuleData({
        coupangProductId: "product-1",
        salePriceKrw: 19900,
        effectiveFrom: toDateOnly("2026-06-22")!,
        latestCostRule: null
      })
    ).toBeNull();
  });
});

describe("Coupang margin cost rule import data", () => {
  it("preserves the latest sale price instead of using Product Margin CSV sale price", () => {
    const data = buildCoupangMarginCostRuleData({
      coupangProductId: "product-1",
      effectiveFrom: toDateOnly("2026-06-22")!,
      latestCostRule: { salePriceKrw: new Prisma.Decimal(25800) },
      parsedRow: {
        itemName: "Zero Bar",
        ignoredSalePriceKrw: 24050,
        supplyPriceKrw: 0,
        productCostKrw: 7000,
        salesFeeRate: 0.108,
        salesFeeKrw: 1800,
        sellerShippingFeeKrw: 3000,
        growthInboundFeeKrw: 500,
        growthShippingFeeKrw: 1200,
        returnRate: 0.04,
        returnCostPerUnitKrw: 2500,
        adEnabled: true
      }
    });

    expect(Number(data.salePriceKrw)).toBe(25800);
    expect(Number(data.productCostKrw)).toBe(7000);
    expect(Number(data.salesFeeRate)).toBe(0.108);
  });

  it("uses zero sale price when there is no previous base sale price", () => {
    const data = buildCoupangMarginCostRuleData({
      coupangProductId: "product-1",
      effectiveFrom: toDateOnly("2026-06-22")!,
      latestCostRule: null,
      parsedRow: {
        itemName: "Zero Bar",
        ignoredSalePriceKrw: 24050,
        supplyPriceKrw: 0,
        productCostKrw: 7000,
        salesFeeRate: 0,
        salesFeeKrw: 1800,
        sellerShippingFeeKrw: 3000,
        growthInboundFeeKrw: 500,
        growthShippingFeeKrw: 1200,
        returnRate: 0,
        returnCostPerUnitKrw: 2500,
        adEnabled: true
      }
    });

    expect(Number(data.salePriceKrw)).toBe(0);
  });
});

describe("CoupangService rematch", () => {
  it("rematches ad spend and conversion products with active Coupang rules", async () => {
    const prisma = fakeCoupangRematchPrisma();
    const service = new CoupangService(prisma as never);

    const result = await service.rematch({ from: "2026-06-22", to: "2026-06-22" });

    expect(result).toMatchObject({
      scannedSalesCount: 0,
      matchedSalesCount: 0,
      scannedAdsCount: 1,
      matchedSpendCount: 1,
      matchedConversionCount: 1
    });
    expect(prisma.coupangAdMetric.update).toHaveBeenCalledWith({
      where: { id: "metric-1" },
      data: expect.objectContaining({
        spendProductId: "product-spend",
        spendProductRuleId: "rule-spend",
        conversionProductId: "product-conversion",
        conversionProductRuleId: "rule-conversion",
        spendMatchSource: MatchSource.RULE,
        conversionMatchSource: MatchSource.RULE,
        validationStatus: RowValidationStatus.VALID,
        validationErrors: []
      })
    });
    expect(prisma.coupangUploadRowError.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        adMetricId: "metric-1",
        severity: "WARNING"
      })
    });
    expect(prisma.coupangUploadRowError.createMany).not.toHaveBeenCalled();
  });

  it("preserves inactive promotion status warnings while rematching matched promotions", async () => {
    const prisma = fakeCoupangRematchPrisma({
      promotions: [
        {
          id: "promotion-1",
          uploadBatchId: "batch-1",
          rowNumber: 9,
          productText: "Spend Product promotion",
          promotionStartDate: toDateOnly("2026-06-19")!,
          promotionEndDate: toDateOnly("2026-07-19")!,
          promotionStatus: "취소",
          validationStatus: RowValidationStatus.WARNING
        }
      ]
    });
    const service = new CoupangService(prisma as never);

    const result = await service.rematch({ from: "2026-06-22", to: "2026-06-22" });

    expect(result).toMatchObject({
      scannedPromotionCount: 1,
      matchedPromotionCount: 1
    });
    expect(prisma.coupangPromotionPrice.update).toHaveBeenCalledWith({
      where: { id: "promotion-1" },
      data: expect.objectContaining({
        coupangProductId: "product-spend",
        coupangProductRuleId: "rule-spend",
        matchSource: MatchSource.RULE,
        validationStatus: RowValidationStatus.WARNING,
        validationErrors: [expect.objectContaining({ errorCode: "INVALID_PROMOTION_STATUS" })]
      })
    });
    expect(prisma.coupangUploadRowError.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        promotionPriceId: "promotion-1",
        severity: "WARNING"
      })
    });
    expect(prisma.coupangUploadRowError.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          sourceType: CoupangUploadSourceType.PROMOTION,
          promotionPriceId: "promotion-1",
          severity: "WARNING",
          errorCode: "INVALID_PROMOTION_STATUS"
        })
      ]
    });
  });
});

describe("CoupangService promotion import", () => {
  it("stores inactive promotion statuses as warnings", async () => {
    const prisma = fakeCoupangPromotionImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = await workbookBuffer([
      ["Product Name", "Option Name", "Promotion Price", "Promotion Status", "Start Date", "End Date"],
      ["Zero Bar", "Black", 24050, "취소", "2026-06-19", "2026-07-19"]
    ]);

    const result = await service.importPromotionXlsx({ originalname: "promotion.xlsx", buffer } as Express.Multer.File, {});

    expect(result).toMatchObject({ warningCount: 1, matchedCount: 1 });
    expect(prisma.coupangPromotionPrice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        validationStatus: RowValidationStatus.WARNING,
        matchSource: MatchSource.RULE,
        promotionStatus: "취소"
      })
    });
    expect(prisma.coupangUploadRowError.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          sourceType: CoupangUploadSourceType.PROMOTION,
          promotionPriceId: "promotion-price-1",
          severity: "WARNING",
          errorCode: "INVALID_PROMOTION_STATUS"
        })
      ]
    });
  });
});

describe("CoupangService deleteUpload", () => {
  it("restores the latest remaining non-error rows after deleting an overwrite batch", async () => {
    const prisma = fakeCoupangDeletePrisma();
    const service = new CoupangService(prisma as never);

    await service.deleteUpload("batch-new");

    expect(prisma.coupangSaleLine.deleteMany).toHaveBeenCalledWith({ where: { uploadBatchId: "batch-new" } });
    expect(prisma.coupangSaleLine.updateMany).toHaveBeenCalledWith({
      where: { saleLineKey: "sale-key" },
      data: { isCurrent: false }
    });
    expect(prisma.coupangSaleLine.findFirst).toHaveBeenCalledWith({
      where: { saleLineKey: "sale-key", validationStatus: { not: RowValidationStatus.ERROR } },
      orderBy: [{ importVersion: "desc" }, { createdAt: "desc" }],
      select: { id: true }
    });
    expect(prisma.coupangSaleLine.update).toHaveBeenCalledWith({
      where: { id: "sale-old" },
      data: { isCurrent: true }
    });

    expect(prisma.coupangAdMetric.updateMany).toHaveBeenCalledWith({
      where: { adMetricKey: "ad-key" },
      data: { isCurrent: false }
    });
    expect(prisma.coupangAdMetric.update).toHaveBeenCalledWith({
      where: { id: "ad-old" },
      data: { isCurrent: true }
    });
    expect(prisma.coupangUploadBatch.delete).toHaveBeenCalledWith({ where: { id: "batch-new" } });
  });
});

describe("CoupangService unmatched", () => {
  it("limits parse errors to rows or batches overlapping the requested period", async () => {
    const prisma = fakeCoupangUnmatchedPrisma();
    const service = new CoupangService(prisma as never);

    await service.unmatched({ from: "2026-06-22", to: "2026-06-23" });

    expect(prisma.coupangUploadRowError.findMany).toHaveBeenCalledWith({
      where: {
        severity: "ERROR",
        OR: [
          { saleLine: { is: { saleDate: { gte: toDateOnly("2026-06-22"), lte: toDateOnly("2026-06-23") } } } },
          { adMetric: { is: { metricDate: { gte: toDateOnly("2026-06-22"), lte: toDateOnly("2026-06-23") } } } },
          {
            promotionPrice: {
              is: {
                promotionStartDate: { lte: toDateOnly("2026-06-23") },
                promotionEndDate: { gte: toDateOnly("2026-06-22") }
              }
            }
          },
          { batch: { dataStart: { lte: toDateOnly("2026-06-23") }, dataEnd: { gte: toDateOnly("2026-06-22") } } }
        ]
      },
      take: 200,
      orderBy: [{ createdAt: "desc" }],
      include: { batch: true }
    });
  });
});

function fakeCoupangRematchPrisma(options: { promotions?: any[] } = {}) {
  return {
    coupangProductRule: {
      findMany: vi.fn(async () => [
        {
          id: "rule-spend",
          coupangProductId: "product-spend",
          displayName: "Spend Product",
          includeKeywords: ["Spend"],
          excludeKeywords: [],
          priority: 10,
          validFrom: toDateOnly("2026-01-01")!,
          validTo: null,
          isActive: true
        },
        {
          id: "rule-conversion",
          coupangProductId: "product-conversion",
          displayName: "Conversion Product",
          includeKeywords: ["Conversion"],
          excludeKeywords: [],
          priority: 10,
          validFrom: toDateOnly("2026-01-01")!,
          validTo: null,
          isActive: true
        }
      ])
    },
    coupangSaleLine: {
      findMany: vi.fn(async () => [])
    },
    coupangAdMetric: {
      findMany: vi.fn(async () => [
        {
          id: "metric-1",
          uploadBatchId: "batch-1",
          rowNumber: 7,
          metricDate: toDateOnly("2026-06-22")!,
          adExecutionProductName: "Spend Product 2-pack",
          conversionProductName: "Conversion Product 2-pack",
          validationStatus: RowValidationStatus.UNMATCHED
        }
      ]),
      update: vi.fn(async () => ({}))
    },
    coupangPromotionPrice: {
      findMany: vi.fn(async () => options.promotions ?? []),
      update: vi.fn(async () => ({}))
    },
    coupangUploadRowError: {
      deleteMany: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({}))
    }
  };
}

function fakeCoupangPromotionImportPrisma() {
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
    coupangUploadBatch: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args) => ({ id: "batch-promotion", conflictPolicy: args.data.conflictPolicy, ...args.data })),
      update: vi.fn(async () => ({}))
    },
    coupangProductRule: {
      findMany: vi.fn(async () => [
        {
          id: "rule-zero",
          coupangProductId: "product-zero",
          displayName: "Zero Bar",
          includeKeywords: ["Zero Bar"],
          excludeKeywords: [],
          priority: 10,
          validFrom: toDateOnly("2026-01-01")!,
          validTo: null,
          isActive: true
        }
      ])
    },
    coupangPromotionPrice: {
      create: vi.fn(async (args) => ({ id: "promotion-price-1", ...args.data }))
    },
    coupangUploadRowError: {
      createMany: vi.fn(async () => ({}))
    }
  };
  return prisma;
}

function fakeCoupangDeletePrisma() {
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
    coupangUploadBatch: {
      findUnique: vi.fn(async () => ({ id: "batch-new" })),
      delete: vi.fn(async () => ({ id: "batch-new" }))
    },
    coupangUploadRowError: {
      deleteMany: vi.fn(async () => ({}))
    },
    coupangSaleLine: {
      findMany: vi.fn(async (args) =>
        args.where?.uploadBatchId === "batch-new" ? [{ saleLineKey: "sale-key" }] : []
      ),
      deleteMany: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => ({ id: "sale-old" })),
      update: vi.fn(async () => ({}))
    },
    coupangAdMetric: {
      findMany: vi.fn(async (args) =>
        args.where?.uploadBatchId === "batch-new" ? [{ adMetricKey: "ad-key" }] : []
      ),
      deleteMany: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => ({ id: "ad-old" })),
      update: vi.fn(async () => ({}))
    }
  };
  return prisma;
}

async function workbookBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("promotions");
  rows.forEach((row) => sheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function fakeCoupangUnmatchedPrisma() {
  return {
    coupangSaleLine: {
      findMany: vi.fn(async () => [])
    },
    coupangAdMetric: {
      findMany: vi.fn(async () => [])
    },
    coupangUploadRowError: {
      findMany: vi.fn(async () => [])
    },
    coupangPromotionPrice: {
      findMany: vi.fn(async () => [])
    }
  };
}
