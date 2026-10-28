import assert from "node:assert/strict";
import test from "node:test";
import { calculateCoupangProfitBySegments } from "../../domain/coupang-profit-calculator";
import { aggregateManualPurchasesByProductDate, aggregateReportedSalesByProductDate, adjustReportedSalesForManualPurchase, productDateKey } from "../../domain/coupang-profit-pipeline";
import { ExactDecimal as D } from "../domain/decimal";
import { CONTRACT_VERSION, type AdapterRequest } from "../types";
import { normalizeCoupangSalesDay, type CoupangSalesDayInput, type CoupangSaleRow, type CoupangSaleCostRule, type CoupangManualRow } from "./coupang-sales";

const date = "2026-10-26", at = `${date}T00:00:00Z`, scope = "LEGACY_COUPANG_SINGLE_UPLOAD";
const request = (): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: "run", readSnapshotId: "snapshot", from: date, to: date,
  scopeKeys: [scope], platforms: ["COUPANG"], scopePolicyVersion: "scope", nameRuleVersion: "names", saleUnitRuleVersion: "units",
  allocationRuleVersion: "allocation", calculationVersion: "coupang-normal-v1", fxVersion: "fx", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 });
const row = (changes: Partial<CoupangSaleRow> = {}): CoupangSaleRow => ({ id: "r1", saleLineKey: "daily-aggregate-1", productName: "버닝웨이브바", optionName: "1개입",
  saleMethod: "판매자배송", salesKrw: "110000", cancelAmountKrw: "11000", netSalesKrw: "99000", salesQuantity: "9", orderCount: 8,
  uploadBatchId: "batch", sourceVersion: "version1", observedAt: at, updatedAt: null, ...changes });
const rule = (changes: Partial<CoupangSaleCostRule> = {}): CoupangSaleCostRule => ({ id: "cost", productName: "버닝웨이브바", saleUnitName: "1개입", from: "2026-01-01", to: null,
  optionExact: "1개입", unitsPerSaleUnit: "1", productCostKrw: "2000", sellerShippingFeeKrw: "3000", hanaroShippingFeeKrw: "100",
  growthInboundFeeKrw: "200", growthShippingFeeKrw: "1000", returnRate: "0.1", returnCostPerUnitKrw: "1000", extraCostKrw: "50", salePriceKrw: "11000", ...changes });
const manual = (changes: Partial<CoupangManualRow> = {}): CoupangManualRow => ({ id: "m1", productName: "버닝웨이브바", optionName: "1개입", saleUnitName: "1개입", quantity: "2",
  salesAmountKrw: "22000", baseSalePriceKrw: "11000", vendorFeeTotalKrw: "600", totalCostKrw: "600", saleMethod: "로켓그로스", updatedAt: at, ...changes });
const input = (changes: Partial<CoupangSalesDayInput> = {}): CoupangSalesDayInput => ({ scopeKey: scope, date, observedAt: at, collectedAt: at,
  sourceVersion: "source", complete: true, sourceIssues: [], excludedByPolicyRows: 0, rows: [row()], costRules: [rule()],
  salesFeeRules: [{ id: "global", from: "2026-01-01", to: null, rate: "0.1" }], manualPurchases: [],
  configuration: { products: [{ canonicalName: "버닝웨이브바" }, { canonicalName: "플로우라이트" }], nameRules: [] }, ...changes });
const total = (values: (string | null)[]) => values.reduce((acc, value) => acc.plus(value!), new D(0)).toFixed(6);

test("Coupang preserves reported net (no second cancellation), quantities and legacy seller costs", () => {
  const batch = normalizeCoupangSalesDay(request(), input()), sale = batch.sales[0];
  const old = calculateCoupangProfitBySegments({ segments: [{ fulfillmentMethod: "SELLER", netSalesKrw: 99000, salesQuantity: 9 }],
    cost: { productCostKrw: 2000, sellerShippingFeeKrw: 3000, hanaroShippingFeeKrw: 100, growthInboundFeeKrw: 200, growthShippingFeeKrw: 1000,
      returnRate: 0.1, returnCostPerUnitKrw: 1000, extraCostKrw: 50 }, ads: { adSpendKrw: 0, adGeneratedSalesKrw: 0, attributedConversionSalesKrw: 0 }, salesFeeRate: 0.1 });
  assert.equal(sale.operatingRevenue, "99000.000000"); assert.equal(sale.profitBeforeAds, new D(old.marginKrw).toFixed(6));
  assert.equal(sale.directShippingCost, "27000.000000"); assert.equal(sale.vatExpense, "9000.000000");
  assert.match(sale.quantityBasis, /DAILY_AGGREGATE.*orders=8/); assert.equal(sale.paymentGrain, "NOT_ORDER_GRAIN");
  assert.equal(sale.costComponents.find(c => c.kind === "CANCELLATION_ALREADY_INCLUDED")!.applied, false);
  assert.equal(batch.adSpends.length, 0); assert.ok(batch.sourceControlTotals.every(c => c.difference === "0.000000"));
});

test("Coupang name and unit select costs after source ID changes; same-name rows remain separate", () => {
  const s = input({ rows: [row(), row({ id: "new-id", saleLineKey: "new-key" })] });
  const facts = normalizeCoupangSalesDay(request(), s).sales;
  assert.equal(facts.length, 2); assert.equal(facts[0].name.nameInputHash, facts[1].name.nameInputHash);
  assert.equal(facts[0].productCost, facts[1].productCost);
  const renamed = normalizeCoupangSalesDay(request(), input({ rows: [row({ productName: "플로우라이트" })] })).sales[0];
  assert.equal(renamed.productName, "플로우라이트"); assert.equal(renamed.productCost, null); assert.equal(renamed.profitBeforeAds, null);
});

test("Coupang set unit totals multiply sales units once; seller and growth logistics differ", () => {
  const batch = normalizeCoupangSalesDay(request(), input({ rows: [row(), row({ id: "r2", saleLineKey: "growth", optionName: "2개입", saleMethod: "로켓그로스", salesQuantity: "3" })],
    costRules: [rule(), rule({ id: "set", saleUnitName: "2개입", optionExact: "2개입", unitsPerSaleUnit: "2", productCostKrw: "3500" })] }));
  const growth = batch.sales.find(s => s.ref.sourceRecordKey === "growth")!;
  assert.equal(growth.productCost, "10500.000000"); assert.equal(growth.physicalQuantity, "6"); assert.equal(growth.calculationQuantity, "3");
  assert.equal(growth.directShippingCost, "3900.000000"); assert.equal(growth.costComponents.find(c => c.kind === "SELLER_SHIPPING")!.amount, "0.000000");
});

test("Coupang manual deduction matches legacy pipeline SELLER-first and vendor-only cost once", () => {
  const sourceRows = [row({ salesKrw: "22000", netSalesKrw: "22000", salesQuantity: "2", cancelAmountKrw: "0" }),
    row({ id: "r2", saleLineKey: "growth", saleMethod: "로켓그로스", salesKrw: "33000", netSalesKrw: "33000", salesQuantity: "3", cancelAmountKrw: "0" })];
  const m = manual({ quantity: "3", salesAmountKrw: "33000", vendorFeeTotalKrw: "900", totalCostKrw: "900" });
  const batch = normalizeCoupangSalesDay(request(), input({ rows: sourceRows, manualPurchases: [m] }));
  const report = aggregateReportedSalesByProductDate(sourceRows.map(r => ({ productId: "p", productName: r.productName, date, salesKrw: +r.salesKrw,
    netSalesKrw: +r.netSalesKrw, cancelAmountKrw: 0, salesQuantity: +r.salesQuantity, orderCount: r.orderCount, saleMethod: r.saleMethod })));
  const manuals = aggregateManualPurchasesByProductDate([{ productId: "p", date, quantity: 3, salesAmountKrw: 33000, vendorFeeKrw: 900, totalCostKrw: 900 }]);
  const actual = adjustReportedSalesForManualPurchase(report.get(productDateKey("p", date))!, manuals.get(productDateKey("p", date))!);
  assert.equal(total(batch.sales.map(s => s.operatingRevenue)), new D(actual.netSalesKrw!).toFixed(6));
  for (const method of ["SELLER", "GROWTH"]) {
    const fact = batch.sales.find(s => s.shippingBasis.startsWith(`${method}:`))!;
    assert.equal(fact.calculationQuantity, String(actual.segments.find(s => s.fulfillmentMethod === method)!.salesQuantity));
  }
  const old = calculateCoupangProfitBySegments({ segments: actual.segments, cost: { productCostKrw: 2000, sellerShippingFeeKrw: 3000, hanaroShippingFeeKrw: 100,
    growthInboundFeeKrw: 200, growthShippingFeeKrw: 1000, returnRate: 0.1, returnCostPerUnitKrw: 1000, extraCostKrw: 50 },
    ads: { adSpendKrw: 0, adGeneratedSalesKrw: 0, attributedConversionSalesKrw: 0 }, salesFeeRate: 0.1 });
  assert.equal(total(batch.sales.map(s => s.profitBeforeAds)), new D(old.marginKrw - 900).toFixed(6));
  assert.equal(total(batch.sales.map(s => s.manualVendorFee)), "900.000000"); assert.equal(batch.commonExpenses.length, 0);
  assert.equal(batch.sales.find(s => s.ref.recordKind === "MANUAL_PURCHASE_ADJUSTMENT")!.productCost, "0.000000");
});

test("Coupang manual snapshot uses stored sales or legacy base-price fallback, never promotion price", () => {
  const s = input({ manualPurchases: [manual({ salesAmountKrw: null, baseSalePriceKrw: "10000" })] });
  const batch = normalizeCoupangSalesDay(request(), s);
  assert.equal(batch.sales[0].operatingRevenue, "79000.000000");
  assert.ok(batch.sales[1].quality.issues.includes("MANUAL_PURCHASE_SALES_AMOUNT_LEGACY_FALLBACK"));
  const missing = normalizeCoupangSalesDay(request(), input({ manualPurchases: [manual({ salesAmountKrw: null, baseSalePriceKrw: null })] }));
  assert.equal(missing.sales[0].operatingRevenue, null); assert.equal(missing.sales[0].profitBeforeAds, null);
  assert.ok(missing.coverage[0].missingCostRows > 0);
});

test("Coupang incomplete vendor snapshot preserves known vendor fee but blocks full profit", () => {
  const batch = normalizeCoupangSalesDay(request(), input({ manualPurchases: [manual({ totalCostKrw: null })] }));
  assert.equal(batch.sales[0].operatingRevenue, "77000.000000"); assert.equal(batch.sales[1].manualVendorFee, "600.000000");
  assert.equal(batch.sales[1].profitBeforeAds, null); assert.equal(batch.coverage[0].missingCostRows, 1);
  const mismatch = normalizeCoupangSalesDay(request(), input({ manualPurchases: [manual({ totalCostKrw: "1000" })] }));
  assert.ok(mismatch.sales[1].quality.issues.includes("MANUAL_PURCHASE_TOTAL_COST_MISMATCH")); assert.equal(mismatch.sales[1].profitBeforeAds, null);
});

test("Coupang excess manual and duplicate corrections cannot expose fabricated normal revenue", () => {
  const excess = normalizeCoupangSalesDay(request(), input({ manualPurchases: [manual({ quantity: "10" })] }));
  assert.equal(excess.sales[0].operatingRevenue, null); assert.ok(excess.sales[0].quality.issues.includes("MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED"));
  const duplicate = normalizeCoupangSalesDay(request(), input({ manualPurchases: [manual(), manual({ id: "m2" })] }));
  assert.equal(duplicate.sales[0].operatingRevenue, null); assert.ok(duplicate.sales[0].quality.issues.includes("DUPLICATE_MANUAL_PURCHASE_ROWS"));
});

test("Coupang manual without reported sales remains zero sales and charges only captured vendor fee", () => {
  const batch = normalizeCoupangSalesDay(request(), input({ rows: [], manualPurchases: [manual()] }));
  assert.equal(batch.sales.length, 1); assert.equal(batch.sales[0].operatingRevenue, "0.000000");
  assert.equal(batch.sales[0].profitBeforeAds, "-600.000000"); assert.ok(batch.sales[0].quality.issues.includes("MANUAL_PURCHASE_WITHOUT_REPORTED_SALES"));
});

test("Coupang effective cost and fee boundaries are inclusive, zero is explicit, conflicts stay unresolved", () => {
  const s = input({ costRules: [rule({ id: "old", to: date }), rule({ id: "future", from: "2026-10-27", productCostKrw: "9999" })],
    salesFeeRules: [{ id: "zero", from: date, to: date, rate: "0" }] });
  const sale = normalizeCoupangSalesDay(request(), s).sales[0];
  assert.equal(sale.costRuleRef, "old"); assert.equal(sale.platformFee, "0.000000");
  const latest = normalizeCoupangSalesDay(request(), input({ costRules: [rule({ id: "old" }), rule({ id: "new", from: date, productCostKrw: "1000" })] })).sales[0];
  assert.equal(latest.productCost, "9000.000000");
  const conflict = normalizeCoupangSalesDay(request(), input({ costRules: [rule(), rule({ id: "conflict" })] })).sales[0];
  assert.equal(conflict.productCost, null); assert.equal(conflict.profitBeforeAds, null); assert.equal(conflict.name.matchStatus, "UNIT_REQUIRED");
  const distinct = normalizeCoupangSalesDay(request(), input({ costRules: [rule({ historyKey: "definition-a" }),
    rule({ id: "same-name-other-definition", historyKey: "definition-b", from: date, productCostKrw: "9999" })] })).sales[0];
  assert.equal(distinct.productCost, null); assert.equal(distinct.profitBeforeAds, null);
});

test("Coupang missing cost fields retain independent known components and null full profit", () => {
  const batch = normalizeCoupangSalesDay(request(), input({ costRules: [rule({ productCostKrw: null, sellerShippingFeeKrw: null })] }));
  const sale = batch.sales[0]; assert.equal(sale.operatingRevenue, "99000.000000"); assert.equal(sale.productCost, null);
  assert.equal(sale.directShippingCost, null); assert.equal(sale.vatExpense, "9000.000000"); assert.equal(sale.profitBeforeAds, null);
  assert.equal(batch.coverage[0].collectionState, "COMPLETE"); assert.equal(batch.coverage[0].missingCostRows, 1);
});

test("Coupang logical duplicates rejected; complete zero differs from uncollected source", () => {
  assert.throws(() => normalizeCoupangSalesDay(request(), input({ rows: [row(), row({ id: "other" })] })), /Duplicate/);
  const zero = normalizeCoupangSalesDay(request(), input({ rows: [] }));
  assert.equal(zero.coverage[0].zeroConfirmed, true); assert.equal(zero.sourceControlTotals[0].selectedAmount, "0.000000");
  const missing = normalizeCoupangSalesDay(request(), input({ rows: [], complete: false, collectedAt: null }));
  assert.equal(missing.coverage[0].collectionState, "NOT_COLLECTED"); assert.equal(missing.coverage[0].zeroConfirmed, false);
  assert.equal(missing.sourceControlTotals[0].selectedAmount, null);
});

test("Coupang source array reordering keeps calculation fingerprint and manual effects stable", () => {
  const rows = [row(), row({ id: "r2", saleLineKey: "another" })], costRules = [rule(), rule({ id: "future", from: "2027-01-01" })];
  const first = normalizeCoupangSalesDay(request(), input({ rows, costRules, manualPurchases: [manual()] }));
  const next = normalizeCoupangSalesDay(request(), input({ rows: [...rows].reverse(), costRules: [...costRules].reverse(), manualPurchases: [manual()] }));
  assert.equal(first.sourceFingerprint, next.sourceFingerprint); assert.deepEqual(first.sales, next.sales);
});

test("Coupang repeating VAT reconciles source aggregate rows at product/day and records micro-won rounding", () => {
  const rows = Array.from({ length: 11 }, (_, i) => row({ id: `r${i}`, saleLineKey: `daily-${i}`, salesKrw: "1", netSalesKrw: "1", salesQuantity: "1" }));
  const batch = normalizeCoupangSalesDay(request(), input({ rows }));
  assert.equal(total(batch.sales.map(sale => sale.vatExpense)), "1.000000");
  assert.equal(batch.sourceControlTotals.find(c => c.measure === "VAT_EXPENSE")!.roundingAdjustment, "0.000001");
  assert.equal(total(batch.sales.map(sale => sale.operatingRevenue)), "11.000000");
  for (const sale of batch.sales) assert.equal(sale.costComponents.find(c => c.kind === "VAT_EXPENSE")!.amount, sale.vatExpense);
});

test("Coupang multiple aggregate rows and manual amount shortfalls match segment pipeline totals", () => {
  const rows = [row({ id: "a", saleLineKey: "a", salesQuantity: "1", salesKrw: "1", netSalesKrw: "1" }),
    row({ id: "b", saleLineKey: "b", salesQuantity: "4", salesKrw: "77000", netSalesKrw: "77000" }),
    row({ id: "c", saleLineKey: "c", saleMethod: "로켓그로스", salesQuantity: "4", salesKrw: "44000", netSalesKrw: "44000" })];
  const m = manual({ quantity: "6", salesAmountKrw: "66000" });
  const batch = normalizeCoupangSalesDay(request(), input({ rows, manualPurchases: [m] }));
  const reported = aggregateReportedSalesByProductDate(rows.map(row => ({ productId: "p", date, salesKrw: +row.salesKrw, netSalesKrw: +row.netSalesKrw,
    cancelAmountKrw: +row.cancelAmountKrw, salesQuantity: +row.salesQuantity, saleMethod: row.saleMethod, orderCount: row.orderCount })));
  const manualFacts = aggregateManualPurchasesByProductDate([{ productId: "p", date, quantity: 6, salesAmountKrw: 66000, vendorFeeKrw: 600, totalCostKrw: 600 }]);
  const actual = adjustReportedSalesForManualPurchase(reported.get(productDateKey("p", date))!, manualFacts.get(productDateKey("p", date))!);
  for (const method of ["SELLER", "GROWTH"]) {
    const normal = batch.sales.filter(fact => fact.shippingBasis.startsWith(`${method}:`));
    assert.equal(total(normal.map(fact => fact.operatingRevenue)), new D(actual.segments.find(segment => segment.fulfillmentMethod === method)!.netSalesKrw).toFixed(6));
  }
  assert.equal(total(batch.sales.map(fact => fact.vatExpense)), new D(actual.netSalesKrw!).div(11).toFixed(6));
  assert.equal(batch.sourceControlTotals.find(c => c.measure === "MANUAL_VENDOR_FEE")!.selectedAmount, "600.000000");
});

test("Coupang signed cancellation corrections retain negative quantity, direct costs and VAT", () => {
  const sale = normalizeCoupangSalesDay(request(), input({ rows: [row({ salesQuantity: "-1", netSalesKrw: "-11000", salesKrw: "0", cancelAmountKrw: "11000" })] })).sales[0];
  const baseline = calculateCoupangProfitBySegments({ segments: [{ fulfillmentMethod: "SELLER", netSalesKrw: -11000, salesQuantity: -1 }],
    cost: { productCostKrw: 2000, sellerShippingFeeKrw: 3000, hanaroShippingFeeKrw: 100, growthInboundFeeKrw: 200, growthShippingFeeKrw: 1000,
      returnRate: 0.1, returnCostPerUnitKrw: 1000, extraCostKrw: 50 }, ads: { adSpendKrw: 0, adGeneratedSalesKrw: 0, attributedConversionSalesKrw: 0 }, salesFeeRate: 0.1 });
  assert.equal(sale.orderedQuantity, "-1"); assert.equal(sale.calculationQuantity, "-1"); assert.equal(sale.physicalQuantity, "-1");
  assert.equal(sale.productCost, "-2000.000000"); assert.equal(sale.directShippingCost, "-3000.000000");
  assert.equal(sale.vatExpense, "-1000.000000"); assert.equal(sale.profitBeforeAds, new D(baseline.marginKrw).toFixed(6));
});

test("Coupang unknown manual names cannot consume unrelated unmatched reported groups", () => {
  const batch = normalizeCoupangSalesDay(request(), input({ rows: [row({ productName: "unknown original" })], manualPurchases: [manual({ productName: "unknown manual", saleUnitName: null })] }));
  assert.equal(batch.sales[0].operatingRevenue, "99000.000000");
  assert.equal(batch.sales[1].operatingRevenue, "0.000000"); assert.equal(batch.sales[1].profitBeforeAds, null);
  assert.equal(batch.sales[1].productName, null); assert.ok(batch.sales[1].quality.issues.includes("MANUAL_PURCHASE_WITHOUT_REPORTED_SALES"));
});

test("Coupang manual deduction uses signed segment aggregate availability before source-row allocation", () => {
  const rows = [row({ id: "a", saleLineKey: "a", salesQuantity: "3", salesKrw: "33000", netSalesKrw: "33000" }),
    row({ id: "b", saleLineKey: "b", salesQuantity: "-1", salesKrw: "-11000", netSalesKrw: "-11000" }),
    row({ id: "c", saleLineKey: "c", saleMethod: "로켓그로스", salesQuantity: "3", salesKrw: "33000", netSalesKrw: "33000" })];
  const batch = normalizeCoupangSalesDay(request(), input({ rows, manualPurchases: [manual({ quantity: "3", salesAmountKrw: "33000" })] }));
  const seller = batch.sales.filter(sale => sale.shippingBasis.startsWith("SELLER:")), growth = batch.sales.find(sale => sale.shippingBasis.startsWith("GROWTH:"))!;
  assert.equal(total(seller.map(sale => sale.calculationQuantity)), "0.000000"); assert.equal(growth.calculationQuantity, "2");
  assert.equal(total(seller.map(sale => sale.operatingRevenue)), "0.000000"); assert.equal(growth.operatingRevenue, "22000.000000");
  assert.equal(total(seller.map(sale => sale.directShippingCost)), "0.000000"); assert.equal(growth.directShippingCost, "2600.000000");
});

test("Coupang ambiguous manual product names withhold only candidate normal sales rather than expose unadjusted totals", () => {
  const batch = normalizeCoupangSalesDay(request(), input({ rows: [row(), row({ id: "flow", saleLineKey: "flow", productName: "플로우라이트" }),
    row({ id: "third", saleLineKey: "third", productName: "독립제품" })], manualPurchases: [manual({ productName: "모호한 별칭", saleUnitName: null })],
    configuration: { products: [{ canonicalName: "버닝웨이브바" }, { canonicalName: "플로우라이트" }, { canonicalName: "독립제품" }],
      nameRules: ["버닝웨이브바", "플로우라이트"].map((canonicalProductName, index) => ({ id: `ambiguous${index}`, canonicalProductName,
        matchType: "EXACT", terms: ["모호한 별칭"], validFrom: "2026-01-01", platform: "COUPANG" })) } }));
  for (const fact of batch.sales.filter(fact => ["버닝웨이브바", "플로우라이트"].includes(fact.name.canonicalProductName ?? ""))) {
    assert.equal(fact.operatingRevenue, null); assert.equal(fact.profitBeforeAds, null); assert.ok(fact.quality.issues.includes("NAME_AMBIGUOUS"));
  }
  assert.equal(batch.sales.find(fact => fact.name.canonicalProductName === "독립제품")!.operatingRevenue, "99000.000000");
  const manualFact = batch.sales.find(fact => fact.ref.recordKind === "MANUAL_PURCHASE_ADJUSTMENT")!;
  assert.equal(manualFact.profitBeforeAds, null); assert.equal(manualFact.manualVendorFee, "600.000000");
  assert.ok(!manualFact.quality.issues.includes("MANUAL_PURCHASE_WITHOUT_REPORTED_SALES"));
});
