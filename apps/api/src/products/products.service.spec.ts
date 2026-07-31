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

async function expectErrorCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect((error as { response?: { code?: string } }).response?.code).toBe(code);
  }
}
