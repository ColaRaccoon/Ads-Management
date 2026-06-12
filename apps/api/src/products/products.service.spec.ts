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
    expect(prisma.product.deleteCalls).toHaveLength(0);
  });
});

function fakePrismaForDelete() {
  const productUpdateCalls: any[] = [];
  const productDeleteCalls: any[] = [];
  const cafe24OrderLineCountCalls: any[] = [];
  const cafe24ProductRuleUpdateManyCalls: any[] = [];
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
    metaAdset: { updateMany: async () => ({ count: 0 }) },
    productCpaRule: { deleteMany: async () => ({ count: 0 }) },
    productCostRule: { deleteMany: async () => ({ count: 0 }) },
    product: {
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
      deleteCalls: productDeleteCalls,
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
        return 1;
      }
    },
    cafe24ProductRule: {
      updateManyCalls: cafe24ProductRuleUpdateManyCalls,
      count: async () => 0
    },
    $transaction: async (callback: (tx: unknown) => unknown) => callback(tx)
  };
}
