import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_PERMISSIONS } from "../auth/route-decorators";
import { UnifiedReportController } from "./report.controller";
import { UnifiedReportService } from "./report.service";
import { missingCoverage, type ReportSnapshot, type UnifiedReportRepository } from "./report.repository";
import type { UnifiedAggregationRepository } from "./aggregation.repository";
import type { PublishedReportFact, ReportSummary } from "./report-contract";
import type { ReportQuery } from "./report-query";
import type { Platform } from "./types";

const actor = { id: "reader", permissions: ["data.read" as const] };
const input = { from: "2026-10-31", to: "2026-11-01", compareFrom: "2026-10-31", compareTo: "2026-10-31", grain: "day",
  platforms: ["META", "GOOGLE", "CAFE24", "COUPANG", "NAVER"] };
const quality = { isEstimate: false, confidence: "SOURCE_REPORTED" as const, issues: [] };
const fact = (value: Partial<PublishedReportFact>): PublishedReportFact => ({
  component: "SALE", productName: "A", platform: "CAFE24", scopeKey: "CAFE24", date: input.to,
  marketplace: "CAFE24", medium: null, factKey: "fact", saleUnitName: null,
  amountKrw: "100.000000", completeAmountKrw: "100.000000", profitBeforeAds: "70.000000", completeProfitBeforeAds: "70.000000",
  originalAmount: null, currency: "KRW", quantity: null, attribution: "DIRECT", commonKind: null, rowsCount: 1, quality, ...value
});
const compact = (value: ReportSummary) => ({ knownTotals: value.knownTotals, completeTotals: value.completeTotals,
  byMarketplace: value.byMarketplace, byMedium: value.byMedium, isEstimate: value.isEstimate });

async function enabled(work: () => Promise<void>) {
  const saved = process.env.UNIFIED_PERFORMANCE_ENABLED; process.env.UNIFIED_PERFORMANCE_ENABLED = "true";
  try { await work(); } finally { if (saved === undefined) delete process.env.UNIFIED_PERFORMANCE_ENABLED; else process.env.UNIFIED_PERFORMANCE_ENABLED = saved; }
}
function fixture() {
  const scopes = input.platforms.map(platform => ({ platform: platform as Platform, scopeKey: platform, label: platform }));
  const coverage = [input.from, input.to].flatMap(day => scopes.flatMap(scope => missingCoverage(scope, day).map(row => ({ ...row,
    collectionState: "COMPLETE" as const, rowsPresent: 1, mappedRows: 1, zeroConfirmed: true, quality }))));
  const facts = [input.from, input.to].flatMap(date => [
    fact({ date, amountKrw: "900.000000", completeAmountKrw: "900.000000" }), // replaced legacy result
    ...(["META", "GOOGLE"] as const).flatMap((medium, index) => [
      fact({ date, component: "STOREFRONT_RESULT", marketplace: index ? "CAFE24_YOUTUBE" : "CAFE24_META", medium,
        amountKrw: index ? "30.000000" : "100.000000", completeAmountKrw: index ? "30.000000" : "100.000000",
        profitBeforeAds: index ? "20.000000" : "70.000000", completeProfitBeforeAds: index ? "20.000000" : "70.000000",
        persistedNetProfit: index ? "18.000000" : "60.000000", persistedAdSpend: index ? "2.000000" : "10.000000" }),
      fact({ date, component: "STOREFRONT_RESULT", productName: null, marketplace: index ? "CAFE24_YOUTUBE" : "CAFE24_META", medium,
        saleUnitName: "PARTITION_MARKER", rowsCount: 0, amountKrw: null, completeAmountKrw: null, profitBeforeAds: null, completeProfitBeforeAds: null }),
      fact({ date, component: "AD_SPEND", platform: medium, scopeKey: medium, marketplace: null, medium,
        amountKrw: index ? "2.000000" : "10.000000", completeAmountKrw: index ? "2.000000" : "10.000000",
        profitBeforeAds: null, completeProfitBeforeAds: null })
    ]),
    fact({ date, platform: "COUPANG", scopeKey: "COUPANG", marketplace: "COUPANG", productName: "B" }),
    fact({ date, platform: "NAVER", scopeKey: "NAVER", marketplace: "NAVER_SMARTSTORE", productName: "과거 이름" })
  ]);
  const snapshot = { scopes, coverage, facts, publications: [], availableDateRanges: [], snapshotHash: "single-revision", baseSnapshotHash: "single-revision",
    products: ["A", "B", "거래 없는 비활성"].map(canonicalName => ({ id: canonicalName, canonicalName, active: canonicalName !== "거래 없는 비활성" })),
    availableProductNames: ["과거 이름", "과거 자료 없음"], rules: [], versions: {} } as unknown as ReportSnapshot;
  const reads: ReportQuery[] = [];
  const repository = { snapshot: async (query: ReportQuery) => { reads.push(query); return snapshot; } } as unknown as UnifiedReportRepository;
  const aggregation = { enqueue: () => assert.fail("a read cannot rebuild") } as unknown as UnifiedAggregationRepository;
  return { service: new UnifiedReportService(repository, aggregation), snapshot, reads };
}

test("daily products reads one all-product snapshot, retaining selected summary and exact two-day totals", async () => enabled(async () => {
  const f = fixture();
  const response = await f.service.read("daily-products", { ...input, productName: "A", limit: 1 }, actor) as any;
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].productName, undefined);
  assert.equal(response.summary.selection.productName, "A");
  assert.equal(response.summary.snapshotHash, response.timeseries.snapshotHash);
  assert.deepEqual(response.timeseries.items.map((row: any) => row.date), [input.from, input.to]);
  assert.equal(response.timeseries.items[1].knownTotals.revenue, "130.000000");
  assert.equal(response.timeseries.items[1].knownTotals.estimatedProfit, "78.000000");
  assert.equal(response.allProducts.current.knownTotals.revenue, "330.000000");
  assert.equal(response.allProducts.current.knownTotals.estimatedProfit, "218.000000");
  assert.equal(response.reportDate, input.to); assert.equal(response.previousDate, input.from);
  assert.equal(response.totalProducts, 5); assert.equal(response.nextCursor, null);
  assert.deepEqual(response.products.map((row: any) => row.productName), ["A", "B", "거래 없는 비활성", "과거 이름", "과거 자료 없음"]);
  assert.equal(new Set(response.products.map((row: any) => row.productKey)).size, response.totalProducts);
  assert.equal(response.products.find((row: any) => row.productName === "거래 없는 비활성").active, false);
  assert.equal(response.products.find((row: any) => row.productName === "과거 이름").historical, true);
  assert.equal(response.products[0].current.byMarketplace.find((row: any) => row.marketplace === "CAFE24_META").display.estimatedProfit.value, "60.000000");
  assert.equal(response.products[0].current.byMarketplace.find((row: any) => row.marketplace === "CAFE24_YOUTUBE").display.estimatedProfit.value, "18.000000");
}));

test("indexed product metrics match the canonical full-ledger read including zero products and unassigned money", async () => enabled(async () => {
  for (const unassigned of [false, true]) {
    const f = fixture();
    if (unassigned) f.snapshot.facts.push(fact({ productName: null, platform: "META", scopeKey: "META", component: "AD_SPEND", medium: "META", marketplace: null,
      amountKrw: "3.123456", completeAmountKrw: "3.123456", profitBeforeAds: null, completeProfitBeforeAds: null }));
    const response = await f.service.read("daily-products", input, actor) as any;
    assert.equal(response.allProducts.current.knownTotals, response.timeseries.items[1].knownTotals, "reuse the existing all-product current bucket");
    assert.equal(response.allProducts.previous.knownTotals, response.timeseries.items[0].knownTotals, "reuse the existing all-product previous bucket");
    for (const product of response.products) for (const [key, day] of [["current", input.to], ["previous", input.from]] as const) {
      const canonical = await f.service.read("summary", { ...input, from: day, to: day, productName: product.productName }, actor) as any;
      assert.deepEqual(compact(product[key]), compact(canonical.items[0]), `${product.productName}/${key}/${unassigned}`);
    }
    if (unassigned) {
      assert.equal(response.allProducts.current.scopeBalances.unallocatedAdSpend, "3.123456");
      assert.equal(response.products[0].current.completeTotals.adSpend, null);
    }
  }
}));

test("native readiness context survives when old result partitions lack explicit zero markers", async () => enabled(async () => {
  const f = fixture(); f.snapshot.facts = f.snapshot.facts.filter(row => row.saleUnitName !== "PARTITION_MARKER");
  const response = await f.service.read("daily-products", input, actor) as any;
  for (const product of response.products) {
    const canonical = await f.service.read("summary", { ...input, from: input.to, to: input.to, productName: product.productName }, actor) as any;
    assert.deepEqual(compact(product.current), compact(canonical.items[0]), product.productName);
  }
}));

test("Excel platform presence uses own source rows rather than catalog, coverage or other-product native context", async () => enabled(async () => {
  const f = fixture();
  const response = await f.service.read("daily-products", { ...input, productName: "A" }, actor) as any;
  assert.deepEqual(Object.fromEntries(response.products.map((row: any) => [row.productName, row.exportPlatforms])), {
    A: ["STOREFRONT", "GOOGLE"], B: ["COUPANG"], "거래 없는 비활성": [], "과거 이름": ["NAVER"], "과거 자료 없음": []
  });
  assert.ok(response.products.find((row: any) => row.productName === "거래 없는 비활성").current.byMarketplace.length > 0,
    "synthetic marketplace summaries must not become membership evidence");
  assert.equal(response.totalProducts, 5, "export metadata never removes ordinary report products");
  assert.equal(f.reads.length, 1);
}));

test("Excel source presence retains real zero, negative, unknown, previous-only and ad-only results without inferred allocations", async () => enabled(async () => {
  const f = fixture();
  f.snapshot.availableProductNames.push("legacy zero");
  f.snapshot.facts.push(
    fact({ productName: "legacy zero", amountKrw: "0", completeAmountKrw: "0" }),
    fact({ productName: "native meta zero", component: "STOREFRONT_RESULT", marketplace: "CAFE24_META", medium: "META",
      amountKrw: "0", completeAmountKrw: "0", profitBeforeAds: "0", completeProfitBeforeAds: "0" }),
    fact({ productName: "native google unknown", component: "STOREFRONT_RESULT", marketplace: "CAFE24_YOUTUBE", medium: "GOOGLE",
      amountKrw: null, completeAmountKrw: null, profitBeforeAds: null, completeProfitBeforeAds: null }),
    fact({ productName: "naver unknown", platform: "NAVER", scopeKey: "NAVER", marketplace: "NAVER_SMARTSTORE",
      amountKrw: null, completeAmountKrw: null, profitBeforeAds: null, completeProfitBeforeAds: null }),
    fact({ productName: "coupang previous negative", date: input.from, platform: "COUPANG", scopeKey: "COUPANG", marketplace: "COUPANG", amountKrw: "-12" }),
    fact({ productName: "coupang manual zero", platform: "COUPANG", scopeKey: "COUPANG", marketplace: "COUPANG", amountKrw: "0", quantity: "0", profitBeforeAds: "-5" }),
    ...(["META", "GOOGLE", "COUPANG", "NAVER"] as const).map(platform => fact({ productName: `${platform} ad only`, platform, scopeKey: platform,
      component: "AD_SPEND", marketplace: null, medium: platform === "COUPANG" ? "COUPANG_ADS" : platform === "NAVER" ? "NAVER_ADS" : platform,
      amountKrw: "0", completeAmountKrw: "0", profitBeforeAds: null, completeProfitBeforeAds: null })),
    fact({ productName: "allocation only", platform: "META", scopeKey: "META", component: "AD_SPEND", marketplace: null, medium: "META", attribution: "ALLOCATED" }),
    fact({ productName: "expense only", platform: "COUPANG", scopeKey: "COUPANG", component: "COMMON_EXPENSE", marketplace: null, commonKind: "OTHER" }),
    fact({ productName: "invalid product marker", component: "STOREFRONT_RESULT", marketplace: "CAFE24_YOUTUBE", medium: "GOOGLE", rowsCount: 0, saleUnitName: "PARTITION_MARKER" }),
    fact({ productName: "outside date", date: "2026-10-30", platform: "COUPANG", scopeKey: "COUPANG", marketplace: "COUPANG" })
  );
  const response = await f.service.read("daily-products", input, actor) as any;
  const platforms = (name: string) => response.products.find((row: any) => row.productName === name).exportPlatforms;
  // Legacy sales coexist with native adoption in this fixture and are correctly
  // removed by the canonical overlay, so test their evidence in an older partition.
  assert.deepEqual(platforms("legacy zero"), []);
  assert.deepEqual(platforms("native meta zero"), ["STOREFRONT"]);
  assert.deepEqual(platforms("native google unknown"), ["GOOGLE"]);
  assert.deepEqual(platforms("naver unknown"), ["NAVER"]);
  assert.deepEqual(platforms("coupang previous negative"), ["COUPANG"]);
  assert.deepEqual(platforms("coupang manual zero"), ["COUPANG"]);
  assert.deepEqual(platforms("META ad only"), ["STOREFRONT"]);
  assert.deepEqual(platforms("GOOGLE ad only"), ["GOOGLE"]);
  assert.deepEqual(platforms("COUPANG ad only"), ["COUPANG"]);
  for (const name of ["NAVER ad only", "allocation only", "expense only", "invalid product marker", "outside date"])
    assert.deepEqual(platforms(name), [], name);
  f.snapshot.facts = [fact({ productName: "legacy zero", amountKrw: "0", completeAmountKrw: "0" })];
  const legacy = await f.service.read("daily-products", input, actor) as any;
  assert.deepEqual(legacy.products.find((row: any) => row.productName === "legacy zero").exportPlatforms, ["STOREFRONT"],
    "an older Cafe24 row never guesses a Google channel");
}));

test("Excel source presence respects selected platforms, accounts and published date-specific participation", async () => enabled(async () => {
  const f = fixture();
  f.snapshot.rules.push({ id: "policy", productId: "A", kind: "SCOPE_POLICY", platform: "CAFE24", scopeKey: "CAFE24", active: true,
    validFrom: new Date(input.from), validTo: null, payload: { components: ["SALE", "DIRECT_COST"] } } as any);
  for (const day of [input.from, input.to]) f.snapshot.publications.push({ platform: "CAFE24", scopeKey: "CAFE24", businessDate: new Date(day), runId: day, revision: 1,
    run: { versions: { participationOverrides: { A: day === input.to ? [] : ["SALE", "DIRECT_COST"] } }, publishedAt: new Date("2026-11-02T00:00:00Z") } } as any);
  const previous = await f.service.read("daily-products", input, actor) as any;
  assert.deepEqual(previous.products[0].exportPlatforms, ["STOREFRONT", "GOOGLE"], "previous day's eligible result remains evidence");
  (f.snapshot.publications[0].run.versions as any).participationOverrides.A = [];
  const excluded = await f.service.read("daily-products", input, actor) as any;
  assert.deepEqual(excluded.products[0].exportPlatforms, [], "published overrides and policy exclude both days and ad media");
  const selected = await f.service.read("daily-products", { ...input, platforms: ["COUPANG"], scopeKeys: ["COUPANG"] }, actor) as any;
  assert.deepEqual(selected.products.find((row: any) => row.productName === "B").exportPlatforms, ["COUPANG"]);
  assert.deepEqual(selected.products.find((row: any) => row.productName === "과거 이름").exportPlatforms, []);
  const noAccounts = await f.service.read("daily-products", { ...input, scopeKeys: [] }, actor) as any;
  assert.ok(noAccounts.products.every((row: any) => row.exportPlatforms.length === 0));
}));

test("date-specific product policy and published overrides are applied identically to existing reads", async () => enabled(async () => {
  const f = fixture();
  f.snapshot.rules.push({ id: "policy", productId: "A", kind: "SCOPE_POLICY", platform: "CAFE24", scopeKey: "CAFE24", active: true,
    validFrom: new Date(input.to), validTo: null, payload: { components: ["SALE", "DIRECT_COST"] } } as any);
  for (const published of [false, true]) {
    if (published) f.snapshot.publications = f.snapshot.scopes.map(scope => ({ ...scope, businessDate: new Date(input.to), runId: scope.platform, revision: 1,
      run: { versions: { participationOverrides: { A: [] } }, publishedAt: new Date("2026-11-02T00:00:00Z") } } as any));
    const response = await f.service.read("daily-products", input, actor) as any;
    for (const [key, day] of [["current", input.to], ["previous", input.from]] as const) {
      const canonical = await f.service.read("summary", { ...input, from: day, to: day, productName: "A" }, actor) as any;
      assert.deepEqual(compact(response.products[0][key]), compact(canonical.items[0]), `${published}/${key}`);
      const applicability = response.products[0][key].notApplicable;
      assert.equal(applicability.revenue.includes("CAFE24"), published || key === "previous");
      assert.equal(applicability.adSpend.includes("META"), true);
    }
  }
}));

test("all products exceed the ordinary page limit without truncation and include previous-only records", async () => enabled(async () => {
  const f = fixture();
  f.snapshot.products.push(...Array.from({ length: 120 }, (_, index) => ({ id: `p${index}`, canonicalName: `제품 ${String(index).padStart(3, "0")}`, active: true } as any)));
  f.snapshot.facts.push(fact({ date: input.from, platform: "COUPANG", scopeKey: "COUPANG", marketplace: "COUPANG", productName: "전일만 존재" }));
  const response = await f.service.read("daily-products", { ...input, limit: 1 }, actor) as any;
  assert.equal(response.totalProducts, 126); assert.equal(response.products.length, 126); assert.equal(f.reads.length, 1);
  assert.equal(response.products.find((row: any) => row.productName === "전일만 존재").previous.knownTotals.revenue, "100.000000");
}));

test("applicability requires explicit exclusion in every selected account and never infers missing coverage", async () => enabled(async () => {
  const f = fixture();
  const secondAccount = f.snapshot.coverage.filter(row => row.platform === "CAFE24").map(row => ({ ...row, scopeKey: "another-store" }));
  f.snapshot.coverage = [...f.snapshot.coverage.filter(row => row.platform !== "NAVER"), ...secondAccount];
  f.snapshot.rules.push({ id: "one-store-policy", productId: "A", kind: "SCOPE_POLICY", platform: "CAFE24", scopeKey: "CAFE24", active: true,
    validFrom: new Date(input.from), validTo: null, payload: { components: ["SALE", "DIRECT_COST"] } } as any);
  const response = await f.service.read("daily-products", input, actor) as any;
  const applicability = response.products[0].current.notApplicable;
  assert.equal(applicability.revenue.includes("CAFE24"), false, "one participating account keeps the sales metric applicable");
  assert.equal(applicability.revenue.includes("NAVER"), false, "no coverage is unknown rather than non-applicable");
  assert.equal(applicability.adSpend.includes("META"), true, "explicit product policy excludes every Meta account");
  assert.deepEqual(response.allProducts.current.notApplicable, { revenue: [], adSpend: [] });
}));

test("invalid daily ranges, cursor and missing permissions fail before reading", async () => enabled(async () => {
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, UnifiedReportController.prototype.dailyProducts), ["data.read"]);
  const f = fixture();
  for (const override of [{ from: input.to }, { grain: "week" }, { compareTo: input.to }, { compareFrom: "2026-10-30" }, { cursor: "token" },
    { from: "2999-01-01", to: "2999-01-02", compareFrom: "2999-01-01", compareTo: "2999-01-01" }])
    await assert.rejects(f.service.read("daily-products", { ...input, ...override }, actor));
  await assert.rejects(f.service.read("daily-products", input, { ...actor, permissions: [] }), /실행 권한/);
  assert.equal(f.reads.length, 0);
  await assert.rejects(f.service.read("daily-products", { ...input, productName: "없는 제품" }, actor), /기준 제품명/);
  assert.equal(f.reads.length, 1);
}));

test("explicit empty account selection is passed through and no missing day is substituted", async () => enabled(async () => {
  const f = fixture();
  f.snapshot.facts = f.snapshot.facts.filter(row => row.date !== input.from);
  f.snapshot.coverage = f.snapshot.coverage.map(row => row.date === input.from ? { ...row, collectionState: "NOT_COLLECTED", zeroConfirmed: false, rowsPresent: 0 } : row);
  const response = await f.service.read("daily-products", { ...input, scopeKeys: [] }, actor) as any;
  assert.deepEqual(f.reads[0].scopeKeys, []);
  assert.equal(response.previousDate, input.from);
  assert.equal(response.products[0].previous.knownTotals.revenue, null);
  assert.equal(response.products[0].current.knownTotals.revenue, "130.000000");
}));

test("opt-in synthetic daily products benchmark (no database or source reads)", {
  skip: process.env.UNIFIED_DAILY_PRODUCTS_BENCHMARK !== "true"
}, async () => enabled(async () => {
  for (const count of [100, 1000, 5000]) {
    const f = fixture();
    const template = f.snapshot.facts.filter(row => row.productName === "A" && row.marketplace !== "CAFE24");
    const markers = f.snapshot.facts.filter(row => row.productName === null);
    f.snapshot.products = Array.from({ length: count }, (_, index) => ({
      id: `benchmark-${index}`, canonicalName: `제품 ${String(index).padStart(5, "0")}`, active: true
    } as any));
    f.snapshot.availableProductNames = [];
    f.snapshot.facts = [...markers, ...f.snapshot.products.flatMap(product =>
      template.map(row => ({ ...row, productName: product.canonicalName })))];
    const started = performance.now();
    const response = await f.service.read("daily-products", input, actor) as any;
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    assert.equal(response.products.length, count); assert.equal(response.totalProducts, count);
    assert.equal(f.reads.length, 1); assert.equal(response.nextCursor, null);
    console.info(JSON.stringify({ benchmark: "daily-products", products: count, storedFacts: f.snapshot.facts.length,
      serviceMs: durationMs, responseBytes: Buffer.byteLength(JSON.stringify(response)),
      snapshotCalls: f.reads.length, sourceCalls: 0, database: "synthetic repository only", measurement: "single sample; not p95" }));
  }
}));
