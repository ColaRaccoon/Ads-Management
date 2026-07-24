import { MatchType, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const settings = [
  ["timezone", "Asia/Seoul", "Default reporting timezone"],
  ["default_conflict_policy", "SKIP", "Default duplicate upload conflict policy"],
  ["default_target_ratio", 0.8, "Default target CPA ratio"],
  ["default_watch_ratio", 1.1, "Default watch CPA ratio"],
  ["default_stop_ratio", 1.25, "Default stop-candidate CPA ratio"],
  ["good_ctr_link_pct", 1.0, "Watch threshold for link CTR percent"],
  ["good_landing_page_view_count", 3, "Watch threshold for landing page views"],
  ["purchase_result_indicators", ["구매", "웹사이트 구매", "purchase"], "Result labels treated as purchases"]
] as const;

const products = [
  { code: "burning-wavebar", name: "버닝 웨이브바", displayName: "버닝 웨이브바", pattern: "버닝웨이브바" },
  { code: "burning-slide", name: "버닝 슬라이드", displayName: "버닝 슬라이드", pattern: "버닝슬라이드" },
  { code: "flowlight", name: "플로우라이트", displayName: "플로우라이트", pattern: "플로우라이트" }
];

async function main() {
  const existingCoupangSalesFeeRule = await prisma.coupangSalesFeeRule.findFirst({
    orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }]
  });
  if (!existingCoupangSalesFeeRule) {
    await prisma.coupangSalesFeeRule.create({
      data: {
        salesFeeRate: 0.1188,
        effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
        note: "Default global Coupang sales fee rate (11.88%)"
      }
    });
  }

  await prisma.appUser.upsert({
    where: { email: "admin@meta-ads-performance.local" },
    update: { name: "Admin" },
    create: {
      email: "admin@meta-ads-performance.local",
      name: "Admin"
    }
  });

  for (const [key, valueJson, description] of settings) {
    await prisma.appSetting.upsert({
      where: { key },
      update: { valueJson, description },
      create: { key, valueJson, description }
    });
  }

  for (const [index, product] of products.entries()) {
    const savedProduct = await prisma.product.upsert({
      where: { code: product.code },
      update: {
        name: product.name,
        displayName: product.displayName,
        sortOrder: (index + 1) * 10
      },
      create: {
        code: product.code,
        name: product.name,
        displayName: product.displayName,
        sortOrder: (index + 1) * 10
      }
    });

    const existingRule = await prisma.productMatchRule.findFirst({
      where: {
        productId: savedProduct.id,
        pattern: product.pattern,
        matchType: MatchType.CONTAINS
      }
    });

    if (!existingRule) {
      await prisma.productMatchRule.create({
        data: {
          productId: savedProduct.id,
          matchType: MatchType.CONTAINS,
          pattern: product.pattern,
          patternKey: product.pattern.trim().toLowerCase(),
          priority: (index + 1) * 10,
          note: "Seeded default product name rule"
        }
      });
    }
  }
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
