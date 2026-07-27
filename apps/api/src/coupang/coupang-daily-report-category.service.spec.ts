import { describe, expect, it, vi } from "vitest";
import { CoupangService } from "./coupang.service";

const CATEGORY_A = "11111111-1111-4111-8111-111111111111";
const CATEGORY_B = "22222222-2222-4222-8222-222222222222";
const PRODUCT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRODUCT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRODUCT_MISSING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("Coupang daily report category writes", () => {
  it("creates empty and initially populated categories with normalized names and duplicate product ids removed", async () => {
    const fake = dailyCategoryPrisma();
    const service = new CoupangService(fake.prisma as never);

    const empty = await service.createDailyReportCategory({ displayName: "  홈   트레이닝  " });
    const populated = await service.createDailyReportCategory({
      displayName: "신제품",
      sortOrder: -1_000_000,
      productIds: [PRODUCT_A, PRODUCT_A, PRODUCT_B]
    });

    expect(empty).toMatchObject({ displayName: "홈 트레이닝", productIds: [], sortOrder: 100 });
    expect(populated).toMatchObject({ productIds: [PRODUCT_A, PRODUCT_B], sortOrder: -1_000_000 });
    await expect(service.createDailyReportCategory({ displayName: "홈 트레이닝" }))
      .rejects.toMatchObject({ response: { code: "COUPANG_DAILY_CATEGORY_NAME_CONFLICT" } });
  });

  it("validates sort-order bounds and requires a real boolean while allowing explicit reactivation", async () => {
    const fake = dailyCategoryPrisma({
      categories: [{ id: CATEGORY_A, displayName: "기존", standardName: "기존", sortOrder: 100, isActive: false }]
    });
    const service = new CoupangService(fake.prisma as never);

    await expect(service.updateDailyReportCategory(CATEGORY_A, { isActive: "false" }))
      .rejects.toMatchObject({ response: { code: "INVALID_DAILY_CATEGORY_BOOLEAN" } });
    await expect(service.updateDailyReportCategory(CATEGORY_A, { sortOrder: 1_000_001 }))
      .rejects.toMatchObject({ response: { code: "INVALID_DAILY_CATEGORY_SORT_ORDER" } });
    await expect(service.createDailyReportCategory({ displayName: "범위 밖", sortOrder: -1_000_001 }))
      .rejects.toMatchObject({ response: { code: "INVALID_DAILY_CATEGORY_SORT_ORDER" } });

    expect(await service.updateDailyReportCategory(CATEGORY_A, { isActive: true, sortOrder: 0 }))
      .toMatchObject({ isActive: true, sortOrder: 0 });
  });

  it("soft-deactivates without deleting membership", async () => {
    const fake = dailyCategoryPrisma({
      categories: [{ id: CATEGORY_A, displayName: "기존", standardName: "기존", sortOrder: 100, isActive: true }],
      memberships: [[CATEGORY_A, PRODUCT_A]]
    });
    const result = await new CoupangService(fake.prisma as never).deleteDailyReportCategory(CATEGORY_A);
    expect(result).toMatchObject({ isActive: false, productIds: [PRODUCT_A] });
    expect(fake.memberships()).toEqual([[CATEGORY_A, PRODUCT_A]]);
  });

  it("rejects a missing product before changing metadata or membership", async () => {
    const fake = dailyCategoryPrisma({
      categories: [{ id: CATEGORY_A, displayName: "기존", standardName: "기존", sortOrder: 100, isActive: true }],
      memberships: [[CATEGORY_A, PRODUCT_A]]
    });
    const service = new CoupangService(fake.prisma as never);
    const before = fake.category(CATEGORY_A);

    await expect(service.replaceDailyReportCategoryProducts(CATEGORY_A, {
      productIds: [PRODUCT_MISSING],
      displayName: "변경되면 안 됨",
      expectedUpdatedAt: before.updatedAt.toISOString()
    })).rejects.toMatchObject({ response: { code: "COUPANG_PRODUCT_NOT_FOUND" } });

    expect(fake.category(CATEGORY_A)).toMatchObject({ displayName: "기존" });
    expect(fake.memberships()).toEqual([[CATEGORY_A, PRODUCT_A]]);
  });

  it("atomically saves metadata and members while preserving other categories", async () => {
    const fake = dailyCategoryPrisma({
      categories: [
        { id: CATEGORY_A, displayName: "기존", standardName: "기존", sortOrder: 100, isActive: true },
        { id: CATEGORY_B, displayName: "다른", standardName: "다른", sortOrder: 100, isActive: true }
      ],
      memberships: [[CATEGORY_A, PRODUCT_A], [CATEGORY_B, PRODUCT_A]]
    });
    const service = new CoupangService(fake.prisma as never);
    const before = fake.category(CATEGORY_A);

    const result = await service.replaceDailyReportCategoryProducts(CATEGORY_A, {
      productIds: [PRODUCT_B, PRODUCT_B],
      displayName: "  통합   저장 ",
      sortOrder: 25,
      expectedUpdatedAt: before.updatedAt.toISOString()
    });

    expect(result).toMatchObject({ displayName: "통합 저장", sortOrder: 25, productIds: [PRODUCT_B] });
    expect(fake.memberships().sort()).toEqual([[CATEGORY_A, PRODUCT_B], [CATEGORY_B, PRODUCT_A]].sort());
  });

  it("uses an atomic updatedAt CAS so only one concurrent replacement succeeds", async () => {
    const fake = dailyCategoryPrisma({
      categories: [{ id: CATEGORY_A, displayName: "기존", standardName: "기존", sortOrder: 100, isActive: true }]
    });
    const service = new CoupangService(fake.prisma as never);
    const token = fake.category(CATEGORY_A).updatedAt.toISOString();

    const results = await Promise.allSettled([
      service.replaceDailyReportCategoryProducts(CATEGORY_A, {
        productIds: [PRODUCT_A],
        displayName: "첫 저장",
        expectedUpdatedAt: token
      }),
      service.replaceDailyReportCategoryProducts(CATEGORY_A, {
        productIds: [PRODUCT_B],
        displayName: "둘째 저장",
        expectedUpdatedAt: token
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ response: { code: "COUPANG_DAILY_CATEGORY_CHANGED" } });
    expect(fake.updateMany).toHaveBeenCalledTimes(2);
    expect(fake.memberships()).toHaveLength(1);
  });

  it("rolls metadata, token, and memberships back when a post-CAS membership write fails", async () => {
    const fake = dailyCategoryPrisma({
      categories: [{ id: CATEGORY_A, displayName: "기존", standardName: "기존", sortOrder: 100, isActive: true }],
      memberships: [[CATEGORY_A, PRODUCT_A]],
      failCreateMany: true
    });
    const service = new CoupangService(fake.prisma as never);
    const before = fake.category(CATEGORY_A);

    await expect(service.replaceDailyReportCategoryProducts(CATEGORY_A, {
      productIds: [PRODUCT_B],
      displayName: "롤백 대상",
      sortOrder: 1,
      expectedUpdatedAt: before.updatedAt.toISOString()
    })).rejects.toThrow("injected membership failure");

    expect(fake.category(CATEGORY_A)).toMatchObject({
      displayName: "기존",
      sortOrder: 100,
      updatedAt: before.updatedAt
    });
    expect(fake.memberships()).toEqual([[CATEGORY_A, PRODUCT_A]]);
  });

  it("maps a normalized-name conflict in unified save to 409 without changing the draft base", async () => {
    const fake = dailyCategoryPrisma({
      categories: [
        { id: CATEGORY_A, displayName: "첫 분류", standardName: "첫 분류", sortOrder: 100, isActive: true },
        { id: CATEGORY_B, displayName: "중복 이름", standardName: "중복 이름", sortOrder: 100, isActive: true }
      ],
      memberships: [[CATEGORY_A, PRODUCT_A]]
    });
    const service = new CoupangService(fake.prisma as never);
    const before = fake.category(CATEGORY_A);

    await expect(service.replaceDailyReportCategoryProducts(CATEGORY_A, {
      productIds: [PRODUCT_B],
      displayName: "  중복   이름 ",
      expectedUpdatedAt: before.updatedAt.toISOString()
    })).rejects.toMatchObject({ response: { code: "COUPANG_DAILY_CATEGORY_NAME_CONFLICT" } });

    expect(fake.category(CATEGORY_A)).toMatchObject({
      displayName: "첫 분류",
      updatedAt: before.updatedAt
    });
    expect(fake.memberships()).toEqual([[CATEGORY_A, PRODUCT_A]]);
  });
});

type CategorySeed = {
  id: string;
  displayName: string;
  standardName: string;
  sortOrder: number;
  isActive: boolean;
};

function dailyCategoryPrisma(input: {
  categories?: CategorySeed[];
  memberships?: [string, string][];
  failCreateMany?: boolean;
} = {}) {
  let tick = 0;
  const nextDate = () => new Date(1_700_000_000_000 + ++tick);
  const products = new Set([PRODUCT_A, PRODUCT_B]);
  const categories = new Map((input.categories ?? []).map((category) => [category.id, {
    ...category,
    createdAt: nextDate(),
    updatedAt: nextDate()
  }]));
  const memberships = new Set((input.memberships ?? []).map(([categoryId, productId]) => `${categoryId}:${productId}`));
  const categoryWithMembers = (id: string) => {
    const category = categories.get(id);
    if (!category) return null;
    return {
      ...category,
      members: [...memberships]
        .map((key) => key.split(":") as [string, string])
        .filter(([categoryId]) => categoryId === id)
        .map(([, coupangProductId]) => ({ coupangProductId }))
    };
  };
  const assertUnique = (standardName: string, excludingId?: string) => {
    if ([...categories.values()].some((category) => category.id !== excludingId && category.standardName === standardName)) {
      throw { code: "P2002" };
    }
  };
  const updateMany = vi.fn(async ({ where, data }: any) => {
    const current = categories.get(where.id);
    if (!current || current.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
    if (data.standardName) assertUnique(data.standardName, current.id);
    categories.set(current.id, { ...current, ...data });
    return { count: 1 };
  });
  const categoryDelegate = {
    create: vi.fn(async ({ data }: any) => {
      assertUnique(data.standardName);
      const id = data.standardName === "홈 트레이닝" ? CATEGORY_A : CATEGORY_B;
      const category = {
        id,
        displayName: data.displayName,
        standardName: data.standardName,
        sortOrder: data.sortOrder,
        isActive: true,
        createdAt: nextDate(),
        updatedAt: nextDate()
      };
      categories.set(id, category);
      for (const member of data.members?.createMany?.data ?? []) memberships.add(`${id}:${member.coupangProductId}`);
      return categoryWithMembers(id);
    }),
    findUnique: vi.fn(async ({ where }: any) => categoryWithMembers(where.id)),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const category = categoryWithMembers(where.id);
      if (!category) throw new Error("missing");
      return category;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const current = categories.get(where.id);
      if (!current) throw new Error("missing");
      if (data.standardName) assertUnique(data.standardName, current.id);
      categories.set(current.id, { ...current, ...data, updatedAt: data.updatedAt ?? nextDate() });
      return categoryWithMembers(current.id);
    }),
    updateMany
  };
  const tx = {
    coupangProduct: {
      findMany: vi.fn(async ({ where }: any) => (
        where.id.in.filter((id: string) => products.has(id)).map((id: string) => ({ id }))
      ))
    },
    coupangDailyReportCategory: categoryDelegate,
    coupangDailyReportCategoryProduct: {
      deleteMany: vi.fn(async ({ where }: any) => {
        for (const key of [...memberships]) {
          const [categoryId, productId] = key.split(":");
          if (categoryId === where.categoryId && !where.coupangProductId.notIn.includes(productId)) memberships.delete(key);
        }
      }),
      createMany: vi.fn(async ({ data }: any) => {
        if (input.failCreateMany) throw new Error("injected membership failure");
        for (const member of data) memberships.add(`${member.categoryId}:${member.coupangProductId}`);
      })
    }
  };
  let transactionTail = Promise.resolve();
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const categorySnapshot = [...categories].map(([id, category]) => [id, { ...category, updatedAt: new Date(category.updatedAt) }] as const);
      const membershipSnapshot = [...memberships];
      try {
        return await callback(tx);
      } catch (error) {
        categories.clear();
        for (const [id, category] of categorySnapshot) categories.set(id, category);
        memberships.clear();
        for (const membership of membershipSnapshot) memberships.add(membership);
        throw error;
      } finally {
        release();
      }
    })
  };
  return {
    prisma,
    updateMany,
    category: (id: string) => categoryWithMembers(id)!,
    memberships: () => [...memberships].map((key) => key.split(":") as [string, string])
  };
}
