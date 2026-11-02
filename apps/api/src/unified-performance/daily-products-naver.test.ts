import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNaverStoredDay } from "./adapters/naver-native-results";
import type { NaverStoredErrors, NaverStoredRaw } from "./adapters/naver-reader";
import { completeSourceCoverage } from "./aggregation.worker";
import { prepareReportBatch } from "./domain/report-calculation";
import { UnifiedReportService } from "./report.service";
import type { ReportSnapshot, UnifiedReportRepository } from "./report.repository";
import type { UnifiedAggregationRepository } from "./aggregation.repository";
import type { ReportSummary } from "./report-contract";
import type { ReportQuery } from "./report-query";
import { CONTRACT_VERSION, type AdapterRequest } from "./types";

const day = "2026-11-01", prior = "2026-10-31", at = "2026-11-02T07:00:00Z";
const scope = "11111111-1111-4111-8111-111111111111";
const actor = { id: "synthetic-reader", permissions: ["data.read" as const] };
const query = { from: prior, to: day, compareFrom: prior, compareTo: prior, grain: "day", platforms: ["NAVER"] };
const request = (date: string): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: `run-${date}`, readSnapshotId: "synthetic",
  from: date, to: date, scopeKeys: [scope], platforms: ["NAVER"], scopePolicyVersion: "s", nameRuleVersion: "n", saleUnitRuleVersion: "u",
  allocationRuleVersion: "a", calculationVersion: "c", fxVersion: "f", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 10000 });
const errors = (): NaverStoredErrors => ({ stores: [], daily_store_summaries: [], daily_sales_unit_profits: [], daily_fake_purchases: [] });
const compact = (value: ReportSummary) => ({ knownTotals: value.knownTotals, completeTotals: value.completeTotals,
  byMarketplace: value.byMarketplace, byMedium: value.byMedium, isEstimate: value.isEstimate });

function stored(date: string): NaverStoredRaw {
  const current = date === day;
  const row = (id: string, values: Record<string, unknown>) => ({ id, storeId: scope, date, updatedAt: at, calculatedAt: at, calculationVersion: "profit-v2", ...values });
  const product = (name: string, revenue: string, ad: string, net: string, vat: string) => row(name, {
    canonicalSalesUnitId: name, displayName: name, totalQuantity: "1", totalProductRevenue: revenue, totalAdCost: ad,
    estimatedNetProfit: net, vatAmount: vat, totalUnitCost: "999999", totalFeeCost: "0", totalOtherCost: "0"
  });
  return {
    stores: [row(scope, { platformType: "NAVER_SMARTSTORE" })],
    daily_store_summaries: [row("summary", { totalProductRevenue: current ? "1500" : "1200", totalAdCost: current ? "150" : "120",
      estimatedNetProfit: current ? "580" : "470", totalVatAmount: current ? "150" : "120",
      customerPaidDeliveryFee: current ? "30" : "20", estimatedDeliveryBaseCost: current ? "50" : "30", deliveryMargin: current ? "-20" : "-10" })],
    daily_sales_unit_profits: current ? [product("A", "1000", "100", "400", "100"), product("B", "500", "50", "200", "50")]
      : [product("A", "800", "80", "320", "80"), product("B", "400", "40", "160", "40")],
    daily_fake_purchases: [row("fake", { amount: current ? "10" : "5" })]
  };
}

function fixture(mutator?: (raw: NaverStoredRaw) => void) {
  const parts = [prior, day].map(date => {
    const raw = stored(date); if (date === day) mutator?.(raw);
    const batch = completeSourceCoverage({ platform: "NAVER", scopeKey: scope, date, runId: `run-${date}`, token: "synthetic", previousRunId: null },
      normalizeNaverStoredDay(request(date), raw, errors(), { products: [{ canonicalName: "A" }, { canonicalName: "B" }], nameRules: [] }, at));
    const facts = prepareReportBatch(request(date), batch).map(row => ({ ...row, platform: "NAVER" as const, scopeKey: scope, date }));
    return { facts, coverage: batch.coverage };
  });
  const snapshot = { scopes: [{ platform: "NAVER", scopeKey: scope, label: "합성 스토어" }],
    facts: parts.flatMap(part => part.facts), coverage: parts.flatMap(part => part.coverage), publications: [],
    products: ["A", "B", "거래 없는 제품"].map(canonicalName => ({ id: canonicalName, canonicalName, active: true })),
    rules: [], versions: {}, availableDateRanges: [], availableProductNames: [], snapshotHash: "naver-native-synthetic", baseSnapshotHash: "naver-native-synthetic"
  } as unknown as ReportSnapshot;
  const reads: ReportQuery[] = [];
  const repository = { snapshot: async (input: ReportQuery) => { reads.push(input); return snapshot; } } as unknown as UnifiedReportRepository;
  const aggregation = { enqueue: () => assert.fail("daily report must not enqueue or call a source") } as unknown as UnifiedAggregationRepository;
  return { snapshot, reads, service: new UnifiedReportService(repository, aggregation) };
}
async function enabled(work: () => Promise<void>) {
  const before = process.env.UNIFIED_PERFORMANCE_ENABLED; process.env.UNIFIED_PERFORMANCE_ENABLED = "true";
  try { await work(); } finally { if (before === undefined) delete process.env.UNIFIED_PERFORMANCE_ENABLED; else process.env.UNIFIED_PERFORMANCE_ENABLED = before; }
}

test("native Naver published results flow into one daily snapshot with exact product and total parity on D and D-1", async () => enabled(async () => {
  const f = fixture();
  const result = await f.service.read("daily-products", { ...query, productName: "A" }, actor) as any;
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].productName, undefined);
  assert.notEqual(f.snapshot.coverage.find(row => row.date === day)!.sourceVersion,
    f.snapshot.coverage.find(row => row.date === prior)!.sourceVersion, "daily fingerprints differ but do not define the comparison basis");
  assert.equal(result.reportDate, day); assert.equal(result.previousDate, prior); assert.equal(result.totalProducts, 3);
  assert.equal(result.allProducts.current.knownTotals.estimatedProfit, "570.000000");
  assert.equal(result.allProducts.previous.knownTotals.estimatedProfit, "465.000000");
  assert.match(result.allProducts.current.comparisonBasis.NAVER, /^[a-f0-9]{64}$/);
  assert.equal(result.allProducts.current.comparisonBasis.NAVER, result.allProducts.previous.comparisonBasis.NAVER,
    "different native publication dates share the same comparison basis");
  assert.equal(result.products[0].current.comparisonBasis.NAVER, result.products[0].previous.comparisonBasis.NAVER);
  assert.equal(result.products.find((row: any) => row.productName === "A").current.knownTotals.estimatedProfit, "400.000000");
  assert.equal(result.products.find((row: any) => row.productName === "A").previous.knownTotals.estimatedProfit, "320.000000");
  for (const [key, date] of [["current", day], ["previous", prior]] as const) {
    const total = await f.service.read("summary", { ...query, from: date, to: date }, actor) as any;
    assert.deepEqual(compact(result.allProducts[key]), compact(total));
    for (const product of result.products) {
      const canonical = await f.service.read("summary", { ...query, from: date, to: date, productName: product.productName }, actor) as any;
      assert.deepEqual(compact(product[key]), compact(canonical.items[0]), `${product.productName}/${date}`);
      assert.equal(product[key].isEstimate, true);
    }
  }
}));

test("store-level Naver ads, shipping and fake-purchase amounts stay unassigned and are reflected only once", async () => enabled(async () => {
  const f = fixture(raw => {
    const base = raw.daily_sales_unit_profits[0];
    raw.daily_sales_unit_profits.push({ ...base, id: "store-level", canonicalSalesUnitId: "store-level", displayName: "스토어 공통", isStoreLevel: true,
      totalProductRevenue: "0", totalAdCost: "20", estimatedNetProfit: "-20", vatAmount: "0" });
    Object.assign(raw.daily_store_summaries[0], { totalAdCost: "170", estimatedNetProfit: "560" });
  });
  const result = await f.service.read("daily-products", query, actor) as any;
  assert.equal(result.totalProducts, 3); assert.equal(result.products.some((row: any) => row.productName === "스토어 공통"), false);
  assert.equal(result.allProducts.current.knownTotals.estimatedProfit, "550.000000");
  assert.equal(result.allProducts.current.knownTotals.adSpend, "170.000000");
  assert.equal(result.allProducts.current.scopeBalances.unallocatedAdSpend, "20.000000");
  assert.equal(result.allProducts.current.scopeBalances.unallocatedExpense, "60.000000");
  assert.equal(result.allProducts.current.scopeBalances.unallocatedShippingIncome, "30.000000");
  assert.equal(result.products[0].current.knownTotals.estimatedProfit, "400.000000");
  assert.equal(result.products[0].current.completeTotals.estimatedProfit, null, "unassigned costs must retain the canonical partial state");
  const native = result.allProducts.current.byMarketplace.find((row: any) => row.marketplace === "NAVER_SMARTSTORE");
  assert.equal(native.display.estimatedProfit.value, "550.000000");
  assert.equal(native.display.estimatedProfit.state, "COMPLETE");
}));

test("new native Naver product names are retained while child detail is never counted twice", async () => enabled(async () => {
  const f = fixture(raw => {
    raw.daily_sales_unit_profits[1].displayName = "새 네이버 상품";
    raw.daily_sales_unit_profits.push({ ...raw.daily_sales_unit_profits[1], id: "child", parentSalesUnitId: "B", displayName: "중복 자식",
      totalProductRevenue: "999999", estimatedNetProfit: "999999", totalAdCost: "999999" });
  });
  const result = await f.service.read("daily-products", query, actor) as any;
  const product = result.products.find((row: any) => row.productName === "새 네이버 상품");
  assert(product); assert.equal(product.current.knownTotals.revenue, "500.000000");
  assert.equal(product.previous.knownTotals.revenue, "0.000000");
  assert.equal(result.products.some((row: any) => row.productName === "중복 자식"), false);
  assert.equal(result.allProducts.current.knownTotals.estimatedProfit, "570.000000");
}));

test("native Naver unknown product profit is preserved as unavailable rather than reconstructed from components", async () => enabled(async () => {
  const f = fixture(raw => {
    raw.daily_store_summaries[0].estimatedNetProfit = null;
    raw.daily_sales_unit_profits[0].estimatedNetProfit = null;
  });
  const result = await f.service.read("daily-products", query, actor) as any;
  const product = result.products.find((row: any) => row.productName === "A");
  assert.equal(product.current.knownTotals.revenue, "1000.000000");
  assert.equal(product.current.knownTotals.adSpend, "100.000000");
  assert.equal(product.current.knownTotals.estimatedProfit, null);
  assert.equal(product.current.completeTotals.estimatedProfit, null);
  assert.equal(result.allProducts.current.completeTotals.estimatedProfit, null);
  const canonical = await f.service.read("summary", { ...query, from: day, to: day, productName: "A" }, actor) as any;
  assert.deepEqual(compact(product.current), compact(canonical.items[0]));
}));

test("legacy-to-native comparison metadata changes without changing either day's published money", async () => enabled(async () => {
  const f = fixture();
  f.snapshot.coverage = f.snapshot.coverage.map(row => row.date === prior ? { ...row, selectedSource: "NAVER_OPERATIONAL",
    quality: { ...row.quality, issues: row.quality.issues.filter(issue => issue !== "NAVER_STORED_NATIVE_SOURCE") } } : row);
  const result = await f.service.read("daily-products", query, actor) as any;
  assert.notEqual(result.allProducts.current.comparisonBasis.NAVER, result.allProducts.previous.comparisonBasis.NAVER);
  assert.notEqual(result.products[0].current.comparisonBasis.NAVER, result.products[0].previous.comparisonBasis.NAVER);
  assert.equal(result.allProducts.current.knownTotals.estimatedProfit, "570.000000");
  assert.equal(result.allProducts.previous.knownTotals.estimatedProfit, "465.000000");
}));
