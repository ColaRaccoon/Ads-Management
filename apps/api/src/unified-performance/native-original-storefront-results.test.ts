import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaService } from "../common/prisma.service";
import { Prisma } from "@prisma/client";
import { SalesMetricsService } from "../sales/sales-metrics.service";
import { calculateGooglePerformance } from "../google/google-performance";
import { originalGoogleStoredResults, originalMetaStoredResults, readOriginalStorefrontResults } from "./native-original-storefront-results";

type MetaReport = Parameters<typeof originalMetaStoredResults>[0];
type GoogleReport = Parameters<typeof originalGoogleStoredResults>[0];
const metaRow = { productId: "source-product-id", product: { displayName: "원본 제품명 [유튜브]" }, quantity: 2,
  revenueKrw: 10000, totalPaidKrw: 9000, adSpendUsd: 1, adSpendKrw: 1300,
  grossCostKrw: 3000, couponDeductionKrw: 500, marginKrw: 5100,
  matchedSalesLineCount: 2, couponUnknownOrderCount: 0, couponUnmatchedOrderCount: 0, ruleStatus: "OK" };
const meta = (rows: object[] = [metaRow]) => ({ rows, summary: { adUnmatchedSpendKrw: 700, salesUnmatchedCount: 1 } }) as MetaReport;
const googleRow = { productId: "google-product", productName: "Google 원본", quantity: 1,
  revenueKrwExact: "9007199254740993.123456", knownRevenueKrwExact: "9007199254740993.123456",
  adSpendKrwExact: "123.123456", knownAdSpendKrwExact: "123.123456", marginKrwExact: "17.123456",
  profitBeforeAdsKrwExact: "300.333333", complete: true, warningCodes: [] as string[] };
const google = (row = googleRow) => ({ products: [row], summary: { ...row,
  productId: null, adSpendKrwExact: "999.123456", knownAdSpendKrwExact: "999.123456", marginKrwExact: null,
  complete: false, warningCodes: ["UNALLOCATED_AD_SPEND"] } }) as unknown as GoogleReport;

test("Meta source snapshot preserves original whole-storefront final margin and native product identity", () => {
  const result = originalMetaStoredResults(meta(), true);
  const product = result.find(row => row.kind === "PRODUCT")!;
  assert.equal(product.productKey, "source-product-id");
  assert.equal(product.productName, "원본 제품명 [유튜브]");
  assert.deepEqual(product.netProfit, { known: "5100", complete: "5100" });
  // A different reconstructed revenue - cost - coupon - ad would be 5200.
  assert.equal(result[0].netProfit.complete, "5100");
  assert.equal(result[0].adSpend.complete, "1300");
  assert.equal(result[0].audit?.unallocatedAdSpend, "700");
  assert.ok(product.issues.includes("STOREFRONT_GOOGLE_SALES_MAY_OVERLAP"));
});

test("Meta source nullable totals and uncollected empty days never become final zero", () => {
  const partial = originalMetaStoredResults(meta([metaRow, { ...metaRow, productId: "second", marginKrw: null }]), true);
  assert.deepEqual(partial[0].netProfit, { known: null, complete: null });
  assert.deepEqual(originalMetaStoredResults(meta([]), false)[0].revenue, { known: null, complete: null });
  assert.deepEqual(originalMetaStoredResults(meta([]), true)[0].revenue, { known: "0", complete: "0" });
});

test("Google persists exact Decimal outputs and original account summary instead of summing products", () => {
  const rows = originalGoogleStoredResults(google(), true);
  assert.equal(rows[1].revenue.complete, "9007199254740993.123456");
  assert.equal(rows[1].netProfit.complete, "17.123456");
  assert.equal(rows[0].adSpend.complete, "999.123456");
  assert.deepEqual(rows[0].netProfit, { known: null, complete: null });
  assert.equal(rows[1].adSpend.complete, "123.123456");
});

test("Google unknown source metrics retain partial known totals separately", () => {
  const row = { ...googleRow, adSpendKrwExact: null, marginKrwExact: null, complete: false,
    warningCodes: ["GOOGLE_COLLECTION_INCOMPLETE"] } as unknown as typeof googleRow;
  const product = originalGoogleStoredResults(google(row), false)[1];
  assert.deepEqual(product.adSpend, { known: "123.123456", complete: null });
  assert.equal(product.revenue.complete, null);
  assert.deepEqual(product.netProfit, { known: null, complete: null });
});

test("actual Google source calculator exposes an exact final loss without a number round trip", () => {
  const source = calculateGooglePerformance({ salesLines: [], days: [{ date: "2026-11-01", googleComplete: true, cafe24Complete: true }],
    adMetrics: [{ id: "ad", date: "2026-11-01", connectionId: "account", customerId: "customer", campaignId: "campaign",
      campaignName: "source product", currencyCode: "KRW", costMicros: "9007199254740993123456", impressions: 0,
      clicks: 0, productId: "product", timeZone: "Asia/Seoul" }] });
  assert.equal(source.products[0].adSpendKrwExact, "9007199254740993.123456");
  assert.equal(source.products[0].marginKrwExact, "-9007199254740993.123456");
  assert.equal(source.products[0].revenueKrwExact, "0");
  assert.equal(source.products[0].profitBeforeAdsKrwExact, "0");
});

test("multiple storefront ownership cannot duplicate an unscoped original report", async () => {
  const noReads = new Proxy({}, { get() { throw new Error("must not query an unowned source"); } }) as PrismaService;
  const rows = await readOriginalStorefrontResults(noReads, { date: "2026-11-01", scopeKey: "second-shop", sourceComplete: true, ownsSource: false });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.kind === "SUMMARY" && row.revenue.known === null && row.issues.includes("SOURCE_SCOPE_UNSUPPORTED")));
});

test("restricted Meta projection preserves original financial outputs without full metric, sales or FX reads", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  const queries: Array<{ table: string; args: Record<string, any> }> = [];
  const read = (table: string, rows: unknown[]) => async (args: Record<string, any>) => { queries.push({ table, args }); return rows; };
  const product = { id: "p", displayName: "원본 상품", isActive: true };
  const date = new Date("2026-11-01T00:00:00Z");
  const db = { cafe24UploadBatch: { findMany: read("batches", []) }, cafe24OrderLine: { findMany: read("sales", []) },
    metaAdsetDailyMetric: { findMany: read("ads", [{ id: "ad", source: "CSV", productId: "p", product, metricDate: date,
      spendUsd: new Prisma.Decimal("10.25"), adsetName: "원본 상품" }]) },
    productCostRule: { findMany: read("cost", []) }, cafe24CouponRule: { findMany: read("coupon", []) },
    exchangeRate: { findMany: read("fx", [{ id: "rate", rateDate: date, rate: new Prisma.Decimal("1300.25") }]) }
  } as unknown as PrismaService;
  try {
    const service = new SalesMetricsService(db);
    const original = await service.productPerformance({ from: "2026-11-01", to: "2026-11-01" });
    assert.equal(queries.find(q => q.table === "ads")?.args.include.product, true);
    queries.length = 0;
    const projected = await service.productPerformance({ from: "2026-11-01", to: "2026-11-01" }, true);
    assert.deepEqual(projected, original);
    assert.equal(projected.rows[0].adSpendKrw, 13327.5625);
    assert.equal(projected.rows[0].marginKrw, -13327.5625);
    for (const table of ["sales", "ads", "fx"]) {
      const args = queries.find(q => q.table === table)!.args;
      assert.ok(args.select, `${table} must select explicit authorized columns`);
      assert.equal(args.include, undefined);
      assert.equal(args.select.providerPayload, undefined);
    }
    assert.deepEqual(queries.find(q => q.table === "ads")!.args.select.product, { select: { id: true, displayName: true, isActive: true } });
  } finally { if (previous === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});
