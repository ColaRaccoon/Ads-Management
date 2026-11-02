import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import type { AdapterBatch, AdapterRequest, NativeStorefrontResult, Platform, SaleFact, SourceCoverage } from "../types";
import type { PublishedReportFact } from "../report-contract";
import { prepareReportBatch, summarizeReport } from "./report-calculation";
import { UnifiedReportService } from "../report.service";
import { missingCoverage, type ReportSnapshot, type UnifiedReportRepository } from "../report.repository";
import type { UnifiedAggregationRepository } from "../aggregation.repository";
import { parseReportQuery } from "../report-query";
import { parseRelationshipQuery } from "../relationship-query";
import { relationshipDays } from "../relationship-input";

const DATE = "2026-11-01", quality = { isEstimate: false, confidence: "SOURCE_REPORTED" as const, issues: [] as string[] };
const platforms: Platform[] = ["CAFE24", "META", "GOOGLE"];
const request = (platform: Platform, date = DATE): AdapterRequest => ({ contractVersion: "product-performance-v1.1.0", runId: "test-run", readSnapshotId: "test-snapshot",
  from: date, to: date, scopeKeys: [platform === "CAFE24" ? "shop" : platform.toLowerCase()], platforms: [platform], scopePolicyVersion: "s", nameRuleVersion: "n", saleUnitRuleVersion: "u",
  allocationRuleVersion: "a", calculationVersion: "native-test", fxVersion: "fx", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 });
const baseBatch = (): AdapterBatch => ({ sales: [], adSpends: [], commonExpenses: [], coverage: [], sourceControlTotals: [], sourceFingerprint: "test-fingerprint", nextCursor: null });
const nativeRows = (): NativeStorefrontResult[] => [
  { channel: "META", productName: "A", revenue: "12545080", grossCost: "4915808", coupon: "19000", profitBeforeAds: "7610272", adSpend: "5067824.031", estimatedProfit: "2542447.969", quantity: "1", complete: true, issues: [] },
  { channel: "YOUTUBE", productName: "A", revenue: "521800", grossCost: "203080", coupon: "1000", profitBeforeAds: "317720", adSpend: "446889.026713", estimatedProfit: "-129169.026713", quantity: "1", complete: true, issues: [] },
];
function published(platform: Platform, batch: AdapterBatch, date = DATE): PublishedReportFact[] {
  const req = request(platform, date);
  return prepareReportBatch(req, batch).map(row => ({ ...row, platform, scopeKey: req.scopeKeys[0], date }));
}
function coverage(date = DATE): SourceCoverage[] {
  return platforms.flatMap(platform => missingCoverage({ platform, scopeKey: request(platform).scopeKeys[0], label: "test" }, date))
    .filter(row => row.component !== "COMMON_EXPENSE").map(row => ({ ...row, collectionState: "COMPLETE", rowsPresent: 1, mappedRows: 1,
      lastSuccessAt: "2026-11-02T00:00:00Z", quality })) as SourceCoverage[];
}
function rawSale(revenue: string, profit: string, productName = "A"): SaleFact {
  return { productName, saleUnitName: "unit", operatingRevenue: revenue, profitBeforeAds: profit, calculationQuantity: "1", marketplace: "CAFE24", quality } as SaleFact;
}
function ad(platform: "META" | "GOOGLE", amount: string | null, productName = "A", date = DATE) {
  return published(platform, { ...baseBatch(), adSpends: [{ productName, amountKrw: amount, originalAmount: amount, currency: "KRW", attribution: "DIRECT", medium: platform, name: { originalName: "test" }, quality } as AdapterBatch["adSpends"][number]] }, date);
}
function fixture(rows = nativeRows()) {
  const cafe = published("CAFE24", { ...baseBatch(), sales: [rawSale("999999999", "888888888")], nativeStorefrontResults: {
    calculationVersion: "native-test", sourceFingerprint: "native-test", rows, issues: [],
  } });
  return { cafe, facts: [...cafe, ...ad("META", "5067824.031"), ...ad("GOOGLE", "446889.026713")], coverage: coverage() };
}
const market = (result: ReturnType<typeof summarizeReport>, key: string) => result.byMarketplace.find(row => row.marketplace === key)!;

test("actual 11/1 native storefront targets replace stale raw sales without adding or subtracting a ledger twice", () => {
  const input = fixture(), before = structuredClone(input.facts);
  const result = summarizeReport(input.facts, input.coverage, { platforms });
  assert.equal(result.knownTotals.revenue, "13066880.000000");
  assert.equal(result.knownTotals.profitBeforeAds, "7927992.000000");
  assert.equal(result.knownTotals.adSpend, "5514713.057713");
  assert.equal(result.knownTotals.estimatedProfit, "2413278.942287");
  assert.equal(market(result, "CAFE24_META").display!.estimatedProfit.value, "2542447.969000");
  assert.equal(market(result, "CAFE24_YOUTUBE").display!.estimatedProfit.value, "-129169.026713");
  assert.equal(result.byMarketplace.some(row => row.marketplace === "CAFE24"), false);
  assert.deepEqual(input.facts, before);
});

test("a later independent ad revision changes net profit exactly once while the stored audit result stays intact", () => {
  const input = fixture();
  const facts = [...input.cafe, ...ad("META", "5167824.031"), ...ad("GOOGLE", "446889.026713")];
  const result = summarizeReport(facts, input.coverage, { platforms });
  assert.equal(result.knownTotals.profitBeforeAds, "7927992.000000");
  assert.equal(result.knownTotals.estimatedProfit, "2313278.942287");
  assert.equal(market(result, "CAFE24_META").display!.estimatedProfit.value, "2442447.969000");
  assert.equal(input.cafe.find(row => row.marketplace === "CAFE24_META" && row.rowsCount !== 0)!.persistedNetProfit, "2542447.969000");
});

test("excluding an ad platform returns its channel before-ad profit rather than retaining an excluded charge", () => {
  const input = fixture();
  const noAds = summarizeReport(input.facts, input.coverage, { platforms: ["CAFE24"] });
  assert.equal(noAds.knownTotals.estimatedProfit, "7927992.000000");
  assert.equal(market(noAds, "CAFE24_META").display!.estimatedProfit.value, "7610272.000000");
  assert.equal(market(noAds, "CAFE24_YOUTUBE").display!.estimatedProfit.value, "317720.000000");
  const noGoogle = summarizeReport(input.facts, input.coverage, { platforms: ["CAFE24", "META"] });
  assert.equal(noGoogle.knownTotals.estimatedProfit, "2860167.969000");
  assert.equal(market(noGoogle, "CAFE24_META").display!.estimatedProfit.value, "2542447.969000");
});

test("missing Google publication leaves Meta and known source-day results visible without declaring missing spend zero", () => {
  const input = fixture();
  const facts = input.facts.filter(row => row.platform !== "GOOGLE");
  const cov = input.coverage.map(row => row.platform === "GOOGLE" ? { ...row, collectionState: "NOT_COLLECTED" as const, rowsPresent: 0, zeroConfirmed: false } : row);
  const result = summarizeReport(facts, cov, { platforms });
  assert.equal(result.knownTotals.estimatedProfit, "2860167.969000"); assert.equal(result.completeTotals.estimatedProfit, null);
  assert.equal(market(result, "CAFE24_META").display!.estimatedProfit.value, "2542447.969000");
  assert.equal(result.byMedium.find(row => row.medium === "GOOGLE")!.displayAdSpend!.value, null);
  assert.equal(result.byMedium.find(row => row.medium === "GOOGLE")!.displayAdSpend!.state, "UNAVAILABLE");
});

test("mixed old and new source days sum each source day once and leave the old marketplace distinct", () => {
  const input = fixture(), previous = "2026-10-31";
  const old = [...published("CAFE24", { ...baseBatch(), sales: [rawSale("111", "57")] }, previous), ...ad("META", "10", "A", previous), ...ad("GOOGLE", "5", "A", previous)];
  const result = summarizeReport([...old, ...input.facts], [...coverage(previous), ...input.coverage], { platforms });
  assert.equal(result.knownTotals.revenue, "13066991.000000");
  assert.equal(result.knownTotals.estimatedProfit, "2413320.942287");
  assert.equal(market(result, "CAFE24").revenue, "111.000000");
  assert.equal(market(result, "CAFE24_META").revenue, "12545080.000000");
});

test("unknown native monetary inputs never fall back to stale legacy amounts or invented zeros", () => {
  const input = fixture(nativeRows().map(row => ({ ...row, revenue: null, grossCost: null, coupon: null, profitBeforeAds: null, estimatedProfit: null, complete: false, issues: ["MISSING_INPUT"] })));
  const result = summarizeReport(input.facts, input.coverage, { platforms });
  assert.equal(result.knownTotals.revenue, null); assert.equal(result.knownTotals.profitBeforeAds, null); assert.equal(result.knownTotals.estimatedProfit, null);
  assert.equal(market(result, "CAFE24_META").display!.revenue.value, null);
  assert.equal(market(result, "CAFE24_YOUTUBE").display!.estimatedProfit.value, null);
});

function productFixture() {
  const rows = nativeRows().map((row, index) => ({ ...row, productName: index === 0 ? "A" : "B" }));
  const input = fixture(rows);
  input.facts = [...input.cafe, ...ad("META", "5067824.031", "A"), ...ad("GOOGLE", "446889.026713", "B")];
  // Exact financial SQL predicate: selected product OR NULL metadata markers.
  return { ...input, facts: input.facts.filter(row => row.productName === "A" || row.productName === null) };
}

test("SQL-filtered product with one native channel and two NULL markers replaces the old product and confirms only collected product zero", () => {
  const input = productFixture();
  assert.equal(input.facts.filter(row => row.saleUnitName === "PARTITION_MARKER").length, 2);
  const result = summarizeReport(input.facts, input.coverage, { platforms, productName: "A" });
  assert.equal(result.knownTotals.revenue, "12545080.000000");
  assert.equal(result.knownTotals.estimatedProfit, "2542447.969000");
  assert.equal(market(result, "CAFE24_YOUTUBE").display!.revenue.value, "0.000000");
  const unknownCoverage = input.coverage.map(row => row.platform === "CAFE24" ? { ...row, collectionState: "NOT_COLLECTED" as const, rowsPresent: 0, zeroConfirmed: false } : row);
  const unknown = summarizeReport(input.facts, unknownCoverage, { platforms, productName: "A" });
  assert.equal(market(unknown, "CAFE24_YOUTUBE").display!.revenue.value, null);
});

test("full service dashboard and relationship inputs preserve the filtered native channel boundary", async () => {
  const saved = process.env.UNIFIED_PERFORMANCE_ENABLED; process.env.UNIFIED_PERFORMANCE_ENABLED = "true";
  try {
    const input = productFixture();
    const scopes = platforms.map(platform => ({ platform, scopeKey: request(platform).scopeKeys[0], label: "test" }));
    const snapshot = { scopes, coverage: input.coverage, facts: input.facts, publications: [], availableDateRanges: [], snapshotHash: "native-test",
      products: [{ id: "A", canonicalName: "A", active: true }, { id: "B", canonicalName: "B", active: true }], rules: [], versions: {} } as unknown as ReportSnapshot;
    const repository = { snapshot: async () => snapshot } as unknown as UnifiedReportRepository;
    const service = new UnifiedReportService(repository, {} as UnifiedAggregationRepository);
    const query = { from: DATE, to: DATE, compareFrom: "2026-10-31", compareTo: "2026-10-31", platforms, productName: "A" };
    const response = await service.read("dashboard", query, { id: "test-user", permissions: ["data.read"] }) as { summary: { knownTotals: { revenue: string } }; timeseries: { items: Array<{ knownTotals: { revenue: string } }> } };
    assert.equal(response.summary.knownTotals.revenue, "12545080.000000");
    assert.equal(response.timeseries.items[0].knownTotals.revenue, "12545080.000000");
    const parsed = parseReportQuery(query), settings = parseRelationshipQuery({ ...query, analysisMedia: ["META"] }, parsed);
    const days = relationshipDays(input, parsed, settings, DATE);
    assert.equal(days[0].revenue, "12545080.000000");
  } finally { if (saved === undefined) delete process.env.UNIFIED_PERFORMANCE_ENABLED; else process.env.UNIFIED_PERFORMANCE_ENABLED = saved; }
});
