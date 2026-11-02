import "reflect-metadata";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../common/prisma.service";
import { SalesMetricsService, type NativeMetaFinancialRow } from "../sales/sales-metrics.service";
import { GoogleReadService } from "../google/google-read.service";
import { readNativeStorefrontResults } from "./native-storefront-results";

type GoogleDay = Awaited<ReturnType<GoogleReadService["nativeStorefrontDay"]>>;
type GoogleRow = NonNullable<GoogleDay["nativeFinancialRows"]>[number];
const metaRow = (extra: Partial<NativeMetaFinancialRow> = {}): NativeMetaFinancialRow => ({ productId: "p", productName: "상품",
  revenue: 10000, grossCost: 4000, coupon: 1000, profitBeforeAds: 5000, adSpend: 2000,
  estimatedProfit: 3000, quantity: 1, salesRows: 1, issues: [], ...extra });
const googleRow = (extra: Partial<GoogleRow> = {}): GoogleRow => ({ productId: "p", productName: "상품", date: "2026-11-01",
  revenueKrw: 10000, grossCostKrw: 4000, couponDeductionKrw: 1000, profitBeforeAdsKrw: 5000,
  adSpendKrw: 2000, marginKrw: 3000, quantity: 1, salesRows: 1, complete: true, warningCodes: [], ...extra });

async function fixture(options: { meta?: NativeMetaFinancialRow[]; google?: GoogleRow[]; sourceComplete?: boolean;
  shops?: number; selectionFailed?: boolean; dependency?: number; assertCoupon?: boolean } = {}) {
  const dependencies = { value: options.dependency ?? 1 };
  const tx = { sourceConnection: { findMany: async () => Array.from({ length: options.shops ?? 1 }, (_, i) => ({ id: `shop-${i}` })) },
    productCostRule: { findMany: async () => [dependencies] } } as unknown as Prisma.TransactionClient;
  mock.method(SalesMetricsService.prototype, "nativeMetaStorefrontDay", async function(this: SalesMetricsService, _date: string, _scope: string,
    _ads: boolean, coupons?: ReadonlyMap<string, number | null>) {
    await (this as unknown as { prisma: Prisma.TransactionClient }).prisma.productCostRule.findMany();
    if (options.assertCoupon) assert.deepEqual(coupons, new Map([["line", 1001]]));
    return options.meta ?? [];
  });
  mock.method(GoogleReadService.prototype, "nativeStorefrontDay", async () => ({ nativeFinancialRows: options.google ?? [],
    nativeFinancialCouponLines: [{ id: "line", amount: 1001 }], nativeSalesSelectionFailed: options.selectionFailed ?? false }) as GoogleDay);
  try { return await readNativeStorefrontResults(tx, { date: "2026-11-01", scopeKey: "shop-0", sourceComplete: options.sourceComplete ?? true }); }
  finally { mock.restoreAll(); }
}

test("empty source requires collection evidence before either channel becomes zero", async () => {
  const complete = await fixture();
  assert.equal(complete.rows.length, 2);
  assert.ok(complete.rows.every(row => row.revenue === "0.000000" && row.profitBeforeAds === "0.000000" && row.complete));
  const absent = await fixture({ sourceComplete: false });
  assert.ok(absent.rows.every(row => row.revenue === null && row.profitBeforeAds === null && !row.complete));
});

test("unknown-only native results never acquire an additional numeric zero", async () => {
  const result = await fixture({ meta: [metaRow({ revenue: null, grossCost: null, coupon: null, profitBeforeAds: null, estimatedProfit: null })],
    google: [googleRow({ revenueKrw: null, profitBeforeAdsKrw: null, complete: false })] });
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(row => row.revenue === null && row.profitBeforeAds === null && !row.complete));
});

test("missing Google ads preserve independently known sales before ads and pass one coupon ledger to Meta", async () => {
  const result = await fixture({ meta: [metaRow()], google: [googleRow({ adSpendKrw: null, marginKrw: null,
    warningCodes: ["GOOGLE_COLLECTION_INCOMPLETE"] })], assertCoupon: true });
  assert.equal(result.rows.find(row => row.channel === "YOUTUBE")?.profitBeforeAds, "5000.000000");
  assert.equal(result.rows.find(row => row.channel === "YOUTUBE")?.complete, true);
  assert.equal(result.rows.find(row => row.channel === "META")?.estimatedProfit, "3000.000000");
});

test("Google advertising selection failure does not become a Cafe24 execution failure", async () => {
  const result = await fixture({ meta: [metaRow()], google: [googleRow({ adSpendKrw: null, marginKrw: null,
    warningCodes: ["SOURCE_SELECTION_REQUIRED"] })] });
  assert.ok(result.rows.every(row => !row.issues.includes("SOURCE_SELECTION_REQUIRED")));
  assert.ok(result.rows.find(row => row.channel === "YOUTUBE")?.issues.includes("GOOGLE_AD_AUDIT_UNAVAILABLE"));
  assert.equal(result.rows.find(row => row.channel === "META")?.profitBeforeAds, "5000.000000");
});

test("a failed Cafe24 selection cannot confirm an empty YouTube channel", async () => {
  const result = await fixture({ selectionFailed: true });
  assert.equal(result.rows.find(row => row.channel === "YOUTUBE")?.revenue, null);
});

test("several shops retain sales before ads while ambiguous ad ownership stays unknown", async () => {
  const result = await fixture({ shops: 2, meta: [metaRow()], google: [googleRow()] });
  assert.ok(result.rows.every(row => row.profitBeforeAds === "5000.000000" && row.complete));
  assert.ok(result.rows.every(row => row.adSpend === null && row.estimatedProfit === null && row.issues.includes("ATTRIBUTION_UNKNOWN")));
});

test("negative margins, confirmed zero and ad-only source gaps remain distinct", async () => {
  const result = await fixture({ sourceComplete: false, meta: [metaRow({ quantity: 0, salesRows: 0, revenue: 0, profitBeforeAds: 0, estimatedProfit: -2000 })],
    google: [googleRow({ profitBeforeAdsKrw: -10, marginKrw: -2010 })] });
  assert.equal(result.rows.find(row => row.channel === "META")?.profitBeforeAds, null);
  assert.equal(result.rows.find(row => row.channel === "YOUTUBE")?.profitBeforeAds, "-10.000000");
});

test("fingerprint is repeatable and changes with native cost dependencies or financial outputs", async () => {
  const first = await fixture({ meta: [metaRow()] }), same = await fixture({ meta: [metaRow()] });
  assert.equal(first.sourceFingerprint, same.sourceFingerprint);
  assert.notEqual(first.sourceFingerprint, (await fixture({ meta: [metaRow()], dependency: 2 })).sourceFingerprint);
  assert.notEqual(first.sourceFingerprint, (await fixture({ meta: [metaRow({ profitBeforeAds: 4999 })] })).sourceFingerprint);
});

test("actual Meta core consumes shared canonical line coupons after excluding remapped YouTube sales", async () => {
  const date = new Date("2026-11-01"), d = (value: number) => new Prisma.Decimal(value);
  const lines = [{ id: "meta", productName: "일반 상품", productId: "p", product: { id: "p", displayName: "상품", isActive: true } },
    { id: "yt", productName: "[유튜브] 상품", productId: null, product: null }].map(line => ({ ...line, orderDate: date,
      orderNo: "order", source: "CSV", connectionId: "shop", uploadBatchId: "batch", matchRule: null,
      quantity: d(1), salePriceKrw: d(10000), totalOrderKrw: d(20000), totalPaidKrw: d(19000), paymentMethod: "카드", validationStatus: "VALID" }));
  const cost = { id: "cost", productId: "p", effectiveFrom: new Date("2026-01-01"), effectiveTo: null, createdAt: date,
    salePriceKrw: d(10000), vatKrw: d(1000), productCostKrw: d(2000), shippingKrw: d(1000), extraCostKrw: d(0), fxRateKrwPerUsd: d(1400) };
  const prisma = { productCostRule: { findMany: async () => [cost] }, cafe24CouponRule: { findMany: async () => [] } } as unknown as PrismaService;
  const service = new SalesMetricsService(prisma);
  mock.method(service as unknown as { cafe24SalesLines: () => unknown }, "cafe24SalesLines", async () => ({ salesLines: lines,
    couponLines: lines, couponInputSources: new Map() }));
  try {
    const rows = await service.nativeMetaStorefrontDay("2026-11-01", "shop", false, new Map([["meta", 400], ["yt", 600]]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].revenue, 10000);
    assert.equal(rows[0].coupon, 400);
    assert.equal(rows[0].profitBeforeAds, 5600);
    assert.equal(rows[0].adSpend, null);
    const nonMixed = await service.nativeMetaStorefrontDay("2026-11-01", "shop", false, new Map());
    assert.equal(nonMixed[0].coupon, 0);
    assert.equal(nonMixed[0].profitBeforeAds, 6000);
  } finally { mock.restoreAll(); }
});

test("actual Meta ad policy conflict leaves canonical sales available and only nulls the audit", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  const date = new Date("2026-11-01"), d = (value: number) => new Prisma.Decimal(value);
  const line = { id: "meta", productName: "일반 상품", productId: "p", product: { id: "p", displayName: "상품", isActive: true },
    orderDate: date, orderNo: "order", source: "CSV", connectionId: "shop", uploadBatchId: "batch", matchRule: null,
    quantity: d(1), salePriceKrw: d(10000), totalOrderKrw: d(10000), totalPaidKrw: d(10000), paymentMethod: "카드", validationStatus: "VALID" };
  const cost = { id: "cost", productId: "p", effectiveFrom: new Date("2026-01-01"), effectiveTo: null, createdAt: date,
    salePriceKrw: d(10000), vatKrw: d(1000), productCostKrw: d(2000), shippingKrw: d(1000), extraCostKrw: d(0), fxRateKrwPerUsd: d(1400) };
  const prisma = { metaAdsetDailyMetric: { findMany: async () => [{ id: "ad", source: "API", connectionId: "meta-shop", metricDate: date }] },
    sourcePolicy: { findMany: async () => [] }, exchangeRate: { findMany: async () => [] },
    productCostRule: { findMany: async () => [cost] }, cafe24CouponRule: { findMany: async () => [] } } as unknown as PrismaService;
  const service = new SalesMetricsService(prisma);
  mock.method(service as unknown as { cafe24SalesLines: () => unknown }, "cafe24SalesLines", async () => ({ salesLines: [line],
    couponLines: [line], couponInputSources: new Map() }));
  try {
    const rows = await service.nativeMetaStorefrontDay("2026-11-01", "shop", true, new Map([["meta", 0]]));
    assert.equal(rows[0].profitBeforeAds, 6000);
    assert.equal(rows[0].adSpend, null);
    assert.equal(rows[0].estimatedProfit, null);
    assert.ok(rows[0].issues.includes("META_AD_AUDIT_UNAVAILABLE"));
  } finally { mock.restoreAll(); if (previous === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});
