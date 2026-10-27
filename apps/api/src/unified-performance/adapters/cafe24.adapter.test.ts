import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { Cafe24SalesCalculator } from "../../domain/cafe24-sales-calculator";
import { resolveCafe24CouponOrder } from "../../domain/cafe24-coupon-matcher";
import { managementVersions, UnifiedManagementRepository } from "../management.repository";
import { CONTRACT_VERSION, type AdapterRequest } from "../types";
import { Cafe24PerformanceAdapter, normalizeCafe24Snapshot, type Cafe24SelectedLine, type Cafe24Snapshot } from "./cafe24.adapter";
import { cafe24OrderCoupon } from "./cafe24-coupon";

const D = Prisma.Decimal;
const date = new Date("2026-10-26T00:00:00Z");
const config = (() => {
  const products = ["두줄무릎보호대", "러닝양말"].map((canonicalName, i) => ({ id: `p${i}`, canonicalName, active: true, version: 1, normalizedName: canonicalName, createdAt: date, updatedAt: date }));
  const rules = [{ id: "name1", kind: "NAME", productId: "p0", platform: "CAFE24", scopeKey: "shop", active: true, version: 1,
    validFrom: date, validTo: null, identityKey: "name", payload: { matchType: "CONTAINS", terms: ["두줄무릎보호대"] }, createdAt: date, updatedAt: date }];
  const typed = { products, rules } as unknown as Omit<Cafe24Snapshot["configuration"], "versions">;
  return { ...typed, versions: managementVersions(typed.products, typed.rules) };
})();
const request = (): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: "run", readSnapshotId: "snapshot", from: "2026-10-26", to: "2026-10-26",
  scopeKeys: ["shop"], platforms: ["CAFE24"], ...config.versions, calculationVersion: "cafe24-registered-v1", fxVersion: "fx", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 });
const line = (changes: Partial<Cafe24SelectedLine> = {}): Cafe24SelectedLine => ({ id: "l1", connectionId: "shop", source: "CSV", syncRunId: null,
  uploadBatchId: "batch", orderLineKey: "order:1", orderNo: "order", productNo: "old-id", productName: "두줄무릎보호대", optionName: "1+1 세트",
  quantity: new D(1), salePriceKrw: new D(34900), totalOrderKrw: new D(34900), totalPaidKrw: new D(34900), paymentMethod: "카드",
  providerCouponSignal: false, actualOrderPriceKrw: null, actualShippingFeeKrw: null, orderDate: date, importVersion: 1, validationStatus: "VALID",
  createdAt: date, providerUpdatedAt: null, sourceRowHash: null, ...changes });
const snapshot = (changes: Partial<Cafe24Snapshot> = {}): Cafe24Snapshot => ({ configuration: config, scopeKey: "shop", currency: "KRW", timeZone: "Asia/Seoul",
  date: "2026-10-26", observedAt: date.toISOString(), lines: [line()], unitRules: [{ id: "set", productName: "두줄무릎보호대", from: "2026-10-24", to: null, source: "LEGACY",
    unit: { saleUnitName: "1+1 세트", optionExact: "1+1 세트", unitsPerSaleUnit: "2", quantityBasis: "SALE_UNIT_TOTAL", salePrice: "34900", productCost: "9000", shippingCost: "0", otherCost: "0" } }],
  couponRules: [], selectedSource: "CSV", complete: true, collectedAt: date.toISOString(), sourceVersion: "v1", couponInputSource: null, sourceIssues: [], excludedByPolicyRows: 0, ...changes });

test("Cafe24 set prices/costs match legacy calculation, while physical quantities double only once", () => {
  const result = normalizeCafe24Snapshot(request(), snapshot({ lines: [line({ quantity: new D(2) })] }));
  const sale = result.sales[0];
  const baseline = new Cafe24SalesCalculator().calculate({ quantity: 2, adSpendUsd: 0, exchangeRateKrwPerUsd: 1,
    cost: { salePriceKrw: 34900, vatKrw: 3490, productCostKrw: 9000, shippingKrw: 0, extraCostKrw: 0 } });
  assert.equal(sale.operatingRevenue, new D(baseline.revenueKrw).toFixed(6));
  assert.equal(sale.profitBeforeAds, new D(baseline.marginKrw).toFixed(6));
  assert.equal(sale.calculationQuantity, "2"); assert.equal(sale.physicalQuantity, "4");
  assert.equal(result.adSpends.length, 0); assert.equal(result.sourceControlTotals[0].difference, "0.000000");
});

test("Cafe24 product ID replacement and separate same-name orders preserve rules and both sales", () => {
  const result = normalizeCafe24Snapshot(request(), snapshot({ lines: [line(), line({ id: "l2", orderNo: "another", orderLineKey: "another:1", productNo: "new-id" })] }));
  assert.equal(result.sales.length, 2);
  assert.equal(result.sales[0].productCost, result.sales[1].productCost);
  assert.equal(result.sales[0].name.nameInputHash, result.sales[1].name.nameInputHash);
  assert.equal(result.sourceControlTotals[0].selectedAmount, "69800.000000");
});

test("Cafe24 whole-order coupon is allocated once before product selection; payment retained once", () => {
  const lines = [line({ paymentMethod: "카드,쿠폰", totalOrderKrw: new D(44900), totalPaidKrw: new D(41900) }),
    line({ id: "l2", orderLineKey: "order:2", productName: "러닝양말", optionName: "단품", productNo: "socks", salePriceKrw: new D(10000),
      paymentMethod: "카드", totalOrderKrw: new D(44900), totalPaidKrw: new D(41900) })];
  const s = snapshot({ lines, couponRules: [{ id: "coupon", productName: null, scope: "GLOBAL", amount: "3000", from: "2026-01-01", to: null, priority: 1, createdAt: date.toISOString() }] });
  s.unitRules.push({ id: "socks", productName: "러닝양말", from: "2026-01-01", to: null, source: "LEGACY", unit: { saleUnitName: "단품", quantityBasis: "SALE_UNIT_TOTAL", salePrice: "10000", productCost: "1000", shippingCost: "0", otherCost: "0" } });
  const result = normalizeCafe24Snapshot(request(), s);
  assert.equal(result.sales.reduce((s, l) => s.plus(l.operatingRevenue!), new D(0)).toFixed(), "41900");
  assert.equal(result.sales.reduce((s, l) => s.plus(l.costComponents.find(c => c.kind === "COUPON")!.amount!), new D(0)).toFixed(), "3000");
  assert.equal(result.sales.filter(s => s.collectedPaymentAmount !== null).length, 1);
  assert.equal(result.sales.every(s => s.discountNotYetIncluded === "0"), true);
  const old = resolveCafe24CouponOrder({ orderNo: "order", lines: lines.map(l => ({ orderDate: l.orderDate, paymentMethod: l.paymentMethod, totalOrderKrw: 44900, totalPaidKrw: 41900,
    productId: l.productName, salePriceKrw: l.salePriceKrw.toNumber(), quantity: 1 })), rules: [{ id: "coupon", name: "coupon", scope: "GLOBAL", productId: null,
    discountKrw: 3000, priority: 1, validFrom: new Date("2026-01-01"), validTo: null, isActive: true, createdAt: date }] });
  for (const sale of result.sales) assert.equal(new D(sale.costComponents.find(c => c.kind === "COUPON")!.amount!).toNumber(), old.allocationsByProductId.get(sale.productName!));
});

test("Google complete SALE configuration overrides Cafe24 costs with Google excluded and no product-number dependency", () => {
  const s = snapshot({ lines: [line({ productName: "[유튜브] 두줄무릎보호대", productNo: "new-youtube-id" })] });
  s.unitRules.push({ ...s.unitRules[0], id: "google", source: "GOOGLE_SALE", unit: { ...s.unitRules[0].unit, salePrice: "30000", productCost: "8000" } });
  const sale = normalizeCafe24Snapshot(request(), s).sales[0];
  assert.equal(sale.costRuleRef, "google"); assert.equal(sale.operatingRevenue, "30000.000000"); assert.equal(sale.productCost, "8000.000000");
});

test("Google partial configuration and unit ambiguity preserve null totals without mixing inputs", () => {
  const s = snapshot({ lines: [line({ productName: "[유튜브] 두줄무릎보호대" })] });
  s.unitRules.push({ ...s.unitRules[0], id: "partial", source: "GOOGLE_SALE", unit: { ...s.unitRules[0].unit, salePrice: null } });
  const result = normalizeCafe24Snapshot(request(), s), sale = result.sales[0];
  assert.equal(sale.operatingRevenue, null); assert.equal(sale.productCost, null); assert.equal(sale.profitBeforeAds, null);
  assert.equal(sale.quality.issues.includes("GOOGLE_SALE_CONFIG_INCOMPLETE"), true);
  assert.equal(result.sourceControlTotals[0].selectedAmount, null); assert.equal(result.sourceControlTotals[0].difference, null);
  const conflict = snapshot(); conflict.unitRules.push({ ...conflict.unitRules[0], id: "conflicting" });
  assert.equal(normalizeCafe24Snapshot(request(), conflict).sales[0].name.matchStatus, "UNIT_REQUIRED");
});

test("Unknown coupons keep registered gross evidence and known sales parts without a fabricated total", () => {
  const result = normalizeCafe24Snapshot(request(), snapshot({ lines: [line({ source: "API", providerCouponSignal: null }),
    line({ id: "l2", orderLineKey: "other:1", orderNo: "other" })] }));
  assert.equal(result.sales[0].operatingRevenue, null);
  assert.equal(result.sales[0].costComponents.find(c => c.kind === "REGISTERED_GROSS_BEFORE_COUPON")!.amount, "34900.000000");
  assert.equal(result.sales[1].operatingRevenue, "34900.000000");
  assert.equal(result.sourceControlTotals[0].assignedAmount, "34900.000000");
  assert.equal(result.sourceControlTotals[0].selectedAmount, null);
});

test("Cafe24 missing cost, unmatched names, alias/exclude constraints and confirmed zero are distinct", () => {
  const s = snapshot({ unitRules: [], lines: [line({ productName: "unknown product" })] });
  const result = normalizeCafe24Snapshot(request(), s);
  assert.equal(result.sales[0].productName, null); assert.equal(result.sales[0].operatingRevenue, "34900.000000");
  assert.equal(result.sales[0].profitBeforeAds, null); assert.equal(result.sourceControlTotals[0].unmatchedAmount, "34900.000000");
  const excluded = snapshot(); excluded.unitRules[0].nameAliases = ["different-name"];
  assert.equal(normalizeCafe24Snapshot(request(), excluded).sales[0].productCost, null);
  const zero = normalizeCafe24Snapshot(request(), snapshot({ lines: [] }));
  assert.equal(zero.coverage[0].zeroConfirmed, true); assert.equal(zero.sourceControlTotals[0].selectedAmount, "0.000000");
  const missing = normalizeCafe24Snapshot(request(), snapshot({ lines: [], complete: false }));
  assert.equal(missing.coverage[0].zeroConfirmed, false); assert.equal(missing.sourceControlTotals[0].selectedAmount, null);
});

test("Coupon allocation maintains decimal precision and source separation", () => {
  const policy = [{ id: "c", productName: null, scope: "GLOBAL" as const, amount: "0.03", from: "2026-01-01", to: null, priority: 1, createdAt: date.toISOString() }];
  const result = cafe24OrderCoupon(["a", "b", "c"].map(key => ({ key, productName: key, date: "2026-10-26", signal: true, total: "100.03", paid: "100", weight: "1", valid: true })), policy);
  assert.equal([...result.allocations.values()].reduce((s, v) => s.plus(v!), new D(0)).toFixed(), "0.03");
});

test("Cafe24 read rejects excluded source and invalid date before any query", async () => {
  let reads = 0;
  const adapter = new Cafe24PerformanceAdapter({ $transaction: async () => { reads++; throw new Error("must not read"); } } as never, {} as never);
  await assert.rejects(adapter.read({ ...request(), platforms: ["META"] }), /Excluded source/);
  await assert.rejects(adapter.read({ ...request(), cursor: "2026-02-31" }), /existing YYYY/);
  assert.equal(reads, 0);
});

test("Cafe24 source/cost fingerprints change with monetary inputs, independently of run identifiers", () => {
  const s = snapshot();
  const original = normalizeCafe24Snapshot(request(), s);
  const rerun = normalizeCafe24Snapshot({ ...request(), runId: "other-run", readSnapshotId: "other-read" }, s);
  assert.equal(original.sourceFingerprint, rerun.sourceFingerprint);
  s.unitRules[0].unit.productCost = "10000";
  const revised = normalizeCafe24Snapshot(request(), s);
  assert.notEqual(original.sourceFingerprint, revised.sourceFingerprint);
  assert.notEqual(original.sales[0].costBasisVersion, revised.sales[0].costBasisVersion);
  assert.throws(() => normalizeCafe24Snapshot({ ...request(), nameRuleVersion: "stale" }, s), /configuration version changed/);
});

test("Cafe24 controls reconcile original unit formulas, collected list prices, direct costs and one order coupon", () => {
  const s = snapshot({ lines: [line({ quantity: new D(2), totalOrderKrw: new D(84800), totalPaidKrw: new D(83800), paymentMethod: "쿠폰" }),
    line({ id: "socks", orderLineKey: "order:2", productName: "러닝양말", optionName: "단품", quantity: new D(3), salePriceKrw: new D(4000),
      totalOrderKrw: new D(84800), totalPaidKrw: new D(83800) })],
    couponRules: [{ id: "coupon", scope: "GLOBAL", productName: null, amount: "1000", from: "2026-01-01", to: null, priority: 1, createdAt: date.toISOString() }] });
  s.unitRules[0].unit.shippingCost = "600"; s.unitRules[0].unit.otherCost = "50";
  s.unitRules.push({ id: "socks", productName: "러닝양말", from: "2026-01-01", to: null, source: "LEGACY", unit: { saleUnitName: "단품", quantityBasis: "SALE_UNIT_TOTAL",
    salePrice: "5000", productCost: "2000", shippingCost: "300", otherCost: "20" } });
  const result = normalizeCafe24Snapshot(request(), s);
  // Independent source equations: registered prices 34900*2+5000*3,
  // costs 9000*2+2000*3, shipping 600*2+300*3, other 50*2+20*3.
  const expected = { OPERATING_REVENUE: "83800", REGISTERED_GROSS: "84800", SOURCE_LIST_PRICE_GROSS: "81800", PRODUCT_COST: "24000",
    DIRECT_SHIPPING_COST: "2100", OTHER_DIRECT_COST: "160", VAT_EXPENSE: "8480", COUPON: "1000" };
  for (const [measure, amount] of Object.entries(expected)) {
    const control = result.sourceControlTotals.find(c => c.measure === measure)!;
    assert.equal(new D(control.selectedAmount!).toFixed(), amount, measure);
    assert.equal(new D(control.assignedAmount!).plus(control.unmatchedAmount!).toFixed(), amount, measure);
    assert.equal(control.difference, "0.000000", measure);
  }
  assert.equal(result.sales.reduce((total, sale) => total.plus(sale.profitBeforeAds!), new D(0)).toFixed(), "49060");
  assert.equal(result.sales[0].costComponents.find(c => c.kind === "COUPON")!.amount, "853.000000");
  assert.equal(result.sales[1].costComponents.find(c => c.kind === "COUPON")!.amount, "147.000000");
});

test("Cafe24 controls preserve known costs and unmatched original list prices when full values are unavailable", () => {
  const result = normalizeCafe24Snapshot(request(), snapshot({ lines: [line(), line({ id: "unknown", orderNo: "other", orderLineKey: "other:1", productName: "unmapped", salePriceKrw: new D(12345) })] }));
  const cost = result.sourceControlTotals.find(c => c.measure === "PRODUCT_COST")!;
  assert.equal(cost.selectedAmount, null); assert.equal(cost.assignedAmount, "9000.000000"); assert.equal(cost.difference, null);
  const list = result.sourceControlTotals.find(c => c.measure === "SOURCE_LIST_PRICE_GROSS")!;
  assert.equal(list.selectedAmount, "47245.000000"); assert.equal(list.assignedAmount, "34900.000000"); assert.equal(list.unmatchedAmount, "12345.000000");
  assert.equal(list.difference, "0.000000");
});

test("A resolver UNIT_REQUIRED result cannot select a cost from an otherwise unique unit rule", () => {
  const s = snapshot();
  const rules = [{ ...config.rules[0], payload: { matchType: "CONTAINS", terms: ["두줄무릎보호대"], saleUnitName: "단품" } },
    { ...config.rules[0], id: "another-name-rule", payload: { matchType: "CONTAINS", terms: ["두줄"], saleUnitName: "세트" } }];
  s.configuration = { ...config, rules, versions: managementVersions(config.products, rules) };
  const result = normalizeCafe24Snapshot({ ...request(), ...s.configuration.versions }, s);
  assert.equal(result.sales[0].name.matchStatus, "UNIT_REQUIRED");
  assert.equal(result.sales[0].productCost, null); assert.equal(result.sales[0].profitBeforeAds, null);
  assert.equal(result.sales[0].costRuleRef, null);
  assert.equal(result.sourceControlTotals.find(c => c.measure === "PRODUCT_COST")!.selectedAmount, null);
});

test("VAT uses precise registered price times quantity before a single storage quantization", () => {
  const s = snapshot({ lines: [line({ quantity: new D("0.1") })] });
  s.unitRules[0].unit.salePrice = "0.000045";
  const result = normalizeCafe24Snapshot(request(), s);
  assert.equal(result.sales[0].vatExpense, "0.000000");
  assert.equal(result.sourceControlTotals.find(c => c.measure === "VAT_EXPENSE")!.difference, "0.000000");
});

test("Cafe24 provider scope validation happens before source rows or configuration are read", async () => {
  let downstreamReads = 0;
  const tx = { $executeRaw: async () => 0, sourceConnection: { findUnique: async () => ({ provider: "GOOGLE" }) } };
  const adapter = new Cafe24PerformanceAdapter({ $transaction: async (work: (client: unknown) => unknown) => work(tx) } as never,
    { snapshot: async () => { downstreamReads++; return config; } } as unknown as UnifiedManagementRepository);
  await assert.rejects(adapter.read(request()), /Unauthorized Cafe24/);
  assert.equal(downstreamReads, 0);
});

test("Cafe24 reader applies existing CSV/API source policy and day pagination", async () => {
  const old = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const candidates = [line(), line({ id: "api", source: "API", uploadBatchId: null })];
    const policies = [{ id: "policy", connectionId: "shop", dataKind: "CAFE24_ORDER", fromDate: new Date("2026-01-01"), toDate: null, primarySource: "CSV", couponInputSource: null }];
    const tx = { $executeRaw: async () => 0, sourceConnection: { findUnique: async () => ({ provider: "CAFE24", currencyCode: "KRW", timeZone: "Asia/Seoul" }) },
      sourcePolicy: { findMany: async () => policies }, sourceCoverage: { findMany: async () => [] }, cafe24UploadBatch: { findMany: async () => [{ id: "batch", rowCount: 1, _count: { rows: 1 }, importedAt: date }] },
      productCostRule: { findMany: async () => [] }, cafe24ProductRule: { findMany: async () => [] }, googlePerformanceMapping: { findMany: async () => [] },
      cafe24CouponRule: { findMany: async () => [] }, cafe24OrderLine: { findMany: async () => candidates } };
    const adapter = new Cafe24PerformanceAdapter({ $transaction: async (work: (client: unknown) => unknown) => work(tx) } as never,
      { snapshot: async () => config } as unknown as UnifiedManagementRepository);
    const result = await adapter.read({ ...request(), to: "2026-10-27" });
    assert.equal(result.sales.length, 1); assert.equal(result.sales[0].ref.selectedSource, "CSV");
    assert.equal(result.sourceControlTotals[0].excludedByPolicyRows, 1); assert.equal(result.nextCursor, "2026-10-27");
  } finally { if (old === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = old; }
});
