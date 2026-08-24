import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ProductsService } from "./products.service";

describe("ProductsService deleteProduct", () => {
  it("deactivates products with Cafe24 operational data and disables Cafe24 rules", async () => {
    const prisma = fakePrismaForDelete();
    const service = new ProductsService(prisma as never);

    const result = await service.deleteProduct("product-1");

    expect(result.mode).toBe("deactivated");
    expect(prisma.cafe24OrderLine.countCalls[0]).toEqual({ where: { productId: "product-1" } });
    expect(prisma.cafe24ProductRule.updateManyCalls).toEqual(
      expect.arrayContaining([
        { where: { productId: "product-1" }, data: { isActive: false } },
        { where: { adCostSourceProductId: "product-1" }, data: { adCostSourceProductId: null } }
      ])
    );
    expect(prisma.cafe24CouponRule.updateManyCalls).toEqual([
      { where: { productId: "product-1" }, data: { isActive: false } }
    ]);
    expect(prisma.product.deleteCalls).toHaveLength(0);
  });

  it("deletes product coupon settings without treating them as operational data", async () => {
    const prisma = fakePrismaForDelete({ hasOperationalData: false });
    const service = new ProductsService(prisma as never);

    const result = await service.deleteProduct("product-1");

    expect(result.mode).toBe("deleted");
    expect(prisma.cafe24CouponRule.deleteManyCalls).toEqual([
      { where: { productId: "product-1" } }
    ]);
    expect(prisma.cafe24CouponRule.updateManyCalls).toEqual([]);
    expect(prisma.product.deleteCalls).toHaveLength(1);
  });

  it("never targets global coupons while deleting or deactivating a product", async () => {
    const deactivated = fakePrismaForDelete();
    const deleted = fakePrismaForDelete({ hasOperationalData: false });

    await new ProductsService(deactivated as never).deleteProduct("product-1");
    await new ProductsService(deleted as never).deleteProduct("product-1");

    expect([
      ...deactivated.cafe24CouponRule.updateManyCalls,
      ...deleted.cafe24CouponRule.deleteManyCalls
    ]).toEqual([
      { where: { productId: "product-1" }, data: { isActive: false } },
      { where: { productId: "product-1" } }
    ]);
  });

  it("disables product coupon rules when updateProduct deactivates a product", async () => {
    const prisma = fakePrismaForDelete();
    const service = new ProductsService(prisma as never);

    await service.updateProduct("product-1", { isActive: false, displayName: "Inactive Wavebar" });

    expect(prisma.cafe24CouponRule.updateManyCalls).toEqual([
      { where: { productId: "product-1" }, data: { isActive: false } }
    ]);
    expect(prisma.product.updateCalls.at(-1)).toMatchObject({
      where: { id: "product-1" },
      data: { isActive: false, displayName: "Inactive Wavebar" }
    });
  });

  it.each([
    ["createProduct", (service: ProductsService) => service.createProduct({
      code: "wavebar-new",
      name: "Wavebar New",
      isActive: "false"
    })],
    ["updateProduct", (service: ProductsService) => service.updateProduct("product-1", {
      isActive: "false"
    })]
  ])("rejects a non-boolean isActive value on %s", async (_operation, request) => {
    const prisma = fakePrismaForDelete();
    const service = new ProductsService(prisma as never);

    await expectErrorCode(request(service), "INVALID_BOOLEAN");

    expect(prisma.product.createCalls).toEqual([]);
    expect(prisma.product.updateCalls).toEqual([]);
    expect(prisma.cafe24CouponRule.updateManyCalls).toEqual([]);
  });
});

describe("ProductsService product rule history", () => {
  it("creates a cost snapshot and closes the previous rule on the prior date", async () => {
    const fixture = productRuleHistoryFixture({
      costRules: [costRule("cost-old", "2026-06-01", null, { salePriceKrw: 38900 })]
    });
    const service = new ProductsService(fixture.prisma as never);

    const result = await service.saveCostRuleSnapshot("product-1", {
      effectiveFrom: "2026-08-21",
      salePriceKrw: 36900
    });

    expect(result.operation).toBe("CREATED");
    expect(result.previousRuleEffectiveTo).toBe("2026-08-20");
    expect(result.effectiveTo).toBeNull();
    expect(Number(result.rule.salePriceKrw)).toBe(36900);
    expect(Number(result.rule.vatKrw)).toBe(3690);
    expect(Number(result.rule.productCostKrw)).toBe(6000);
    expect(Number(result.rule.fxRateKrwPerUsd)).toBe(1350);
    expect(dateText(fixture.costRule("cost-old").effectiveTo)).toBe("2026-08-20");
    expect(fixture.advisoryLocks).toHaveLength(1);
    const advisoryQuery = fixture.advisoryLocks[0] as Prisma.Sql;
    expect(String(advisoryQuery.sql)).toContain("pg_advisory_xact_lock");
    expect(advisoryQuery.values).toContain("meta-product-rule:product-1");
  });

  it("updates the same-date snapshot without duplication and preserves omitted fields", async () => {
    const fixture = productRuleHistoryFixture({
      costRules: [costRule("cost-current", "2026-08-21", null, { salePriceKrw: 36900, note: "keep" })]
    });
    const service = new ProductsService(fixture.prisma as never);

    const result = await service.saveCostRuleSnapshot("product-1", {
      effectiveFrom: "2026-08-21",
      shippingKrw: 3200
    });

    expect(result.operation).toBe("UPDATED_SAME_DATE");
    expect(fixture.costRules).toHaveLength(1);
    expect(Number(result.rule.salePriceKrw)).toBe(36900);
    expect(Number(result.rule.vatKrw)).toBe(3690);
    expect(Number(result.rule.shippingKrw)).toBe(3200);
    expect(result.rule.note).toBe("keep");
  });

  it("splits ranges when inserting a snapshot between two histories", async () => {
    const fixture = productRuleHistoryFixture({
      costRules: [
        costRule("cost-old", "2026-06-01", "2026-08-31"),
        costRule("cost-future", "2026-09-01", null, { salePriceKrw: 35000 })
      ]
    });
    const service = new ProductsService(fixture.prisma as never);

    const result = await service.saveCostRuleSnapshot("product-1", {
      effectiveFrom: "2026-08-21",
      salePriceKrw: 36900
    });

    expect(result.previousRuleEffectiveTo).toBe("2026-08-20");
    expect(result.effectiveTo).toBe("2026-08-31");
    expect(result.nextRuleEffectiveFrom).toBe("2026-09-01");
    expect(dateText(fixture.costRule("cost-old").effectiveTo)).toBe("2026-08-20");
    expect(dateText(fixture.costRule("cost-future").effectiveTo)).toBeNull();
  });

  it("uses the exchange-rate fallback only when the first cost snapshot has no base", async () => {
    const fixture = productRuleHistoryFixture();
    const service = new ProductsService(fixture.prisma as never);

    const result = await service.saveCostRuleSnapshot("product-1", {
      effectiveFrom: "2026-08-21",
      salePriceKrw: 36900,
      productCostKrw: 6000,
      shippingKrw: 2800,
      extraCostKrw: 0
    });

    expect(Number(result.rule.fxRateKrwPerUsd)).toBe(1400);
    expect(fixture.exchangeRateLookups).toBe(1);
  });

  it.each([
    ["cost", (service: ProductsService) => service.saveCostRuleSnapshot("product-1", {
      effectiveFrom: "2026-08-21", salePriceKrw: 1, effectiveTo: null
    }), "PRODUCT_COST_RULE_EFFECTIVE_TO_MANAGED"],
    ["CPA", (service: ProductsService) => service.saveCpaRuleSnapshot("product-1", {
      effectiveFrom: "2026-08-21", targetRatio: 0.8, effectiveTo: null
    }), "PRODUCT_CPA_RULE_EFFECTIVE_TO_MANAGED"]
  ])("rejects client-managed effectiveTo for %s snapshots", async (_kind, request, code) => {
    await expectErrorCode(request(new ProductsService(productRuleHistoryFixture().prisma as never)), code);
  });

  it("rejects a first partial snapshot and an inactive product", async () => {
    await expectErrorCode(
      new ProductsService(productRuleHistoryFixture().prisma as never).saveCostRuleSnapshot("product-1", {
        effectiveFrom: "2026-08-21", salePriceKrw: 36900
      }),
      "PRODUCT_COST_RULE_BASE_REQUIRED"
    );
    await expectErrorCode(
      new ProductsService(productRuleHistoryFixture({ isActive: false }).prisma as never).saveCpaRuleSnapshot("product-1", {
        effectiveFrom: "2026-08-21", targetRatio: 0.8, watchRatio: 1.1, stopRatio: 1.25
      }),
      "PRODUCT_INACTIVE"
    );
  });

  it("applies the same snapshot and range rules to CPA histories", async () => {
    const fixture = productRuleHistoryFixture({
      cpaRules: [cpaRule("cpa-old", "2026-06-01", null)]
    });
    const service = new ProductsService(fixture.prisma as never);

    const created = await service.saveCpaRuleSnapshot("product-1", {
      effectiveFrom: "2026-08-21",
      targetRatio: 0.75
    });
    const updated = await service.saveCpaRuleSnapshot("product-1", {
      effectiveFrom: "2026-08-21",
      stopRatio: 1.2
    });

    expect(created.operation).toBe("CREATED");
    expect(updated.operation).toBe("UPDATED_SAME_DATE");
    expect(fixture.cpaRules).toHaveLength(2);
    expect(Number(updated.rule.targetRatio)).toBe(0.75);
    expect(Number(updated.rule.watchRatio)).toBe(1.1);
    expect(Number(updated.rule.stopRatio)).toBe(1.2);
    expect(dateText(fixture.cpaRule("cpa-old").effectiveTo)).toBe("2026-08-20");
  });

  it("rejects correction mismatch, duplicate dates, and empty corrections", async () => {
    const fixture = productRuleHistoryFixture({
      costRules: [costRule("cost-old", "2026-06-01", "2026-08-20"), costRule("cost-current", "2026-08-21", null)]
    });
    const service = new ProductsService(fixture.prisma as never);

    await expectErrorCode(service.correctCostRule("other-product", "cost-old", { salePriceKrw: 1 }), "PRODUCT_COST_RULE_PRODUCT_MISMATCH");
    await expectErrorCode(service.correctCostRule("product-1", "cost-old", { effectiveFrom: "2026-08-21" }), "PRODUCT_COST_RULE_DATE_EXISTS");
    await expectErrorCode(service.correctCostRule("product-1", "cost-old", {}), "PRODUCT_COST_RULE_CORRECTION_EMPTY");
    await expectErrorCode(service.correctCostRule("product-1", "missing", { salePriceKrw: 1 }), "PRODUCT_COST_RULE_NOT_FOUND");
  });

  it("recalculates VAT and normalizes neighboring ranges during an explicit correction", async () => {
    const fixture = productRuleHistoryFixture({
      costRules: [costRule("cost-old", "2026-06-01", "2026-08-20"), costRule("cost-current", "2026-08-21", null)]
    });
    const service = new ProductsService(fixture.prisma as never);

    const result = await service.correctCostRule("product-1", "cost-old", {
      salePriceKrw: 40000,
      effectiveFrom: "2026-06-02"
    });

    expect(result.operation).toBe("CORRECTED");
    expect(result.effectiveFrom).toBe("2026-06-02");
    expect(result.effectiveTo).toBe("2026-08-20");
    expect(Number(result.rule.vatKrw)).toBe(4000);
    expect(Number(result.rule.fxRateKrwPerUsd)).toBe(1350);
  });

  it("fails closed on pre-existing duplicate starts and reports dry-run keep candidates", async () => {
    const first = costRule("a", "2026-06-01", null);
    const latest = costRule("b", "2026-06-01", null, { createdAt: "2026-06-02T00:00:00.000Z" });
    const fixture = productRuleHistoryFixture({ costRules: [first, latest] });
    const service = new ProductsService(fixture.prisma as never);

    await expectErrorCode(service.saveCostRuleSnapshot("product-1", {
      effectiveFrom: "2026-08-21", salePriceKrw: 36900
    }), "PRODUCT_COST_RULE_DUPLICATE_DATES");
    const diagnostics = await service.productRuleDuplicateDiagnostics();
    expect(diagnostics.dryRun).toBe(true);
    expect(diagnostics.costRules.groups[0]).toMatchObject({
      keepCandidateId: "b",
      duplicateRuleIds: ["a"],
      identicalValues: true
    });
  });

  it("serializes concurrent same-date writes into one row", async () => {
    const fixture = productRuleHistoryFixture({
      costRules: [costRule("cost-old", "2026-06-01", null)]
    });
    const service = new ProductsService(fixture.prisma as never);

    const [first, second] = await Promise.all([
      service.saveCostRuleSnapshot("product-1", { effectiveFrom: "2026-08-21", salePriceKrw: 36900 }),
      service.saveCostRuleSnapshot("product-1", { effectiveFrom: "2026-08-21", shippingKrw: 3200 })
    ]);

    expect([first.operation, second.operation].sort()).toEqual(["CREATED", "UPDATED_SAME_DATE"]);
    expect(fixture.costRules.filter((rule) => dateText(rule.effectiveFrom) === "2026-08-21")).toHaveLength(1);
  });
});

function fakePrismaForDelete(input: { hasOperationalData?: boolean } = {}) {
  const productCreateCalls: any[] = [];
  const productUpdateCalls: any[] = [];
  const productDeleteCalls: any[] = [];
  const cafe24OrderLineCountCalls: any[] = [];
  const cafe24ProductRuleUpdateManyCalls: any[] = [];
  const cafe24CouponRuleUpdateManyCalls: any[] = [];
  const cafe24CouponRuleDeleteManyCalls: any[] = [];
  const zeroCount = { count: async () => 0 };
  const tx = {
    productMatchRule: { updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) },
    cafe24ProductRule: {
      updateMany: async (args: unknown) => {
        cafe24ProductRuleUpdateManyCalls.push(args);
        return { count: 1 };
      },
      deleteMany: async () => ({ count: 0 })
    },
    cafe24CouponRule: {
      updateMany: async (args: unknown) => {
        cafe24CouponRuleUpdateManyCalls.push(args);
        return { count: 1 };
      },
      deleteMany: async (args: unknown) => {
        cafe24CouponRuleDeleteManyCalls.push(args);
        return { count: 1 };
      }
    },
    metaAdset: { updateMany: async () => ({ count: 0 }) },
    productCpaRule: { deleteMany: async () => ({ count: 0 }) },
    productCostRule: { deleteMany: async () => ({ count: 0 }) },
    product: {
      create: async (args: unknown) => {
        productCreateCalls.push(args);
        return args;
      },
      update: async (args: unknown) => {
        productUpdateCalls.push(args);
        return { id: "product-1", isActive: false };
      },
      delete: async (args: unknown) => {
        productDeleteCalls.push(args);
        return args;
      }
    }
  };

  return {
    product: {
      createCalls: productCreateCalls,
      deleteCalls: productDeleteCalls,
      updateCalls: productUpdateCalls,
      create: tx.product.create,
      update: tx.product.update,
      findUnique: async () => ({ id: "product-1", code: "wavebar", displayName: "Wavebar" })
    },
    metaAdset: zeroCount,
    adsetProductHistory: zeroCount,
    uploadRow: zeroCount,
    metaAdsetDailyMetric: zeroCount,
    decisionLog: zeroCount,
    changeLog: zeroCount,
    productChangeLog: zeroCount,
    cafe24OrderLine: {
      countCalls: cafe24OrderLineCountCalls,
      count: async (args: unknown) => {
        cafe24OrderLineCountCalls.push(args);
        return input.hasOperationalData === false ? 0 : 1;
      }
    },
    cafe24ProductRule: {
      updateManyCalls: cafe24ProductRuleUpdateManyCalls,
      count: async () => 0
    },
    cafe24CouponRule: {
      updateManyCalls: cafe24CouponRuleUpdateManyCalls,
      deleteManyCalls: cafe24CouponRuleDeleteManyCalls
    },
    $transaction: async (callback: (tx: unknown) => unknown) => callback(tx)
  };
}

type CostRuleFixture = ReturnType<typeof costRule>;
type CpaRuleFixture = ReturnType<typeof cpaRule>;

function productRuleHistoryFixture(input: {
  costRules?: CostRuleFixture[];
  cpaRules?: CpaRuleFixture[];
  isActive?: boolean;
} = {}) {
  const costRules = [...(input.costRules ?? [])];
  const cpaRules = [...(input.cpaRules ?? [])];
  const advisoryLocks: unknown[] = [];
  let exchangeRateLookups = 0;
  let costSequence = 0;
  let cpaSequence = 0;
  let transactionTail = Promise.resolve();

  const costRepository = ruleRepository(costRules, "cost", () => ++costSequence);
  const cpaRepository = ruleRepository(cpaRules, "cpa", () => ++cpaSequence);
  const tx = {
    product: {
      findUnique: async ({ where }: any) => ({
        id: where.id,
        code: where.id,
        isActive: input.isActive !== false
      })
    },
    productCostRule: costRepository,
    productCpaRule: cpaRepository,
    exchangeRate: {
      findFirst: async () => {
        exchangeRateLookups += 1;
        return { rate: new Prisma.Decimal(1400) };
      }
    },
    $queryRaw: async (query: unknown) => {
      advisoryLocks.push(query);
      return [];
    }
  };
  const prisma = {
    ...tx,
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
      let release: () => void = () => {};
      const previous = transactionTail;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(tx);
      } finally {
        release();
      }
    }
  };

  return {
    prisma,
    costRules,
    cpaRules,
    advisoryLocks,
    get exchangeRateLookups() {
      return exchangeRateLookups;
    },
    costRule: (id: string) => costRules.find((rule) => rule.id === id)!,
    cpaRule: (id: string) => cpaRules.find((rule) => rule.id === id)!
  };
}

function ruleRepository<T extends CostRuleFixture | CpaRuleFixture>(rules: T[], prefix: string, nextSequence: () => number) {
  return {
    findMany: async (args: any = {}) => sortRuleFixtures(
      args.where?.productId ? rules.filter((rule) => rule.productId === args.where.productId) : rules
    ),
    findUnique: async ({ where }: any) => rules.find((rule) => rule.id === where.id) ?? null,
    findFirst: async ({ where }: any) => sortRuleFixtures(rules.filter((rule) =>
      (!where.productId || rule.productId === where.productId) &&
      (!where.effectiveFrom || rule.effectiveFrom.getTime() === where.effectiveFrom.getTime()) &&
      (!where.NOT?.id || rule.id !== where.NOT.id)
    )).reverse()[0] ?? null,
    create: async ({ data }: any) => {
      const sequence = nextSequence();
      const created = {
        ...data,
        id: `${prefix}-new-${sequence}`,
        createdAt: new Date(`2026-08-21T00:00:0${sequence}.000Z`),
        updatedAt: new Date(`2026-08-21T00:00:0${sequence}.000Z`)
      } as T;
      rules.push(created);
      return created;
    },
    update: async ({ where, data }: any) => {
      const rule = rules.find((candidate) => candidate.id === where.id);
      if (!rule) throw new Error(`Missing fixture rule ${where.id}`);
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) (rule as any)[key] = value;
      }
      rule.updatedAt = new Date(rule.updatedAt.getTime() + 1000);
      return rule;
    }
  };
}

function sortRuleFixtures<T extends { id: string; effectiveFrom: Date; createdAt: Date }>(rules: readonly T[]) {
  return [...rules].sort((left, right) =>
    left.effectiveFrom.getTime() - right.effectiveFrom.getTime() ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

function costRule(
  id: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  overrides: Partial<{
    productId: string;
    salePriceKrw: number;
    vatKrw: number;
    productCostKrw: number;
    shippingKrw: number;
    extraCostKrw: number;
    fxRateKrwPerUsd: number;
    note: string | null;
    createdAt: string;
  }> = {}
) {
  const salePriceKrw = overrides.salePriceKrw ?? 38900;
  const createdAt = new Date(overrides.createdAt ?? "2026-06-01T00:00:00.000Z");
  return {
    id,
    productId: overrides.productId ?? "product-1",
    salePriceKrw: new Prisma.Decimal(salePriceKrw),
    vatKrw: new Prisma.Decimal(overrides.vatKrw ?? salePriceKrw * 0.1),
    productCostKrw: new Prisma.Decimal(overrides.productCostKrw ?? 6000),
    shippingKrw: new Prisma.Decimal(overrides.shippingKrw ?? 2800),
    extraCostKrw: new Prisma.Decimal(overrides.extraCostKrw ?? 0),
    fxRateKrwPerUsd: new Prisma.Decimal(overrides.fxRateKrwPerUsd ?? 1350),
    effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`),
    effectiveTo: effectiveTo ? new Date(`${effectiveTo}T00:00:00.000Z`) : null,
    note: overrides.note ?? null,
    createdAt,
    updatedAt: createdAt
  };
}

function cpaRule(id: string, effectiveFrom: string, effectiveTo: string | null) {
  const createdAt = new Date("2026-06-01T00:00:00.000Z");
  return {
    id,
    productId: "product-1",
    targetRatio: new Prisma.Decimal(0.8),
    watchRatio: new Prisma.Decimal(1.1),
    stopRatio: new Prisma.Decimal(1.25),
    effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`),
    effectiveTo: effectiveTo ? new Date(`${effectiveTo}T00:00:00.000Z`) : null,
    note: null,
    createdAt,
    updatedAt: createdAt
  };
}

function dateText(value: Date | null) {
  return value?.toISOString().slice(0, 10) ?? null;
}

async function expectErrorCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect((error as { response?: { code?: string } }).response?.code).toBe(code);
  }
}
