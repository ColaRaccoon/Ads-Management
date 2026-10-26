import assert from "node:assert/strict";
import test from "node:test";
import { Cafe24SalesCalculator } from "../domain/cafe24-sales-calculator";
import { Cafe24CouponRuleInput } from "../domain/cafe24-coupon-matcher";
import { calculateGooglePerformance, GoogleAdMetric, GooglePerformanceInput, GoogleSaleLine } from "./google-performance";

const day = "2026-10-20";
function sale(overrides: Partial<GoogleSaleLine> = {}): GoogleSaleLine {
  return { id: "sale-1", orderNo: "order-1", connectionId: "store-1", date: day,
    productId: "product-1", productName: "[유튜브] 상품", quantity: 1, collectedSalePriceKrw: 100_000,
    cost: { salePriceKrw: 100_000, vatKrw: 10_000, productCostKrw: 25_000, shippingKrw: 3_000, extraCostKrw: 2_000 },
    couponInput: { orderDate: new Date(day), paymentMethod: "카드", source: "CSV", totalOrderKrw: 100_000,
      totalPaidKrw: 100_000, productId: "product-1", salePriceKrw: 100_000, quantity: 1 }, ...overrides };
}
function ad(overrides: Partial<GoogleAdMetric> = {}): GoogleAdMetric {
  return { id: "ad-1", date: day, connectionId: "google-1", customerId: "customer-1", campaignId: "campaign-1",
    campaignName: "동일 이름", currencyCode: "KRW", costMicros: "20000000000", impressions: 1_000,
    clicks: 10, productId: "product-1", timeZone: "Asia/Seoul", ...overrides };
}
function input(overrides: Partial<GooglePerformanceInput> = {}): GooglePerformanceInput {
  return { salesLines: [sale()], adMetrics: [ad()], days: [{ date: day, googleComplete: true, cafe24Complete: true }], ...overrides };
}
function coupon(discountKrw = 5_000): Cafe24CouponRuleInput {
  return { id: "coupon", name: "할인", scope: "GLOBAL", productId: null, discountKrw,
    priority: 1, validFrom: new Date("2026-01-01"), validTo: null, isActive: true, createdAt: new Date("2026-01-01") };
}
function withCoupon(line: GoogleSaleLine, total = 100_000, paid = 95_000) {
  return { ...line, couponInput: { ...line.couponInput, paymentMethod: "카드,쿠폰", totalOrderKrw: total, totalPaidKrw: paid } };
}

test("100000 revenue / 40000 cost / 5000 coupon / 20000 spend produces 35000 margin", () => {
  const result = calculateGooglePerformance(input({ salesLines: [withCoupon(sale())], couponRules: [coupon()] }));
  assert.equal(result.summary.marginKrw, 35_000);
  assert.equal(result.summary.marginRate, 0.35);
  assert.equal(result.summary.roas, 5);
  assert.equal(result.summary.complete, true);
});

test("channel selection uses only the historical line productName literal token", () => {
  const lines = ["[유튜브] 상품", "상품 [유튜브]", "유튜브 상품", "일반 옵션", null].map((productName, i) =>
    sale({ id: `sale-${i}`, orderNo: `order-${i}`, productName }));
  const result = calculateGooglePerformance(input({ salesLines: lines }));
  assert.equal(result.summary.quantity, 2);
  assert.equal(result.summary.revenueKrw, 200_000);
});

test("mixed order same internal product only deducts YouTube line's share", () => {
  const lines = [withCoupon(sale(), 200_000, 195_000), withCoupon(sale({ id: "normal", productName: "일반 상품" }), 200_000, 195_000)];
  const result = calculateGooglePerformance(input({ salesLines: lines, couponRules: [coupon()] }));
  assert.equal(result.summary.revenueKrw, 100_000);
  assert.equal(result.summary.grossCostKrw, 40_000);
  assert.equal(result.summary.couponDeductionKrw, 2_500);
  assert.equal(result.summary.marginKrw, 37_500);
});

test("coupon residual uses stable line ID and excludes normal pages only after allocation", () => {
  const lines = [withCoupon(sale({ id: "a", productName: "일반 상품" }), 300_000, 299_998),
    withCoupon(sale({ id: "b" }), 300_000, 299_998), withCoupon(sale({ id: "c" }), 300_000, 299_998)];
  const args = input({ salesLines: lines, couponRules: [coupon(2)] });
  const before = calculateGooglePerformance(args);
  const after = calculateGooglePerformance({ ...args, salesLines: [...lines].reverse() });
  assert.equal(before.summary.couponDeductionKrw, 1);
  assert.deepEqual(after.summary, before.summary);
});

test("product filter keeps other product's order context for coupon allocation", () => {
  const lines = [withCoupon(sale(), 200_000, 195_000), withCoupon(sale({ id: "other", productId: "product-2" }), 200_000, 195_000)];
  const result = calculateGooglePerformance(input({ salesLines: lines, productId: "product-1", couponRules: [coupon()] }));
  assert.equal(result.summary.couponDeductionKrw, 2_500);
  assert.equal(result.summary.quantity, 1);
});

test("two campaigns for same product add spend without duplicating sales; names do not merge accounts", () => {
  const result = calculateGooglePerformance(input({ adMetrics: [ad({ costMicros: "10000000000" }),
    ad({ id: "ad-2", connectionId: "google-2", customerId: "customer-2", costMicros: "10000000000" })] }));
  assert.equal(result.products.length, 1);
  assert.equal(result.summary.revenueKrw, 100_000);
  assert.equal(result.summary.adSpendKrw, 20_000);
  assert.equal(result.campaigns.length, 2);
  assert.equal("revenueKrw" in result.campaigns[0], false);
  assert.equal("roas" in result.campaigns[0], false);
});

test("micros above Number safe integer preserve all digits and reconcile exactly", () => {
  const result = calculateGooglePerformance(input({ salesLines: [], adMetrics: [ad({ costMicros: "9007199254740993" }),
    ad({ id: "unmapped", costMicros: "7", productId: null })] }));
  assert.equal(result.reconciliation.allocatedAdSpendKrwExact, "9007199254.740993");
  assert.equal(result.reconciliation.unallocatedAdSpendKrwExact, "0.000007");
  assert.equal(result.reconciliation.collectedAdSpendKrwExact, "9007199254.741");
  assert.equal(result.reconciliation.byCurrency[0].collectedCostMicros, "9007199254741000");
  assert.equal(result.reconciliation.byCurrency[0].balanced, true);
  assert.equal(result.summary.marginKrw, null);
});

test("FX is dated loader input; missing FX never substitutes zero", () => {
  const missing = calculateGooglePerformance(input({ adMetrics: [ad({ currencyCode: "USD", costMicros: "1000001" })] }));
  assert.equal(missing.summary.adSpendKrw, null);
  assert.equal(missing.summary.marginKrw, null);
  assert.ok(missing.completeness.warningCodes.includes("MISSING_EXCHANGE_RATE"));
  const present = calculateGooglePerformance(input({ adMetrics: [ad({ currencyCode: "USD", costMicros: "1000001", exchangeRateKrw: "1390.1234" })] }));
  assert.equal(present.summary.adSpendKrwExact, "1390.1247901234");
});

test("known zero collection, missing collection and ad-only loss remain distinct", () => {
  const zero = calculateGooglePerformance(input({ salesLines: [], adMetrics: [] }));
  assert.equal(zero.summary.marginKrw, 0);
  assert.equal(zero.summary.roas, null);
  assert.equal(zero.summary.marginRate, null);
  const missing = calculateGooglePerformance(input({ adMetrics: [], days: [{ date: day, googleComplete: false, cafe24Complete: true }] }));
  assert.equal(missing.summary.adSpendKrw, null);
  assert.equal(missing.summary.marginKrw, null);
  const loss = calculateGooglePerformance(input({ salesLines: [] }));
  assert.equal(loss.summary.marginKrw, -20_000);
  assert.equal(loss.summary.roas, 0);
  assert.equal(loss.summary.marginRate, null);
});

test("missing source day also blocks product period totals with no row on the missing day", () => {
  const result = calculateGooglePerformance(input({ days: [{ date: day, googleComplete: true, cafe24Complete: true },
    { date: "2026-10-21", googleComplete: false, cafe24Complete: true }] }));
  assert.equal(result.products[0].marginKrw, null);
  assert.equal(result.daily[0].marginKrw, 40_000);
  assert.deepEqual(result.completeness.missingGoogleDates, ["2026-10-21"]);
});

test("missing cost, unresolved coupon, timezone and unmapped sales are explicit", () => {
  const missingCost = calculateGooglePerformance(input({ salesLines: [sale({ cost: null })] }));
  assert.equal(missingCost.summary.revenueKrw, null);
  assert.equal(missingCost.summary.collectedRevenueKrw, 100_000);
  assert.equal(missingCost.summary.grossCostKrw, null);
  const unknown = calculateGooglePerformance(input({ salesLines: [withCoupon(sale())] }));
  assert.equal(unknown.summary.couponDeductionKrw, null);
  const timezone = calculateGooglePerformance(input({ adMetrics: [ad({ timeZone: "America/Los_Angeles" })] }));
  assert.equal(timezone.summary.marginKrw, null);
  assert.ok(timezone.summary.warningCodes.includes("TIME_ZONE_MISMATCH"));
  const unmapped = calculateGooglePerformance(input({ salesLines: [sale({ productId: null, cost: null })] }));
  assert.equal(unmapped.unmappedSales.length, 1);
  assert.equal(unmapped.summary.marginKrw, null);
});

test("configured price and collected item price stay separate; order payment is never revenue", () => {
  const result = calculateGooglePerformance(input({ salesLines: [sale({ collectedSalePriceKrw: 90_000,
    couponInput: { ...sale().couponInput, totalPaidKrw: 999_999 } })] }));
  assert.equal(result.summary.revenueKrw, 100_000);
  assert.equal(result.summary.collectedRevenueKrw, 90_000);
  assert.equal(result.summary.priceMismatchCount, 1);
  assert.equal(result.summary.marginKrw, 40_000);
});

test("duplicate source IDs cannot duplicate rows and inputs/legacy calculator remain unchanged", () => {
  const args = input();
  const snapshot = structuredClone(args);
  const calculator = new Cafe24SalesCalculator();
  const legacyInput = { quantity: 1, adSpendUsd: 10, exchangeRateKrwPerUsd: 1_400, cost: sale().cost! };
  const legacy = calculator.calculate(legacyInput);
  const result = calculateGooglePerformance({ ...args, salesLines: [...args.salesLines, ...args.salesLines], adMetrics: [...args.adMetrics, ...args.adMetrics] });
  assert.equal(result.summary.quantity, 1);
  assert.equal(result.summary.adSpendKrw, 20_000);
  assert.deepEqual(args, snapshot);
  assert.deepEqual(calculator.calculate(legacyInput), legacy);
});

test("bundle quantity preserves existing calculation units separately from displayed units", () => {
  const result = calculateGooglePerformance(input({ salesLines: [sale({ quantity: 6, calculationQuantity: 2, collectedQuantity: 2 })] }));
  assert.equal(result.summary.quantity, 6);
  assert.equal(result.summary.revenueKrw, 200_000);
  assert.equal(result.summary.grossCostKrw, 80_000);
});

test("product coupon is split only across its product's lines before channel selection", () => {
  const lines = [withCoupon(sale({ id: "youtube" }), 300_000, 295_000),
    withCoupon(sale({ id: "normal", productName: "일반 페이지" }), 300_000, 295_000),
    withCoupon(sale({ id: "other", productId: "product-2" }), 300_000, 295_000)];
  const rule = { ...coupon(), scope: "PRODUCT" as const, productId: "product-1" };
  const result = calculateGooglePerformance(input({ salesLines: lines, couponRules: [rule] }));
  assert.equal(result.products.find(row => row.productId === "product-1")!.couponDeductionKrw, 2_500);
  assert.equal(result.products.find(row => row.productId === "product-2")!.couponDeductionKrw, 0);
});

test("unknown API coupon signal and incomplete order context never yield a confirmed margin", () => {
  const line = sale();
  const unknown = calculateGooglePerformance(input({ salesLines: [{ ...line, couponInput: {
    ...line.couponInput, source: "API", providerCouponSignal: null } }] }));
  assert.equal(unknown.summary.couponDeductionKrw, null);
  const invalid = withCoupon(sale({ id: "invalid", includeInSales: false }));
  invalid.couponInput.isValid = false;
  const incomplete = calculateGooglePerformance(input({ salesLines: [withCoupon(line), invalid], couponRules: [coupon()] }));
  assert.equal(incomplete.summary.marginKrw, null);
  assert.equal(incomplete.summary.quantity, 1);
});

test("product-filtered reconciliation declares its scope and retains whole-order coupon context", () => {
  const result = calculateGooglePerformance(input({ productId: "product-1", adMetrics: [ad(),
    ad({ id: "unmapped", productId: null, costMicros: "9000000" })] }));
  assert.equal(result.reconciliation.scope, "PRODUCT");
  assert.equal(result.reconciliation.productId, "product-1");
  assert.equal(result.reconciliation.collectedAdSpendKrwExact, "20000");
  assert.equal(result.reconciliation.unallocatedAdSpendKrwExact, "0");
  assert.equal(result.reconciliation.balanced, true);
});

test("explicit 1+1 set is one sale unit, with full-set cost charged once", () => {
  const lines = ["색상:블랙", "사이즈:M", "신규 색상:네이비"].map((label, index) => sale({
    id: `set-${index}`, orderNo: `set-order-${index}`, productName: `[유튜브] 무릎보호대 ${label}`,
    quantity: 1, calculationQuantity: 1, collectedQuantity: 1, collectedSalePriceKrw: 34900,
    saleUnitLabel: "1+1 세트", cost: { salePriceKrw: 34900, vatKrw: 3490, productCostKrw: 9000, shippingKrw: 0, extraCostKrw: 0 }
  }));
  const result = calculateGooglePerformance(input({ salesLines: lines, adMetrics: [ad({ costMicros: "10000000000" })] }));
  assert.equal(result.summary.quantity, 3);
  assert.equal(result.summary.saleUnitLabel, "1+1 세트");
  assert.equal(result.summary.revenueKrw, 104700);
  assert.equal(result.summary.grossCostKrw, 37470);
  assert.equal(result.summary.marginKrw, 57230);
  assert.equal(result.products[0].saleUnitLabel, "1+1 세트");
  assert.equal(result.daily[0].saleUnitLabel, "1+1 세트");
});

test("mixed units are not represented as a homogeneous set count", () => {
  const result = calculateGooglePerformance(input({ salesLines: [sale({ saleUnitLabel: "1+1 세트" }),
    sale({ id: "single", orderNo: "other", saleUnitLabel: "단품" })] }));
  assert.equal(result.summary.saleUnitLabel, null);
  assert.deepEqual(result.summary.saleUnitLabels, ["1+1 세트", "단품"]);
  const legacyMix = calculateGooglePerformance(input({ salesLines: [sale({ saleUnitLabel: "1+1 세트" }),
    sale({ id: "legacy", orderNo: "legacy" })] }));
  assert.equal(legacyMix.summary.saleUnitLabel, null);
});
