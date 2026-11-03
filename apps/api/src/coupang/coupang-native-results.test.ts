import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { CoupangService, buildCoupangNativeProductProfitRows, summarizeCoupangProductProfitRows } from "./coupang.service";
import { parseDateRange } from "../common/date-range";
import { readCoupangNativeDailyResults } from "./coupang-native-results";
import type { PrismaService } from "../common/prisma.service";
import { readCoupangDay } from "../unified-performance/adapters/coupang.adapter";
import { CONTRACT_VERSION, type AdapterRequest } from "../unified-performance/types";
import type { UnifiedManagementRepository } from "../unified-performance/management.repository";

const date = "2026-10-20", at = new Date(`${date}T00:00:00.000Z`), D = (value: number) => new Prisma.Decimal(value);
const version = { scopePolicyVersion: "p", nameRuleVersion: "n", saleUnitRuleVersion: "u", allocationRuleVersion: "a" };
const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: "r", readSnapshotId: "s", from: date, to: date,
  scopeKeys: ["LEGACY_COUPANG_SINGLE_UPLOAD"], platforms: ["COUPANG"], ...version, calculationVersion: "c", fxVersion: "f",
  sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 };
const management = { snapshot: async () => ({ products: [], rules: [], versions: version }) } as unknown as UnifiedManagementRepository;

type Selection = { select?: Record<string, boolean | Selection> };
function selected<T>(rows: T[], args: Selection): T[] {
  if (!args.select) return rows;
  return rows.map(row => Object.fromEntries(Object.entries(args.select!).flatMap(([key, spec]) => {
    if (!spec) return [];
    const value = (row as Record<string, unknown>)[key];
    return [[key, spec === true || value == null ? value : selected([value], spec)[0]]];
  })) as T);
}

function fixture() {
  const products = ["p", "missing", "adonly"].map(id => ({ id, standardName: id, displayName: id,
    isActive: true, group: null, groupId: null, sortOrder: 100, createdAt: at, updatedAt: at }));
  const sales = [{ id: "sale", saleLineKey: "sale", uploadBatchId: "batch", importVersion: 1, validationStatus: "VALID",
    sourceRowHash: "sale", createdAt: at, saleDate: at, coupangProductId: "p", product: products[0],
    productName: "p", optionName: "", saleMethod: "판매자배송", salesKrw: D(2200), cancelAmountKrw: D(110),
    netSalesKrw: D(2090), salesQuantity: D(2), orderCount: 2, rowNumber: 1,
    batch: { status: "IMPORTED", sourceType: "SALES", importedAt: at } }];
  const ads = [{ id: "ad", adMetricKey: "ad", uploadBatchId: "ads", importVersion: 1, validationStatus: "VALID",
    sourceRowHash: "ad", createdAt: at, metricDate: at, spendProductId: "p", conversionProductId: "p",
    adExecutionProductName: "p", adSpendKrw: D(100), totalConversionSales1dKrw: D(99999), totalSalesQuantity1d: D(10),
    batch: { status: "IMPORTED", sourceType: "ADS", importedAt: at } }];
  const costs = [{ id: "cost", coupangProductId: "p", effectiveFrom: at, effectiveTo: null, createdAt: at, updatedAt: at,
    salePriceKrw: D(1100), supplyPriceKrw: D(0), productCostKrw: D(100), sellerShippingFeeKrw: D(10), hanaroShippingFeeKrw: D(20),
    growthInboundFeeKrw: D(3), growthShippingFeeKrw: D(7), returnRate: D(0), returnCostPerUnitKrw: D(0), extraCostKrw: D(0) }];
  const fees = [{ id: "fee", effectiveFrom: at, effectiveTo: null, salesFeeRate: D(0.1), createdAt: at, updatedAt: at }];
  const manual = [{ id: "manual", purchaseDate: at, coupangProductId: "p", productDisplayName: "p", ruleDisplayName: null,
    product: products[0], quantity: 1, salesAmountKrw: D(1100), baseSalePriceKrw: D(1100), salePriceKrw: D(1100), promotionPriceKrw: null,
    productCostKrw: D(0), vendorFeeTotalKrw: D(15), coupangSalesFeeKrw: D(0), shippingCostKrw: D(0), otherCostKrw: D(0),
    totalCostKrw: D(15), saleMethod: "판매자배송", memo: null, updatedAt: at, createdAt: at }];
  const commands: string[] = [];
  const inRange = (value: Date, range: Date | { gte: Date; lte: Date }) => range instanceof Date
    ? +value === +range : +value >= +range.gte && +value <= +range.lte;
  const client = {
    $executeRawUnsafe: async (sql: string) => { commands.push(sql); return 0; },
    coupangSaleLine: { findMany: async (args: Selection & { where: { saleDate: Date | { gte: Date; lte: Date } } }) => selected(sales.filter(row => inRange(row.saleDate, args.where.saleDate)), args) },
    coupangAdMetric: { findMany: async (args: Selection & { where: { metricDate: Date | { gte: Date; lte: Date } } }) => selected(ads.filter(row => inRange(row.metricDate, args.where.metricDate)), args) },
    coupangManualPurchase: { findMany: async (args: Selection & { where: { purchaseDate: Date | { gte: Date; lte: Date } } }) => selected(manual.filter(row => inRange(row.purchaseDate, args.where.purchaseDate)), args) },
    coupangProduct: { findMany: async (args: Selection) => selected(products, args) }, coupangCostRule: { findMany: async (args: Selection) => selected(costs, args) },
    coupangSalesFeeRule: { findMany: async (args: Selection) => selected(fees, args) }, coupangPromotionPrice: { findMany: async () => [] },
    coupangProductRule: { findMany: async () => [] }
  };
  return { client, tx: client as unknown as Prisma.TransactionClient, products, sales, ads, costs, fees, manual, commands };
}

test("stored Coupang fields equal native Daily Report including gross sales, refunds, manual purchases and ad tax", async () => {
  const f = fixture();
  const daily = await new CoupangService(f.client as unknown as PrismaService).dailyReport({ date });
  const results = await readCoupangNativeDailyResults(f.tx, date);
  const summary = results[0], product = results.find(row => row.productKey === "COUPANG:p")!;
  assert.equal(summary.revenue.complete, String(daily.summary.current.reportedSalesKrw));
  assert.equal(summary.netProfit.complete, String(daily.summary.current.marginKrw));
  assert.equal(summary.netProfit.known, String(daily.summary.current.knownMarginKrw));
  assert.equal(summary.adSpend.complete, String(daily.summary.current.adSpendKrw));
  assert.equal(product.revenue.complete, "2200");
  assert.equal(product.audit?.actualNetSalesKrw, "990"); // 2090 - 1100; cancellation is already in 2090.
  assert.equal(product.netProfit.complete, "576"); // Native result; manual fee only and exactly 100 advertising.
  assert.equal(product.adSpend.complete, "100");
  assert.equal(product.profitBeforeAds.complete, "676");
  assert.equal(product.quantity, "2");
  assert.equal(product.sourceUpdatedAt, at.toISOString());
});

test("excess manual purchase remains the native calculated loss rather than a blocked unified value", async () => {
  const f = fixture();
  f.manual[0].quantity = 3; f.manual[0].salesAmountKrw = D(3300);
  const daily = await new CoupangService(f.client as unknown as PrismaService).dailyReport({ date });
  const results = await readCoupangNativeDailyResults(f.tx, date), product = results[1];
  assert.equal(product.netProfit.complete, String(daily.summary.current.marginKrw));
  assert.ok(Number(product.netProfit.complete) < 0);
  assert.equal(product.audit?.actualNetSalesKrw, "-1210");
  assert.ok(product.issues.includes("MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED"));
  assert.ok(product.issues.includes("MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED"));
});

test("partial native total preserves completed-product margin and does not subtract incomplete-product ads twice", async () => {
  const f = fixture();
  f.sales.push({ ...f.sales[0], id: "missing-sale", saleLineKey: "missing-sale", coupangProductId: "missing", productName: "missing", product: f.products[1] });
  f.ads.push({ ...f.ads[0], id: "missing-ad", adMetricKey: "missing-ad", spendProductId: "missing", conversionProductId: "missing", adSpendKrw: D(700) });
  const native = await new CoupangService(f.client as unknown as PrismaService).dailyReport({ date });
  const results = await readCoupangNativeDailyResults(f.tx, date), summary = results[0];
  assert.equal(summary.netProfit.complete, null);
  assert.equal(summary.netProfit.known, String(native.summary.current.knownMarginKrw));
  assert.equal(summary.netProfit.known, "576");
  assert.equal(summary.adSpend.complete, "800");
  assert.equal(summary.profitBeforeAds.known, "676");
  const incomplete = results.find(row => row.productKey === "COUPANG:missing")!;
  assert.equal(incomplete.netProfit.complete, null);
  assert.equal(incomplete.netProfit.known, "0");
  assert.ok(incomplete.issues.includes("COUPANG_NATIVE_CALCULATION_INCOMPLETE"));
});

test("ads-only product is native negative margin; empty source keeps native unavailable strict margin", async () => {
  const f = fixture(); f.sales.length = 0; f.manual.length = 0;
  const results = await readCoupangNativeDailyResults(f.tx, date);
  assert.equal(results[1].revenue.complete, "0");
  assert.equal(results[1].netProfit.complete, "-100");
  f.ads.length = 0;
  const empty = await readCoupangNativeDailyResults(f.tx, date);
  assert.equal(empty.length, 1); assert.equal(empty[0].netProfit.complete, null);
  assert.ok(empty[0].issues.includes("COUPANG_NO_NATIVE_SOURCE_ROWS"));
});

test("adapter fingerprints exact native values and cost edits even when imports do not change", async () => {
  const f = fixture();
  const first = await readCoupangDay(f.tx, management, request);
  assert.deepEqual(first.nativeResults, await readCoupangNativeDailyResults(f.tx, date));
  const same = await readCoupangDay(f.tx, management, request);
  assert.equal(first.sourceFingerprint, same.sourceFingerprint);
  f.costs[0].productCostKrw = D(101);
  const changed = await readCoupangDay(f.tx, management, request);
  assert.equal(changed.nativeResults![0].netProfit.complete, "575");
  assert.notEqual(first.sourceFingerprint, changed.sourceFingerprint);
  assert.ok(f.commands.includes("SAVEPOINT coupang_native_read"));
  assert.ok(f.commands.includes("RELEASE SAVEPOINT coupang_native_read"));
});

test("complete native pre-ad known and complete values share the exact floating-point operation order", async () => {
  const f = fixture(); f.sales[0].netSalesKrw = D(2091);
  f.sales.push({ ...f.sales[0], id: "second-sale", saleLineKey: "second-sale", coupangProductId: "missing",
    productName: "missing", product: f.products[1], netSalesKrw: D(1538), cancelAmountKrw: D(662) });
  f.costs.push({ ...f.costs[0], id: "second-cost", coupangProductId: "missing" });
  f.ads.push({ ...f.ads[0], id: "second-ad", adMetricKey: "second-ad", spendProductId: "missing", conversionProductId: "missing", adSpendKrw: D(1) });
  const originalRows = await buildCoupangNativeProductProfitRows(f.tx, parseDateRange(date, date));
  const originalSummary = summarizeCoupangProductProfitRows(originalRows);
  assert.equal(originalSummary.isComplete, true);
  const completeBeforeAds = originalSummary.marginKrw! + originalSummary.adSpendKrw;
  const separatelySummedBeforeAds = originalRows.reduce((sum, row) => sum + row.marginKrw! + row.adSpendKrw, 0);
  assert.notEqual(separatelySummedBeforeAds, completeBeforeAds, "fixture must reproduce floating-point addition-order divergence");
  // readCoupangDay also executes the actual native complete/known equality validator.
  const batch = await readCoupangDay(f.tx, management, request);
  const summary = batch.nativeResults!.find(row => row.kind === "SUMMARY")!;
  assert.deepEqual(summary.profitBeforeAds, { known: String(completeBeforeAds), complete: String(completeBeforeAds) });
  assert.equal(summary.netProfit.complete, String(originalSummary.marginKrw));
  assert.equal(summary.netProfit.known, String(originalSummary.knownMarginKrw));
  assert.equal(summary.revenue.complete, String(originalSummary.reportedSalesKrw));
  assert.equal(summary.adSpend.complete, String(originalSummary.adSpendKrw));
});

test("unavailable native source is explicit and isolated from healthy audit rows", async () => {
  const f = fixture();
  f.client.coupangPromotionPrice.findMany = async () => { throw new Error("SELECT denied"); };
  const batch = await readCoupangDay(f.tx, management, request);
  assert.ok(batch.sales.length > 0); assert.ok(batch.adSpends.length > 0);
  assert.equal(batch.nativeResults![0].revenue.known, null);
  assert.deepEqual(batch.nativeResults![0].issues, ["COUPANG_NATIVE_READ_FAILED"]);
  assert.ok(f.commands.includes("ROLLBACK TO SAVEPOINT coupang_native_read"));
});
