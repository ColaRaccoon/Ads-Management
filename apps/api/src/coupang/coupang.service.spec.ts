import ExcelJS from "exceljs";
import { ConflictPolicy, CoupangUploadSourceType, MatchSource, Prisma, RowValidationStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { toDateOnly } from "../domain/date-number";
import {
  aggregateCoupangProductProfitRowsByGroup,
  buildCoupangDailyHierarchy,
  buildCoupangMarginCostRuleData,
  buildCoupangPriceTextCostRuleData,
  CoupangService,
  findSalesFeeRuleForDate,
  normalizeDailyMemo,
  salesFeeRateFromPercentBody,
  type ProductProfitRow,
  resolveCoupangRowImportDecision,
  resolveCoupangRowStoredState,
  summarizeCoupangProductProfitRows
} from "./coupang.service";

describe("global Coupang sales fee snapshots", () => {
  it("converts UI percentages to bounded decimal rates, including 0%", () => {
    expect(salesFeeRateFromPercentBody(11.88).toString()).toBe("0.1188");
    expect(salesFeeRateFromPercentBody(0).toString()).toBe("0");
    expect(() => salesFeeRateFromPercentBody(-0.01)).toThrow();
    expect(() => salesFeeRateFromPercentBody(100.01)).toThrow();
  });

  it("selects the latest effective global rule regardless of input order", () => {
    const rules = [
      salesFeeRuleFixture("older", 0.1, "2026-01-01", "2026-06-30"),
      salesFeeRuleFixture("newer-created", 0.12, "2026-07-01", null, "2026-07-02"),
      salesFeeRuleFixture("newer", 0.1188, "2026-07-01", null, "2026-07-01")
    ];

    expect(findSalesFeeRuleForDate(rules, new Date("2026-06-30T00:00:00.000Z"))?.id).toBe("older");
    expect(findSalesFeeRuleForDate(rules.reverse(), new Date("2026-07-22T00:00:00.000Z"))?.id).toBe("newer-created");
  });

  it("uses the Asia/Seoul date for current fee and manual options during the UTC-date boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T15:30:00.000Z"));
    try {
      const salesFeeRule = salesFeeRuleFixture("kst-rule", 0.1188, "2026-07-23", null);
      const findFirst = vi.fn(async () => salesFeeRule);
      const service = new CoupangService({
        appSetting: { findUnique: vi.fn(async () => null) },
        coupangProduct: { findMany: vi.fn(async () => []) },
        coupangManualPurchase: { findMany: vi.fn(async () => []) },
        coupangSalesFeeRule: { findFirst }
      } as never);

      await service.currentSalesFeeRule();
      const options = await service.manualPurchaseOptions({});

      const expectedDate = toDateOnly("2026-07-23");
      expect(findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
        where: expect.objectContaining({ effectiveFrom: { lte: expectedDate } })
      }));
      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(options.date).toBe("2026-07-23");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Coupang sales fee history corrections", () => {
  it("updates the selected legacy cost history with an explicit 0% rate and preserves omitted fields", async () => {
    const existing = {
      id: "cost-rule-1",
      coupangProductId: "product-1",
      salesFeeRate: new Prisma.Decimal(0.1188),
      salesFeeKrw: new Prisma.Decimal(1_000),
      productCostKrw: new Prisma.Decimal(7_000),
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
      effectiveTo: null
    };
    let stored = { ...existing };
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => (stored = { ...stored, ...data }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      coupangProduct: { findUnique: vi.fn(async () => ({ id: "product-1" })) },
      coupangCostRule: {
        findUnique: vi.fn(async () => stored),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => [stored]),
        findUniqueOrThrow: vi.fn(async () => stored),
        update
      }
    };
    const service = new CoupangService({ ...tx, $transaction: vi.fn(async (callback) => callback(tx)) } as never);

    await service.correctProductCostRule("product-1", existing.id, { salesFeeRate: 0 });

    expect(update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: { salesFeeRate: new Prisma.Decimal(0) }
    });
    expect(update.mock.calls[0]?.[0].data).not.toHaveProperty("productCostKrw");
    expect(update.mock.calls[0]?.[0].data).not.toHaveProperty("effectiveFrom");
  });

  it("rejects a cost-history id owned by another product", async () => {
    const update = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      coupangProduct: { findUnique: vi.fn(async () => ({ id: "product-1" })) },
      coupangCostRule: {
        findUnique: vi.fn(async () => ({ id: "cost-rule-2", coupangProductId: "product-2" })),
        update
      }
    };
    const service = new CoupangService({ ...tx, $transaction: vi.fn(async (callback) => callback(tx)) } as never);

    await expect(service.correctProductCostRule("product-1", "cost-rule-2", { salesFeeRate: 0.1 }))
      .rejects.toMatchObject({ response: { code: "COUPANG_COST_RULE_PRODUCT_MISMATCH" } });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    [11.88, "0.1188"],
    [0, "0"]
  ] as const)("stores a global UI percentage of %s and closes the preceding date range", async (salesFeePercent, expectedRate) => {
    const oldRule = salesFeeRuleFixture("old-rule", 0.1, "2026-01-01", null);
    const createdRule = salesFeeRuleFixture("new-rule", Number(expectedRate), "2026-07-01", null);
    const create = vi.fn(async ({ data }: { data: { salesFeeRate: Prisma.Decimal } }) => ({
      ...createdRule,
      salesFeeRate: data.salesFeeRate
    }));
    const update = vi.fn(async () => ({}));
    const tx: any = {
      $queryRaw: vi.fn(async () => []),
      coupangSalesFeeRule: {
        findFirst: vi.fn(async () => null),
        create,
        findMany: vi.fn(async ({ orderBy }: { orderBy: Array<{ effectiveFrom: string }> }) => (
          orderBy[0]?.effectiveFrom === "asc" ? [oldRule, createdRule] : [createdRule, oldRule]
        )),
        update,
        findUniqueOrThrow: vi.fn(async () => createdRule)
      },
      coupangManualPurchase: { findMany: vi.fn(async () => []) }
    };
    const service = new CoupangService({
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    } as never);

    await service.createSalesFeeRule({ salesFeePercent, effectiveFrom: "2026-07-01" });

    expect(create.mock.calls[0]?.[0].data.salesFeeRate.toString()).toBe(expectedRate);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(String((tx.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql).sql))
      .toContain("pg_advisory_xact_lock(7426894320158627)::text AS lock_result");
    expect(update).toHaveBeenCalledWith({
      where: { id: oldRule.id },
      data: { effectiveTo: new Date("2026-06-30T00:00:00.000Z") }
    });
  });

  it("maps the effective-date unique constraint race to the public duplicate-date error", async () => {
    const service = new CoupangService({
      $transaction: vi.fn(async () => Promise.reject({ code: "P2002" }))
    } as never);

    await expect(service.createSalesFeeRule({ salesFeePercent: 11.88, effectiveFrom: "2026-07-01" }))
      .rejects.toMatchObject({ response: { code: "COUPANG_SALES_FEE_RULE_DATE_EXISTS" } });
  });

  it("takes the transaction advisory lock for concurrent writes on different effective dates", async () => {
    const fixture = salesFeeRuleWriteFixture({
      rules: [salesFeeRuleFixture("old", 0.1, "2026-01-01", null)],
      purchases: []
    });
    const service = new CoupangService(fixture.prisma as never);

    await Promise.all([
      service.createSalesFeeRule({ salesFeePercent: 11, effectiveFrom: "2026-07-01" }),
      service.createSalesFeeRule({ salesFeePercent: 12, effectiveFrom: "2026-08-01" })
    ]);

    expect((fixture.prisma as any).$transaction).toHaveBeenCalledTimes(2);
    expect(fixture.advisoryLock).toHaveBeenCalledTimes(2);
    const advisoryQuery = (fixture.advisoryLock as any).mock.calls[0][0] as Prisma.Sql;
    expect(String(advisoryQuery.sql))
      .toContain("pg_advisory_xact_lock(7426894320158627)::text AS lock_result");
    expect(fixture.rule("old").effectiveTo).toEqual(new Date("2026-06-30T00:00:00.000Z"));
    expect(fixture.ruleByDate("2026-07-01").effectiveTo).toEqual(new Date("2026-07-31T00:00:00.000Z"));
    expect(fixture.ruleByDate("2026-08-01").effectiveTo).toBeNull();
  });

  it("does not rewrite manual-purchase snapshots when a global fee rule changes", async () => {
    const purchase = manualSalesFeeSnapshot("manual", "2026-07-21", 777);
    const fixture = salesFeeRuleWriteFixture({
      rules: [salesFeeRuleFixture("old", 0.1, "2026-01-01", null)],
      purchases: [purchase]
    });
    const service = new CoupangService(fixture.prisma as never);

    await service.createSalesFeeRule({ salesFeePercent: 20, effectiveFrom: "2026-07-21" });

    expect(fixture.purchase("manual")).toEqual(purchase);
  });

  it("keeps a concurrent manual write independent from the global fee lock and snapshot", async () => {
    const fixture = concurrentManualSalesFeeWriteFixture();
    const service = new CoupangService(fixture.prisma as never);

    const [manualResult] = await Promise.all([
      service.replaceManualPurchasesForDate("2026-07-21", {
        vendorFeePerUnitKrw: 100,
        entries: [{ coupangProductId: "product-1", quantity: 1 }]
      }),
      service.createSalesFeeRule({ salesFeePercent: 20, effectiveFrom: "2026-07-21" })
    ]);

    expect(manualResult.rows[0]).toMatchObject({
      priceSource: "BASE",
      salesAmountKrw: 10_000,
      salesFeeRateApplied: 0,
      coupangSalesFeeKrw: 0,
      productCostKrw: 0,
      shippingCostKrw: 0,
      otherCostKrw: 0
    });
    expect(fixture.lockEvents).toEqual([
      "transaction-2:acquired",
      "transaction-2:released"
    ]);
    expect(fixture.purchase()).toMatchObject({
      salesFeeRateApplied: new Prisma.Decimal(0),
      coupangSalesFeeKrw: new Prisma.Decimal(0)
    });
  });

  it("inserts an intermediate rule and leaves every manual snapshot immutable", async () => {
    const fixture = salesFeeRuleWriteFixture({
      rules: [
        salesFeeRuleFixture("old", 0.1, "2026-01-01", "2026-08-31"),
        salesFeeRuleFixture("future", 0.2, "2026-09-01", null)
      ],
      purchases: [
        manualSalesFeeSnapshot("june", "2026-06-15", 777),
        manualSalesFeeSnapshot("july", "2026-07-15", 777),
        manualSalesFeeSnapshot("september", "2026-09-15", 777)
      ]
    });
    const service = new CoupangService(fixture.prisma as never);

    await service.createSalesFeeRule({
      salesFeePercent: 11.88,
      effectiveFrom: "2026-07-01"
    });

    expect(fixture.rule("old").effectiveTo).toEqual(new Date("2026-06-30T00:00:00.000Z"));
    expect(fixture.ruleByDate("2026-07-01").effectiveTo).toEqual(new Date("2026-08-31T00:00:00.000Z"));
    expect(fixture.rule("future").effectiveTo).toBeNull();
    expect(fixture.purchase("june")).toMatchObject({ coupangSalesFeeKrw: new Prisma.Decimal(777) });
    expect(fixture.purchase("july")).toMatchObject({
      salesFeeRateApplied: new Prisma.Decimal(0.0777),
      coupangSalesFeeKrw: new Prisma.Decimal(777)
    });
    expect(fixture.purchase("september")).toMatchObject({
      salesFeeRateApplied: new Prisma.Decimal(0.0777),
      coupangSalesFeeKrw: new Prisma.Decimal(777)
    });
  });

  it("moves a rule date, repairs neighboring ranges, and leaves manual snapshots immutable", async () => {
    const fixture = salesFeeRuleWriteFixture({
      rules: [
        salesFeeRuleFixture("old", 0.1, "2026-01-01", "2026-06-30"),
        salesFeeRuleFixture("moving", 0.1188, "2026-07-01", "2026-08-31"),
        salesFeeRuleFixture("future", 0.2, "2026-09-01", null)
      ],
      purchases: [
        manualSalesFeeSnapshot("june", "2026-06-15", 600),
        manualSalesFeeSnapshot("july", "2026-07-15", 777),
        manualSalesFeeSnapshot("august", "2026-08-15", 777)
      ]
    });
    const service = new CoupangService(fixture.prisma as never);

    await service.correctSalesFeeRule("moving", { effectiveFrom: "2026-08-01" });

    expect(fixture.rule("old").effectiveTo).toEqual(new Date("2026-07-31T00:00:00.000Z"));
    expect(fixture.rule("moving").effectiveFrom).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(fixture.rule("moving").effectiveTo).toEqual(new Date("2026-08-31T00:00:00.000Z"));
    expect(Number(fixture.purchase("june").coupangSalesFeeKrw)).toBe(600);
    expect(Number(fixture.purchase("july").salesFeeRateApplied)).toBe(0.0777);
    expect(Number(fixture.purchase("july").coupangSalesFeeKrw)).toBe(777);
    expect(Number(fixture.purchase("august").salesFeeRateApplied)).toBe(0.0777);
    expect(Number(fixture.purchase("august").totalCostKrw)).toBe(4_777);
  });

  it("moves a rule past its former end without violating the range check", async () => {
    const fixture = salesFeeRuleWriteFixture({
      rules: [
        salesFeeRuleFixture("old", 0.1, "2026-01-01", "2026-06-30"),
        salesFeeRuleFixture("moving", 0.1188, "2026-07-01", "2026-08-31")
      ],
      purchases: []
    });
    const service = new CoupangService(fixture.prisma as never);

    await service.correctSalesFeeRule("moving", { effectiveFrom: "2026-09-15" });

    expect(fixture.rule("old").effectiveTo).toEqual(new Date("2026-09-14T00:00:00.000Z"));
    expect(fixture.rule("moving").effectiveFrom).toEqual(new Date("2026-09-15T00:00:00.000Z"));
    expect(fixture.rule("moving").effectiveTo).toBeNull();
  });
});

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
        hanaroShippingFeeKrw: new Prisma.Decimal(650),
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
    expect(Number(data?.hanaroShippingFeeKrw)).toBe(650);
    expect(Number(data?.returnCostPerUnitKrw)).toBe(2500);
  });

  it("creates a sale-price-only cost rule when there is no previous cost baseline", () => {
    const data = buildCoupangPriceTextCostRuleData({
      coupangProductId: "product-1",
      salePriceKrw: 19900,
      effectiveFrom: toDateOnly("2026-06-22")!,
      latestCostRule: null
    });

    expect(data).toMatchObject({
      coupangProductId: "product-1",
      effectiveFrom: toDateOnly("2026-06-22")!
    });
    expect(Number(data.salePriceKrw)).toBe(19900);
    expect(Number(data.productCostKrw)).toBe(0);
    expect(data.sellerShippingFeeKrw).toBeNull();
    expect(data.hanaroShippingFeeKrw).toBeNull();
  });
});

describe("Coupang price text import repair", () => {
  it("reprocesses the same price text file and copies costs from a legacy misparsed product", async () => {
    const prisma = fakeCoupangPriceTextRepairPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = Buffer.from("다이어트양말 10개입\t₩69,900", "utf8");

    const result = await service.importPriceText(
      { originalname: "판매가.txt", buffer } as Express.Multer.File,
      { effectiveFrom: "2026-06-22" }
    );

    expect(result).toMatchObject({ rowCount: 1, validRowCount: 1, warningCount: 0, errorCount: 0 });
    expect(prisma.coupangUploadBatch.findFirst).not.toHaveBeenCalled();
    expect(prisma.coupangUploadBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceType: CoupangUploadSourceType.PRICE_TEXT,
        fileHashSha256: expect.not.stringMatching(createHash("sha256").update(buffer).digest("hex"))
      })
    });
    expect(prisma.coupangProduct.findUnique).toHaveBeenCalledWith({
      where: { standardName: "다이어트양말 10개입 ₩69" },
      select: { id: true }
    });
    expect(prisma.coupangCostRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        coupangProductId: "product-correct",
        salePriceKrw: new Prisma.Decimal(69900),
        productCostKrw: new Prisma.Decimal(7000)
      })
    });
    expect(prisma.coupangProduct.delete).toHaveBeenCalledWith({ where: { id: "product-legacy" } });
  });
});

describe("Coupang margin cost rule import data", () => {
  it("uses Product Margin CSV/TSV sale price as the base sale price", () => {
    const data = buildCoupangMarginCostRuleData({
      coupangProductId: "product-1",
      effectiveFrom: toDateOnly("2026-06-22")!,
      parsedRow: {
        itemName: "Zero Bar",
        salePriceKrw: 24050,
        supplyPriceKrw: 0,
        productCostKrw: 7000,
        sellerShippingFeeKrw: 3000,
        hanaroShippingFeeKrw: 650,
        growthInboundFeeKrw: 500,
        growthShippingFeeKrw: 1200,
        returnRate: 0.04,
        returnCostPerUnitKrw: 2500,
        adEnabled: true
      }
    });

    expect(Number(data.salePriceKrw)).toBe(24050);
    expect(Number(data.productCostKrw)).toBe(7000);
    expect(Number(data.salesFeeRate)).toBe(0);
    expect(Number(data.salesFeeKrw)).toBe(0);
    expect(Number(data.sellerShippingFeeKrw)).toBe(3000);
    expect(Number(data.hanaroShippingFeeKrw)).toBe(650);
  });

  it("does not need a previous base sale price to create a full margin rule", () => {
    const data = buildCoupangMarginCostRuleData({
      coupangProductId: "product-1",
      effectiveFrom: toDateOnly("2026-06-22")!,
      parsedRow: {
        itemName: "Zero Bar",
        salePriceKrw: 24050,
        supplyPriceKrw: 0,
        productCostKrw: 7000,
        hanaroShippingFeeKrw: 650,
        growthInboundFeeKrw: 500,
        growthShippingFeeKrw: 1200,
        returnRate: 0,
        returnCostPerUnitKrw: 2500,
        adEnabled: true
      }
    });

    expect(Number(data.salePriceKrw)).toBe(24050);
    expect(data.sellerShippingFeeKrw).toBeNull();
    expect(Number(data.hanaroShippingFeeKrw)).toBe(650);
  });

  it("preserves a user-set seller shipping fee when the margin row has no seller column", () => {
    const data = buildCoupangMarginCostRuleData({
      coupangProductId: "product-1",
      effectiveFrom: toDateOnly("2026-07-22")!,
      latestCostRule: {
        salePriceKrw: new Prisma.Decimal(24050),
        supplyPriceKrw: new Prisma.Decimal(0),
        productCostKrw: new Prisma.Decimal(7000),
        salesFeeRate: new Prisma.Decimal(0.108),
        salesFeeKrw: new Prisma.Decimal(1800),
        sellerShippingFeeKrw: new Prisma.Decimal(3000),
        hanaroShippingFeeKrw: new Prisma.Decimal(650),
        growthInboundFeeKrw: new Prisma.Decimal(500),
        growthShippingFeeKrw: new Prisma.Decimal(1200),
        returnRate: new Prisma.Decimal(0),
        returnCostPerUnitKrw: new Prisma.Decimal(0),
        extraCostKrw: new Prisma.Decimal(0),
        note: null
      },
      parsedRow: {
        itemName: "Zero Bar",
        salePriceKrw: 25000,
        supplyPriceKrw: 0,
        productCostKrw: 7200,
        hanaroShippingFeeKrw: 700,
        growthInboundFeeKrw: 550,
        growthShippingFeeKrw: 1250,
        returnRate: 0,
        returnCostPerUnitKrw: 0,
        adEnabled: true
      }
    });

    expect(Number(data.sellerShippingFeeKrw)).toBe(3000);
    expect(Number(data.hanaroShippingFeeKrw)).toBe(700);
  });
});

describe("CoupangService product settings and mapping rules", () => {
  it("does not create or update mapping rules from product settings", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await service.createProductSetting({ displayName: "Zero Bar" });
    await service.createProductSetting({ displayName: "Black Socks", includeKeywords: ["Black", "Socks"], priority: 5 });
    await service.updateProductSetting("product-1", {
      displayName: "Black Socks Updated",
      includeKeywords: ["Should", "Ignore"],
      excludeKeywords: ["Ignore"],
      priority: 1,
      salePriceKrw: 19900
    });

    expect(prisma.coupangProduct.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        displayName: "Zero Bar"
      }),
      include: { group: true, productRules: true, costRules: true }
    });
    expect(prisma.coupangProduct.create.mock.calls[0][0].data).not.toHaveProperty("productRules");
    expect(prisma.coupangProduct.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        displayName: "Black Socks"
      }),
      include: { group: true, productRules: true, costRules: true }
    });
    expect(prisma.coupangProduct.create.mock.calls[1][0].data).not.toHaveProperty("productRules");
    expect(prisma.coupangProduct.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { displayName: "Black Socks Updated" }
    });
    expect(prisma.coupangCostRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        coupangProductId: "product-1",
        salePriceKrw: new Prisma.Decimal(19900)
      })
    });
    expect(prisma.coupangProductRule.findFirst).not.toHaveBeenCalled();
    expect(prisma.coupangProductRule.create).not.toHaveBeenCalled();
    expect(prisma.coupangProductRule.update).not.toHaveBeenCalled();
  });

  it("deactivates only the product when deleting product settings", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await service.deleteProductSetting("product-1");

    expect(prisma.coupangProduct.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { isActive: false }
    });
    expect(prisma.coupangProductRule.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates, updates, and soft deletes Coupang product groups", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await service.createProductGroup({ displayName: "Gyro Ball", sortOrder: "5" });
    await service.updateProductGroup("group-1", { displayName: "Gyro Ball Set", sortOrder: "7", isActive: false });
    await service.deleteProductGroup("group-1");

    expect(prisma.coupangProductGroup.create).toHaveBeenCalledWith({
      data: {
        standardName: "gyro ball",
        displayName: "Gyro Ball",
        sortOrder: 5,
        isActive: true
      },
      include: { products: true }
    });
    expect(prisma.coupangProductGroup.update).toHaveBeenNthCalledWith(1, {
      where: { id: "group-1" },
      data: { displayName: "Gyro Ball Set", sortOrder: 7, isActive: false },
      include: { products: true }
    });
    expect(prisma.coupangProductGroup.update).toHaveBeenNthCalledWith(2, {
      where: { id: "group-1" },
      data: { isActive: false },
      include: { products: true }
    });
  });

  it("connects and clears product setting groupId without creating mapping rules", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await service.createProductSetting({ displayName: "Grouped Product", groupId: "group-1" });
    await service.updateProductSetting("product-1", { groupId: null });

    expect(prisma.coupangProductGroup.findUnique).toHaveBeenCalledWith({ where: { id: "group-1" } });
    expect(prisma.coupangProduct.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        displayName: "Grouped Product",
        group: { connect: { id: "group-1" } }
      }),
      include: { group: true, productRules: true, costRules: true }
    });
    expect(prisma.coupangProduct.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { group: { disconnect: true } }
    });
    expect(prisma.coupangProductRule.create).not.toHaveBeenCalled();
  });

  it("rejects missing product groups on product setting updates", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await expect(service.updateProductSetting("product-1", { groupId: "missing-group" })).rejects.toMatchObject({
      response: expect.objectContaining({ code: "COUPANG_PRODUCT_GROUP_NOT_FOUND" })
    });
  });

  it("updates product configuration and creates a new cost rule", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await service.updateProductConfiguration("product-1", {
      displayName: "Black Socks Updated",
      standardName: "Black Socks Updated",
      groupId: "group-1",
      salePriceKrw: 24900,
      supplyPriceKrw: 12000,
      productCostKrw: 7000,
      effectiveFrom: "2026-07-06"
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.coupangProduct.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: {
        displayName: "Black Socks Updated",
        standardName: "black socks updated",
        group: { connect: { id: "group-1" } }
      }
    });
    expect(prisma.coupangCostRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        coupangProductId: "product-1",
        salePriceKrw: new Prisma.Decimal(24900),
        supplyPriceKrw: new Prisma.Decimal(12000),
        productCostKrw: new Prisma.Decimal(7000),
        salesFeeRate: new Prisma.Decimal(0),
        salesFeeKrw: new Prisma.Decimal(0),
        effectiveFrom: toDateOnly("2026-07-06")
      })
    });
  });

  it("rejects product-level sales fee writes after globalisation", async () => {
    const service = new CoupangService(fakeCoupangProductSettingPrisma() as never);

    await expect(service.updateProductConfiguration("product-1", { salesFeeRate: 0 })).rejects.toMatchObject({
      response: expect.objectContaining({ code: "COUPANG_SALES_FEE_IS_GLOBAL" })
    });
  });

  it("merges a partial shipping PATCH with the latest cost snapshot", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    vi.mocked(prisma.coupangCostRule.findFirst).mockImplementationOnce(async () => null).mockResolvedValueOnce({
      salePriceKrw: new Prisma.Decimal(24_000),
      supplyPriceKrw: new Prisma.Decimal(12_000),
      productCostKrw: new Prisma.Decimal(7_000),
      salesFeeRate: new Prisma.Decimal(0.11),
      salesFeeKrw: new Prisma.Decimal(1_800),
      sellerShippingFeeKrw: new Prisma.Decimal(3_000),
      hanaroShippingFeeKrw: new Prisma.Decimal(650),
      growthInboundFeeKrw: new Prisma.Decimal(500),
      growthShippingFeeKrw: new Prisma.Decimal(1_200),
      returnRate: new Prisma.Decimal(0.04),
      returnCostPerUnitKrw: new Prisma.Decimal(2_500),
      extraCostKrw: new Prisma.Decimal(300),
      note: "preserve me"
    });
    const service = new CoupangService(prisma as never);

    await service.updateProductConfiguration("product-1", {
      hanaroShippingFeeKrw: 700,
      effectiveFrom: "2026-07-22"
    });

    expect(prisma.coupangCostRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        coupangProductId: "product-1",
        salePriceKrw: new Prisma.Decimal(24_000),
        productCostKrw: new Prisma.Decimal(7_000),
        sellerShippingFeeKrw: new Prisma.Decimal(3_000),
        hanaroShippingFeeKrw: new Prisma.Decimal(700),
        growthInboundFeeKrw: new Prisma.Decimal(500),
        growthShippingFeeKrw: new Prisma.Decimal(1_200),
        note: "preserve me"
      })
    });
  });

  it("persists explicit null shipping fees instead of omitting them", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await service.updateProductConfiguration("product-1", {
      sellerShippingFeeKrw: null,
      hanaroShippingFeeKrw: null,
      effectiveFrom: "2026-07-22"
    });

    expect(prisma.coupangCostRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sellerShippingFeeKrw: null,
        hanaroShippingFeeKrw: null
      })
    });
  });

  it.each([
    ["createProductSetting", (service: CoupangService, field: string, value: unknown) => service.createProductSetting({
      displayName: "Invalid Shipping Product",
      [field]: value
    })],
    ["updateProductSetting", (service: CoupangService, field: string, value: unknown) => service.updateProductSetting("product-1", {
      displayName: "Must Not Persist",
      [field]: value
    })],
    ["updateProductConfiguration", (service: CoupangService, field: string, value: unknown) => service.updateProductConfiguration("product-1", {
      [field]: value,
      effectiveFrom: "2026-07-22"
    })]
  ] as const)("validates every logistics cost through %s", async (_entryPoint, request) => {
    const fields = [
      ["sellerShippingFeeKrw", "INVALID_SELLER_SHIPPING_FEE"],
      ["hanaroShippingFeeKrw", "INVALID_HANARO_SHIPPING_FEE"],
      ["growthInboundFeeKrw", "INVALID_GROWTH_INBOUND_FEE"],
      ["growthShippingFeeKrw", "INVALID_GROWTH_SHIPPING_FEE"]
    ] as const;
    const invalidValues = ["not-a-number", Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5] as const;

    for (const [field, fieldCode] of fields) {
      for (const value of invalidValues) {
        const prisma = fakeCoupangProductSettingPrisma();
        const service = new CoupangService(prisma as never);
        await expect(request(service, field, value)).rejects.toMatchObject({
          response: { code: fieldCode, field, message: expect.stringContaining(field) }
        });
        expect(prisma.coupangCostRule.create).not.toHaveBeenCalled();
      }
    }
  });

  it.each([
    ["salePriceKrw", "INVALID_SALE_PRICE"],
    ["supplyPriceKrw", "INVALID_SUPPLY_PRICE"],
    ["productCostKrw", "INVALID_PRODUCT_COST"],
    ["sellerShippingFeeKrw", "INVALID_SELLER_SHIPPING_FEE"],
    ["hanaroShippingFeeKrw", "INVALID_HANARO_SHIPPING_FEE"],
    ["growthInboundFeeKrw", "INVALID_GROWTH_INBOUND_FEE"],
    ["growthShippingFeeKrw", "INVALID_GROWTH_SHIPPING_FEE"],
    ["returnCostPerUnitKrw", "INVALID_RETURN_COST_PER_UNIT"],
    ["extraCostKrw", "INVALID_EXTRA_COST"]
  ] as const)("reports the field and field-specific code for invalid %s", async (field, code) => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await expect(service.createProductSetting({ displayName: "Invalid Money", [field]: true })).rejects.toMatchObject({
      response: { code, field, message: expect.stringContaining(field) }
    });
    expect(prisma.coupangProduct.create).not.toHaveBeenCalled();
  });

  it("rejects caller-managed effectiveTo when creating a product", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await expect(service.createProductSetting({
      displayName: "Invalid Range",
      salePriceKrw: 10_000,
      effectiveFrom: "2026-07-01",
      effectiveTo: "2026-07-31"
    })).rejects.toMatchObject({
      response: { code: "COUPANG_COST_RULE_EFFECTIVE_TO_MANAGED" }
    });
    expect(prisma.coupangProduct.create).not.toHaveBeenCalled();
  });

  it("uses the explicit Asia/Seoul calendar date for a new product cost snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T15:00:00.000Z"));
    try {
      const prisma = fakeCoupangProductSettingPrisma();
      const service = new CoupangService(prisma as never);

      await service.createProductSetting({ displayName: "KST Product", salePriceKrw: 10_000 });

      expect(prisma.coupangProduct.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          costRules: { create: expect.objectContaining({ effectiveFrom: toDateOnly("2026-07-23") }) }
        })
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an explicitly supplied blank effectiveFrom on product creation", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await expect(service.createProductSetting({
      displayName: "Blank Date",
      salePriceKrw: 10_000,
      effectiveFrom: ""
    })).rejects.toMatchObject({ response: { code: "INVALID_DATE" } });
    expect(prisma.coupangProduct.create).not.toHaveBeenCalled();
  });

  it("does not create a cost rule when configuration has no cost fields", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    vi.mocked(prisma.coupangProductRule.findFirst).mockResolvedValueOnce({ id: "rule-primary", coupangProductId: "product-1" });
    const service = new CoupangService(prisma as never);

    await service.updateProductConfiguration("product-1", {
      displayName: "Black Socks Renamed",
      includeKeywords: ["Black Socks"],
      excludeKeywords: ["Gift"],
      priority: "3"
    });

    expect(prisma.coupangCostRule.create).not.toHaveBeenCalled();
    expect(prisma.coupangProductRule.update).toHaveBeenCalledWith({
      where: { id: "rule-primary" },
      data: {
        displayName: "Black Socks Renamed",
        includeKeywords: ["Black Socks"],
        excludeKeywords: ["Gift"],
        priority: 3,
        isActive: true
      }
    });
  });

  it("creates a primary mapping rule when none exists and include keywords are provided", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await service.updateProductConfiguration("product-1", {
      displayName: "Black Socks",
      includeKeywords: "Black, Socks",
      excludeKeywords: "Gift, Sample",
      priority: "5"
    });

    expect(prisma.coupangProductRule.create).toHaveBeenCalledWith({
      data: {
        coupangProductId: "product-1",
        displayName: "Black Socks",
        includeKeywords: ["Black", "Socks"],
        excludeKeywords: ["Gift", "Sample"],
        priority: 5,
        adEnabled: true,
        isActive: true
      }
    });
  });

  it("rejects configuration updates for a mapping rule owned by another product", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await expect(
      service.updateProductConfiguration("product-1", {
        mappingRuleId: "other-rule",
        includeKeywords: ["Other"]
      })
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "COUPANG_RULE_PRODUCT_MISMATCH" })
    });
    expect(prisma.coupangProductRule.update).not.toHaveBeenCalled();
  });

  it("rejects empty include keywords on configuration mapping updates", async () => {
    const prisma = fakeCoupangProductSettingPrisma();
    const service = new CoupangService(prisma as never);

    await expect(service.updateProductConfiguration("product-1", { includeKeywords: [] })).rejects.toMatchObject({
      response: expect.objectContaining({ code: "FIELD_REQUIRED" })
    });
    expect(prisma.coupangProductRule.update).not.toHaveBeenCalled();
    expect(prisma.coupangProductRule.create).not.toHaveBeenCalled();
  });

  it("creates, updates, and disables Coupang mapping rules", async () => {
    const prisma = fakeCoupangMappingRulePrisma();
    const service = new CoupangService(prisma as never);

    await service.createMappingRule({
      coupangProductId: "product-1",
      includeKeywords: "Zero, Black",
      excludeKeywords: ["Sample"],
      validFrom: "2026-06-01"
    });
    await service.updateMappingRule("rule-1", {
      includeKeywords: ["Zero Bar"],
      excludeKeywords: "Sample, Gift",
      priority: "5",
      isActive: false,
      validTo: null
    });
    await service.deleteMappingRule("rule-1");

    expect(prisma.coupangProductRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        coupangProductId: "product-1",
        displayName: "Zero Bar",
        includeKeywords: ["Zero", "Black"],
        excludeKeywords: ["Sample"],
        priority: 100,
        validFrom: toDateOnly("2026-06-01")
      }),
      include: { product: true }
    });
    expect(prisma.coupangProductRule.update).toHaveBeenCalledWith({
      where: { id: "rule-1" },
      data: expect.objectContaining({
        includeKeywords: ["Zero Bar"],
        excludeKeywords: ["Sample", "Gift"],
        priority: 5,
        isActive: false,
        validTo: null
      }),
      include: { product: true }
    });
    expect(prisma.coupangProductRule.update).toHaveBeenLastCalledWith({
      where: { id: "rule-1" },
      data: { isActive: false },
      include: { product: true }
    });
  });
});

describe("Coupang product cost history invariants", () => {
  it("serializes reverse-order bulk imports before taking per-product locks", async () => {
    const service = new CoupangService({} as never) as any;
    const trace: string[] = [];
    let queue = Promise.resolve();

    async function simulatedBulkImport(name: string, productIds: string[]) {
      const predecessor = queue;
      let release: () => void = () => {};
      queue = new Promise<void>((resolve) => { release = resolve; });
      const tx = {
        $queryRaw: vi.fn(async (rawQuery: any) => {
          const query = rawQuery as { values?: unknown[] };
          if ((query.values?.length ?? 0) === 0) {
            await predecessor;
            trace.push(`${name}:bulk`);
          } else {
            trace.push(`${name}:${String(query.values?.[0]).replace("coupang-cost-rule:", "")}`);
          }
          return [];
        })
      };
      try {
        await service.lockCoupangCostRuleBulkWrites(tx);
        for (const productId of productIds) {
          await service.lockCoupangCostRuleWrites(tx, productId);
        }
      } finally {
        release();
      }
    }

    await Promise.all([
      simulatedBulkImport("first", ["product-b", "product-a"]),
      simulatedBulkImport("second", ["product-a", "product-b"])
    ]);

    expect(trace).toEqual([
      "first:bulk", "first:product-b", "first:product-a",
      "second:bulk", "second:product-a", "second:product-b"
    ]);
  });

  it("returns the zero-valued rule effective on the requested date even when a future rule exists", async () => {
    const fixture = costHistoryFixture([
      costHistoryRule("current-zero", "2026-07-01", "2026-07-21", 0),
      costHistoryRule("future", "2026-07-22", null, 9_000)
    ]);
    const [product] = await new CoupangService(fixture.prisma as never).listProductSettings(false, "2026-07-20");
    expect(product.currentCostRule?.id).toBe("current-zero");
    expect(Number(product.currentCostRule?.productCostKrw)).toBe(0);
    expect(product.costRules.map((rule: { id: string }) => rule.id)).toEqual(["future", "current-zero"]);
  });

  it("inserts an intermediate snapshot from the preceding rule and normalizes adjacent ranges", async () => {
    const fixture = costHistoryFixture([
      costHistoryRule("old", "2026-07-01", "2026-07-21", 7_000, { supplyPriceKrw: 12_000 }),
      costHistoryRule("future", "2026-07-22", null, 9_000, { supplyPriceKrw: 15_000 })
    ]);
    const result = await new CoupangService(fixture.prisma as never).updateProductConfiguration("product-1", {
      productCostKrw: 8_000,
      effectiveFrom: "2026-07-10"
    });
    expect(result.costRuleChange).toMatchObject({ operation: "CREATED", effectiveFrom: "2026-07-10", effectiveTo: "2026-07-21", nextRuleEffectiveFrom: "2026-07-22" });
    expect(Number(fixture.rule("created-1").supplyPriceKrw)).toBe(12_000);
    expect(formatRuleRange(fixture.rule("old"))).toEqual(["2026-07-01", "2026-07-09"]);
    expect(formatRuleRange(fixture.rule("future"))).toEqual(["2026-07-22", null]);
    expect(String(((fixture.lock as any).mock.calls[0]?.[0] as Prisma.Sql).sql))
      .toContain(")::text AS lock_result");
  });

  it("updates a same-date snapshot without creating a duplicate and preserves legacy fee audit fields", async () => {
    const fixture = costHistoryFixture([costHistoryRule("same", "2026-07-23", null, 7_000, { salesFeeRate: 0.1188, salesFeeKrw: 1_000 })]);
    const result = await new CoupangService(fixture.prisma as never).updateProductConfiguration("product-1", {
      supplyPriceKrw: 15_000,
      productCostKrw: 12_800,
      effectiveFrom: "2026-07-23"
    });
    expect(result.costRuleChange?.operation).toBe("UPDATED_SAME_DATE");
    expect(fixture.create).not.toHaveBeenCalled();
    expect(Number(fixture.rule("same").supplyPriceKrw)).toBe(15_000);
    expect(Number(fixture.rule("same").productCostKrw)).toBe(12_800);
    expect(Number(fixture.rule("same").salesFeeRate)).toBe(0.1188);
    expect(Number(fixture.rule("same").salesFeeKrw)).toBe(1_000);
  });

  it("rejects moving a correction onto another history date", async () => {
    const fixture = costHistoryFixture([
      costHistoryRule("old", "2026-07-01", "2026-07-21", 7_000),
      costHistoryRule("new", "2026-07-22", null, 9_000)
    ]);
    await expect(new CoupangService(fixture.prisma as never).correctProductCostRule("product-1", "old", { effectiveFrom: "2026-07-22" }))
      .rejects.toMatchObject({ response: { code: "COUPANG_COST_RULE_DATE_EXISTS" } });
  });

  it("moves a cost rule past its former end without violating the range check", async () => {
    const fixture = costHistoryFixture([
      costHistoryRule("moving", "2026-07-01", "2026-07-21", 7_000),
      costHistoryRule("current", "2026-07-22", null, 9_000)
    ]);

    await new CoupangService(fixture.prisma as never).correctProductCostRule(
      "product-1",
      "moving",
      { effectiveFrom: "2026-08-01" }
    );

    expect(formatRuleRange(fixture.rule("current"))).toEqual(["2026-07-22", "2026-07-31"]);
    expect(formatRuleRange(fixture.rule("moving"))).toEqual(["2026-08-01", null]);
  });

  it("maps Prisma camelCase unique metadata to the public date collision error", async () => {
    const fixture = costHistoryFixture([]);
    fixture.create.mockRejectedValueOnce({ code: "P2002", meta: { target: ["coupangProductId", "effectiveFrom"] } });
    await expect(new CoupangService(fixture.prisma as never).updateProductConfiguration("product-1", {
      productCostKrw: 7_000,
      effectiveFrom: "2026-07-23"
    })).rejects.toMatchObject({ response: { code: "COUPANG_COST_RULE_DATE_EXISTS" } });
  });

  it("rejects deleting an older upload after a newer cost snapshot and keeps its batch", async () => {
    const rule = costHistoryRule("shared", "2026-07-23", null, 9_000);
    const afterOlderUpload = costRuleJsonSnapshot(costHistoryRule("shared", "2026-07-23", null, 7_000));
    const fixture = costHistoryFixture([rule], {
      upload: {
        id: "older-upload",
        sourceType: CoupangUploadSourceType.PRICE_TEXT,
        validRowCount: 1,
        columnSchema: { appliedRows: [{ productId: "product-1", costRuleId: "shared", costRuleOperation: "UPDATED_SAME_DATE", costRuleBefore: afterOlderUpload, costRuleAfter: afterOlderUpload }] }
      }
    });
    await expect(new CoupangService(fixture.prisma as never).deleteUpload("older-upload"))
      .rejects.toMatchObject({ response: { code: "COUPANG_UPLOAD_ROLLBACK_ORDER_CONFLICT" } });
    expect(fixture.deleteUpload).not.toHaveBeenCalled();
    expect(fixture.lock.mock.invocationCallOrder[0]).toBeLessThan(fixture.findUniqueCost.mock.invocationCallOrder[0]);
    expect(String(((fixture.lock as any).mock.calls[0]?.[0] as Prisma.Sql).sql))
      .toContain("pg_advisory_xact_lock(7426894320158628)::text AS lock_result");
  });
});

describe("Coupang manual-purchase quantity-based cost flow", () => {
  const manualPurchaseTransactionPrisma = (
    delegates: Record<string, unknown>,
    manualPurchaseDelegate: Record<string, unknown> = {}
  ) => {
    const transactionClient = {
      ...delegates,
      coupangManualPurchase: manualPurchaseDelegate,
      $queryRaw: vi.fn(async () => [])
    };
    const transaction = vi.fn(async (callback: (client: typeof transactionClient) => unknown) => callback(transactionClient));
    return {
      prisma: {
        ...delegates,
        coupangManualPurchase: manualPurchaseDelegate,
        $transaction: transaction
      },
      transaction,
      transactionClient
    };
  };

  it("validates every replacement entry before deleting the date", async () => {
    const deleteMany = vi.fn();
    const service = new CoupangService({
      appSetting: { findUnique: vi.fn(async () => null) },
      coupangManualPurchase: { deleteMany }
    } as never);

    await expect(service.replaceManualPurchasesForDate("2026-07-21", {
      entries: [{ coupangProductId: "product-1", quantity: 1.5 }]
    })).rejects.toMatchObject({ response: { code: "INVALID_MANUAL_PURCHASE_FIELD", field: "quantity" } });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("rejects duplicate products instead of silently keeping the last entry", async () => {
    const service = new CoupangService({ appSetting: { findUnique: vi.fn(async () => null) } } as never);
    const entry = { coupangProductId: "product-1", quantity: 1 };
    await expect(service.replaceManualPurchasesForDate("2026-07-21", { entries: [entry, entry] }))
      .rejects.toMatchObject({ response: { code: "DUPLICATE_MANUAL_PURCHASE_PRODUCT" } });
  });

  it("stores base-price sales and only the vendor fee as manual-purchase cost", async () => {
    let created: any[] = [];
    const promotionPriceFindMany = vi.fn(async () => [{
      coupangProductId: "product-1",
      promotionPriceKrw: new Prisma.Decimal(1)
    }]);
    const product = { id: "product-1", displayName: "테스트 상품", standardName: "테스트", group: null, productRules: [] };
    const manualPurchaseDelegate = {
      deleteMany: vi.fn(),
      createMany: vi.fn(async ({ data }: { data: any[] }) => { created = data; }),
      findMany: vi.fn(async () => created.map((row, index) => ({
        ...row,
        id: `manual-${index}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        product,
        productRule: null
      })))
    };
    const delegates = {
      ...globalSalesFeeRulePrisma(),
      appSetting: { findUnique: vi.fn(async () => null) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangProductRule: { findMany: vi.fn(async () => []) },
      coupangCostRule: { findMany: vi.fn(async () => [{
        coupangProductId: "product-1",
        salePriceKrw: new Prisma.Decimal(24_000),
        supplyPriceKrw: new Prisma.Decimal(0),
        productCostKrw: new Prisma.Decimal(10_000),
        salesFeeRate: new Prisma.Decimal(0.11),
        salesFeeKrw: new Prisma.Decimal(0),
        sellerShippingFeeKrw: new Prisma.Decimal(3_000),
        growthInboundFeeKrw: new Prisma.Decimal(0),
        growthShippingFeeKrw: new Prisma.Decimal(0),
        returnRate: new Prisma.Decimal(0),
        returnCostPerUnitKrw: new Prisma.Decimal(0),
        extraCostKrw: new Prisma.Decimal(300),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      }]) },
      coupangPromotionPrice: { findMany: promotionPriceFindMany }
    };
    const { prisma } = manualPurchaseTransactionPrisma(delegates, manualPurchaseDelegate);
    const service = new CoupangService(prisma as never);

    const result = await service.replaceManualPurchasesForDate("2026-07-21", {
      entries: [{
        coupangProductId: "product-1",
        quantity: 2
      }]
    });

    expect(created).toHaveLength(1);
    expect(Number(created[0].salesAmountKrw)).toBe(48_000);
    expect(Number(created[0].productCostKrw)).toBe(0);
    expect(Number(created[0].vendorFeeTotalKrw)).toBe(6_364);
    expect(Number(created[0].coupangSalesFeeKrw)).toBe(0);
    expect(Number(created[0].salesFeeRateApplied)).toBe(0);
    expect(Number(created[0].shippingCostKrw)).toBe(0);
    expect(created[0]).not.toHaveProperty("vatKrw");
    expect(Number(created[0].otherCostKrw)).toBe(0);
    expect(created[0]).toMatchObject({ priceSource: "BASE", promotionPriceKrw: null });
    expect(Number(created[0].salePriceKrw)).toBe(24_000);
    expect(Number(created[0].totalCostKrw)).toBe(6_364);
    expect(result).toMatchObject({ selectedOptionCount: 1, totalQuantity: 2, totalSalesAmountKrw: 48_000 });
    expect(result.totalCostKrw).toBe(6_364);
    expect(result.rows[0]).toMatchObject({
      productCostKrw: 0,
      coupangSalesFeeKrw: 0,
      shippingCostKrw: 0,
      otherCostKrw: 0
    });
    expect(promotionPriceFindMany).not.toHaveBeenCalled();
  });

  it("stores a memo-only row at zero quantity without requiring a cost rule", async () => {
    let created: any[] = [];
    const product = {
      id: "product-1",
      displayName: "메모 전용 상품",
      standardName: "메모 전용",
      group: null,
      productRules: []
    };
    const manualPurchaseDelegate = {
      deleteMany: vi.fn(),
      createMany: vi.fn(async ({ data }: { data: any[] }) => { created = data; }),
      findMany: vi.fn(async () => created.map((row, index) => ({
        ...row,
        id: `manual-${index}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        product,
        productRule: null
      })))
    };
    const { prisma } = manualPurchaseTransactionPrisma({
      appSetting: { findUnique: vi.fn(async () => null) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangProductRule: { findMany: vi.fn(async () => []) },
      coupangCostRule: { findMany: vi.fn(async () => []) }
    }, manualPurchaseDelegate);
    const service = new CoupangService(prisma as never);

    const result = await service.replaceManualPurchasesForDate("2026-07-21", {
      entries: [{
        coupangProductId: product.id,
        quantity: 0,
        memo: " 리뷰 보강 "
      }]
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      quantity: 0,
      memo: "리뷰 보강",
      salesAmountKrw: new Prisma.Decimal(0),
      salePriceKrw: null,
      baseSalePriceKrw: null,
      priceSource: null,
      vendorFeeTotalKrw: new Prisma.Decimal(0),
      totalCostKrw: new Prisma.Decimal(0)
    });
    expect(result).toMatchObject({
      selectedOptionCount: 1,
      totalQuantity: 0,
      totalSalesAmountKrw: 0,
      totalCostKrw: 0
    });
    expect(result.rows[0]).toMatchObject({
      quantity: 0,
      memo: "리뷰 보강",
      salesAmountKrw: 0,
      totalCostKrw: 0,
      warnings: []
    });
  });

  it("serializes the vendor fee as the total and warns on a one-cent stored mismatch", async () => {
    const service = new CoupangService({
      coupangManualPurchase: {
        findMany: vi.fn(async () => [{
          id: "manual-mismatch",
          purchaseDate: new Date("2026-07-21T00:00:00.000Z"),
          coupangProductId: "product-1",
          coupangProductRuleId: null,
          productDisplayName: "합계 불일치 상품",
          ruleDisplayName: null,
          saleMethod: null,
          quantity: 1,
          salesAmountKrw: new Prisma.Decimal(24_000),
          productCostKrw: new Prisma.Decimal(0),
          vendorFeePerUnitKrw: new Prisma.Decimal(3_182),
          vendorFeeTotalKrw: new Prisma.Decimal(3_182),
          salePriceKrw: new Prisma.Decimal(24_000),
          baseSalePriceKrw: new Prisma.Decimal(24_000),
          promotionPriceKrw: null,
          priceSource: "BASE",
          coupangSalesFeeKrw: new Prisma.Decimal(0),
          salesFeeRateApplied: new Prisma.Decimal(0),
          shippingCostKrw: new Prisma.Decimal(0),
          otherCostKrw: new Prisma.Decimal(0),
          totalCostKrw: new Prisma.Decimal("3181.99"),
          memo: null,
          product: { group: null },
          productRule: null
        }])
      }
    } as never);

    const result = await service.listManualPurchases({ from: "2026-07-21", to: "2026-07-21" });

    expect(result.rows[0]).toMatchObject({
      vendorFeeTotalKrw: 3_182,
      totalCostKrw: 3_182
    });
    expect(result.rows[0]).not.toHaveProperty("vatKrw");
    expect(result.rows[0].warnings).toContain("MANUAL_PURCHASE_TOTAL_COST_MISMATCH");
  });

  it("rejects an out-of-range derived vendor-fee total before replacing rows", async () => {
    const product = { id: "product-1", displayName: "테스트 상품", standardName: "테스트", group: null, productRules: [] };
    const deleteMany = vi.fn();
    const createMany = vi.fn();
    const { prisma, transaction } = manualPurchaseTransactionPrisma({
      ...globalSalesFeeRulePrisma(),
      appSetting: { findUnique: vi.fn(async () => null) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangProductRule: { findMany: vi.fn(async () => []) },
      coupangCostRule: { findMany: vi.fn(async () => [{
        coupangProductId: "product-1",
        salePriceKrw: new Prisma.Decimal(1),
        supplyPriceKrw: new Prisma.Decimal(0),
        productCostKrw: new Prisma.Decimal(400_000_000_000),
        salesFeeRate: new Prisma.Decimal(0),
        salesFeeKrw: new Prisma.Decimal(0),
        sellerShippingFeeKrw: new Prisma.Decimal(0),
        growthInboundFeeKrw: new Prisma.Decimal(0),
        growthShippingFeeKrw: new Prisma.Decimal(0),
        returnRate: new Prisma.Decimal(0),
        returnCostPerUnitKrw: new Prisma.Decimal(0),
        extraCostKrw: new Prisma.Decimal(0),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      }]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    }, { deleteMany, createMany, findMany: vi.fn(async () => []) });
    const service = new CoupangService(prisma as never);

    await expect(service.replaceManualPurchasesForDate("2026-07-21", {
      vendorFeePerUnitKrw: 500_000_000_000,
      entries: [{ coupangProductId: "product-1", quantity: 2 }]
    })).rejects.toMatchObject({ response: { code: "MANUAL_PURCHASE_AMOUNT_OUT_OF_RANGE", field: "vendorFeeTotalKrw" } });
    expect(transaction).toHaveBeenCalledOnce();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("ignores unrelated product and other costs even when they exceed manual snapshot range", async () => {
    const product = { id: "product-1", displayName: "기타비용 범위 상품", standardName: "기타비용", group: null, productRules: [] };
    const deleteMany = vi.fn();
    const createMany = vi.fn();
    const { prisma, transaction } = manualPurchaseTransactionPrisma({
      ...globalSalesFeeRulePrisma(),
      appSetting: { findUnique: vi.fn(async () => null) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangProductRule: { findMany: vi.fn(async () => []) },
      coupangCostRule: { findMany: vi.fn(async () => [{
        coupangProductId: product.id,
        salePriceKrw: new Prisma.Decimal(1),
        supplyPriceKrw: new Prisma.Decimal(0),
        productCostKrw: new Prisma.Decimal(0),
        salesFeeRate: new Prisma.Decimal(0),
        salesFeeKrw: new Prisma.Decimal(0),
        sellerShippingFeeKrw: new Prisma.Decimal(0),
        growthInboundFeeKrw: new Prisma.Decimal(0),
        growthShippingFeeKrw: new Prisma.Decimal(0),
        returnRate: new Prisma.Decimal(0),
        returnCostPerUnitKrw: new Prisma.Decimal(0),
        extraCostKrw: new Prisma.Decimal(1_000_000_000_000),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      }]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    }, { deleteMany, createMany, findMany: vi.fn(async () => []) });
    const service = new CoupangService(prisma as never);

    await expect(service.replaceManualPurchasesForDate("2026-07-21", {
      vendorFeePerUnitKrw: 1,
      entries: [{ coupangProductId: product.id, quantity: 1 }]
    })).resolves.toMatchObject({ date: "2026-07-21" });
    expect(transaction).toHaveBeenCalledOnce();
    expect(deleteMany).toHaveBeenCalledOnce();
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ productCostKrw: new Prisma.Decimal(0), otherCostKrw: new Prisma.Decimal(0) })]
    });
  });

  it.each([
    ["RATE", 0.1, 0],
    ["PER_UNIT", 0, 1_000]
  ] as const)("rejects a missing positive sale price for %s sales adjustment before replacement", async (_mode, salesFeeRate, salesFeeKrw) => {
    const product = {
      id: "product-1",
      displayName: "가격 누락 상품",
      standardName: "가격 누락",
      group: null,
      productRules: [{
        id: "rule-1",
        coupangProductId: "product-1",
        displayName: "가격 누락 규칙",
        saleMethod: "판매자배송",
        includeKeywords: ["가격 누락"],
        excludeKeywords: []
      }]
    };
    const costRule = {
      coupangProductId: "product-1",
      salePriceKrw: new Prisma.Decimal(0),
      supplyPriceKrw: new Prisma.Decimal(0),
      productCostKrw: new Prisma.Decimal(2_000),
      salesFeeRate: new Prisma.Decimal(salesFeeRate),
      salesFeeKrw: new Prisma.Decimal(salesFeeKrw),
      sellerShippingFeeKrw: new Prisma.Decimal(1_000),
      growthInboundFeeKrw: new Prisma.Decimal(0),
      growthShippingFeeKrw: new Prisma.Decimal(0),
      returnRate: new Prisma.Decimal(0),
      returnCostPerUnitKrw: new Prisma.Decimal(0),
      extraCostKrw: new Prisma.Decimal(0),
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    };
    const deleteMany = vi.fn();
    const createMany = vi.fn();
    const { prisma, transaction } = manualPurchaseTransactionPrisma({
      ...globalSalesFeeRulePrisma(),
      appSetting: { findUnique: vi.fn(async () => null) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangProductRule: { findMany: vi.fn(async () => []) },
      coupangCostRule: { findMany: vi.fn(async () => [costRule]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    }, { deleteMany, createMany, findMany: vi.fn(async () => []) });
    const service = new CoupangService(prisma as never);

    const options = await service.manualPurchaseOptions({ date: "2026-07-21" });
    expect(options.options[0]).toMatchObject({ isCalculable: false, unitSalesAmountKrw: null, unitTotalCostKrw: null });
    expect(options.options[0]).not.toHaveProperty("unitVatKrw");
    expect(options.options[0].warnings).toContain("COUPANG_BASE_SALE_PRICE_REQUIRED");

    await expect(service.replaceManualPurchasesForDate("2026-07-21", {
      entries: [{ coupangProductId: "product-1", quantity: 1 }]
    })).rejects.toMatchObject({ response: { code: "COUPANG_BASE_SALE_PRICE_REQUIRED" } });
    expect(transaction).toHaveBeenCalledOnce();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("builds quantity options, preserves inactive rows, and resolves exact cost-rule ties by id", async () => {
    const activeProduct = {
      id: "active-product",
      displayName: "활성 상품",
      standardName: "활성",
      group: null,
      productRules: [{
        id: "active-rule",
        coupangProductId: "active-product",
        displayName: "활성 규칙",
        saleMethod: "판매자배송",
        includeKeywords: ["활성"],
        excludeKeywords: []
      }]
    };
    const inactiveProduct = { id: "inactive-product", displayName: "비활성 상품", standardName: "비활성", group: null };
    const existing = {
      id: "manual-legacy",
      coupangProductId: "inactive-product",
      coupangProductRuleId: null,
      productDisplayName: "비활성 상품",
      ruleDisplayName: null,
      saleMethod: null,
      quantity: 2,
      salesAmountKrw: null,
      vendorFeeTotalKrw: new Prisma.Decimal(100),
      coupangSalesFeeKrw: new Prisma.Decimal(0),
      shippingCostKrw: new Prisma.Decimal(0),
      otherCostKrw: new Prisma.Decimal(0),
      totalCostKrw: new Prisma.Decimal(100),
      memo: "legacy",
      product: inactiveProduct,
      productRule: null
    };
    const service = new CoupangService({
      ...globalSalesFeeRulePrisma(),
      appSetting: { findUnique: vi.fn(async () => null) },
      coupangProduct: { findMany: vi.fn(async () => [activeProduct]) },
      coupangManualPurchase: { findMany: vi.fn(async () => [existing]) },
      coupangCostRule: { findMany: vi.fn(async () => [{
        id: "00000000-0000-0000-0000-000000000001",
        coupangProductId: "active-product",
        salePriceKrw: new Prisma.Decimal(23_000),
        supplyPriceKrw: new Prisma.Decimal(0),
        productCostKrw: new Prisma.Decimal(9_000),
        salesFeeRate: new Prisma.Decimal(0.1),
        salesFeeKrw: new Prisma.Decimal(0),
        sellerShippingFeeKrw: new Prisma.Decimal(3_000),
        growthInboundFeeKrw: new Prisma.Decimal(0),
        growthShippingFeeKrw: new Prisma.Decimal(0),
        returnRate: new Prisma.Decimal(0),
        returnCostPerUnitKrw: new Prisma.Decimal(0),
        extraCostKrw: new Prisma.Decimal(0),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      }, {
        id: "00000000-0000-0000-0000-000000000002",
        coupangProductId: "active-product",
        salePriceKrw: new Prisma.Decimal(24_000),
        supplyPriceKrw: new Prisma.Decimal(0),
        productCostKrw: new Prisma.Decimal(10_000),
        salesFeeRate: new Prisma.Decimal(0.1),
        salesFeeKrw: new Prisma.Decimal(0),
        sellerShippingFeeKrw: new Prisma.Decimal(3_000),
        growthInboundFeeKrw: new Prisma.Decimal(0),
        growthShippingFeeKrw: new Prisma.Decimal(0),
        returnRate: new Prisma.Decimal(0),
        returnCostPerUnitKrw: new Prisma.Decimal(0),
        extraCostKrw: new Prisma.Decimal(300),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      }]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    } as never);

    const result = await service.manualPurchaseOptions({ date: "2026-07-21" });
    expect(result.options.map((option) => option.coupangProductId).sort()).toEqual(["active-product", "inactive-product"]);
    const activeOption = result.options.find((option) => option.coupangProductId === "active-product");
    const inactiveOption = result.options.find((option) => option.coupangProductId === "inactive-product");
    expect(activeOption).toMatchObject({
      salePriceKrw: 24_000,
      unitProductCostKrw: 0,
      unitVendorFeeKrw: 3_182,
      unitCoupangSalesFeeKrw: 0,
      unitShippingCostKrw: 0,
      unitOtherCostKrw: 0,
      isCalculable: true
    });
    expect(activeOption).not.toHaveProperty("unitVatKrw");
    expect(activeOption?.unitTotalCostKrw).toBe(3_182);
    expect(inactiveOption).toMatchObject({ existingQuantity: 2, existingMemo: "legacy", isCalculable: false });
    expect(inactiveOption?.warnings).toContain("COUPANG_COST_RULE_MISSING");
  });

  it("separates manual-purchase sales before calculating normal costs and charges snapshots once", async () => {
    const date = new Date("2026-07-21T00:00:00.000Z");
    const product = { id: "product-1", displayName: "테스트 상품" };
    const prisma = {
      ...globalSalesFeeRulePrisma(),
      coupangSaleLine: { findMany: vi.fn(async () => [{
        coupangProductId: "product-1", product, productName: "테스트 상품",
        salesKrw: new Prisma.Decimal(1_000_000), cancelAmountKrw: new Prisma.Decimal(0), netSalesKrw: new Prisma.Decimal(1_000_000),
        salesQuantity: new Prisma.Decimal(100), orderCount: 100, saleMethod: "판매자배송"
      }]) },
      coupangAdMetric: { findMany: vi.fn(async () => []) },
      coupangManualPurchase: { findMany: vi.fn(async () => [{
        coupangProductId: "product-1", product, quantity: 10, salesAmountKrw: new Prisma.Decimal(100_000),
        productCostKrw: new Prisma.Decimal(30_000),
        vendorFeeTotalKrw: new Prisma.Decimal(5_000), coupangSalesFeeKrw: new Prisma.Decimal(10_000), shippingCostKrw: new Prisma.Decimal(20_000),
        otherCostKrw: new Prisma.Decimal(0), totalCostKrw: new Prisma.Decimal(5_000), saleMethod: "판매자배송"
      }]) },
      coupangCostRule: { findMany: vi.fn(async () => [{
        coupangProductId: "product-1", salePriceKrw: new Prisma.Decimal(0), supplyPriceKrw: new Prisma.Decimal(0),
        productCostKrw: new Prisma.Decimal(3_000), salesFeeRate: new Prisma.Decimal(0.1), salesFeeKrw: new Prisma.Decimal(0),
        sellerShippingFeeKrw: new Prisma.Decimal(2_000), growthInboundFeeKrw: new Prisma.Decimal(0), growthShippingFeeKrw: new Prisma.Decimal(0),
        returnRate: new Prisma.Decimal(0), returnCostPerUnitKrw: new Prisma.Decimal(0), extraCostKrw: new Prisma.Decimal(0),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), effectiveTo: null, createdAt: new Date("2026-01-01T00:00:00.000Z")
      }]) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    };
    const service = new CoupangService(prisma as never);
    const rows = await (service as any).buildProductProfitRows({ from: "2026-07-21", to: "2026-07-21", fromDate: date, toDate: date });

    expect(rows[0]).toMatchObject({
      reportedNetSalesKrw: 1_000_000,
      manualPurchaseSalesKrw: 100_000,
      manualPurchaseProductCostKrw: 0,
      actualNetSalesKrw: 900_000,
      actualSalesQuantity: 90,
      productCostKrw: 270_000,
      salesFeeKrw: 90_000,
      shippingCostKrw: 180_000,
      calculationStatus: "COMPLETE"
    });
    expect(rows[0].vatKrw).toBeCloseTo(900_000 / 11);
    expect(rows[0].manualPurchaseTotalCostKrw).toBe(5_000);
    expect(rows[0]).not.toHaveProperty("manualPurchaseVatKrw");
    expect(rows[0].marginKrw).toBeCloseTo(900_000 - 270_000 - 90_000 - 180_000 - 900_000 / 11 - 5_000);
    expect(Math.round(rows[0].marginKrw)).toBe(273_182);
  });

  it("keeps net sales numeric with no manual rows or legacy rows and calculates manual-only costs", async () => {
    const date = new Date("2026-07-21T00:00:00.000Z");
    const product = { id: "product-1", displayName: "테스트 상품" };
    const basePrisma = {
      ...globalSalesFeeRulePrisma(),
      coupangSaleLine: { findMany: vi.fn(async () => [{
        coupangProductId: "product-1", product, productName: "테스트 상품", salesKrw: new Prisma.Decimal(10_000),
        cancelAmountKrw: new Prisma.Decimal(0), netSalesKrw: new Prisma.Decimal(10_000), salesQuantity: new Prisma.Decimal(1), orderCount: 1, saleMethod: "판매자배송"
      }]) },
      coupangAdMetric: { findMany: vi.fn(async () => [{
        spendProductId: "product-1", conversionProductId: "product-1", adSpendKrw: new Prisma.Decimal(500),
        totalConversionSales1dKrw: new Prisma.Decimal(300), totalSalesQuantity1d: new Prisma.Decimal(1)
      }]) },
      coupangCostRule: { findMany: vi.fn(async () => []) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    };
    const range = {
      from: "2026-07-20",
      to: "2026-07-21",
      fromDate: new Date("2026-07-20T00:00:00.000Z"),
      toDate: date
    };

    const withoutManualService = new CoupangService({
      ...basePrisma,
      coupangManualPurchase: { findMany: vi.fn(async () => []) }
    } as never);
    const withoutManualRows = await (withoutManualService as any).buildProductProfitRows(range);
    expect(withoutManualRows[0]).toMatchObject({
      reportedNetSalesKrw: 10_000,
      actualNetSalesKrw: 10_000,
      netSalesKrw: 10_000,
      manualPurchaseQuantity: 0
    });

    const legacyService = new CoupangService({
      ...basePrisma,
      coupangManualPurchase: { findMany: vi.fn(async () => [
        {
          purchaseDate: new Date("2026-07-20T00:00:00.000Z"),
          coupangProductId: "product-1", product, quantity: 1, salesAmountKrw: new Prisma.Decimal(5_000), productCostKrw: new Prisma.Decimal(1_000), vendorFeeTotalKrw: new Prisma.Decimal(50),
          coupangSalesFeeKrw: new Prisma.Decimal(0), shippingCostKrw: new Prisma.Decimal(0),
          otherCostKrw: new Prisma.Decimal(0), totalCostKrw: new Prisma.Decimal(50), saleMethod: null
        },
        {
          purchaseDate: new Date("2026-07-21T00:00:00.000Z"),
          coupangProductId: "product-1", product, quantity: 1, salesAmountKrw: null, productCostKrw: new Prisma.Decimal(2_000), vendorFeeTotalKrw: new Prisma.Decimal(100),
          coupangSalesFeeKrw: new Prisma.Decimal(0), shippingCostKrw: new Prisma.Decimal(0),
          otherCostKrw: new Prisma.Decimal(0), totalCostKrw: new Prisma.Decimal(100), saleMethod: null
        }
      ]) }
    } as never);
    const legacyRows = await (legacyService as any).buildProductProfitRows(range);
    expect(legacyRows[0]).toMatchObject({
      actualSalesKrw: null,
      actualNetSalesKrw: null,
      netSalesKrw: null,
      actualSalesQuantity: 0,
      manualPurchaseProductCostKrw: 0,
      manualCalculationStatus: "INCOMPLETE",
      calculationStatus: "INCOMPLETE",
      totalCostKrw: null,
      marginKrw: null
    });
    expect(legacyRows[0].warnings).not.toContain("AD_CONVERSION_EXCEEDS_NET_SALES");

    const manualOnlyService = new CoupangService({
      ...basePrisma,
      coupangSaleLine: { findMany: vi.fn(async () => []) },
      coupangManualPurchase: { findMany: vi.fn(async () => [{
        purchaseDate: date,
        coupangProductId: "product-1", product, quantity: 1, salesAmountKrw: new Prisma.Decimal(10_000), productCostKrw: new Prisma.Decimal(2_000), vendorFeeTotalKrw: new Prisma.Decimal(100),
        coupangSalesFeeKrw: new Prisma.Decimal(0), shippingCostKrw: new Prisma.Decimal(0),
        otherCostKrw: new Prisma.Decimal(0), totalCostKrw: new Prisma.Decimal(100), saleMethod: null
      }]) }
    } as never);
    const manualOnlyRows = await (manualOnlyService as any).buildProductProfitRows(range);
    expect(manualOnlyRows[0].calculationStatus).toBe("COMPLETE");
    expect(manualOnlyRows[0].normalCalculationStatus).toBe("NOT_APPLICABLE");
    expect(manualOnlyRows[0].manualCalculationStatus).toBe("COMPLETE");
    expect(manualOnlyRows[0].warnings).toContain("MANUAL_PURCHASE_WITHOUT_REPORTED_SALES");
    expect(manualOnlyRows[0].actualNetSalesKrw).toBe(0);
    expect(manualOnlyRows[0].manualPurchaseProductCostKrw).toBe(0);
    expect(manualOnlyRows[0].totalCostKrw).toBe(600);
    expect(manualOnlyRows[0].marginKrw).toBe(-600);
  });

  it("keeps normal calculations on actual sales when only manual cost snapshots are incomplete", async () => {
    const date = new Date("2026-07-21T00:00:00.000Z");
    const product = { id: "product-1", displayName: "비용 누락 가구매 상품" };
    const manualPurchase = {
      purchaseDate: date,
      coupangProductId: product.id,
      product,
      quantity: 1,
      salesAmountKrw: new Prisma.Decimal(25_000),
      salePriceKrw: new Prisma.Decimal(25_000),
      promotionPriceKrw: null,
      baseSalePriceKrw: new Prisma.Decimal(25_000),
      productCostKrw: new Prisma.Decimal(10_000),
      vendorFeeTotalKrw: null,
      coupangSalesFeeKrw: new Prisma.Decimal(0),
      shippingCostKrw: new Prisma.Decimal(0),
      otherCostKrw: new Prisma.Decimal(0),
      totalCostKrw: new Prisma.Decimal(10_000),
      saleMethod: "판매자배송"
    };
    const costRule = {
      coupangProductId: product.id,
      salePriceKrw: new Prisma.Decimal(25_000),
      supplyPriceKrw: new Prisma.Decimal(0),
      productCostKrw: new Prisma.Decimal(10_000),
      salesFeeRate: new Prisma.Decimal(0),
      salesFeeKrw: new Prisma.Decimal(0),
      sellerShippingFeeKrw: new Prisma.Decimal(0),
      growthInboundFeeKrw: new Prisma.Decimal(0),
      growthShippingFeeKrw: new Prisma.Decimal(0),
      returnRate: new Prisma.Decimal(0),
      returnCostPerUnitKrw: new Prisma.Decimal(0),
      extraCostKrw: new Prisma.Decimal(0),
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    };
    const basePrisma = {
      ...globalSalesFeeRulePrisma(),
      coupangAdMetric: { findMany: vi.fn(async () => []) },
      coupangManualPurchase: { findMany: vi.fn(async () => [manualPurchase]) },
      coupangCostRule: { findMany: vi.fn(async () => [costRule]) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    };
    const range = { from: "2026-07-21", to: "2026-07-21", fromDate: date, toDate: date };

    const withSales = new CoupangService({
      ...basePrisma,
      coupangSaleLine: { findMany: vi.fn(async () => [{
        saleDate: date,
        coupangProductId: product.id,
        product,
        productName: product.displayName,
        salesKrw: new Prisma.Decimal(100_000),
        cancelAmountKrw: new Prisma.Decimal(0),
        netSalesKrw: new Prisma.Decimal(100_000),
        salesQuantity: new Prisma.Decimal(4),
        orderCount: 4,
        saleMethod: "판매자배송"
      }]) }
    } as never);
    const saleRows = await (withSales as any).buildProductProfitRows(range);

    expect(saleRows[0]).toMatchObject({
      actualSalesKrw: 75_000,
      actualNetSalesKrw: 75_000,
      actualSalesQuantity: 3,
      productCostKrw: 30_000,
      normalCalculationStatus: "COMPLETE",
      manualCalculationStatus: "INCOMPLETE",
      calculationStatus: "INCOMPLETE",
      totalCostKrw: null,
      marginKrw: null
    });
    expect(saleRows[0].normalMarginKrw).toBeCloseTo(75_000 - 30_000 - 7_500 - 75_000 / 11);
    expect(saleRows[0].warnings).toContain("MANUAL_PURCHASE_COST_SNAPSHOT_INCOMPLETE");

    const manualOnly = new CoupangService({
      ...basePrisma,
      coupangSaleLine: { findMany: vi.fn(async () => []) }
    } as never);
    const manualOnlyRows = await (manualOnly as any).buildProductProfitRows(range);

    expect(manualOnlyRows[0]).toMatchObject({
      actualNetSalesKrw: 0,
      actualSalesQuantity: 0,
      normalCalculationStatus: "NOT_APPLICABLE",
      manualCalculationStatus: "INCOMPLETE",
      calculationStatus: "INCOMPLETE",
      normalMarginKrw: 0,
      totalCostKrw: null,
      marginKrw: null
    });
    expect(manualOnlyRows[0].warnings).toEqual(expect.arrayContaining([
      "MANUAL_PURCHASE_WITHOUT_REPORTED_SALES",
      "MANUAL_PURCHASE_COST_SNAPSHOT_INCOMPLETE"
    ]));
  });

  it("uses reported exclusion bases for invalid adjustments and actual bases for complete dates in a range", async () => {
    const firstDate = new Date("2026-07-14T00:00:00.000Z");
    const secondDate = new Date("2026-07-15T00:00:00.000Z");
    const quantityProduct = { id: "quantity-invalid", displayName: "수량 초과 상품" };
    const salesProduct = { id: "sales-invalid", displayName: "매출 초과 상품" };
    const products = [quantityProduct, salesProduct];
    const saleLine = (product: typeof quantityProduct, saleDate: Date, salesKrw: number, quantity: number) => ({
      saleDate,
      coupangProductId: product.id,
      product,
      productName: product.displayName,
      salesKrw: new Prisma.Decimal(salesKrw),
      cancelAmountKrw: new Prisma.Decimal(0),
      netSalesKrw: new Prisma.Decimal(salesKrw),
      salesQuantity: new Prisma.Decimal(quantity),
      orderCount: quantity,
      saleMethod: "판매자배송"
    });
    const manualPurchase = (product: typeof quantityProduct, quantity: number, salesAmountKrw: number) => ({
      purchaseDate: firstDate,
      coupangProductId: product.id,
      product,
      quantity,
      salesAmountKrw: new Prisma.Decimal(salesAmountKrw),
      salePriceKrw: new Prisma.Decimal(50_000),
      promotionPriceKrw: null,
      baseSalePriceKrw: new Prisma.Decimal(50_000),
      productCostKrw: new Prisma.Decimal(0),
      vendorFeeTotalKrw: new Prisma.Decimal(0),
      coupangSalesFeeKrw: new Prisma.Decimal(0),
      shippingCostKrw: new Prisma.Decimal(0),
      otherCostKrw: new Prisma.Decimal(0),
      totalCostKrw: new Prisma.Decimal(0),
      saleMethod: "판매자배송"
    });
    const costRule = (product: typeof quantityProduct) => ({
      coupangProductId: product.id,
      salePriceKrw: new Prisma.Decimal(50_000),
      supplyPriceKrw: new Prisma.Decimal(0),
      productCostKrw: new Prisma.Decimal(0),
      salesFeeRate: new Prisma.Decimal(0),
      salesFeeKrw: new Prisma.Decimal(0),
      sellerShippingFeeKrw: new Prisma.Decimal(0),
      growthInboundFeeKrw: new Prisma.Decimal(0),
      growthShippingFeeKrw: new Prisma.Decimal(0),
      returnRate: new Prisma.Decimal(0),
      returnCostPerUnitKrw: new Prisma.Decimal(0),
      extraCostKrw: new Prisma.Decimal(0),
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
    const service = new CoupangService({
      ...globalSalesFeeRulePrisma(),
      coupangSaleLine: { findMany: vi.fn(async () => products.flatMap((product) => [
        saleLine(product, firstDate, 100_000, 2),
        saleLine(product, secondDate, 200_000, 4)
      ])) },
      coupangAdMetric: { findMany: vi.fn(async () => []) },
      coupangManualPurchase: { findMany: vi.fn(async () => [
        manualPurchase(quantityProduct, 5, 50_000),
        manualPurchase(salesProduct, 1, 150_000)
      ]) },
      coupangCostRule: { findMany: vi.fn(async () => products.map(costRule)) },
      coupangProduct: { findMany: vi.fn(async () => products) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    } as never);

    const rows = await (service as any).buildProductProfitRows({
      from: "2026-07-14", to: "2026-07-15", fromDate: firstDate, toDate: secondDate
    });
    const quantityRow = rows.find((row: ProductProfitRow) => row.productId === quantityProduct.id);
    const salesRow = rows.find((row: ProductProfitRow) => row.productId === salesProduct.id);

    expect(quantityRow).toMatchObject({
      actualNetSalesKrw: 250_000,
      actualSalesQuantity: 1,
      excludedNetSalesKrw: 300_000,
      excludedSalesQuantity: 6,
      calculationStatus: "INCOMPLETE"
    });
    expect(quantityRow?.warnings).toContain("MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED");
    expect(salesRow).toMatchObject({
      actualNetSalesKrw: 150_000,
      actualSalesQuantity: 5,
      excludedNetSalesKrw: 300_000,
      excludedSalesQuantity: 6,
      calculationStatus: "INCOMPLETE"
    });
    expect(salesRow?.warnings).toContain("MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED");
    expect(summarizeCoupangProductProfitRows(rows)).toMatchObject({
      incompleteProductCount: 2,
      excludedNetSalesKrw: 600_000,
      excludedSalesQuantity: 12
    });
  });

  it("applies the cost rule effective on each sale date before range aggregation", async () => {
    const firstDate = new Date("2026-07-14T00:00:00.000Z");
    const secondDate = new Date("2026-07-15T00:00:00.000Z");
    const product = { id: "product-1", displayName: "일별 원가 상품" };
    const costRule = (productCostKrw: number, effectiveFrom: Date, effectiveTo: Date | null) => ({
      coupangProductId: product.id,
      salePriceKrw: new Prisma.Decimal(10_000), supplyPriceKrw: new Prisma.Decimal(0),
      productCostKrw: new Prisma.Decimal(productCostKrw), salesFeeRate: new Prisma.Decimal(0), salesFeeKrw: new Prisma.Decimal(0),
      sellerShippingFeeKrw: new Prisma.Decimal(0), growthInboundFeeKrw: new Prisma.Decimal(0), growthShippingFeeKrw: new Prisma.Decimal(0),
      returnRate: new Prisma.Decimal(0), returnCostPerUnitKrw: new Prisma.Decimal(0), extraCostKrw: new Prisma.Decimal(0),
      effectiveFrom, effectiveTo, createdAt: effectiveFrom
    });
    const service = new CoupangService({
      ...globalSalesFeeRulePrisma(),
      coupangSaleLine: { findMany: vi.fn(async () => [firstDate, secondDate].map((saleDate) => ({
        saleDate, coupangProductId: product.id, product, productName: product.displayName,
        salesKrw: new Prisma.Decimal(10_000), cancelAmountKrw: new Prisma.Decimal(0), netSalesKrw: new Prisma.Decimal(10_000),
        salesQuantity: new Prisma.Decimal(1), orderCount: 1, saleMethod: "판매자배송"
      }))) },
      coupangAdMetric: { findMany: vi.fn(async () => []) },
      coupangManualPurchase: { findMany: vi.fn(async () => []) },
      coupangCostRule: { findMany: vi.fn(async () => [
        costRule(3_000, secondDate, null),
        costRule(1_000, new Date("2026-01-01T00:00:00.000Z"), firstDate)
      ]) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    } as never);

    const rows = await (service as any).buildProductProfitRows({
      from: "2026-07-14", to: "2026-07-15", fromDate: firstDate, toDate: secondDate
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].productCostKrw).toBe(4_000);
    expect(rows[0].vatKrw).toBeCloseTo(20_000 / 11);
    expect(rows[0].marginKrw).toBeCloseTo(20_000 - 4_000 - 2_000 - 20_000 / 11);
  });

  it("isolates a missing legacy manual sales snapshot to the manual area and keeps a normal reference margin", async () => {
    const date = new Date("2026-07-15T00:00:00.000Z");
    const product = { id: "product-1", displayName: "레거시 가구매 상품" };
    const service = new CoupangService({
      ...globalSalesFeeRulePrisma(),
      coupangSaleLine: { findMany: vi.fn(async () => [{
        saleDate: date, coupangProductId: product.id, product, productName: product.displayName,
        salesKrw: new Prisma.Decimal(10_000), cancelAmountKrw: new Prisma.Decimal(0), netSalesKrw: new Prisma.Decimal(10_000),
        salesQuantity: new Prisma.Decimal(1), orderCount: 1, saleMethod: "판매자배송"
      }]) },
      coupangAdMetric: { findMany: vi.fn(async () => []) },
      coupangManualPurchase: { findMany: vi.fn(async () => [{
        purchaseDate: date, coupangProductId: product.id, product, quantity: 1, salesAmountKrw: null,
        salePriceKrw: null, promotionPriceKrw: null, baseSalePriceKrw: null,
        productCostKrw: new Prisma.Decimal(1_000), vendorFeeTotalKrw: new Prisma.Decimal(0),
        coupangSalesFeeKrw: new Prisma.Decimal(0), shippingCostKrw: new Prisma.Decimal(0),
        otherCostKrw: new Prisma.Decimal(0), totalCostKrw: new Prisma.Decimal(1_000), saleMethod: "판매자배송"
      }]) },
      coupangCostRule: { findMany: vi.fn(async () => [{
        coupangProductId: product.id, salePriceKrw: new Prisma.Decimal(10_000), supplyPriceKrw: new Prisma.Decimal(0),
        productCostKrw: new Prisma.Decimal(3_000), salesFeeRate: new Prisma.Decimal(0), salesFeeKrw: new Prisma.Decimal(0),
        sellerShippingFeeKrw: new Prisma.Decimal(0), growthInboundFeeKrw: new Prisma.Decimal(0), growthShippingFeeKrw: new Prisma.Decimal(0),
        returnRate: new Prisma.Decimal(0), returnCostPerUnitKrw: new Prisma.Decimal(0), extraCostKrw: new Prisma.Decimal(0),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), effectiveTo: null, createdAt: new Date("2026-01-01T00:00:00.000Z")
      }]) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    } as never);

    const rows = await (service as any).buildProductProfitRows({ from: "2026-07-15", to: "2026-07-15", fromDate: date, toDate: date });

    expect(rows[0]).toMatchObject({
      actualNetSalesKrw: null,
      normalCalculationStatus: "COMPLETE",
      manualCalculationStatus: "INCOMPLETE",
      calculationStatus: "INCOMPLETE",
      productCostKrw: null,
      marginKrw: null
    });
    expect(rows[0].normalMarginKrw).toBeCloseTo(10_000 - 3_000 - 1_000 - 10_000 / 11);
    expect(rows[0].warnings).toContain("MANUAL_PURCHASE_SALES_AMOUNT_MISSING");
  });

  it("calculates seller and growth rows together and exposes shipping audit fields", async () => {
    const date = new Date("2026-07-20T00:00:00.000Z");
    const product = { id: "mixed-product", displayName: "혼합 판매 상품" };
    const service = new CoupangService({
      ...globalSalesFeeRulePrisma(),
      coupangSaleLine: { findMany: vi.fn(async () => [{
        saleDate: date,
        coupangProductId: product.id,
        product,
        productName: product.displayName,
        salesKrw: new Prisma.Decimal(60_000),
        cancelAmountKrw: new Prisma.Decimal(0),
        netSalesKrw: new Prisma.Decimal(60_000),
        salesQuantity: new Prisma.Decimal(3),
        orderCount: 3,
        saleMethod: "판매자배송"
      }, {
        saleDate: date,
        coupangProductId: product.id,
        product,
        productName: product.displayName,
        salesKrw: new Prisma.Decimal(40_000),
        cancelAmountKrw: new Prisma.Decimal(0),
        netSalesKrw: new Prisma.Decimal(40_000),
        salesQuantity: new Prisma.Decimal(2),
        orderCount: 2,
        saleMethod: "로켓그로스"
      }]) },
      coupangAdMetric: { findMany: vi.fn(async () => [{
        metricDate: date,
        spendProductId: product.id,
        conversionProductId: product.id,
        adSpendKrw: new Prisma.Decimal(10_000),
        totalConversionSales1dKrw: new Prisma.Decimal(30_000),
        totalSalesQuantity1d: new Prisma.Decimal(1)
      }]) },
      coupangManualPurchase: { findMany: vi.fn(async () => []) },
      coupangCostRule: { findMany: vi.fn(async () => [{
        coupangProductId: product.id,
        salePriceKrw: new Prisma.Decimal(20_000),
        supplyPriceKrw: new Prisma.Decimal(0),
        productCostKrw: new Prisma.Decimal(1_000),
        salesFeeRate: new Prisma.Decimal(0.1),
        salesFeeKrw: new Prisma.Decimal(0),
        sellerShippingFeeKrw: new Prisma.Decimal(2_500),
        hanaroShippingFeeKrw: new Prisma.Decimal(300),
        growthInboundFeeKrw: new Prisma.Decimal(700),
        growthShippingFeeKrw: new Prisma.Decimal(1_300),
        returnRate: new Prisma.Decimal(0),
        returnCostPerUnitKrw: new Prisma.Decimal(0),
        extraCostKrw: new Prisma.Decimal(0),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      }]) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    } as never);

    const rows = await (service as any).buildProductProfitRows({
      from: "2026-07-20",
      to: "2026-07-20",
      fromDate: date,
      toDate: date
    });
    const summary = summarizeCoupangProductProfitRows(rows);

    expect(rows[0]).toMatchObject({
      saleMethod: "MIXED",
      sellerSalesQuantity: 3,
      growthSalesQuantity: 2,
      sellerShippingCostKrw: 7_500,
      hanaroShippingCostKrw: 600,
      growthInboundCostKrw: 1_400,
      growthShippingCostKrw: 2_600,
      totalLogisticsCostKrw: 12_100,
      shippingCostKrw: 12_100,
      adSpendKrw: 10_000,
      calculationStatus: "COMPLETE"
    });
    expect(rows[0].warnings).not.toContain("NORMAL_SALE_METHOD_CONFLICT");
    expect(rows[0].totalCostKrw).toBeCloseTo(37_100 + 100_000 / 11);
    expect(summary).toMatchObject({
      sellerSalesQuantity: 3,
      growthSalesQuantity: 2,
      sellerShippingCostKrw: 7_500,
      hanaroShippingCostKrw: 600,
      growthInboundCostKrw: 1_400,
      growthShippingCostKrw: 2_600,
      totalLogisticsCostKrw: 12_100,
      shippingCostKrw: 12_100
    });
  });

  it("requires a cost rule for offsetting mixed segments with zero aggregate sales", async () => {
    const date = new Date("2026-07-20T00:00:00.000Z");
    const product = { id: "offset-product", displayName: "상쇄 혼합 상품" };
    const service = new CoupangService({
      ...globalSalesFeeRulePrisma(),
      coupangSaleLine: { findMany: vi.fn(async () => [{
        saleDate: date,
        coupangProductId: product.id,
        product,
        productName: product.displayName,
        salesKrw: new Prisma.Decimal(12_800),
        cancelAmountKrw: new Prisma.Decimal(0),
        netSalesKrw: new Prisma.Decimal(12_800),
        salesQuantity: new Prisma.Decimal(1),
        orderCount: 1,
        saleMethod: "판매자배송"
      }, {
        saleDate: date,
        coupangProductId: product.id,
        product,
        productName: product.displayName,
        salesKrw: new Prisma.Decimal(-12_800),
        cancelAmountKrw: new Prisma.Decimal(0),
        netSalesKrw: new Prisma.Decimal(-12_800),
        salesQuantity: new Prisma.Decimal(-1),
        orderCount: 1,
        saleMethod: "로켓그로스"
      }]) },
      coupangAdMetric: { findMany: vi.fn(async () => []) },
      coupangManualPurchase: { findMany: vi.fn(async () => []) },
      coupangCostRule: { findMany: vi.fn(async () => []) },
      coupangProduct: { findMany: vi.fn(async () => [product]) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) }
    } as never);

    const rows = await (service as any).buildProductProfitRows({
      from: "2026-07-20",
      to: "2026-07-20",
      fromDate: date,
      toDate: date
    });

    expect(rows[0]).toMatchObject({
      actualNetSalesKrw: 0,
      actualSalesQuantity: 0,
      sellerSalesQuantity: 1,
      growthSalesQuantity: -1,
      normalCalculationStatus: "INCOMPLETE",
      calculationStatus: "INCOMPLETE",
      ruleStatus: "MISSING_COST_RULE",
      sellerShippingCostKrw: null,
      growthShippingCostKrw: null
    });
    expect(rows[0].warnings).toContain("NORMAL_COST_RULE_MISSING");
  });
});

describe("Coupang product group aggregation", () => {
  it("sums calculated product rows by group and recalculates margin rate and ROAS", () => {
    const rows = [
      productProfitRow({
        productId: "product-medic",
        productName: "자이로볼 메딕",
        saleMethod: "로켓그로스",
        netSalesKrw: 100_000,
        salesQuantity: 5,
        productCostKrw: 30_000,
        salesFeeKrw: 10_000,
        shippingCostKrw: 5_000,
        vatKrw: 100_000 / 11,
        manualPurchaseQuantity: 2,
        manualPurchaseProductCostKrw: 0,
        manualPurchaseVendorFeeKrw: 6_364,
        manualPurchaseCoupangSalesFeeKrw: 0,
        manualPurchaseShippingCostKrw: 0,
        manualPurchaseTotalCostKrw: 6_364,
        adSpendKrw: 20_000,
        adConversionSalesKrw: 60_000,
        totalCostKrw: 71_364 + 100_000 / 11,
        marginKrw: 28_636 - 100_000 / 11,
        marginRate: 0.35,
        roas: 3,
        salePriceKrw: 20_000
      }),
      productProfitRow({
        productId: "product-challenge",
        productName: "자이로볼 챌린지",
        saleMethod: "판매자배송",
        netSalesKrw: 200_000,
        salesQuantity: 8,
        productCostKrw: 80_000,
        salesFeeKrw: 20_000,
        shippingCostKrw: 8_000,
        vatKrw: 200_000 / 11,
        manualPurchaseQuantity: 1,
        manualPurchaseProductCostKrw: 0,
        manualPurchaseVendorFeeKrw: 3_182,
        manualPurchaseCoupangSalesFeeKrw: 0,
        manualPurchaseShippingCostKrw: 0,
        manualPurchaseTotalCostKrw: 3_182,
        adSpendKrw: 30_000,
        adConversionSalesKrw: 90_000,
        totalCostKrw: 141_182 + 200_000 / 11,
        marginKrw: 58_818 - 200_000 / 11,
        marginRate: 0.31,
        roas: 3,
        salePriceKrw: 25_000
      }),
      productProfitRow({
        productId: "product-solo",
        productName: "솔로 상품",
        netSalesKrw: 50_000,
        marginKrw: 20_000
      })
    ];

    const result = aggregateCoupangProductProfitRowsByGroup(rows, [
      { id: "product-medic", group: { id: "group-gyro", displayName: "자이로볼" } },
      { id: "product-challenge", group: { id: "group-gyro", displayName: "자이로볼" } },
      { id: "product-solo", group: null }
    ]);
    const groupRow = result.find((row) => row.groupId === "group-gyro");
    const soloRow = result.find((row) => row.productId === "product-solo");

    expect(groupRow).toMatchObject({
      rowType: "GROUP",
      productName: "자이로볼",
      childProductCount: 2,
      netSalesKrw: 300_000,
      salesQuantity: 13,
      productCostKrw: 110_000,
      salesFeeKrw: 30_000,
      shippingCostKrw: 13_000,
      manualPurchaseQuantity: 3,
      manualPurchaseProductCostKrw: 0,
      manualPurchaseVendorFeeKrw: 9_546,
      manualPurchaseCoupangSalesFeeKrw: 0,
      manualPurchaseShippingCostKrw: 0,
      adSpendKrw: 50_000,
      adConversionSalesKrw: 150_000,
      salePriceKrw: null,
      priceSource: "MIXED",
      saleMethod: "MIXED"
    });
    expect(groupRow?.vatKrw).toBeCloseTo(300_000 / 11);
    expect(groupRow).not.toHaveProperty("manualPurchaseVatKrw");
    expect(groupRow?.manualPurchaseTotalCostKrw).toBe(9_546);
    expect(groupRow?.totalCostKrw).toBeCloseTo(212_546 + 300_000 / 11);
    expect(groupRow?.marginKrw).toBeCloseTo(87_454 - 300_000 / 11);
    expect(groupRow?.marginRate).toBeCloseTo((87_454 - 300_000 / 11) / 300_000);
    expect(groupRow?.roas).toBeCloseTo(150_000 / 50_000);
    expect(groupRow?.warnings).toEqual(expect.arrayContaining(["GROUP_MIXED_PRICE", "GROUP_MIXED_SALE_METHOD"]));
    expect(soloRow).toMatchObject({ rowType: "PRODUCT", productName: "솔로 상품", childProductCount: 1 });
  });

  it("propagates incomplete group totals when some child cost rules are missing", () => {
    const result = aggregateCoupangProductProfitRowsByGroup(
      [
        productProfitRow({ productId: "product-ok", netSalesKrw: 50_000, totalCostKrw: 40_000, marginKrw: 10_000 }),
        productProfitRow({
          productId: "product-missing",
          netSalesKrw: 20_000,
          totalCostKrw: null,
          marginKrw: null,
          sellerShippingCostKrw: null,
          growthShippingCostKrw: null,
          ruleStatus: "MISSING_COST_RULE"
        })
      ],
      [
        { id: "product-ok", group: { id: "group-mixed-cost", displayName: "부분 누락 그룹" } },
        { id: "product-missing", group: { id: "group-mixed-cost", displayName: "부분 누락 그룹" } }
      ]
    );

    expect(result[0]).toMatchObject({
      productName: "부분 누락 그룹",
      totalCostKrw: null,
      marginKrw: null,
      knownMarginKrw: 10_000,
      knownTotalCostKrw: 40_000,
      incompleteProductCount: 1,
      excludedNetSalesKrw: 20_000,
      sellerShippingCostKrw: null,
      growthShippingCostKrw: null,
      calculationStatus: "INCOMPLETE",
      ruleStatus: "MISSING_COST_RULE"
    });
    expect(result[0].warnings).toContain("GROUP_HAS_MISSING_COST_RULE");
  });

  it("keeps a known partial summary without treating incomplete rows as zero", () => {
    const summary = summarizeCoupangProductProfitRows([
      productProfitRow({
        productId: "complete",
        netSalesKrw: 100_000,
        totalCostKrw: 60_000,
        marginKrw: 40_000,
        reportedOrderCount: 2,
        cancelAmountKrw: 1_000
      }),
      productProfitRow({
        productId: "incomplete",
        netSalesKrw: 50_000,
        totalCostKrw: null,
        marginKrw: null,
        sellerShippingCostKrw: null,
        growthShippingCostKrw: null,
        reportedOrderCount: 1,
        cancelAmountKrw: 500,
        ruleStatus: "MISSING_COST_RULE"
      })
    ]);

    expect(summary).toMatchObject({
      isComplete: false,
      marginKrw: null,
      knownMarginKrw: 40_000,
      knownTotalCostKrw: 60_000,
      completeProductCount: 1,
      incompleteProductCount: 1,
      sellerShippingCostKrw: null,
      growthShippingCostKrw: null,
      reportedOrderCount: 3,
      cancelAmountKrw: 1_500,
      excludedNetSalesKrw: 50_000,
      incompleteNormalCount: 1
    });
  });

  it("keeps dashboard summary based on product rows while grouping only display rows", async () => {
    const service = new CoupangService({} as never);
    const productRows = [
      productProfitRow({
        productId: "product-a",
        netSalesKrw: 100_000,
        marginKrw: 40_000,
        vatKrw: 1_000,
        manualPurchaseProductCostKrw: 0,
        manualPurchaseVendorFeeKrw: 200,
        manualPurchaseTotalCostKrw: 200
      }),
      productProfitRow({
        productId: "product-b",
        netSalesKrw: 50_000,
        marginKrw: null,
        vatKrw: null,
        manualPurchaseProductCostKrw: 0,
        manualPurchaseVendorFeeKrw: 300,
        manualPurchaseTotalCostKrw: 300,
        ruleStatus: "MISSING_COST_RULE"
      })
    ];
    const groupedRows = [
      productProfitRow({ productId: "group-a", productName: "그룹 A", rowType: "GROUP", netSalesKrw: 150_000, marginKrw: 40_000 })
    ];
    vi.spyOn(service as any, "buildProductProfitRows").mockResolvedValue(productRows);
    vi.spyOn(service as any, "groupProductProfitRows").mockResolvedValue(groupedRows);

    const result = await service.dashboard({ from: "2026-06-01", to: "2026-06-30", groupBy: "group" });

    expect(result.groupBy).toBe("group");
    expect(result.summary.netSalesKrw).toBe(150_000);
    expect(result.summary.actualNetSalesKrw).toBe(150_000);
    expect(result.summary.marginKrw).toBeNull();
    expect(result.summary.vatKrw).toBeNull();
    expect(result.summary.manualPurchaseVendorFeeKrw).toBe(500);
    expect(result.summary).not.toHaveProperty("manualPurchaseVatKrw");
    expect(result.summary.manualPurchaseProductCostKrw).toBe(0);
    expect(result.summary.missingCostRuleCount).toBe(1);
    expect(result.rows).toEqual(groupedRows);
  });

  it("returns every dashboard product row instead of truncating the product summary", async () => {
    const service = new CoupangService({} as never);
    const productRows = Array.from({ length: 25 }, (_, index) =>
      productProfitRow({
        productId: `product-${index + 1}`,
        productName: `Product ${index + 1}`,
        netSalesKrw: index + 1
      })
    );
    vi.spyOn(service as any, "buildProductProfitRows").mockResolvedValue(productRows);

    const result = await service.dashboard({ from: "2026-06-01", to: "2026-06-30" });

    expect(result.rows).toHaveLength(25);
    expect(result.rows).toEqual(productRows);
  });

  it("omits products with no activity but keeps manual-purchase-only rows in the daily report", async () => {
    const service = new CoupangService({
      coupangProduct: { findMany: vi.fn(async () => []) },
      coupangManualPurchase: { findMany: vi.fn(async () => []) }
    } as never);
    const productRows = [
      productProfitRow({
        productId: "zero-row",
        productName: "Zero Product",
        matchedSalesLineCount: 3,
        netSalesKrw: 0,
        salesQuantity: 0,
        orderCount: 0,
        adSpendKrw: 0,
        adConversionSalesKrw: 0,
        adConversionQuantity: 0
      }),
      productProfitRow({
        productId: "sales-row",
        productName: "Sales Product",
        netSalesKrw: 10_000,
        salesQuantity: 1,
        orderCount: 1
      }),
      productProfitRow({
        productId: "ad-row",
        productName: "Ad Product",
        netSalesKrw: 0,
        salesQuantity: 0,
        orderCount: 0,
        adSpendKrw: 500
      }),
      productProfitRow({
        productId: "manual-row",
        productName: "Manual Product",
        netSalesKrw: 0,
        salesQuantity: 0,
        orderCount: 0,
        manualPurchaseQuantity: 2,
        manualPurchaseProductCostKrw: 0,
        manualPurchaseVendorFeeKrw: 9_000,
        manualPurchaseTotalCostKrw: 9_000,
        totalCostKrw: 9_000,
        marginKrw: -9_000
      }),
      productProfitRow({
        productId: "reported-gross-only",
        productName: "Reported Gross Only",
        reportedSalesKrw: 5_000
      }),
      productProfitRow({
        productId: "warning-only",
        productName: "Warning Only",
        warnings: ["RECONCILIATION_WARNING"]
      }),
      productProfitRow({
        productId: "incomplete-only",
        productName: "Incomplete Only",
        calculationStatus: "INCOMPLETE"
      })
    ];
    vi.spyOn(service as any, "buildProductProfitRows")
      .mockResolvedValueOnce(productRows)
      .mockResolvedValueOnce([]);

    const result = await service.dailyReport({ date: "2026-07-02" });

    expect(result.rows.map((row) => row.productName)).toEqual([
      "Sales Product",
      "Reported Gross Only",
      "Ad Product",
      "Incomplete Only",
      "Manual Product",
      "Warning Only"
    ]);
    expect(result.rows.map((row) => row.productName)).not.toContain("Zero Product");
    expect(result.rows.find((row) => row.productName === "Manual Product")).toMatchObject({
      manualPurchaseQuantity: 2,
      marginKrw: -9_000
    });
    expect(result.rows.find((row) => row.productName === "Reported Gross Only")).toMatchObject({
      reportedSalesKrw: 5_000,
      organicSalesKrw: 0
    });
    expect(result.summary.current.incompleteProductCount).toBe(1);
  });

  it("projects incomplete child product names into grouped daily reports without duplicating child amounts", async () => {
    const productRows = [
      productProfitRow({ productId: "complete", productName: "정상 옵션", netSalesKrw: 50_000, totalCostKrw: 30_000, marginKrw: 20_000 }),
      productProfitRow({
        productId: "incomplete",
        productName: "원가 누락 옵션",
        netSalesKrw: 20_000,
        totalCostKrw: null,
        marginKrw: null,
        ruleStatus: "MISSING_COST_RULE"
      })
    ];
    const group = { id: "group", displayName: "혼합 그룹" };
    const products = [
      dailyCatalogProduct("complete", "정상 옵션", group),
      dailyCatalogProduct("incomplete", "원가 누락 옵션", group)
    ];
    const service = new CoupangService({
      coupangProduct: { findMany: vi.fn(async () => products) },
      coupangManualPurchase: { findMany: vi.fn(async () => []) }
    } as never);
    vi.spyOn(service as any, "buildProductProfitRows")
      .mockResolvedValueOnce(productRows)
      .mockResolvedValueOnce([]);

    const result = await service.dailyReport({ date: "2026-07-02" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      rowType: "GROUP",
      productName: "혼합 그룹",
      reportedSalesKrw: 70_000,
      marginKrw: null,
      calculationStatus: "INCOMPLETE"
    });
    expect(result.rows[0]).toHaveProperty("children");
  });

  it("keeps the daily-report date errors stable", async () => {
    const service = new CoupangService({} as never);

    await expect(service.dailyReport({})).rejects.toMatchObject({
      response: { code: "DATE_REQUIRED" }
    });
    await expect(service.dailyReport({ date: "2026-02-30" })).rejects.toMatchObject({
      response: { code: "INVALID_DATE" }
    });
  });

  it.each([
    {
      name: "returns null when no prior-day source row exists",
      previousRows: [] as ProductProfitRow[],
      expectedMarginKrw: null
    },
    {
      name: "keeps an exact zero from a complete prior-day source row",
      previousRows: [productProfitRow({
        productId: "product",
        totalCostKrw: 0,
        marginKrw: 0,
        calculationStatus: "COMPLETE"
      })],
      expectedMarginKrw: 0
    },
    {
      name: "keeps null from an incomplete prior-day source row",
      previousRows: [productProfitRow({
        productId: "product",
        totalCostKrw: null,
        marginKrw: null,
        calculationStatus: "INCOMPLETE"
      })],
      expectedMarginKrw: null
    }
  ])("$name", async ({ previousRows, expectedMarginKrw }) => {
    const service = new CoupangService({
      coupangProduct: { findMany: vi.fn(async () => []) },
      coupangManualPurchase: { findMany: vi.fn(async () => []) }
    } as never);
    vi.spyOn(service as any, "buildProductProfitRows")
      .mockResolvedValueOnce([productProfitRow({
        productId: "product",
        reportedSalesKrw: 100,
        totalCostKrw: 50,
        marginKrw: 50
      })])
      .mockResolvedValueOnce(previousRows);

    const result = await service.dailyReport({ date: "2026-07-24" });

    expect(result.summary.current.marginKrw).toBe(50);
    expect(result.summary.previous.marginKrw).toBe(expectedMarginKrw);
  });

  it("preserves the current empty-summary zero while prior-day absence stays null", async () => {
    const service = new CoupangService({
      coupangProduct: { findMany: vi.fn(async () => []) },
      coupangManualPurchase: { findMany: vi.fn(async () => []) }
    } as never);
    vi.spyOn(service as any, "buildProductProfitRows")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await service.dailyReport({ date: "2026-07-24" });

    expect(result.summary.current.marginKrw).toBe(0);
    expect(result.summary.previous.marginKrw).toBeNull();
  });

  it("normalizes all blank memo forms without changing internal user text", () => {
    expect(normalizeDailyMemo(null)).toBeNull();
    expect(normalizeDailyMemo(undefined)).toBeNull();
    expect(normalizeDailyMemo("")).toBeNull();
    expect(normalizeDailyMemo(" \t\r\n ")).toBeNull();
    expect(normalizeDailyMemo("  keep   internal spacing  ")).toBe("keep   internal spacing");
  });

  it("promotes memo-only products into the daily hierarchy with zero metrics", () => {
    const group = { id: "memo-group", displayName: "메모 그룹" };
    const products = [
      dailyCatalogProduct("grouped-memo", "그룹 메모 상품", group),
      dailyCatalogProduct("single-memo", "단일 메모 상품", null)
    ];

    const rows = buildCoupangDailyHierarchy({
      currentProductRows: [],
      previousProductRows: [],
      products,
      manualPurchases: [
        { coupangProductId: "grouped-memo", productDisplayName: "그룹 메모 상품", memo: "그룹 리뷰 보강" },
        { coupangProductId: "single-memo", productDisplayName: "단일 메모 상품", memo: "단일 리뷰 보강" }
      ]
    });

    const groupRow = rows.find((row) => row.rowType === "GROUP");
    const singleRow = rows.find((row) => row.rowType === "PRODUCT");
    expect(groupRow).toMatchObject({
      rowType: "GROUP",
      groupId: group.id,
      manualPurchaseQuantity: 0,
      reportedSalesKrw: 0,
      marginKrw: 0
    });
    if (groupRow?.rowType !== "GROUP") throw new Error("Expected memo-only group row.");
    expect(groupRow.children.find((child) => child.productId === "grouped-memo")).toMatchObject({
      memo: "그룹 리뷰 보강",
      manualPurchaseQuantity: 0
    });
    expect(singleRow).toMatchObject({
      rowType: "PRODUCT",
      productId: "single-memo",
      memo: "단일 리뷰 보강",
      manualPurchaseQuantity: 0,
      reportedSalesKrw: 0,
      marginKrw: 0
    });
  });

  it("returns the final hierarchy contract with strict totals, weighted ROAS, memos, and prior-day metrics", async () => {
    const group = { id: "group-a", displayName: "Group A" };
    const products = [
      dailyCatalogProduct("option-a", "Option A", group, { sortOrder: 20 }),
      dailyCatalogProduct("option-b", "Option B", group, { sortOrder: 10 }),
      dailyCatalogProduct("zero-option", "Zero Option", group, { sortOrder: 30 }),
      dailyCatalogProduct("prior-option", "Prior Option", group, { sortOrder: 40 }),
      dailyCatalogProduct("inactive-option", "Inactive Option", group, { isActive: false, sortOrder: 15 }),
      dailyCatalogProduct("single", "Single Product", null),
      dailyCatalogProduct("prior-single", "Prior-only Single", null)
    ];
    const currentRows = [
      productProfitRow({
        productId: "option-a",
        productName: "Same Name",
        reportedSalesKrw: 900,
        reportedSalesQuantity: 9,
        manualPurchaseQuantity: 1,
        adSpendKrw: 100,
        adConversionSalesKrw: 400,
        roas: 4,
        actualOrganicSalesKrw: 500,
        totalCostKrw: 700,
        marginKrw: 200
      }),
      productProfitRow({
        productId: "option-b",
        productName: "Same Name",
        reportedSalesKrw: 100,
        reportedSalesQuantity: 1,
        actualSalesQuantity: 1,
        adSpendKrw: 300,
        adConversionSalesKrw: 600,
        roas: 2,
        actualOrganicSalesKrw: -500,
        totalCostKrw: null,
        marginKrw: null,
        calculationStatus: "INCOMPLETE",
        warnings: ["MISSING_COST"]
      }),
      productProfitRow({
        productId: "inactive-option",
        productName: "Inactive Option",
        reportedSalesKrw: 50,
        reportedSalesQuantity: 1,
        actualOrganicSalesKrw: 50,
        totalCostKrw: 40,
        marginKrw: 10
      }),
      productProfitRow({
        productId: "single",
        productName: "Outdated Single Name",
        reportedSalesKrw: 600,
        reportedSalesQuantity: 6,
        actualOrganicSalesKrw: 300,
        totalCostKrw: 500,
        marginKrw: 100
      })
    ];
    const previousRows = [
      productProfitRow({
        productId: "option-a",
        productName: "Same Name",
        reportedSalesKrw: 700,
        reportedSalesQuantity: 7,
        adSpendKrw: 100,
        adConversionSalesKrw: 300,
        roas: 3,
        totalCostKrw: 550,
        marginKrw: 150
      }),
      productProfitRow({
        productId: "prior-option",
        productName: "Same Name",
        reportedSalesKrw: 200,
        reportedSalesQuantity: 2,
        adSpendKrw: 50,
        adConversionSalesKrw: 100,
        roas: 2,
        totalCostKrw: 160,
        marginKrw: 40
      }),
      productProfitRow({
        productId: "prior-single",
        productName: "Prior-only Single",
        reportedSalesKrw: 1_000,
        reportedSalesQuantity: 10,
        marginKrw: 300
      })
    ];
    const findProducts = vi.fn(async () => products);
    const findManualPurchases = vi.fn(async () => [
      { coupangProductId: "option-a", productDisplayName: "Wrong Name", memo: "  review boost  " },
      { coupangProductId: "option-b", productDisplayName: "Option B", memo: " \t\n " },
      { coupangProductId: "single", productDisplayName: "Single Product", memo: "<b>literal</b>" }
    ]);
    const service = new CoupangService({
      coupangProduct: { findMany: findProducts },
      coupangManualPurchase: { findMany: findManualPurchases }
    } as never);
    const buildRows = vi.spyOn(service as any, "buildProductProfitRows");
    buildRows.mockResolvedValueOnce(currentRows).mockResolvedValueOnce(previousRows);

    const result = await service.dailyReport({ date: "2026-07-24" });

    expect(result.date).toBe("2026-07-24");
    expect(result.previousDate).toBe("2026-07-23");
    expect(buildRows).toHaveBeenNthCalledWith(1, expect.objectContaining({ from: "2026-07-24", to: "2026-07-24" }));
    expect(buildRows).toHaveBeenNthCalledWith(2, expect.objectContaining({ from: "2026-07-23", to: "2026-07-23" }));
    expect(findProducts).toHaveBeenCalledWith({ include: { group: true } });
    expect(findManualPurchases).toHaveBeenCalledWith({
      where: { purchaseDate: new Date("2026-07-24T00:00:00.000Z") },
      select: { coupangProductId: true, productDisplayName: true, memo: true }
    });
    expect(result).not.toHaveProperty("groupBy");
    expect(result.rows.map((row) => row.productName)).toEqual(["Group A", "Single Product"]);

    const groupRow = result.rows[0];
    expect(groupRow.rowType).toBe("GROUP");
    if (groupRow.rowType !== "GROUP") throw new Error("Expected grouped daily row.");
    expect(groupRow).toMatchObject({
      reportedSalesKrw: 1_050,
      reportedSalesQuantity: 11,
      manualPurchaseQuantity: 1,
      adSpendKrw: 400,
      roas: 2.5,
      organicSalesKrw: 50,
      marginKrw: null,
      calculationStatus: "INCOMPLETE",
      childProductCount: 5,
      previous: {
        reportedSalesQuantity: 9,
        adSpendKrw: 150,
        roas: 8 / 3,
        marginKrw: 190
      }
    });
    expect(groupRow.roas).not.toBe((4 + 2) / 2);
    expect(groupRow.children.map((child) => child.productName)).toEqual([
      "Option A",
      "Option B",
      "Inactive Option",
      "Zero Option",
      "Prior Option"
    ]);
    expect(groupRow.children.find((child) => child.productId === "option-a")).toMatchObject({
      memo: "review boost",
      previous: { reportedSalesQuantity: 7, adSpendKrw: 100, roas: 3, marginKrw: 150 },
      organicSalesKrw: 500
    });
    expect(groupRow.children.find((child) => child.productId === "option-b")).toMatchObject({
      memo: null,
      previous: { reportedSalesQuantity: 0, adSpendKrw: 0, roas: null, marginKrw: null }
    });
    expect(groupRow.children.find((child) => child.productId === "zero-option")).toMatchObject({
      reportedSalesKrw: 0,
      reportedSalesQuantity: 0,
      adSpendKrw: 0,
      roas: null,
      organicSalesKrw: 0,
      marginKrw: 0,
      calculationStatus: "COMPLETE",
      warnings: []
    });
    expect(groupRow.children.find((child) => child.productId === "prior-option")).toMatchObject({
      reportedSalesKrw: 0,
      previous: { reportedSalesQuantity: 2, adSpendKrw: 50, roas: 2, marginKrw: 40 }
    });
    expect(groupRow.children.find((child) => child.productId === "inactive-option")).toBeDefined();

    const singleRow = result.rows[1];
    expect(singleRow).toMatchObject({
      rowType: "PRODUCT",
      productId: "single",
      productName: "Single Product",
      groupId: null,
      groupName: null,
      memo: "<b>literal</b>",
      organicSalesKrw: 300,
      previous: { reportedSalesQuantity: 0, adSpendKrw: 0, roas: null, marginKrw: null }
    });
    expect(result.rows.some((row) => row.productName === "Prior-only Single")).toBe(false);
    expect(result.summary.current).toEqual({
      reportedSalesKrw: 1_650,
      reportedSalesQuantity: 17,
      manualPurchaseQuantity: 1,
      adSpendKrw: 400,
      roas: 2.5,
      organicSalesKrw: 350,
      marginKrw: null,
      isComplete: false,
      knownMarginKrw: 310,
      incompleteProductCount: 1,
      excludedNetSalesKrw: 0,
      excludedSalesQuantity: 1
    });
    expect(result.summary.current.reportedSalesKrw).not.toBe(
      groupRow.reportedSalesKrw +
      groupRow.children.reduce((sum, child) => sum + child.reportedSalesKrw, 0) +
      singleRow.reportedSalesKrw
    );
  });

  it("does not promote prior-only products and preserves inactive products with current activity", () => {
    const products = [
      dailyCatalogProduct("inactive-current", "Inactive Current", null, { isActive: false }),
      dailyCatalogProduct("prior-only", "Prior Only", null)
    ];
    const rows = buildCoupangDailyHierarchy({
      currentProductRows: [productProfitRow({
        productId: "inactive-current",
        reportedSalesKrw: 10
      })],
      previousProductRows: [productProfitRow({
        productId: "prior-only",
        reportedSalesKrw: 20
      })],
      products,
      manualPurchases: []
    });

    expect(rows.map((row) => row.rowType === "PRODUCT" ? row.productId : row.groupId))
      .toEqual(["inactive-current"]);
  });

  it("groups ads analysis by spend product group and campaign/ad group", async () => {
    const prisma = fakeCoupangAdsAnalysisPrisma();
    const service = new CoupangService(prisma as never);

    const result = await service.adsAnalysis({ from: "2026-06-01", to: "2026-06-30", groupBy: "group" });

    expect(result.groupBy).toBe("group");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      rowType: "GROUP",
      productId: "group-gyro",
      productName: "자이로볼",
      campaignName: "Campaign",
      adGroupName: "Ad Group",
      impressions: 300,
      clicks: 30,
      adSpendKrw: 30_000,
      totalOrders1d: 3,
      totalConversionSales1dKrw: 90_000
    });
    expect(result.rows[0].roas).toBe(3);
  });
});

describe("CoupangService margin import mapping rules", () => {
  it("rejects an invalid logistics row without creating a cost snapshot", async () => {
    const prisma = fakeCoupangMarginImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = Buffer.from([
      "Item\tSale Price\tProduct Cost\tSales Fee Rate\tSeller Shipping Fee\tHanaro Shipping Fee\tGrowth Inbound Fee\tGrowth Shipping Fee",
      "Invalid Logistics\t69900\t20000\t11.88%\t1.5\t500\t1650\t2200"
    ].join("\n"), "utf8");

    const result = await service.importMarginCsv(
      { originalname: "invalid-margin.tsv", buffer } as Express.Multer.File,
      { effectiveFrom: "2026-06-22" }
    );

    expect(result).toMatchObject({ rowCount: 1, validRowCount: 0, errorCount: 1 });
    expect(prisma.coupangCostRule.create).not.toHaveBeenCalled();
    expect(prisma.coupangProduct.upsert).not.toHaveBeenCalled();
    expect(prisma.coupangUploadRowError.createMany).toHaveBeenCalled();
  });

  it("preserves existing mapping keywords when Product Margin TSV is re-uploaded", async () => {
    const prisma = fakeCoupangMarginImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = Buffer.from(
      [
        "항목\t판매가(VAT포함)\t원가\t판매수수료율\t하나로 배송비\t그로스 입출고비\t그로스 배송비",
        "다이어트양말 10개입\t₩69,900\t₩20,000\t11.88%\t₩500\t₩1,650\t₩2,200"
      ].join("\n"),
      "utf8"
    );

    const result = await service.importMarginCsv(
      { originalname: "margin.tsv", buffer } as Express.Multer.File,
      { effectiveFrom: "2026-06-22" }
    );

    expect(result).toMatchObject({ rowCount: 1, validRowCount: 1, errorCount: 0 });
    expect(prisma.coupangProductRule.update).toHaveBeenCalledWith({
      where: { id: "rule-existing" },
      data: {
        displayName: "다이어트양말 10개입",
        adEnabled: true,
        isActive: true
      }
    });
    const ruleUpdateData = prisma.coupangProductRule.update.mock.calls[0][0].data;
    expect(ruleUpdateData).not.toHaveProperty("includeKeywords");
    expect(ruleUpdateData).not.toHaveProperty("excludeKeywords");
    expect(ruleUpdateData).not.toHaveProperty("priority");
    expect(ruleUpdateData).not.toHaveProperty("validFrom");
    expect(ruleUpdateData).not.toHaveProperty("validTo");
    expect(prisma.coupangProductRule.create).not.toHaveBeenCalled();
    expect(prisma.coupangCostRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sellerShippingFeeKrw: new Prisma.Decimal(3_000),
        hanaroShippingFeeKrw: new Prisma.Decimal(500)
      })
    });
  });
});

describe("CoupangService sales import", () => {
  it.each([
    ["omitted", {}],
    ["invalid", { cancelAmountMode: "UNKNOWN_MODE" }]
  ])("uses SALES_IS_NET when cancelAmountMode is %s", async (_label, body) => {
    const prisma = fakeCoupangSalesImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = await workbookBuffer([
      coupangSalesHeaderRow(),
      ["A-1", "Black", "Zero Bar", "seller", "3,295,600", 106, 107, "3,757,600", 122, "-462,000", 15, 0]
    ]);

    const result = await service.importSalesXlsx({ originalname: "sales.xlsx", buffer } as Express.Multer.File, body);

    expect(result).toMatchObject({ rowCount: 1, validRowCount: 1, warningCount: 0, errorCount: 0 });
    expect(prisma.coupangSaleLine.create).toHaveBeenCalledTimes(1);
    const data = prisma.coupangSaleLine.create.mock.calls[0][0].data;
    expect(Number(data.salesKrw)).toBe(3_295_600);
    expect(Number(data.totalSalesKrw)).toBe(3_757_600);
    expect(Number(data.cancelAmountKrw)).toBe(-462_000);
    expect(Number(data.netSalesKrw)).toBe(3_295_600);
  });

  it.each([
    ["NEGATIVE_ADD", { cancelAmountMode: "NEGATIVE_ADD" }, "-10,000", -10_000, 90_000],
    ["POSITIVE_SUBTRACT", { cancelAmountMode: "POSITIVE_SUBTRACT" }, "10,000", 10_000, 90_000],
    ["SALES_IS_NET", { cancelAmountMode: "SALES_IS_NET" }, "-10,000", -10_000, 100_000]
  ])("preserves explicit %s cancel amount mode", async (_mode, body, cancelAmountKrw, expectedCancelAmountKrw, expectedNetSalesKrw) => {
    const prisma = fakeCoupangSalesImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = await workbookBuffer([
      coupangSalesHeaderRow(),
      ["A-1", "Black", "Zero Bar", "seller", "100,000", 3, 4, "120,000", 5, cancelAmountKrw, 1, 0]
    ]);

    const result = await service.importSalesXlsx({ originalname: "sales.xlsx", buffer } as Express.Multer.File, body);

    expect(result).toMatchObject({ rowCount: 1, validRowCount: 1, warningCount: 0, errorCount: 0 });
    expect(prisma.coupangSaleLine.create).toHaveBeenCalledTimes(1);
    const data = prisma.coupangSaleLine.create.mock.calls[0][0].data;
    expect(Number(data.salesKrw)).toBe(100_000);
    expect(Number(data.cancelAmountKrw)).toBe(expectedCancelAmountKrw);
    expect(Number(data.netSalesKrw)).toBe(expectedNetSalesKrw);
  });
});

describe("CoupangService rematch", () => {
  it("infers blank and dash conversion products during Ads XLSX import", async () => {
    const prisma = fakeCoupangAdsImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = await workbookBuffer([
      [
        "Date",
        "Campaign Name",
        "Ad Group",
        "Ad Execution Option ID",
        "Ad Execution Product Name",
        "Conversion Option ID",
        "Conversion Product Name",
        "Impressions",
        "Clicks",
        "Ad Spend(KRW)",
        "Total Orders(1d)",
        "Direct Orders(1d)",
        "Indirect Orders(1d)",
        "Total Conversion Sales(1d)(KRW)",
        "Direct Conversion Sales(1d)(KRW)",
        "Indirect Conversion Sales(1d)(KRW)",
        "Total Sales Quantity(1d)",
        "Direct Sales Quantity(1d)",
        "Indirect Sales Quantity(1d)"
      ],
      ["2026-06-22", "Campaign", "Group", "E-1", "Spend Product 2-pack", "C-1", "", 1000, 50, "12,000", 3, 2, 1, 90000, 60000, 30000, 4, 2, 2],
      ["2026-06-22", "Campaign", "Group", "E-2", "Spend Product 4-pack", "C-2", "-", 1000, 50, "12,000", 3, 2, 1, 90000, 60000, 30000, 4, 2, 2]
    ]);

    const result = await service.importAdsXlsx({ originalname: "ads.xlsx", buffer } as Express.Multer.File, {});

    expect(result).toMatchObject({
      rowCount: 2,
      validRowCount: 2,
      warningCount: 0,
      errorCount: 0,
      matchedSpendCount: 2,
      matchedConversionCount: 2
    });
    expect(prisma.coupangAdMetric.create).toHaveBeenCalledTimes(2);
    for (const call of prisma.coupangAdMetric.create.mock.calls) {
      expect(call[0].data).toMatchObject({
        spendProductId: "product-spend",
        spendProductRuleId: "rule-spend",
        conversionProductId: "product-spend",
        conversionProductRuleId: "rule-spend",
        spendMatchSource: MatchSource.RULE,
        conversionMatchSource: MatchSource.INFERRED,
        validationStatus: RowValidationStatus.VALID,
        validationErrors: []
      });
    }
    expect(prisma.coupangUploadRowError.createMany).not.toHaveBeenCalled();
  });

  it("falls back to ad name only when ad execution product name is a placeholder during Ads XLSX import", async () => {
    const prisma = fakeCoupangAdsImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = await workbookBuffer([
      coupangAdsHeaderRowWithAdName(),
      ["2026-06-22", "Campaign", "Group", "Spend Product 2-pack ad", "E-1", "-", "C-1", "-", 1000, 50, "12,000", 3, 2, 1, 90000, 60000, 30000, 4, 2, 2]
    ]);

    const result = await service.importAdsXlsx({ originalname: "ads.xlsx", buffer } as Express.Multer.File, {});

    expect(result).toMatchObject({
      rowCount: 1,
      validRowCount: 1,
      warningCount: 0,
      errorCount: 0,
      matchedSpendCount: 1,
      matchedConversionCount: 1
    });
    expect(prisma.coupangAdMetric.create).toHaveBeenCalledTimes(1);
    expect(prisma.coupangAdMetric.create.mock.calls[0][0].data).toMatchObject({
      adName: "Spend Product 2-pack ad",
      adExecutionProductName: "-",
      spendProductId: "product-spend",
      spendProductRuleId: "rule-spend",
      conversionProductId: "product-spend",
      conversionProductRuleId: "rule-spend",
      spendMatchSource: MatchSource.RULE,
      conversionMatchSource: MatchSource.INFERRED,
      validationStatus: RowValidationStatus.VALID,
      validationErrors: []
    });
    expect(prisma.coupangUploadRowError.createMany).not.toHaveBeenCalled();
  });

  it("does not fall back to ad name when ad execution product name is populated but unmatched", async () => {
    const prisma = fakeCoupangAdsImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = await workbookBuffer([
      coupangAdsHeaderRowWithAdName(),
      ["2026-06-22", "Campaign", "Group", "Spend Product 2-pack ad", "E-1", "Unknown Product", "C-1", "-", 1000, 50, "12,000", 3, 2, 1, 90000, 60000, 30000, 4, 2, 2]
    ]);

    const result = await service.importAdsXlsx({ originalname: "ads.xlsx", buffer } as Express.Multer.File, {});

    expect(result).toMatchObject({
      rowCount: 1,
      validRowCount: 1,
      warningCount: 1,
      errorCount: 0,
      matchedSpendCount: 0,
      matchedConversionCount: 0
    });
    expect(prisma.coupangAdMetric.create.mock.calls[0][0].data).toMatchObject({
      adName: "Spend Product 2-pack ad",
      adExecutionProductName: "Unknown Product",
      spendProductId: null,
      conversionProductId: null,
      spendMatchSource: MatchSource.UNMATCHED,
      conversionMatchSource: MatchSource.UNMATCHED,
      validationStatus: RowValidationStatus.UNMATCHED,
      validationErrors: [expect.objectContaining({ errorCode: "SPEND_NO_MATCH" })]
    });
  });

  it("aggregates Ads XLSX rows with the same metric key before current duplicate checks", async () => {
    const prisma = fakeCoupangAdsImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = await workbookBuffer([
      coupangAdsHeaderRow(),
      ["2026-06-29", "Campaign", "Group", "E-1", "Spend Product 2-pack", "C-1", "-", 10, 1, 1000, 1, 1, 0, 10000, 7000, 3000, 2, 1, 1],
      ["2026-06-29", "Campaign", "Group", "E-1", "Spend Product 2-pack", "C-1", "-", 20, 2, 2000, 2, 1, 1, 20000, 10000, 10000, 3, 2, 1],
      ["2026-06-29", "Campaign", "Group", "E-1", "Spend Product 2-pack", "C-1", "-", 30, 3, 3000, 3, 2, 1, 30000, 20000, 10000, 4, 3, 1]
    ]);

    const result = await service.importAdsXlsx({ originalname: "ads.xlsx", buffer } as Express.Multer.File, {});

    expect(result).toMatchObject({
      rowCount: 3,
      validRowCount: 1,
      warningCount: 0,
      errorCount: 0,
      matchedSpendCount: 1,
      matchedConversionCount: 1
    });
    expect(prisma.coupangAdMetric.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.coupangAdMetric.create).toHaveBeenCalledTimes(1);
    const data = prisma.coupangAdMetric.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      rowNumber: 2,
      adMetricKey: "2026-06-29:Campaign:Group:E-1:Spend Product 2-pack:C-1:-",
      clicks: 6,
      totalOrders1d: 6,
      directOrders1d: 4,
      indirectOrders1d: 2,
      isCurrent: true,
      validationStatus: RowValidationStatus.VALID,
      validationErrors: [],
      rawRow: expect.objectContaining({
        aggregated: true,
        sourceRowNumbers: [2, 3, 4],
        sourceRowCount: 3,
        adMetricKey: "2026-06-29:Campaign:Group:E-1:Spend Product 2-pack:C-1:-"
      })
    });
    expect(data.impressions).toBe(BigInt(60));
    expect(Number(data.adSpendKrw)).toBe(6000);
    expect(Number(data.totalConversionSales1dKrw)).toBe(60000);
    expect(Number(data.directConversionSales1dKrw)).toBe(37000);
    expect(Number(data.indirectConversionSales1dKrw)).toBe(23000);
    expect(Number(data.totalSalesQuantity1d)).toBe(9);
    expect(Number(data.directSalesQuantity1d)).toBe(6);
    expect(Number(data.indirectSalesQuantity1d)).toBe(3);
    expect(prisma.coupangUploadRowError.createMany).not.toHaveBeenCalled();
    expect(prisma.coupangUploadBatch.create.mock.calls[0][0].data.columnSchema).toMatchObject({
      sourceRowCount: 3,
      aggregatedRowCount: 1,
      aggregatedDuplicateCount: 2
    });
  });

  it("keeps placeholder ad execution rows with different ad names separate during aggregation", async () => {
    const prisma = fakeCoupangAdsImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = await workbookBuffer([
      coupangAdsHeaderRowWithAdName(),
      ["2026-06-29", "Campaign", "Group", "Spend Product A", "E-1", "-", "C-1", "-", 10, 1, 1000, 1, 1, 0, 10000, 7000, 3000, 2, 1, 1],
      ["2026-06-29", "Campaign", "Group", "Spend Product B", "E-1", "-", "C-1", "-", 20, 2, 2000, 2, 1, 1, 20000, 10000, 10000, 3, 2, 1]
    ]);

    const result = await service.importAdsXlsx({ originalname: "ads.xlsx", buffer } as Express.Multer.File, {});

    expect(result).toMatchObject({
      rowCount: 2,
      validRowCount: 2,
      warningCount: 0,
      errorCount: 0,
      matchedSpendCount: 2,
      matchedConversionCount: 2
    });
    expect(prisma.coupangAdMetric.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.coupangAdMetric.create).toHaveBeenCalledTimes(2);
    expect(prisma.coupangAdMetric.create.mock.calls.map((call) => call[0].data.adMetricKey)).toEqual([
      "2026-06-29:Campaign:Group:E-1:Spend Product A:C-1:-",
      "2026-06-29:Campaign:Group:E-1:Spend Product B:C-1:-"
    ]);
  });

  it("aggregates placeholder ad execution rows with the same ad name", async () => {
    const prisma = fakeCoupangAdsImportPrisma();
    const service = new CoupangService(prisma as never);
    const buffer = await workbookBuffer([
      coupangAdsHeaderRowWithAdName(),
      ["2026-06-29", "Campaign", "Group", "Spend Product A", "E-1", "-", "C-1", "-", 10, 1, 1000, 1, 1, 0, 10000, 7000, 3000, 2, 1, 1],
      ["2026-06-29", "Campaign", "Group", "Spend Product A", "E-1", "-", "C-1", "-", 20, 2, 2000, 2, 1, 1, 20000, 10000, 10000, 3, 2, 1]
    ]);

    const result = await service.importAdsXlsx({ originalname: "ads.xlsx", buffer } as Express.Multer.File, {});

    expect(result).toMatchObject({
      rowCount: 2,
      validRowCount: 1,
      warningCount: 0,
      errorCount: 0,
      matchedSpendCount: 1,
      matchedConversionCount: 1
    });
    expect(prisma.coupangAdMetric.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.coupangAdMetric.create).toHaveBeenCalledTimes(1);
    const data = prisma.coupangAdMetric.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      rowNumber: 2,
      adName: "Spend Product A",
      adMetricKey: "2026-06-29:Campaign:Group:E-1:Spend Product A:C-1:-",
      rawRow: expect.objectContaining({
        aggregated: true,
        sourceRowNumbers: [2, 3],
        sourceRowCount: 2,
        adMetricKey: "2026-06-29:Campaign:Group:E-1:Spend Product A:C-1:-"
      })
    });
    expect(Number(data.adSpendKrw)).toBe(3000);
  });

  it("keeps duplicate-current warnings for aggregated Ads rows that conflict with existing DB current rows", async () => {
    const prisma = fakeCoupangAdsImportPrisma({
      existingAdMetrics: [{ id: "metric-current", importVersion: 2, isCurrent: true }]
    });
    const service = new CoupangService(prisma as never);
    const buffer = await workbookBuffer([
      coupangAdsHeaderRow(),
      ["2026-06-29", "Campaign", "Group", "E-1", "Spend Product 2-pack", "C-1", "-", 10, 1, 1000, 1, 1, 0, 10000, 7000, 3000, 2, 1, 1],
      ["2026-06-29", "Campaign", "Group", "E-1", "Spend Product 2-pack", "C-1", "-", 20, 2, 2000, 2, 1, 1, 20000, 10000, 10000, 3, 2, 1]
    ]);

    const result = await service.importAdsXlsx({ originalname: "ads.xlsx", buffer } as Express.Multer.File, {});

    expect(result).toMatchObject({
      rowCount: 2,
      validRowCount: 1,
      warningCount: 1,
      errorCount: 0
    });
    expect(prisma.coupangAdMetric.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.coupangAdMetric.create).toHaveBeenCalledTimes(1);
    expect(prisma.coupangAdMetric.create.mock.calls[0][0].data).toMatchObject({
      importVersion: 2,
      isCurrent: false,
      validationStatus: RowValidationStatus.WARNING,
      validationErrors: [expect.objectContaining({ errorCode: "COUPANG_AD_METRIC_ALREADY_CURRENT" })]
    });
    expect(prisma.coupangUploadRowError.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          sourceType: CoupangUploadSourceType.ADS,
          errorCode: "COUPANG_AD_METRIC_ALREADY_CURRENT"
        })
      ]
    });
  });

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

  it("infers conversion product from matched ad execution product when conversion text is placeholder", async () => {
    const prisma = fakeCoupangRematchPrisma({
      adMetrics: [
        {
          id: "metric-placeholder",
          uploadBatchId: "batch-1",
          rowNumber: 7,
          metricDate: toDateOnly("2026-06-22")!,
          adExecutionProductName: "Spend Product 2-pack",
          conversionProductName: " - ",
          validationStatus: RowValidationStatus.UNMATCHED
        }
      ]
    });
    const service = new CoupangService(prisma as never);

    const result = await service.rematch({ from: "2026-06-22", to: "2026-06-22" });

    expect(result).toMatchObject({
      scannedAdsCount: 1,
      matchedSpendCount: 1,
      matchedConversionCount: 1
    });
    expect(prisma.coupangAdMetric.update).toHaveBeenCalledWith({
      where: { id: "metric-placeholder" },
      data: expect.objectContaining({
        spendProductId: "product-spend",
        spendProductRuleId: "rule-spend",
        conversionProductId: "product-spend",
        conversionProductRuleId: "rule-spend",
        spendMatchSource: MatchSource.RULE,
        conversionMatchSource: MatchSource.INFERRED,
        validationStatus: RowValidationStatus.VALID,
        validationErrors: []
      })
    });
    expect(prisma.coupangUploadRowError.createMany).not.toHaveBeenCalled();
  });

  it("rematches ad spend by ad name when ad execution product name is a placeholder", async () => {
    const prisma = fakeCoupangRematchPrisma({
      adMetrics: [
        {
          id: "metric-ad-name-fallback",
          uploadBatchId: "batch-1",
          rowNumber: 8,
          metricDate: toDateOnly("2026-06-22")!,
          adExecutionProductName: "-",
          adName: "Spend Product 2-pack ad",
          conversionProductName: "-",
          validationStatus: RowValidationStatus.UNMATCHED
        }
      ]
    });
    const service = new CoupangService(prisma as never);

    const result = await service.rematch({ from: "2026-06-22", to: "2026-06-22" });

    expect(result).toMatchObject({
      scannedAdsCount: 1,
      matchedSpendCount: 1,
      matchedConversionCount: 1
    });
    expect(prisma.coupangAdMetric.update).toHaveBeenCalledWith({
      where: { id: "metric-ad-name-fallback" },
      data: expect.objectContaining({
        spendProductId: "product-spend",
        spendProductRuleId: "rule-spend",
        conversionProductId: "product-spend",
        conversionProductRuleId: "rule-spend",
        spendMatchSource: MatchSource.RULE,
        conversionMatchSource: MatchSource.INFERRED,
        validationStatus: RowValidationStatus.VALID,
        validationErrors: []
      })
    });
    expect(prisma.coupangUploadRowError.createMany).not.toHaveBeenCalled();
  });

  it("leaves ad rows unmatched when spend and conversion product names are placeholders", async () => {
    const prisma = fakeCoupangRematchPrisma({
      adMetrics: [
        {
          id: "metric-placeholders",
          uploadBatchId: "batch-1",
          rowNumber: 8,
          metricDate: toDateOnly("2026-06-22")!,
          adExecutionProductName: "-",
          conversionProductName: "-",
          validationStatus: RowValidationStatus.UNMATCHED
        }
      ]
    });
    const service = new CoupangService(prisma as never);

    const result = await service.rematch({ from: "2026-06-22", to: "2026-06-22" });

    expect(result).toMatchObject({
      scannedAdsCount: 1,
      matchedSpendCount: 0,
      matchedConversionCount: 0
    });
    expect(prisma.coupangAdMetric.update).toHaveBeenCalledWith({
      where: { id: "metric-placeholders" },
      data: expect.objectContaining({
        spendProductId: null,
        spendProductRuleId: null,
        conversionProductId: null,
        conversionProductRuleId: null,
        spendMatchSource: MatchSource.UNMATCHED,
        conversionMatchSource: MatchSource.UNMATCHED,
        validationStatus: RowValidationStatus.UNMATCHED,
        validationErrors: [expect.objectContaining({ errorCode: "SPEND_NO_MATCH" })]
      })
    });
    expect(prisma.coupangUploadRowError.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          sourceType: CoupangUploadSourceType.ADS,
          adMetricId: "metric-placeholders",
          errorCode: "SPEND_NO_MATCH"
        })
      ]
    });
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

  it("deletes price text cost rules and removes products left with no references", async () => {
    const prisma = fakeCoupangPriceTextDeletePrisma();
    const service = new CoupangService(prisma as never);

    await service.deleteUpload("batch-price-text");

    expect(prisma.coupangCostRule.delete).toHaveBeenCalledWith({ where: { id: "cost-price-1" } });
    expect(prisma.coupangProduct.delete).toHaveBeenCalledWith({ where: { id: "product-price-only" } });
    expect(prisma.coupangUploadBatch.delete).toHaveBeenCalledWith({ where: { id: "batch-price-text" } });
  });

  it("deletes margin cost rules, created product rules, and products left with no references", async () => {
    const prisma = fakeCoupangMarginDeletePrisma();
    const service = new CoupangService(prisma as never);

    await service.deleteUpload("batch-margin");

    expect(prisma.coupangCostRule.delete).toHaveBeenCalledWith({ where: { id: "cost-margin-1" } });
    expect(prisma.coupangProductRule.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["rule-margin-1"] } } });
    expect(prisma.coupangProduct.delete).toHaveBeenCalledWith({ where: { id: "product-margin-only" } });
    expect(prisma.coupangUploadBatch.delete).toHaveBeenCalledWith({ where: { id: "batch-margin" } });
  });

  it.each([
    "missing-provenance",
    "missing-applied-rows",
    "truncated-applied-rows",
    "created-without-after",
    "updated-without-before",
    "malformed-row-among-complete-rows",
    "partial-after-snapshot"
  ] as const)("fails closed before any deletion for %s", async (provenanceMode) => {
    const prisma = fakeCoupangPriceTextDeletePrisma(provenanceMode);
    const service = new CoupangService(prisma as never);

    await expect(service.deleteUpload("batch-price-text")).rejects.toMatchObject({
      response: { code: "COUPANG_UPLOAD_ROLLBACK_PROVENANCE_MISSING" }
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.coupangUploadRowError.deleteMany).not.toHaveBeenCalled();
    expect(prisma.coupangSaleLine.deleteMany).not.toHaveBeenCalled();
    expect(prisma.coupangAdMetric.deleteMany).not.toHaveBeenCalled();
    expect(prisma.coupangCostRule.delete).not.toHaveBeenCalled();
    expect(prisma.coupangProduct.delete).not.toHaveBeenCalled();
    expect(prisma.coupangUploadBatch.delete).not.toHaveBeenCalled();
  });
});

describe("CoupangService previewUpload", () => {
  it("serializes Ads BigInt fields for JSON responses", async () => {
    const prisma = fakeCoupangPreviewPrisma();
    const service = new CoupangService(prisma as never);

    const result = await service.previewUpload("batch-ads", 1);

    expect(result).toEqual([expect.objectContaining({ id: "metric-1", impressions: "123" })]);
    expect(prisma.coupangAdMetric.findMany).toHaveBeenCalledWith({
      where: { uploadBatchId: "batch-ads" },
      take: 1,
      orderBy: { rowNumber: "asc" },
      include: { spendProduct: true, conversionProduct: true, spendRule: true, conversionRule: true }
    });
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

describe("CoupangService mappingIssues", () => {
  it("returns unmatched, ambiguous, and excluded mapping issues with separate ad targets", async () => {
    const prisma = fakeCoupangMappingIssuesPrisma();
    const service = new CoupangService(prisma as never);

    const result = await service.mappingIssues({ from: "2026-06-22", to: "2026-06-23", take: "2" });

    expect(result.summary).toMatchObject({
      totalCount: 4,
      unmatchedCount: 1,
      ambiguousCount: 2,
      excludedCount: 1,
      adsCount: 2
    });
    expect(result.rows).toHaveLength(2);
    const allIssueTexts = result.rows.map((row) => row.productText);
    expect(allIssueTexts).not.toContain("Promotion Product");
    expect(allIssueTexts).not.toContain("Zero Bar Black");
    expect((prisma.coupangSaleLine.findMany as any).mock.calls[0][0]).not.toHaveProperty("take");
    expect((prisma.coupangAdMetric.findMany as any).mock.calls[0][0]).not.toHaveProperty("take");
    expect((prisma.coupangPromotionPrice.findMany as any).mock.calls[0][0]).not.toHaveProperty("take");
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueType: "AMBIGUOUS",
          sourceType: "ADS",
          targetKind: "ADS_CONVERSION_PRODUCT",
          productText: "Conversion Product",
          candidates: ["Conversion A", "Conversion B"]
        }),
        expect.objectContaining({
          issueType: "UNMATCHED",
          sourceType: "ADS",
          targetKind: "ADS_SPEND_PRODUCT",
          productText: "Spend Product"
        })
      ])
    );
    expect(result.rows.some((row) => row.reason === "INVALID_PROMOTION_STATUS")).toBe(false);
  });

  it("does not return an ad conversion issue when placeholder conversion was inferred", async () => {
    const batch = { originalFilename: "coupang.xlsx" };
    const prisma = fakeCoupangMappingIssuesPrisma({
      saleLines: [],
      promotionPrices: [],
      adMetrics: [
        {
          id: "metric-inferred",
          rowNumber: 8,
          batch,
          adExecutionProductName: "Spend Product",
          conversionProductName: "-",
          adSpendKrw: new Prisma.Decimal(12000),
          totalConversionSales1dKrw: new Prisma.Decimal(99000),
          metricDate: toDateOnly("2026-06-22")!,
          spendProductId: "product-spend",
          conversionProductId: "product-spend",
          validationErrors: []
        }
      ]
    });
    const service = new CoupangService(prisma as never);

    const result = await service.mappingIssues({ from: "2026-06-22", to: "2026-06-22" });

    expect(result.summary.totalCount).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it("returns only the spend issue when conversion text is a placeholder and spend is unresolved", async () => {
    const batch = { originalFilename: "coupang.xlsx" };
    const prisma = fakeCoupangMappingIssuesPrisma({
      saleLines: [],
      promotionPrices: [],
      adMetrics: [
        {
          id: "metric-placeholder-unresolved",
          rowNumber: 9,
          batch,
          adExecutionProductName: "-",
          adName: "Ad name sample",
          conversionProductName: "-",
          adSpendKrw: new Prisma.Decimal(500),
          totalConversionSales1dKrw: new Prisma.Decimal(0),
          metricDate: toDateOnly("2026-06-22")!,
          spendProductId: null,
          conversionProductId: null,
          validationErrors: [
            { errorCode: "SPEND_NO_MATCH", message: "no spend match", candidates: [] },
            { errorCode: "CONVERSION_NO_MATCH", message: "old conversion warning", candidates: [] }
          ]
        }
      ]
    });
    const service = new CoupangService(prisma as never);

    const result = await service.mappingIssues({ from: "2026-06-22", to: "2026-06-22" });

    expect(result.summary.totalCount).toBe(1);
    expect(result.rows).toEqual([
      expect.objectContaining({
        sourceType: "ADS",
        targetKind: "ADS_SPEND_PRODUCT",
        productText: "Ad name sample",
        reason: "SPEND_NO_MATCH"
      })
    ]);
  });
});

function fakeCoupangProductSettingPrisma() {
  let savedCostRule: Record<string, any> | null = null;
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
    $queryRaw: vi.fn(async () => []),
    coupangProduct: {
      create: vi.fn(async (args) => ({ id: "product-created", ...args.data, productRules: [], costRules: [] })),
      findUnique: vi.fn(async (args) =>
        args.where.id === "product-1"
          ? {
              id: "product-1",
              groupId: null,
              displayName: "Black Socks",
              standardName: "black socks",
              productRules: [],
              costRules: []
            }
          : null
      ),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data }))
    },
    coupangProductGroup: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async (args) =>
        args.where.id === "group-1" ? { id: "group-1", displayName: "Gyro Ball", standardName: "gyro ball" } : null
      ),
      create: vi.fn(async (args) => ({ id: "group-created", ...args.data, products: [] })),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data, products: [] }))
    },
    coupangProductRule: {
      findFirst: vi.fn(async (): Promise<{ id: string; coupangProductId: string } | null> => null),
      findUnique: vi.fn(async (args) => {
        if (args.where.id === "rule-1") {
          return { id: "rule-1", coupangProductId: "product-1", displayName: "Black Socks", includeKeywords: ["Black"], priority: 10 };
        }
        if (args.where.id === "other-rule") {
          return { id: "other-rule", coupangProductId: "product-2", displayName: "Other Product", includeKeywords: ["Other"], priority: 10 };
        }
        return null;
      }),
      create: vi.fn(async (args) => ({ id: "rule-created", ...args.data })),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data })),
      updateMany: vi.fn(async () => ({ count: 0 }))
    },
    coupangCostRule: {
      findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
      findMany: vi.fn(async () => savedCostRule ? [savedCostRule] : []),
      findUnique: vi.fn(async ({ where }) => savedCostRule?.id === where.id ? savedCostRule : null),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        if (savedCostRule?.id === where.id) return savedCostRule;
        throw new Error(`Missing cost rule ${where.id}`);
      }),
      create: vi.fn(async (args) => {
        savedCostRule = {
          id: "cost-created",
          effectiveTo: null,
          createdAt: new Date("2026-07-23T00:00:00.000Z"),
          updatedAt: new Date("2026-07-23T00:00:00.000Z"),
          ...args.data
        };
        return savedCostRule;
      }),
      update: vi.fn(async ({ where, data }) => {
        if (!savedCostRule || savedCostRule.id !== where.id) throw new Error(`Missing cost rule ${where.id}`);
        savedCostRule = { ...savedCostRule, ...data };
        return savedCostRule;
      })
    },
    coupangUploadRowError: {
      createMany: vi.fn(async () => ({}))
    },
    coupangUploadBatch: {
      findUnique: vi.fn(async () => null)
    }
  };
  return prisma;
}

function costHistoryRule(
  id: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  productCostKrw: number,
  overrides: Record<string, number | string | null> = {}
) {
  return {
    id,
    coupangProductId: "product-1",
    salePriceKrw: new Prisma.Decimal(24_000),
    supplyPriceKrw: new Prisma.Decimal(overrides.supplyPriceKrw ?? 0),
    productCostKrw: new Prisma.Decimal(productCostKrw),
    salesFeeRate: new Prisma.Decimal(overrides.salesFeeRate ?? 0),
    salesFeeKrw: new Prisma.Decimal(overrides.salesFeeKrw ?? 0),
    sellerShippingFeeKrw: new Prisma.Decimal(2_800),
    hanaroShippingFeeKrw: new Prisma.Decimal(500),
    growthInboundFeeKrw: new Prisma.Decimal(1_000),
    growthShippingFeeKrw: new Prisma.Decimal(2_000),
    returnRate: new Prisma.Decimal(0),
    returnCostPerUnitKrw: new Prisma.Decimal(0),
    extraCostKrw: new Prisma.Decimal(0),
    effectiveFrom: toDateOnly(effectiveFrom)!,
    effectiveTo: effectiveTo ? toDateOnly(effectiveTo)! : null,
    note: null,
    createdAt: new Date(`${effectiveFrom}T01:00:00.000Z`),
    updatedAt: new Date(`${effectiveFrom}T01:00:00.000Z`),
    ...overrides
  };
}

function costHistoryFixture(
  initialRules: ReturnType<typeof costHistoryRule>[],
  options: {
    upload?: {
      id: string;
      sourceType: CoupangUploadSourceType;
      validRowCount: number;
      columnSchema: Record<string, unknown>;
    };
  } = {}
) {
  const rules = initialRules.map((rule) => ({ ...rule }));
  let sequence = 0;
  const lock = vi.fn(async () => []);
  const findUniqueCost = vi.fn(async ({ where }: any) => rules.find((rule) => rule.id === where.id) ?? null);
  const create = vi.fn(async ({ data }: any) => {
    sequence += 1;
    const rule = {
      id: `created-${sequence}`,
      effectiveTo: null,
      createdAt: new Date(`2026-07-23T02:00:0${sequence}.000Z`),
      updatedAt: new Date(`2026-07-23T02:00:0${sequence}.000Z`),
      ...data
    };
    rules.push(rule as ReturnType<typeof costHistoryRule>);
    return rule;
  });
  const costRuleDelegate = {
    findFirst: vi.fn(async ({ where, orderBy }: any) => {
      let candidates = rules.filter((rule) => rule.coupangProductId === where.coupangProductId);
      if (where.NOT?.id) candidates = candidates.filter((rule) => rule.id !== where.NOT.id);
      if (where.effectiveFrom instanceof Date) candidates = candidates.filter((rule) => rule.effectiveFrom.getTime() === where.effectiveFrom.getTime());
      if (where.effectiveFrom?.lte) candidates = candidates.filter((rule) => rule.effectiveFrom <= where.effectiveFrom.lte);
      if (where.effectiveFrom?.gt) candidates = candidates.filter((rule) => rule.effectiveFrom > where.effectiveFrom.gt);
      const direction = orderBy?.[0]?.effectiveFrom ?? "desc";
      return [...candidates].sort((left, right) => (left.effectiveFrom.getTime() - right.effectiveFrom.getTime()) * (direction === "asc" ? 1 : -1))[0] ?? null;
    }),
    findMany: vi.fn(async ({ where, orderBy }: any) => {
      const candidates = rules.filter((rule) => !where?.coupangProductId || rule.coupangProductId === where.coupangProductId);
      const direction = orderBy?.[0]?.effectiveFrom ?? "desc";
      return [...candidates].sort((left, right) => (left.effectiveFrom.getTime() - right.effectiveFrom.getTime()) * (direction === "asc" ? 1 : -1));
    }),
    findUnique: findUniqueCost,
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const rule = rules.find((candidate) => candidate.id === where.id);
      if (!rule) throw new Error(`Missing cost rule ${where.id}`);
      return rule;
    }),
    create,
    update: vi.fn(async ({ where, data }: any) => {
      const rule = rules.find((candidate) => candidate.id === where.id);
      if (!rule) throw new Error(`Missing cost rule ${where.id}`);
      const nextEffectiveFrom = data.effectiveFrom ?? rule.effectiveFrom;
      const nextEffectiveTo = Object.prototype.hasOwnProperty.call(data, "effectiveTo")
        ? data.effectiveTo
        : rule.effectiveTo;
      if (nextEffectiveTo && nextEffectiveTo < nextEffectiveFrom) {
        throw new Error("coupang_cost_rules_effective_range_check");
      }
      Object.assign(rule, data, { updatedAt: new Date("2026-07-23T03:00:00.000Z") });
      return rule;
    }),
    delete: vi.fn(async ({ where }: any) => {
      const index = rules.findIndex((candidate) => candidate.id === where.id);
      if (index >= 0) rules.splice(index, 1);
      return { id: where.id };
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const ids = new Set(where.id.in);
      const before = rules.length;
      for (let index = rules.length - 1; index >= 0; index -= 1) if (ids.has(rules[index].id)) rules.splice(index, 1);
      return { count: before - rules.length };
    })
  };
  const product = () => ({
    id: "product-1", groupId: null, displayName: "Product", standardName: "product", sortOrder: 1, isActive: true,
    group: null, productRules: [], costRules: [...rules]
  });
  const deleteUpload = vi.fn(async ({ where }: any) => ({ id: where.id }));
  const prisma: any = {
    $queryRaw: lock,
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
    coupangProduct: {
      findUnique: vi.fn(async ({ where }: any) => where.id === "product-1" ? product() : null),
      findMany: vi.fn(async () => [product()]),
      update: vi.fn(async () => product())
    },
    coupangProductGroup: { findUnique: vi.fn(async () => null) },
    coupangProductRule: { findFirst: vi.fn(async () => null), create: vi.fn(), update: vi.fn() },
    coupangCostRule: costRuleDelegate,
    coupangUploadBatch: { findUnique: vi.fn(async () => options.upload ?? null), delete: deleteUpload },
    coupangUploadRowError: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    coupangSaleLine: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) },
    coupangAdMetric: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) }
  };
  return { prisma, create, lock, findUniqueCost, deleteUpload, rule: (id: string) => rules.find((rule) => rule.id === id)! };
}

function formatRuleRange(rule: ReturnType<typeof costHistoryRule>) {
  return [rule.effectiveFrom.toISOString().slice(0, 10), rule.effectiveTo?.toISOString().slice(0, 10) ?? null];
}

function costRuleJsonSnapshot(rule: ReturnType<typeof costHistoryRule>) {
  return {
    salePriceKrw: String(rule.salePriceKrw), supplyPriceKrw: String(rule.supplyPriceKrw), productCostKrw: String(rule.productCostKrw),
    salesFeeRate: String(rule.salesFeeRate), salesFeeKrw: String(rule.salesFeeKrw), sellerShippingFeeKrw: String(rule.sellerShippingFeeKrw),
    hanaroShippingFeeKrw: String(rule.hanaroShippingFeeKrw), growthInboundFeeKrw: String(rule.growthInboundFeeKrw),
    growthShippingFeeKrw: String(rule.growthShippingFeeKrw), returnRate: String(rule.returnRate),
    returnCostPerUnitKrw: String(rule.returnCostPerUnitKrw), extraCostKrw: String(rule.extraCostKrw),
    effectiveFrom: rule.effectiveFrom.toISOString().slice(0, 10), effectiveTo: rule.effectiveTo?.toISOString().slice(0, 10) ?? null,
    note: rule.note
  };
}

function dailyCatalogProduct(
  id: string,
  displayName: string,
  group: { id: string; displayName: string } | null,
  overrides: Partial<{ sortOrder: number; isActive: boolean }> = {}
) {
  return {
    id,
    displayName,
    sortOrder: overrides.sortOrder ?? 100,
    isActive: overrides.isActive ?? true,
    groupId: group?.id ?? null,
    group
  };
}

function productProfitRow(overrides: Partial<ProductProfitRow>): ProductProfitRow {
  const actualNetSalesKrw = overrides.actualNetSalesKrw ?? overrides.netSalesKrw ?? 0;
  const actualSalesKrw = overrides.actualSalesKrw ?? overrides.salesKrw ?? actualNetSalesKrw;
  const actualSalesQuantity = overrides.actualSalesQuantity ?? overrides.salesQuantity ?? 0;
  const calculationStatus =
    overrides.calculationStatus ??
    (overrides.ruleStatus === "MISSING_COST_RULE" || overrides.totalCostKrw === null || overrides.marginKrw === null
      ? "INCOMPLETE"
      : "COMPLETE");
  return {
    productId: "product",
    productName: "Product",
    saleMethod: null,
    matchedSalesLineCount: 1,
    reportedSalesQuantity: actualSalesQuantity,
    reportedOrderCount: 0,
    reportedSalesKrw: actualSalesKrw,
    reportedNetSalesKrw: actualNetSalesKrw,
    salesQuantity: actualSalesQuantity,
    orderCount: 0,
    salesKrw: actualSalesKrw,
    cancelAmountKrw: 0,
    netSalesKrw: actualNetSalesKrw,
    salePriceKrw: 10_000,
    baseSalePriceKrw: 10_000,
    promotionPriceKrw: null,
    priceSource: "BASE",
    priceWarnings: [],
    productCostKrw: 0,
    salesFeeKrw: 0,
    shippingCostKrw: 0,
    sellerSalesQuantity: actualSalesQuantity,
    growthSalesQuantity: 0,
    sellerShippingCostKrw: 0,
    hanaroShippingCostKrw: 0,
    growthInboundCostKrw: 0,
    growthShippingCostKrw: 0,
    totalLogisticsCostKrw: 0,
    returnCostKrw: 0,
    extraCostKrw: 0,
    vatKrw: 0,
    manualPurchaseSalesKrw: 0,
    manualPurchaseQuantity: 0,
    manualPurchaseProductCostKrw: 0,
    manualPurchaseVendorFeeKrw: 0,
    manualPurchaseCoupangSalesFeeKrw: 0,
    manualPurchaseShippingCostKrw: 0,
    manualPurchaseOtherCostKrw: 0,
    manualPurchaseTotalCostKrw: 0,
    actualSalesKrw,
    actualNetSalesKrw,
    actualSalesQuantity,
    normalCalculationStatus: calculationStatus === "COMPLETE" ? "COMPLETE" : "INCOMPLETE",
    manualCalculationStatus: overrides.manualPurchaseQuantity ? "COMPLETE" : "NOT_APPLICABLE",
    calculationStatus,
    adSpendKrw: 0,
    adConversionSalesKrw: 0,
    adConversionQuantity: 0,
    organicSalesKrw: 0,
    reportedOrganicSalesKrw: actualNetSalesKrw,
    actualOrganicSalesKrw: actualNetSalesKrw,
    normalMarginKrw: calculationStatus === "COMPLETE" ? overrides.marginKrw ?? 0 : null,
    totalCostKrw: 0,
    marginKrw: 0,
    knownTotalCostKrw: calculationStatus === "COMPLETE" ? overrides.totalCostKrw ?? 0 : 0,
    knownMarginKrw: calculationStatus === "COMPLETE" ? overrides.marginKrw ?? 0 : 0,
    completeProductCount: calculationStatus === "COMPLETE" ? 1 : 0,
    incompleteProductCount: calculationStatus === "COMPLETE" ? 0 : 1,
    excludedNetSalesKrw: calculationStatus === "COMPLETE" ? 0 : actualNetSalesKrw,
    excludedSalesQuantity: calculationStatus === "COMPLETE" ? 0 : actualSalesQuantity,
    incompleteNormalCount: calculationStatus === "COMPLETE" ? 0 : 1,
    incompleteManualCount: 0,
    marginRate: null,
    roas: null,
    warnings: [],
    ruleStatus: "OK",
    ...overrides
  };
}

function fakeCoupangAdsAnalysisPrisma() {
  const group = { id: "group-gyro", displayName: "자이로볼" };
  return {
    coupangAdMetric: {
      findMany: vi.fn(async () => [
        {
          spendProductId: "product-medic",
          spendProduct: { id: "product-medic", displayName: "자이로볼 메딕", group },
          conversionProduct: null,
          campaignName: "Campaign",
          adGroupName: "Ad Group",
          impressions: BigInt(100),
          clicks: 10,
          adSpendKrw: new Prisma.Decimal(10_000),
          totalOrders1d: 1,
          directOrders1d: 1,
          indirectOrders1d: 0,
          totalConversionSales1dKrw: new Prisma.Decimal(30_000),
          directConversionSales1dKrw: new Prisma.Decimal(20_000),
          indirectConversionSales1dKrw: new Prisma.Decimal(10_000)
        },
        {
          spendProductId: "product-challenge",
          spendProduct: { id: "product-challenge", displayName: "자이로볼 챌린지", group },
          conversionProduct: null,
          campaignName: "Campaign",
          adGroupName: "Ad Group",
          impressions: BigInt(200),
          clicks: 20,
          adSpendKrw: new Prisma.Decimal(20_000),
          totalOrders1d: 2,
          directOrders1d: 1,
          indirectOrders1d: 1,
          totalConversionSales1dKrw: new Prisma.Decimal(60_000),
          directConversionSales1dKrw: new Prisma.Decimal(40_000),
          indirectConversionSales1dKrw: new Prisma.Decimal(20_000)
        }
      ])
    }
  };
}

function fakeCoupangMappingRulePrisma() {
  return {
    coupangProduct: {
      findUnique: vi.fn(async (args) =>
        args.where.id === "product-1" ? { id: "product-1", displayName: "Zero Bar", standardName: "zero bar" } : null
      )
    },
    coupangProductRule: {
      findUnique: vi.fn(async (args) => (args.where.id === "rule-1" ? { id: "rule-1", coupangProductId: "product-1" } : null)),
      create: vi.fn(async (args) => ({ id: "rule-created", ...args.data })),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data }))
    }
  };
}

function fakeCoupangMarginImportPrisma() {
  let savedCostRule: Record<string, any> | null = null;
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
    $queryRaw: vi.fn(async () => []),
    coupangUploadBatch: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args) => ({ id: "batch-margin-import", conflictPolicy: args.data.conflictPolicy, ...args.data })),
      update: vi.fn(async () => ({}))
    },
    coupangProduct: {
      upsert: vi.fn(async () => ({ id: "product-existing" }))
    },
    coupangProductRule: {
      findFirst: vi.fn(async () => ({
        id: "rule-existing",
        includeKeywords: ["사용자", "키워드"],
        excludeKeywords: ["제외"],
        priority: 7,
        validFrom: toDateOnly("2026-01-01")!,
        validTo: toDateOnly("2026-12-31")!
      })),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data })),
      create: vi.fn(async (args) => ({ id: "rule-created", ...args.data }))
    },
    coupangCostRule: {
      findFirst: vi.fn(async (args) => args.where.effectiveFrom instanceof Date ? null : ({
        salePriceKrw: new Prisma.Decimal(69_900),
        supplyPriceKrw: new Prisma.Decimal(0),
        productCostKrw: new Prisma.Decimal(20_000),
        salesFeeRate: new Prisma.Decimal(0.1188),
        salesFeeKrw: new Prisma.Decimal(0),
        sellerShippingFeeKrw: new Prisma.Decimal(3_000),
        hanaroShippingFeeKrw: new Prisma.Decimal(450),
        growthInboundFeeKrw: new Prisma.Decimal(1_500),
        growthShippingFeeKrw: new Prisma.Decimal(2_000),
        returnRate: new Prisma.Decimal(0),
        returnCostPerUnitKrw: new Prisma.Decimal(0),
        extraCostKrw: new Prisma.Decimal(0),
        note: null
      })),
      findMany: vi.fn(async () => savedCostRule ? [savedCostRule] : []),
      findUniqueOrThrow: vi.fn(async () => savedCostRule),
      create: vi.fn(async (args) => {
        savedCostRule = { id: "cost-margin-import", effectiveTo: null, createdAt: new Date(), updatedAt: new Date(), ...args.data };
        return savedCostRule;
      })
    },
    coupangUploadRowError: {
      createMany: vi.fn(async () => ({}))
    }
  };
  return prisma;
}

function fakeCoupangMappingIssuesPrisma(
  options: { saleLines?: any[]; adMetrics?: any[]; promotionPrices?: any[] } = {}
) {
  const batch = { originalFilename: "coupang.xlsx" };
  return {
    coupangSaleLine: {
      findMany: vi.fn(async () => options.saleLines ?? [
        {
          id: "sale-1",
          rowNumber: 3,
          batch,
          productName: "Zero Bar",
          optionName: "Black",
          netSalesKrw: new Prisma.Decimal(24050),
          saleDate: toDateOnly("2026-06-22")!,
          coupangProductId: null,
          validationErrors: [
            {
              errorCode: "AMBIGUOUS_MATCH",
              message: "ambiguous",
              candidates: ["Zero Rule", "Black Rule"]
            }
          ]
        }
      ])
    },
    coupangAdMetric: {
      findMany: vi.fn(async () => options.adMetrics ?? [
        {
          id: "metric-1",
          rowNumber: 4,
          batch,
          adExecutionProductName: "Spend Product",
          conversionProductName: "Conversion Product",
          adSpendKrw: new Prisma.Decimal(12000),
          totalConversionSales1dKrw: new Prisma.Decimal(99000),
          metricDate: toDateOnly("2026-06-22")!,
          spendProductId: null,
          conversionProductId: null,
          validationErrors: [
            { errorCode: "SPEND_NO_MATCH", message: "no spend match", candidates: [] },
            {
              errorCode: "CONVERSION_AMBIGUOUS_MATCH",
              message: "ambiguous conversion",
              candidates: ["Conversion A", "Conversion B"]
            },
            { errorCode: "INVALID_PROMOTION_STATUS", message: "ignored", candidates: [] }
          ]
        }
      ])
    },
    coupangPromotionPrice: {
      findMany: vi.fn(async () => options.promotionPrices ?? [
        {
          id: "promotion-1",
          rowNumber: 5,
          batch,
          productText: "Promotion Product",
          promotionPriceKrw: new Prisma.Decimal(19000),
          promotionStartDate: toDateOnly("2026-06-22")!,
          coupangProductId: null,
          validationErrors: [
            {
              errorCode: "EXCLUDED_BY_KEYWORD",
              message: "excluded",
              candidates: ["Promotion Rule"]
            }
          ]
        }
      ])
    }
  };
}

function fakeCoupangSalesImportPrisma() {
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
    coupangUploadBatch: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args) => ({ id: "batch-sales-import", conflictPolicy: args.data.conflictPolicy, ...args.data })),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data }))
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
    coupangSaleLine: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async (args) => ({ id: "sale-line-1", ...args.data }))
    },
    coupangUploadRowError: {
      createMany: vi.fn(async () => ({}))
    }
  };
  return prisma;
}

function fakeCoupangAdsImportPrisma(options: { existingAdMetrics?: any[] } = {}) {
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
    coupangUploadBatch: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args) => ({ id: "batch-ads-import", conflictPolicy: args.data.conflictPolicy, ...args.data })),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data }))
    },
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
        }
      ])
    },
    coupangAdMetric: {
      findMany: vi.fn(async () => options.existingAdMetrics ?? []),
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async (args) => ({ id: `metric-${args.data.rowNumber}`, ...args.data }))
    },
    coupangUploadRowError: {
      createMany: vi.fn(async () => ({}))
    }
  };
  return prisma;
}

function fakeCoupangRematchPrisma(options: { promotions?: any[]; adMetrics?: any[] } = {}) {
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
      findMany: vi.fn(async () => options.adMetrics ?? [
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

function fakeCoupangPriceTextRepairPrisma() {
  const legacyCostRule = {
    salePriceKrw: new Prisma.Decimal(900),
    supplyPriceKrw: new Prisma.Decimal(12000),
    productCostKrw: new Prisma.Decimal(7000),
    salesFeeRate: new Prisma.Decimal("0.108"),
    salesFeeKrw: new Prisma.Decimal(1800),
    sellerShippingFeeKrw: new Prisma.Decimal(3000),
    growthInboundFeeKrw: new Prisma.Decimal(500),
    growthShippingFeeKrw: new Prisma.Decimal(1200),
    returnRate: new Prisma.Decimal("0.04"),
    returnCostPerUnitKrw: new Prisma.Decimal(2500),
    extraCostKrw: new Prisma.Decimal(300),
    note: "legacy malformed price text product"
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
    $queryRaw: vi.fn(async () => []),
    coupangUploadBatch: {
      findFirst: vi.fn(async () => ({ id: "old-batch" })),
      create: vi.fn(async (args) => ({ id: "batch-price-text", conflictPolicy: args.data.conflictPolicy, ...args.data })),
      update: vi.fn(async () => ({}))
    },
    coupangProduct: {
      upsert: vi.fn(async () => ({ id: "product-correct" })),
      findUnique: vi.fn(async (args) => {
        if (args.where.standardName === "다이어트양말 10개입 ₩69") {
          return { id: "product-legacy" };
        }
        if (args.where.id === "product-legacy" && args.select?._count) {
          return {
            id: "product-legacy",
            _count: {
              costRules: 0,
              productRules: 0,
              saleLines: 0,
              manualPurchases: 0,
              promotionPrices: 0,
              spendAdMetrics: 0,
              conversionAdMetrics: 0
            }
          };
        }
        return null;
      }),
      delete: vi.fn(async (args) => ({ id: args.where.id }))
    },
    coupangCostRule: {
      findFirst: vi.fn(async (args) => (args.where.coupangProductId === "product-legacy" ? legacyCostRule : null)),
      findMany: vi.fn(async () => []),
      findUniqueOrThrow: vi.fn(async ({ where }) => ({
        id: where.id,
        effectiveTo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...legacyCostRule,
        effectiveFrom: toDateOnly("2026-06-22")!,
        salePriceKrw: new Prisma.Decimal(69900)
      })),
      create: vi.fn(async (args) => ({ id: "cost-rule-fixed", effectiveTo: null, createdAt: new Date(), updatedAt: new Date(), ...args.data }))
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

type PriceTextDeleteProvenanceMode =
  | "complete"
  | "missing-provenance"
  | "missing-applied-rows"
  | "truncated-applied-rows"
  | "created-without-after"
  | "updated-without-before"
  | "malformed-row-among-complete-rows"
  | "partial-after-snapshot";

function fakeCoupangPriceTextDeletePrisma(provenanceMode: PriceTextDeleteProvenanceMode = "complete") {
  const costRule = costHistoryRule("cost-price-1", "2026-01-01", null, 0, {
    coupangProductId: "product-price-only",
    salePriceKrw: 9_900
  });
  const completeAppliedRow = {
    rowNumber: 1,
    itemName: "다이어트양말",
    standardName: "다이어트양말",
    productId: "product-price-only",
    costRuleId: "cost-price-1",
    salePriceKrw: 9900,
    costRuleOperation: "CREATED",
    costRuleBefore: null,
    costRuleAfter: costRuleJsonSnapshot(costRule)
  };
  const appliedRows = provenanceMode === "missing-provenance"
    ? [{ ...completeAppliedRow, costRuleOperation: undefined, costRuleAfter: undefined }]
    : provenanceMode === "created-without-after"
      ? [{ ...completeAppliedRow, costRuleAfter: undefined }]
      : provenanceMode === "updated-without-before"
        ? [{ ...completeAppliedRow, costRuleOperation: "UPDATED_SAME_DATE", costRuleBefore: null }]
        : provenanceMode === "malformed-row-among-complete-rows"
          ? [completeAppliedRow, { productId: "product-2", costRuleOperation: "CREATED" }]
          : provenanceMode === "partial-after-snapshot"
            ? [{
                ...completeAppliedRow,
                costRuleAfter: { ...completeAppliedRow.costRuleAfter, sellerShippingFeeKrw: undefined }
              }]
            : [completeAppliedRow];
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
    $queryRaw: vi.fn(async () => []),
    coupangUploadBatch: {
      findUnique: vi.fn(async () => ({
        id: "batch-price-text",
        sourceType: CoupangUploadSourceType.PRICE_TEXT,
        validRowCount: provenanceMode === "truncated-applied-rows" ? 2 : 1,
        columnSchema: provenanceMode === "missing-applied-rows" ? {
          schemaVersion: 1,
          format: "name price",
          effectiveFrom: "2026-01-01"
        } : {
          schemaVersion: 1,
          format: "name price",
          effectiveFrom: "2026-01-01",
          appliedRows
        }
      })),
      delete: vi.fn(async () => ({ id: "batch-price-text" }))
    },
    coupangUploadRowError: {
      deleteMany: vi.fn(async () => ({}))
    },
    coupangSaleLine: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({}))
    },
    coupangAdMetric: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({}))
    },
    coupangCostRule: {
      findUnique: vi.fn(async ({ where }) => where.id === costRule.id ? costRule : null),
      delete: vi.fn(async () => ({ id: costRule.id })),
      findMany: vi.fn(async () => [])
    },
    coupangProduct: {
      findUnique: vi.fn(async (args) =>
        args.where.id === "product-price-only"
          ? {
              id: "product-price-only",
              _count: {
                costRules: 0,
                productRules: 0,
                saleLines: 0,
                manualPurchases: 0,
                promotionPrices: 0,
                spendAdMetrics: 0,
                conversionAdMetrics: 0
              }
            }
          : null
      ),
      delete: vi.fn(async (args) => ({ id: args.where.id }))
    }
  };
  return prisma;
}

function fakeCoupangMarginDeletePrisma() {
  const costRule = costHistoryRule("cost-margin-1", "2026-01-01", null, 0, {
    coupangProductId: "product-margin-only"
  });
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
    $queryRaw: vi.fn(async () => []),
    coupangUploadBatch: {
      findUnique: vi.fn(async () => ({
        id: "batch-margin",
        sourceType: CoupangUploadSourceType.MARGIN,
        validRowCount: 1,
        columnSchema: {
          schemaVersion: 1,
          columns: ["항목", "원가", "판매수수료율", "하나로 배송비", "그로스 입출고비", "그로스 배송비"],
          missingColumns: [],
          effectiveFrom: "2026-01-01",
          appliedRows: [
            {
              rowNumber: 2,
              itemName: "다이어트양말",
              standardName: "다이어트양말",
              productId: "product-margin-only",
              productRuleId: "rule-margin-1",
              productRuleCreated: true,
              costRuleId: "cost-margin-1",
              costRuleOperation: "CREATED",
              costRuleBefore: null,
              costRuleAfter: costRuleJsonSnapshot(costRule)
            }
          ]
        }
      })),
      delete: vi.fn(async () => ({ id: "batch-margin" }))
    },
    coupangUploadRowError: {
      deleteMany: vi.fn(async () => ({}))
    },
    coupangSaleLine: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({}))
    },
    coupangAdMetric: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({}))
    },
    coupangCostRule: {
      findUnique: vi.fn(async ({ where }) => where.id === costRule.id ? costRule : null),
      delete: vi.fn(async () => ({ id: costRule.id })),
      findMany: vi.fn(async () => [])
    },
    coupangProductRule: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 0 }))
    },
    coupangManualPurchase: {
      findMany: vi.fn(async () => [])
    },
    coupangProduct: {
      findUnique: vi.fn(async (args) =>
        args.where.id === "product-margin-only"
          ? {
              id: "product-margin-only",
              _count: {
                costRules: 0,
                productRules: 0,
                saleLines: 0,
                manualPurchases: 0,
                promotionPrices: 0,
                spendAdMetrics: 0,
                conversionAdMetrics: 0
              }
            }
          : null
      ),
      delete: vi.fn(async (args) => ({ id: args.where.id }))
    }
  };
  return prisma;
}

function fakeCoupangPreviewPrisma() {
  return {
    coupangUploadBatch: {
      findUnique: vi.fn(async () => ({ id: "batch-ads", sourceType: CoupangUploadSourceType.ADS }))
    },
    coupangAdMetric: {
      findMany: vi.fn(async () => [{ id: "metric-1", rowNumber: 2, impressions: BigInt(123) }])
    }
  };
}

function coupangAdsHeaderRow() {
  return [
    "Date",
    "Campaign Name",
    "Ad Group",
    "Ad Execution Option ID",
    "Ad Execution Product Name",
    "Conversion Option ID",
    "Conversion Product Name",
    "Impressions",
    "Clicks",
    "Ad Spend(KRW)",
    "Total Orders(1d)",
    "Direct Orders(1d)",
    "Indirect Orders(1d)",
    "Total Conversion Sales(1d)(KRW)",
    "Direct Conversion Sales(1d)(KRW)",
    "Indirect Conversion Sales(1d)(KRW)",
    "Total Sales Quantity(1d)",
    "Direct Sales Quantity(1d)",
    "Indirect Sales Quantity(1d)"
  ];
}

function coupangAdsHeaderRowWithAdName() {
  return [
    "Date",
    "Campaign Name",
    "Ad Group",
    "Ad Name",
    "Ad Execution Option ID",
    "Ad Execution Product Name",
    "Conversion Option ID",
    "Conversion Product Name",
    "Impressions",
    "Clicks",
    "Ad Spend(KRW)",
    "Total Orders(1d)",
    "Direct Orders(1d)",
    "Indirect Orders(1d)",
    "Total Conversion Sales(1d)(KRW)",
    "Direct Conversion Sales(1d)(KRW)",
    "Indirect Conversion Sales(1d)(KRW)",
    "Total Sales Quantity(1d)",
    "Direct Sales Quantity(1d)",
    "Indirect Sales Quantity(1d)"
  ];
}

function coupangSalesHeaderRow() {
  return [
    "Option ID",
    "Option Name",
    "Product Name",
    "Sale Method",
    "Sales(KRW)",
    "Orders",
    "Sales Quantity",
    "Total Sales(KRW)",
    "Total Sales Quantity",
    "Cancel Amount(KRW)",
    "Cancel Quantity",
    "Instant Cancel Quantity"
  ];
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

function globalSalesFeeRulePrisma(rate = 0.1) {
  const rule = salesFeeRuleFixture("global-fee-rule", rate, "2000-01-01", null);
  return {
    coupangSalesFeeRule: {
      findFirst: vi.fn(async () => rule),
      findMany: vi.fn(async () => [rule])
    }
  };
}

function salesFeeRuleFixture(
  id: string,
  rate: number,
  effectiveFrom: string,
  effectiveTo: string | null,
  createdAt = effectiveFrom
) {
  return {
    id,
    salesFeeRate: new Prisma.Decimal(rate),
    effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`),
    effectiveTo: effectiveTo ? new Date(`${effectiveTo}T00:00:00.000Z`) : null,
    note: null,
    createdAt: new Date(`${createdAt}T00:00:00.000Z`),
    updatedAt: new Date(`${createdAt}T00:00:00.000Z`)
  };
}

function manualSalesFeeSnapshot(id: string, purchaseDate: string, storedFeeKrw: number) {
  return {
    id,
    purchaseDate: new Date(`${purchaseDate}T00:00:00.000Z`),
    quantity: 1,
    salesAmountKrw: new Prisma.Decimal(10_000),
    salePriceKrw: new Prisma.Decimal(10_000),
    salesFeeRateApplied: new Prisma.Decimal(0.0777),
    coupangSalesFeeKrw: new Prisma.Decimal(storedFeeKrw),
    productCostKrw: new Prisma.Decimal(3_000),
    vendorFeeTotalKrw: new Prisma.Decimal(500),
    shippingCostKrw: new Prisma.Decimal(400),
    otherCostKrw: new Prisma.Decimal(100),
    totalCostKrw: new Prisma.Decimal(4_000 + storedFeeKrw)
  };
}

function salesFeeRuleWriteFixture(input: {
  rules: ReturnType<typeof salesFeeRuleFixture>[];
  purchases: ReturnType<typeof manualSalesFeeSnapshot>[];
}) {
  const rules = input.rules.map((rule) => ({ ...rule }));
  const purchases = input.purchases.map((purchase) => ({ ...purchase }));
  let createdSequence = 0;
  const ruleDelegate = {
    findFirst: vi.fn(async ({ where, orderBy }: any) => {
      let candidates = rules.filter((rule) => !where.NOT?.id || rule.id !== where.NOT.id);
      if (where.effectiveFrom instanceof Date) {
        candidates = candidates.filter((rule) => rule.effectiveFrom.getTime() === where.effectiveFrom.getTime());
      }
      if (where.effectiveFrom?.gt) {
        candidates = candidates.filter((rule) => rule.effectiveFrom > where.effectiveFrom.gt);
      }
      const direction = orderBy?.[0]?.effectiveFrom ?? "asc";
      return [...candidates].sort((left, right) => (
        (left.effectiveFrom.getTime() - right.effectiveFrom.getTime()) * (direction === "asc" ? 1 : -1)
      ))[0] ?? null;
    }),
    create: vi.fn(async ({ data }: any) => {
      createdSequence += 1;
      const rule = {
        id: `created-${createdSequence}`,
        salesFeeRate: data.salesFeeRate,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: null,
        note: data.note ?? null,
        createdAt: new Date(`2026-07-22T00:00:0${createdSequence}.000Z`),
        updatedAt: new Date(`2026-07-22T00:00:0${createdSequence}.000Z`)
      };
      rules.push(rule);
      return rule;
    }),
    findMany: vi.fn(async ({ orderBy }: any) => {
      const direction = orderBy[0].effectiveFrom;
      return [...rules].sort((left, right) => (
        (left.effectiveFrom.getTime() - right.effectiveFrom.getTime()) * (direction === "asc" ? 1 : -1)
        || (left.createdAt.getTime() - right.createdAt.getTime()) * (direction === "asc" ? 1 : -1)
      ));
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const rule = rules.find((candidate) => candidate.id === where.id);
      if (!rule) throw new Error(`Missing rule ${where.id}`);
      const nextEffectiveFrom = data.effectiveFrom ?? rule.effectiveFrom;
      const nextEffectiveTo = Object.prototype.hasOwnProperty.call(data, "effectiveTo")
        ? data.effectiveTo
        : rule.effectiveTo;
      if (nextEffectiveTo && nextEffectiveTo < nextEffectiveFrom) {
        throw new Error("coupang_sales_fee_rules_effective_range_check");
      }
      Object.assign(rule, data);
      return rule;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const rule = rules.find((candidate) => candidate.id === where.id);
      return rule ? { ...rule } : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const rule = rules.find((candidate) => candidate.id === where.id);
      if (!rule) throw new Error(`Missing rule ${where.id}`);
      return rule;
    })
  };
  const purchaseDelegate = {
    findMany: vi.fn(async ({ where }: any) => purchases.filter(
      (purchase) => purchase.purchaseDate >= where.purchaseDate.gte
    )),
    update: vi.fn(async ({ where, data }: any) => {
      const purchase = purchases.find((candidate) => candidate.id === where.id);
      if (!purchase) throw new Error(`Missing purchase ${where.id}`);
      Object.assign(purchase, data);
      return purchase;
    })
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    coupangSalesFeeRule: ruleDelegate,
    coupangManualPurchase: purchaseDelegate
  };
  return {
    prisma: {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    },
    advisoryLock: tx.$queryRaw,
    rule: (id: string) => rules.find((rule) => rule.id === id)!,
    ruleByDate: (date: string) => rules.find(
      (rule) => rule.effectiveFrom.getTime() === new Date(`${date}T00:00:00.000Z`).getTime()
    )!,
    purchase: (id: string) => purchases.find((purchase) => purchase.id === id)!
  };
}

function concurrentManualSalesFeeWriteFixture() {
  const product = {
    id: "product-1",
    displayName: "Concurrent product",
    standardName: "Concurrent",
    group: null,
    productRules: []
  };
  const rules = [salesFeeRuleFixture("old-rule", 0.1, "2026-01-01", null)];
  const purchases: any[] = [];
  const lockEvents: string[] = [];
  let transactionSequence = 0;
  let createdRuleSequence = 0;
  let createdPurchaseSequence = 0;
  let lockTail = Promise.resolve();

  const ruleDelegate = {
    findFirst: vi.fn(async ({ where }: any) => {
      if (where.effectiveFrom instanceof Date) {
        return rules.find((rule) => rule.effectiveFrom.getTime() === where.effectiveFrom.getTime()) ?? null;
      }
      const cutoff = where.effectiveFrom?.lte as Date;
      return [...rules]
        .filter((rule) => rule.effectiveFrom <= cutoff && (rule.effectiveTo === null || rule.effectiveTo >= cutoff))
        .sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime())[0] ?? null;
    }),
    create: vi.fn(async ({ data }: any) => {
      createdRuleSequence += 1;
      const created = {
        id: `created-rule-${createdRuleSequence}`,
        salesFeeRate: data.salesFeeRate,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: null,
        note: data.note ?? null,
        createdAt: new Date(`2026-07-22T00:00:0${createdRuleSequence}.000Z`),
        updatedAt: new Date(`2026-07-22T00:00:0${createdRuleSequence}.000Z`)
      };
      rules.push(created);
      return created;
    }),
    findMany: vi.fn(async ({ orderBy }: any) => {
      const direction = orderBy[0]?.effectiveFrom ?? "desc";
      return [...rules].sort((left, right) => (
        (left.effectiveFrom.getTime() - right.effectiveFrom.getTime()) * (direction === "asc" ? 1 : -1)
      ));
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const rule = rules.find((candidate) => candidate.id === where.id);
      if (!rule) throw new Error(`Missing rule ${where.id}`);
      Object.assign(rule, data);
      return rule;
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const rule = rules.find((candidate) => candidate.id === where.id);
      if (!rule) throw new Error(`Missing rule ${where.id}`);
      return rule;
    })
  };
  const purchaseDelegate = {
    deleteMany: vi.fn(async ({ where }: any) => {
      const purchaseDate = where.purchaseDate as Date;
      for (let index = purchases.length - 1; index >= 0; index -= 1) {
        if (purchases[index].purchaseDate.getTime() === purchaseDate.getTime()) purchases.splice(index, 1);
      }
    }),
    createMany: vi.fn(async ({ data }: any) => {
      for (const input of data) {
        createdPurchaseSequence += 1;
        purchases.push({
          ...input,
          id: `manual-${createdPurchaseSequence}`,
          createdAt: new Date("2026-07-22T00:00:00.000Z"),
          updatedAt: new Date("2026-07-22T00:00:00.000Z"),
          product,
          productRule: null
        });
      }
    }),
    findMany: vi.fn(async ({ where }: any) => {
      const purchaseDate = where.purchaseDate;
      if (purchaseDate instanceof Date) {
        return purchases.filter((purchase) => purchase.purchaseDate.getTime() === purchaseDate.getTime());
      }
      return purchases.filter((purchase) => purchase.purchaseDate >= purchaseDate.gte);
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const purchase = purchases.find((candidate) => candidate.id === where.id);
      if (!purchase) throw new Error(`Missing purchase ${where.id}`);
      Object.assign(purchase, data);
      return purchase;
    })
  };
  const sharedDelegates = {
    appSetting: { findUnique: vi.fn(async () => null) },
    coupangProduct: { findMany: vi.fn(async () => [product]) },
    coupangProductRule: { findMany: vi.fn(async () => []) },
    coupangCostRule: { findMany: vi.fn(async () => [{
      id: "cost-rule-1",
      coupangProductId: product.id,
      salePriceKrw: new Prisma.Decimal(10_000),
      supplyPriceKrw: new Prisma.Decimal(0),
      productCostKrw: new Prisma.Decimal(3_000),
      salesFeeRate: new Prisma.Decimal(0.1),
      salesFeeKrw: new Prisma.Decimal(0),
      sellerShippingFeeKrw: new Prisma.Decimal(400),
      growthInboundFeeKrw: new Prisma.Decimal(0),
      growthShippingFeeKrw: new Prisma.Decimal(0),
      returnRate: new Prisma.Decimal(0),
      returnCostPerUnitKrw: new Prisma.Decimal(0),
      extraCostKrw: new Prisma.Decimal(100),
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    }]) },
    coupangPromotionPrice: { findMany: vi.fn(async () => []) },
    coupangSalesFeeRule: ruleDelegate,
    coupangManualPurchase: purchaseDelegate
  };
  const transaction = vi.fn(async (callback: (client: any) => Promise<unknown>) => {
    transactionSequence += 1;
    const transactionId = transactionSequence;
    const waitForPrevious = lockTail;
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    lockTail = waitForPrevious.then(() => current);
    let acquired = false;
    const transactionClient = {
      ...sharedDelegates,
      $queryRaw: vi.fn(async () => {
        await waitForPrevious;
        acquired = true;
        lockEvents.push(`transaction-${transactionId}:acquired`);
        return [];
      })
    };
    try {
      return await callback(transactionClient);
    } finally {
      if (acquired) lockEvents.push(`transaction-${transactionId}:released`);
      releaseCurrent();
    }
  });

  return {
    prisma: { ...sharedDelegates, $transaction: transaction },
    lockEvents,
    purchase: () => purchases[0]
  };
}
