import { Cafe24CouponScope, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { Cafe24CouponRulesService } from "./cafe24-coupon-rules.service";

describe("Cafe24CouponRulesService", () => {
  it("creates a product coupon for an active product", async () => {
    const prisma = fakePrisma();
    const service = new Cafe24CouponRulesService(prisma as never);

    await service.createCouponRule(productBody());

    expect(prisma.productFindCalls).toEqual([{ where: { id: "product-1" } }]);
    expect(prisma.createCalls[0]).toMatchObject({
      data: {
        name: "Product coupon",
        scope: Cafe24CouponScope.PRODUCT,
        productId: "product-1",
        priority: 100,
        isActive: true
      },
      include: { product: true }
    });
    expect(prisma.createCalls[0].data.discountKrw.toNumber()).toBe(5000);
  });

  it("creates a global coupon without looking up a product", async () => {
    const prisma = fakePrisma();
    const service = new Cafe24CouponRulesService(prisma as never);

    await service.createCouponRule({
      name: "Global coupon",
      scope: "GLOBAL",
      productId: null,
      discountKrw: 1000,
      validFrom: "2026-07-01"
    });

    expect(prisma.productFindCalls).toEqual([]);
    expect(prisma.createCalls[0].data).toMatchObject({
      scope: Cafe24CouponScope.GLOBAL,
      productId: null
    });
  });

  it("rejects a product coupon without productId", async () => {
    const service = new Cafe24CouponRulesService(fakePrisma() as never);
    await expectErrorCode(
      service.createCouponRule({ ...productBody(), productId: undefined }),
      "COUPON_PRODUCT_REQUIRED"
    );
  });

  it("rejects a global coupon with productId", async () => {
    const service = new Cafe24CouponRulesService(fakePrisma() as never);
    await expectErrorCode(
      service.createCouponRule({ ...productBody(), scope: "GLOBAL" }),
      "GLOBAL_COUPON_PRODUCT_FORBIDDEN"
    );
  });

  it.each([0, -1, 1000.5, "not-a-number"])("rejects invalid coupon amount %s", async (discountKrw) => {
    const service = new Cafe24CouponRulesService(fakePrisma() as never);
    await expectErrorCode(
      service.createCouponRule({ ...productBody(), discountKrw }),
      "INVALID_COUPON_AMOUNT"
    );
  });

  it("rejects a date range ending before it begins", async () => {
    const service = new Cafe24CouponRulesService(fakePrisma() as never);
    await expectErrorCode(
      service.createCouponRule({
        ...productBody(),
        validFrom: "2026-07-10",
        validTo: "2026-07-09"
      }),
      "INVALID_COUPON_DATE_RANGE"
    );
  });

  it("rejects an inactive product", async () => {
    const service = new Cafe24CouponRulesService(
      fakePrisma({ product: { id: "product-1", isActive: false } }) as never
    );
    await expectErrorCode(service.createCouponRule(productBody()), "PRODUCT_INACTIVE");
  });

  it("applies product, scope, and inactive filters to the list query", async () => {
    const prisma = fakePrisma();
    const service = new Cafe24CouponRulesService(prisma as never);

    await service.listCouponRules({
      productId: "product-1",
      scope: "PRODUCT",
      includeInactive: true
    });
    await service.listCouponRules({ scope: "GLOBAL" });

    expect(prisma.findManyCalls[0]).toMatchObject({
      where: {
        productId: "product-1",
        scope: Cafe24CouponScope.PRODUCT
      },
      include: { product: true }
    });
    expect(prisma.findManyCalls[0].where).not.toHaveProperty("isActive");
    expect(prisma.findManyCalls[1].where).toEqual({
      isActive: true,
      scope: Cafe24CouponScope.GLOBAL
    });
  });

  it("updates every editable field after validating the merged rule", async () => {
    const prisma = fakePrisma();
    const service = new Cafe24CouponRulesService(prisma as never);

    await service.updateCouponRule("rule-1", {
      name: "Updated coupon",
      productId: "product-2",
      discountKrw: 6000,
      priority: 5,
      validFrom: "2026-08-01",
      validTo: "2026-08-31",
      note: "updated"
    });

    expect(prisma.productFindCalls.at(-1)).toEqual({ where: { id: "product-2" } });
    expect(prisma.updateCalls[0]).toMatchObject({
      where: { id: "rule-1" },
      data: {
        name: "Updated coupon",
        scope: Cafe24CouponScope.PRODUCT,
        productId: "product-2",
        priority: 5,
        note: "updated"
      }
    });
    expect(prisma.updateCalls[0].data.discountKrw.toNumber()).toBe(6000);
  });

  it("deactivates a rule while preserving its history", async () => {
    const prisma = fakePrisma();
    const service = new Cafe24CouponRulesService(prisma as never);

    await service.updateCouponRule("rule-1", { isActive: false });

    expect(prisma.updateCalls[0]).toMatchObject({
      where: { id: "rule-1" },
      data: { isActive: false }
    });
  });

  it.each([
    ["create", () => new Cafe24CouponRulesService(fakePrisma() as never).createCouponRule({
      ...productBody(),
      isActive: "false"
    })],
    ["update", () => new Cafe24CouponRulesService(fakePrisma() as never).updateCouponRule("rule-1", {
      isActive: "false"
    })]
  ])("rejects a non-boolean isActive value on %s", async (_operation, request) => {
    await expectErrorCode(request(), "INVALID_BOOLEAN");
  });

  it("allows an existing product rule to be disabled after its product became inactive", async () => {
    const prisma = fakePrisma({ product: { id: "product-1", isActive: false } });
    const service = new Cafe24CouponRulesService(prisma as never);

    await service.updateCouponRule("rule-1", { isActive: false });

    expect(prisma.productFindCalls).toEqual([]);
    expect(prisma.updateCalls[0].data.isActive).toBe(false);
  });

  it("returns COUPON_RULE_NOT_FOUND for a missing update target", async () => {
    const service = new Cafe24CouponRulesService(fakePrisma({ existing: null }) as never);
    await expectErrorCode(service.updateCouponRule("missing", { isActive: false }), "COUPON_RULE_NOT_FOUND");
  });
});

function productBody() {
  return {
    name: "Product coupon",
    scope: "PRODUCT",
    productId: "product-1",
    discountKrw: 5000,
    priority: 100,
    validFrom: "2026-07-01",
    validTo: null,
    isActive: true,
    note: "note"
  };
}

function fakePrisma(
  input: {
    product?: { id: string; isActive: boolean } | null;
    existing?: Record<string, unknown> | null;
  } = {}
) {
  const createCalls: any[] = [];
  const updateCalls: any[] = [];
  const findManyCalls: any[] = [];
  const productFindCalls: any[] = [];
  const existing =
    input.existing === undefined
      ? {
          id: "rule-1",
          name: "Product coupon",
          scope: Cafe24CouponScope.PRODUCT,
          productId: "product-1",
          discountKrw: new Prisma.Decimal(5000),
          priority: 100,
          validFrom: date("2026-07-01"),
          validTo: null,
          isActive: true,
          note: "note",
          createdAt: date("2026-07-01"),
          updatedAt: date("2026-07-01")
        }
      : input.existing;

  return {
    createCalls,
    updateCalls,
    findManyCalls,
    productFindCalls,
    product: {
      findUnique: async (args: unknown) => {
        productFindCalls.push(args);
        return input.product === undefined ? { id: "product-1", isActive: true } : input.product;
      }
    },
    cafe24CouponRule: {
      findMany: async (args: unknown) => {
        findManyCalls.push(args);
        return [];
      },
      findUnique: async () => existing,
      create: async (args: any) => {
        createCalls.push(args);
        return { id: "created-rule", ...args.data };
      },
      update: async (args: any) => {
        updateCalls.push(args);
        return { id: "rule-1", ...args.data };
      }
    }
  };
}

async function expectErrorCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    if (error instanceof Error && error.message === `Expected ${code}`) {
      throw error;
    }
    const response =
      error && typeof error === "object" && "getResponse" in error && typeof error.getResponse === "function"
        ? error.getResponse()
        : error;
    expect(response).toMatchObject({ code });
  }
}

function date(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}
