import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Prisma, type GooglePerformanceMapping } from "@prisma/client";
import { googleKeywordIdentity } from "../../google/google-campaign-matcher";
import { CONTRACT_VERSION, type AdapterRequest } from "../types";
import { UnifiedManagementRepository } from "../management.repository";
import { readAdDay } from "./ad-reader";
import { normalizeAdDay, type AdDayInput, type AdRow } from "./ad-source";

const oldFeature = process.env.DAILY_SYNC_FEATURE_ENABLED;
process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
after(() => { if (oldFeature === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = oldFeature; });
const scope = "10000000-0000-4000-8000-000000000001";
const versions = { scopePolicyVersion: "s", nameRuleVersion: "n", saleUnitRuleVersion: "u", allocationRuleVersion: "a", configurationVersion: "v" };
const request = (date = "2026-11-01"): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: "run", readSnapshotId: "snapshot",
  from: date, to: date, scopeKeys: [scope], platforms: ["GOOGLE"], ...versions, calculationVersion: "c", fxVersion: "f",
  sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 });
const product = (id: string, name: string, displayName = name) => ({ id, name, displayName, isActive: true });
const keyword = (word: string, productId: string, start = "2026-11-01", end: string | null = "2026-11-02", connectionId = scope) => ({
  id: word, kind: "CAMPAIGN", connectionId, campaignId: word, identityKey: googleKeywordIdentity(word), productId,
  startDate: new Date(start), endDate: end ? new Date(end) : null
}) as GooglePerformanceMapping;
function fixture(names: string[], products = [product("p", "풀업바", "풀 업 바")], mappings: GooglePerformanceMapping[] = [], catalog = ["풀 업 바"], date = "2026-11-01") {
  const at = new Date(date), reads: Record<string, unknown> = {};
  const tx = {
    sourceConnection: { findUnique: async () => ({ provider: "GOOGLE", currencyCode: "USD", timeZone: "Asia/Seoul" }) },
    sourcePolicy: { findMany: async () => [] }, sourceCoverage: { findMany: async () => [] },
    exchangeRate: { findMany: async () => [{ rate: new Prisma.Decimal("1324.3"), sourceDate: at, provider: "KOREA_EXIM", fallbackType: "EXACT" }] },
    product: { findMany: async (args: unknown) => { reads.products = args; return products; } },
    googlePerformanceMapping: { findMany: async (args: unknown) => { reads.mappings = args; return mappings; } },
    googleCampaignDailyCost: { findMany: async () => names.map((campaignName, i) => ({ id: `row${i}`, campaignId: `campaign${i}`,
      campaignName, connectionId: scope, metricDate: at, source: "CSV", version: 1, syncRunId: null,
      costMicros: BigInt(1000001 + i), conversionValue: null, fetchedAt: at })) }
  } as unknown as Prisma.TransactionClient;
  const management = { snapshot: async () => ({ products: catalog.map(canonicalName => ({ canonicalName, active: true })),
    rules: [], versions }) } as unknown as UnifiedManagementRepository;
  return { reads, run: () => readAdDay(tx, management, request(date), "GOOGLE") };
}

test("Google native campaign full-name matching retains campaign evidence and exact converted totals", async () => {
  const f = fixture(["브랜드 풀업바 광고", "풀 업 바 리타겟", "관계없는 캠페인"]);
  const batch = await f.run();
  assert.deepEqual(batch.adSpends.map(row => row.productName), ["풀 업 바", "풀 업 바", null]);
  assert.equal(batch.adSpends[0].name.originalName, "브랜드 풀업바 광고");
  assert.equal(batch.adSpends[0].name.normalizedName, "브랜드 풀업바 광고");
  assert.equal(batch.adSpends[0].name.restorationPath, "GOOGLE_NATIVE_CAMPAIGN_MATCHER");
  assert.ok(batch.adSpends[0].quality.issues.includes("GOOGLE_NATIVE_CAMPAIGN_MATCHER"));
  const control = batch.sourceControlTotals.find(row => row.currency === "KRW")!;
  assert.equal(control.selectedAmount, "3972.907946");
  assert.equal(control.difference, "0.000000");
  assert.equal(new Prisma.Decimal(control.assignedAmount!).plus(control.unmatchedAmount!).toFixed(6), control.selectedAmount);
  assert.deepEqual(f.reads.products, { where: { isActive: true }, select: { id: true, name: true, displayName: true, isActive: true }, take: 10001 });
  assert.deepEqual(f.reads.mappings, { where: { kind: "CAMPAIGN", connectionId: scope, startDate: { lte: new Date("2026-11-01") },
    OR: [{ endDate: null }, { endDate: { gte: new Date("2026-11-01") } }] }, take: 10001 });
});

test("Google native campaign keyword mapping honors inclusive dates and exact scope; legacy campaign IDs are not keywords", async () => {
  const mapping = keyword("특별키워드", "p");
  for (const date of ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]) {
    const batch = await fixture(["특별키워드 캠페인"], undefined, [mapping], undefined, date).run();
    assert.equal(batch.adSpends[0].productName, date === "2026-11-01" || date === "2026-11-02" ? "풀 업 바" : null);
  }
  for (const invalid of [{ ...mapping, connectionId: "other" }, { ...mapping, identityKey: "legacy-id" }]) {
    assert.equal((await fixture(["특별키워드"], undefined, [invalid]).run()).adSpends[0].productName, null);
  }
});

test("Google alias and ambiguous campaign use the same native matcher without arbitrary assignment", async () => {
  const products = [product("venom", "베놈무릎보호대"), product("p", "풀업바")];
  const batch = await fixture(["신규 베놈 캠페인", "풀업바 베놈", "베놈업체광고"], products, [], products.map(p => p.displayName)).run();
  assert.deepEqual(batch.adSpends.map(row => row.productName), ["베놈무릎보호대", null, null]);
  assert.equal(batch.adSpends[1].name.matchStatus, "AMBIGUOUS");
  assert.ok(batch.adSpends[1].quality.issues.includes("AMBIGUOUS_CAMPAIGN_PRODUCT"));
});

const row = (nativeProductName: string | null): AdRow => ({ id: "r", entityKey: "r", originalName: "통합규칙상품", nativeProductName,
  nativeNameIssues: [], source: "API", sourceVersion: "1", runOrUploadId: "run", observedAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z", amount: "9007199254740993", conversionRevenue: null });
const input = (rows: AdRow[]): AdDayInput => ({ platform: "GOOGLE", date: "2026-11-01", scopeKey: scope, currency: "KRW", timeZone: "Asia/Seoul",
  rows, selectedSource: "API", complete: true, sourceIssues: [], storedCoverage: null, fx: null, excludedRows: 0,
  configuration: { products: [{ canonicalName: "통합규칙상품" }], nameRules: [] } });
test("Native null is authoritative while absent native metadata preserves legacy normalization and Meta behavior", () => {
  const nativeNull = normalizeAdDay(request(), input([row(null)]));
  assert.equal(nativeNull.adSpends[0].productName, null);
  const legacy = row(null); delete legacy.nativeProductName;
  assert.equal(normalizeAdDay(request(), input([legacy])).adSpends[0].productName, "통합규칙상품");
  const metaRequest = { ...request(), platforms: ["META" as const] };
  const metaInput = { ...input([{ ...row(null), amount: "1" }]), platform: "META" as const, currency: "USD", fx: { rate: "1324.3", sourceDate: "2026-11-01", provider: "KOREA_EXIM", fallbackType: "EXACT" } };
  assert.equal(normalizeAdDay(metaRequest, metaInput).adSpends[0].productName, "통합규칙상품");
  assert.equal(nativeNull.adSpends[0].amountKrw, "9007199254.740993");
});

test("Native canonical spelling maps by exact normalization, unknown native name survives, collisions stay unallocated", () => {
  const known = input([row("Native Product")]);
  known.configuration.products = [{ canonicalName: "native product" }];
  assert.equal(normalizeAdDay(request(), known).adSpends[0].productName, "native product");
  assert.equal(normalizeAdDay(request(), input([row("네이티브 전용 상품")])).adSpends[0].productName, "네이티브 전용 상품");
  known.configuration.products = [{ canonicalName: "native product" }, { canonicalName: "NATIVE PRODUCT" }];
  const ambiguous = normalizeAdDay(request(), known).adSpends[0];
  assert.equal(ambiguous.productName, null); assert.equal(ambiguous.name.matchStatus, "AMBIGUOUS");
});

test("Fingerprint tracks native name/mapping dependencies, is order stable and never changes original money", async () => {
  const products = [product("p", "풀업바"), product("q", "다른상품")];
  const maps = [keyword("특별", "p"), keyword("추가", "q")];
  const first = await fixture(["풀업바"], products, maps).run();
  const reordered = await fixture(["풀업바"], [...products].reverse(), [...maps].reverse()).run();
  assert.equal(first.sourceFingerprint, reordered.sourceFingerprint);
  const changed = await fixture(["풀업바"], products, [{ ...maps[0], endDate: new Date("2026-11-03") }, maps[1]]).run();
  assert.notEqual(first.sourceFingerprint, changed.sourceFingerprint);
  const reassigned = await fixture(["풀업바"], [product("p", "새상품")], []).run();
  assert.notEqual(first.sourceFingerprint, reassigned.sourceFingerprint);
  assert.deepEqual(first.sourceControlTotals.map(c => c.selectedAmount), reassigned.sourceControlTotals.map(c => c.selectedAmount));
});
