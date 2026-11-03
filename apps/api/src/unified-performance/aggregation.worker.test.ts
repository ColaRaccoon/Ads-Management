import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { UnifiedAggregationRepository, aggregationRequestId, assertReportConservation, canonicalPartitions, type AggregationClaim } from "./aggregation.repository";
import { UnifiedAggregationWorker, aggregationAdapterRequest, aggregationWorkerDatabaseUrl, assertSourceExecutionSucceeded, completeSourceCoverage } from "./aggregation.worker";
import type { UnifiedManagementRepository } from "./management.repository";
import type { PrismaService } from "../common/prisma.service";
import type { AdapterBatch, AdapterRequest, Platform, SourceAdapter, SourceCoverage } from "./types";
import type { ReportFact } from "./report-contract";
import type { NativeResultGroup, NativeStoredResult } from "./native-result-contract";

const claim = (platform: Platform = "META", scopeKey = "scope"): AggregationClaim => ({ platform, scopeKey, date: "2026-10-26", runId: randomUUID(), token: randomUUID(), previousRunId: null });
const batch = (): AdapterBatch => ({ sales: [], adSpends: [], commonExpenses: [], coverage: [], sourceControlTotals: [], nextCursor: null, sourceFingerprint: "fingerprint" });
const versions = { scopePolicyVersion: "scope-v1", nameRuleVersion: "name-v1", saleUnitRuleVersion: "sale-v1", allocationRuleVersion: "allocation-v1" };
const management = { snapshot: async () => ({ rules: [], versions }) } as unknown as Pick<UnifiedManagementRepository, "snapshot">;
const coverage = (platform: Platform, issues: string[] = []): SourceCoverage => ({
  sourceSystem: platform, platform, component: "SALE", scopeKey: "scope", date: "2026-10-26", participation: "INCLUDED",
  collectionState: "PARTIAL", rowsPresent: 1, zeroConfirmed: false, selectedSource: null, selectedUploadId: null, sourceVersion: null,
  collectedAt: null, sourceAsOf: null, calculatedAt: null, lastSuccessAt: null, sourceFingerprint: null, nameRuleVersion: "name-v1", costRuleVersion: "cost-v1",
  mappedRows: 1, unmappedRows: 0, unmatchedAmount: null, missingCostRows: 0, missingFxAmount: null, unallocatedAmount: null,
  quality: { isEstimate: true, confidence: "ESTIMATED", issues }
});
async function enabled(work: () => Promise<void>) {
  const previous = process.env.UNIFIED_PERFORMANCE_ENABLED;
  process.env.UNIFIED_PERFORMANCE_ENABLED = "true";
  try { await work(); } finally { if (previous === undefined) delete process.env.UNIFIED_PERFORMANCE_ENABLED; else process.env.UNIFIED_PERFORMANCE_ENABLED = previous; }
}
async function nativeRequired(work: () => Promise<void>) {
  const previous = process.env.UNIFIED_NATIVE_RESULTS_WRITE_REQUIRED;
  process.env.UNIFIED_NATIVE_RESULTS_WRITE_REQUIRED = "true";
  try { await enabled(work); }
  finally { if (previous === undefined) delete process.env.UNIFIED_NATIVE_RESULTS_WRITE_REQUIRED; else process.env.UNIFIED_NATIVE_RESULTS_WRITE_REQUIRED = previous; }
}
const nativeSummary = (group: NativeResultGroup, issues: string[] = []): NativeStoredResult => ({
  kind: "SUMMARY", group, productKey: `${group}:SUMMARY`, productName: null, quantity: "1",
  revenue: { known: "100", complete: "100" }, adSpend: { known: "20", complete: "20" },
  netProfit: { known: "30", complete: "30" }, profitBeforeAds: { known: "50", complete: "50" },
  sourceUpdatedAt: "2026-10-26T00:00:00Z", issues
});

test("worker isolates a failed Naver read, publishes both sibling sources and persists only a safe failure code", async () => enabled(async () => {
  const jobs = [claim("NAVER"), claim("META"), claim("CAFE24")], failed: string[] = [], published: string[] = [];
  const repo = { claim: async () => jobs.shift() ?? null, heartbeat: async () => true,
    stageAndPublish: async (job: AggregationClaim) => { published.push(job.platform); },
    fail: async (_job: AggregationClaim, issue: string) => { failed.push(issue); return true; } };
  const adapters = Object.fromEntries((["META", "GOOGLE", "NAVER", "COUPANG", "CAFE24"] as Platform[]).map(platform => [platform,
    { platform, read: async () => { if (platform === "NAVER") throw new Error("private-database-url-and-order-name"); return batch(); } }])) as unknown as Record<Platform, SourceAdapter>;
  const outcomes = await new UnifiedAggregationWorker(repo, management, adapters, () => []).runPending(3);
  assert.deepEqual(outcomes.map(row => row.status), ["FAILED", "PUBLISHED", "PUBLISHED"]);
  assert.deepEqual(published, ["META", "CAFE24"]); assert.deepEqual(failed, ["SOURCE_EXECUTION_FAILED"]);
  assert(!JSON.stringify(outcomes).includes("private"));
}));

test("a reclaimed lease fences a completed old source read before it can publish", async () => enabled(async () => {
  const job = claim(); let publishCalls = 0, failCalls = 0;
  const repo = { claim: async () => job, heartbeat: async () => false, stageAndPublish: async () => { publishCalls++; }, fail: async () => { failCalls++; return false; } };
  const adapters = { META: { platform: "META", read: async () => batch() } } as unknown as Record<Platform, SourceAdapter>;
  const outcome = await new UnifiedAggregationWorker(repo, management, adapters, () => []).runOne();
  assert.equal(outcome?.status, "LEASE_LOST"); assert.equal(publishCalls, 0); assert.equal(failCalls, 0);
}));

test("execution failure markers retain prior revisions while estimate and collection uncertainty remain usable", () => {
  for (const issue of ["NAVER_PRODUCTS_READ_FAILED", "COUPANG_SALES_NORMALIZATION_FAILED", "SOURCE_SELECTION_REQUIRED", "GOOGLE_CURRENT_LINEAGE_UNVERIFIED", "COUPANG_CURRENT_ADS_WITHHELD"]) {
    const input = batch(); input.coverage = [coverage("NAVER", [issue])]; assert.throws(() => assertSourceExecutionSucceeded(input), /SOURCE_EXECUTION_FAILED/);
  }
  const input = batch(); input.coverage = [coverage("NAVER", ["NAVER_PAYMENT_DATE_COMPLETION_UNPROVEN", "STALE", "ESTIMATED"])];
  assert.doesNotThrow(() => assertSourceExecutionSucceeded(input));
});

test("native Coupang read failure prevents publication and retains the previous published revision", async () => enabled(async () => {
  const job = { ...claim("COUPANG"), previousRunId: randomUUID() };
  let publishedRunId: string = job.previousRunId;
  let publishCalls = 0;
  const failed: string[] = [];
  const input = batch(), unavailable = { known: null, complete: null };
  input.nativeResults = [{ kind: "SUMMARY", group: "COUPANG", productKey: "COUPANG:SUMMARY", productName: null,
    quantity: null, revenue: unavailable, adSpend: unavailable, netProfit: unavailable, profitBeforeAds: unavailable,
    sourceUpdatedAt: null, issues: ["COUPANG_NATIVE_READ_FAILED"] }];
  assert.throws(() => assertSourceExecutionSucceeded(input), /SOURCE_EXECUTION_FAILED/);
  const repo = { claim: async () => job, heartbeat: async () => true,
    stageAndPublish: async () => { publishCalls++; publishedRunId = job.runId; },
    fail: async (_job: AggregationClaim, issue: string) => { failed.push(issue); return true; } };
  const adapters = { COUPANG: { platform: "COUPANG", read: async () => input } } as unknown as Record<Platform, SourceAdapter>;
  assert.equal((await new UnifiedAggregationWorker(repo, management, adapters).runOne())?.status, "FAILED");
  assert.equal(publishCalls, 0); assert.equal(publishedRunId, job.previousRunId);
  assert.deepEqual(failed, ["SOURCE_EXECUTION_FAILED"]);
}));

test("required native summaries publish independently of legacy audit read and normalization failures", async () => nativeRequired(async () => {
  for (const [platform, groups] of [["COUPANG", ["COUPANG"]], ["NAVER", ["NAVER"]], ["CAFE24", ["STOREFRONT", "GOOGLE"]]] as const) {
    const input = batch();
    input.coverage = [coverage(platform, [`${platform}_SALES_READ_FAILED`, `${platform}_SALES_NORMALIZATION_FAILED`])];
    input.nativeResults = groups.map(group => nativeSummary(group));
    assert.doesNotThrow(() => assertSourceExecutionSucceeded(input));
    const job = claim(platform), published: AdapterBatch[] = [];
    let failCalls = 0;
    const repo = { claim: async () => job, heartbeat: async () => true,
      stageAndPublish: async (_job: AggregationClaim, _request: AdapterRequest, result: AdapterBatch) => { published.push(result); },
      fail: async () => { failCalls++; return true; } };
    const adapters = { [platform]: { platform, read: async () => input } } as unknown as Record<Platform, SourceAdapter>;
    assert.equal((await new UnifiedAggregationWorker(repo, management, adapters).runOne())?.status, "PUBLISHED");
    assert.equal(failCalls, 0); assert.equal(published.length, 1);
    assert.deepEqual(published[0].nativeResults, input.nativeResults);
    assert.ok(published[0].coverage[0].quality.issues.includes(`${platform}_SALES_READ_FAILED`), "audit evidence remains stored");
  }
}));

test("required native source-selection and execution failures retain the previous publication", async () => nativeRequired(async () => {
  for (const issue of ["SOURCE_SELECTION_REQUIRED", "COUPANG_NATIVE_READ_FAILED", "COUPANG_NATIVE_NORMALIZATION_FAILED"]) {
    const job = { ...claim("COUPANG"), previousRunId: randomUUID() };
    const input = batch(); input.coverage = [coverage("COUPANG")]; input.nativeResults = [nativeSummary("COUPANG", [issue])];
    assert.throws(() => assertSourceExecutionSucceeded(input), /SOURCE_EXECUTION_FAILED/);
    let pointer: string = job.previousRunId, publishCalls = 0;
    const failures: string[] = [];
    const repo = { claim: async () => job, heartbeat: async () => true,
      stageAndPublish: async () => { publishCalls++; pointer = job.runId; },
      fail: async (_job: AggregationClaim, reason: string) => { failures.push(reason); return true; } };
    const adapters = { COUPANG: { platform: "COUPANG", read: async () => input } } as unknown as Record<Platform, SourceAdapter>;
    assert.equal((await new UnifiedAggregationWorker(repo, management, adapters).runOne())?.status, "FAILED");
    assert.equal(publishCalls, 0); assert.equal(pointer, job.previousRunId); assert.deepEqual(failures, ["SOURCE_EXECUTION_FAILED"]);
  }
}));

test("required native publication rejects absent summaries including either missing storefront group", async () => nativeRequired(async () => {
  const cases: Array<{ platform: Platform; nativeResults?: NativeStoredResult[] }> = [
    { platform: "COUPANG" }, { platform: "NAVER", nativeResults: [] },
    { platform: "COUPANG", nativeResults: [{ ...nativeSummary("COUPANG"), kind: "PRODUCT", productName: "product" }] },
    { platform: "CAFE24", nativeResults: [nativeSummary("STOREFRONT")] },
    { platform: "CAFE24", nativeResults: [nativeSummary("GOOGLE")] }
  ];
  for (const fixture of cases) {
    const input = { ...batch(), nativeResults: fixture.nativeResults, coverage: [coverage(fixture.platform)] };
    assert.throws(() => assertSourceExecutionSucceeded(input), /NATIVE_FINAL_SOURCE_RESULT_REQUIRED/);
    const job = { ...claim(fixture.platform), previousRunId: randomUUID() };
    let pointer: string = job.previousRunId, publishCalls = 0;
    const repo = { claim: async () => job, heartbeat: async () => true,
      stageAndPublish: async () => { publishCalls++; pointer = job.runId; }, fail: async () => true };
    const adapters = { [fixture.platform]: { platform: fixture.platform, read: async () => input } } as unknown as Record<Platform, SourceAdapter>;
    assert.equal((await new UnifiedAggregationWorker(repo, management, adapters).runOne())?.status, "FAILED");
    assert.equal(publishCalls, 0); assert.equal(pointer, job.previousRunId);
  }
}));

test("required native mode still rejects failed standalone advertising source reads", async () => nativeRequired(async () => {
  for (const platform of ["META", "GOOGLE"] as const) {
    const input = batch(); input.coverage = [{ ...coverage(platform, [`${platform}_ADS_READ_FAILED`]), component: "AD_SPEND" }];
    assert.throws(() => assertSourceExecutionSucceeded(input), /SOURCE_EXECUTION_FAILED/);
  }
}));

test("direct-ledger platforms mark absent separate common costs N/A without masking actual common facts or Naver gaps", () => {
  for (const platform of ["CAFE24", "COUPANG"] as const) {
    const input = batch(); input.coverage = [coverage(platform)];
    const result = completeSourceCoverage(claim(platform), input);
    assert.equal(result.coverage.at(-1)?.component, "COMMON_EXPENSE"); assert.equal(result.coverage.at(-1)?.participation, "NOT_APPLICABLE");
    assert.equal(input.coverage.length, 1);
    const hasCommon = { ...input, commonExpenses: [{}] } as AdapterBatch;
    assert.equal(completeSourceCoverage(claim(platform), hasCommon), hasCommon);
  }
  const naver = batch(); assert.equal(completeSourceCoverage(claim("NAVER"), naver), naver);
});

test("Naver materializes its adapter's SALE cost evidence without inventing complete zero cost coverage", () => {
  const input = batch(); input.coverage = [{ ...coverage("NAVER"), collectionState: "COMPLETE", missingCostRows: 2,
    quality: { isEstimate: true, confidence: "ESTIMATED", issues: ["PRODUCT_COST_MISSING"] } }];
  const result = completeSourceCoverage(claim("NAVER"), input);
  assert.equal(result.coverage.length, 2);
  const direct = result.coverage.find(row => row.component === "DIRECT_COST")!;
  assert.equal(direct.rowsPresent, 1); assert.equal(direct.missingCostRows, 2); assert.equal(direct.zeroConfirmed, false);
  assert.equal(direct.collectionState, "PARTIAL"); assert.deepEqual(direct.quality.issues, ["PRODUCT_COST_MISSING"]);
  assert.equal(input.coverage.length, 1);
  assert.equal(completeSourceCoverage(claim("NAVER"), result), result);
});

test("worker requires its dedicated restricted-role URL and never falls back to the web connection", () => {
  assert.throws(() => aggregationWorkerDatabaseUrl({ DATABASE_URL: "postgresql://web@localhost/app" }), /URL_REQUIRED/);
  assert.throws(() => aggregationWorkerDatabaseUrl({ DATABASE_URL: "postgresql://web@localhost/app", UNIFIED_AGGREGATION_DATABASE_URL: "postgresql://web@localhost/app" }), /DISTINCT_ROLE/);
  assert.throws(() => aggregationWorkerDatabaseUrl({ UNIFIED_AGGREGATION_DATABASE_URL: "https://writer@localhost/app" }), /URL_INVALID/);
  assert.equal(aggregationWorkerDatabaseUrl({ DATABASE_URL: "postgresql://web@localhost/app", UNIFIED_AGGREGATION_DATABASE_URL: "postgresql://writer@localhost/app" }), "postgresql://writer@localhost/app");
});

test("reconciliation requests read a full single day and pin rules without an updated_at filter", () => {
  const job = claim("GOOGLE"); const request = aggregationAdapterRequest(job, versions);
  assert.equal(request.from, job.date); assert.equal(request.to, job.date); assert.deepEqual(request.platforms, ["GOOGLE"]);
  assert.deepEqual(request.sourceWatermarks, {}); assert.equal(request.nameRuleVersion, versions.nameRuleVersion);
  assert.notEqual(aggregationAdapterRequest(job, versions).readSnapshotId, request.readSnapshotId);
  assert.equal(aggregationRequestId("actor", "client-key"), aggregationRequestId("actor", "client-key"));
  assert.notEqual(aggregationRequestId("actor", "client-key"), aggregationRequestId("other-actor", "client-key"));
  assert.throws(() => canonicalPartitions([{ platform: "META", scopeKey: "scope", date: "2026-02-30" }]), /date/i);
});

test("busy early partitions do not starve an independent source after the first candidate page", async () => {
  const blocked = Array.from({ length: 50 }, (_, index) => ({ id: `blocked-${index}`, platform: "META", scopeKey: "busy-scope", businessDate: new Date("2026-10-26"), status: "STAGING", leaseExpiresAt: null, checkpoint: {} }));
  const free = { ...blocked[0], id: randomUUID(), platform: "GOOGLE", scopeKey: "free-scope" };
  let pages = 0;
  const prisma = { unifiedAggregationRun: { findMany: async ({ cursor }: { cursor?: { id: string } }) => { pages++; return cursor ? [free] : blocked; } },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $queryRaw: async () => [{ acquired: true }],
      unifiedAggregationRun: { findFirst: async ({ where }: { where: { scopeKey: string } }) => where.scopeKey === "busy-scope" ? { id: "active-sibling" } : null,
        findUnique: async () => free, updateMany: async () => ({ count: 1 }) }, unifiedSourcePublication: { findUnique: async () => null } })
  } as unknown as PrismaService;
  const selected = await new UnifiedAggregationRepository(prisma).claim();
  assert.equal(selected?.platform, "GOOGLE"); assert.equal(selected?.runId, free.id); assert.equal(pages, 2);
});

test("publication rejects lost allocation residuals, missing known profit and fabricated unknown amounts", () => {
  const source = { ...batch(), sales: [{ operatingRevenue: "100", profitBeforeAds: "60" }, { operatingRevenue: null, profitBeforeAds: null }] } as AdapterBatch;
  const report = [{ component: "SALE", amountKrw: "100", profitBeforeAds: "60" }] as ReportFact[];
  assert.doesNotThrow(() => assertReportConservation(source, report));
  assert.throws(() => assertReportConservation(source, [{ ...report[0], amountKrw: "99.999999" }]), /CONSERVATION_FAILED/);
  assert.throws(() => assertReportConservation(source, [{ ...report[0], profitBeforeAds: null }]), /CONSERVATION_FAILED/);
  const unknown = { ...batch(), sales: [{ operatingRevenue: null, profitBeforeAds: null }] } as AdapterBatch;
  assert.throws(() => assertReportConservation(unknown, [{ ...report[0], amountKrw: "0", profitBeforeAds: null }]), /CONSERVATION_FAILED/);
});

test("worker pins explicit participation including empty date matches until a new rebuild publishes a new snapshot", async () => enabled(async () => {
  const policy = { productId: "configured", kind: "SCOPE_POLICY", active: true, platform: "META", scopeKey: "scope",
    validFrom: new Date("2026-10-27"), validTo: null, payload: { components: ["AD_SPEND"] } };
  const snapshot = { products: [{ id: "configured", canonicalName: "A" }, { id: "default", canonicalName: "B" }], rules: [policy], versions };
  const published: AdapterRequest[] = [];
  const repo = { claim: async () => claim(), heartbeat: async () => true,
    stageAndPublish: async (_claim: AggregationClaim, request: AdapterRequest) => { published.push(request); }, fail: async () => true };
  const adapters = { META: { platform: "META", read: async () => batch() } } as unknown as Record<Platform, SourceAdapter>;
  const worker = new UnifiedAggregationWorker(repo, { snapshot: async () => snapshot } as unknown as Pick<UnifiedManagementRepository, "snapshot">, adapters, () => []);
  assert.equal((await worker.runOne())?.status, "PUBLISHED");
  assert.deepEqual(published[0].sourcePolicySnapshot.participationOverrides, { A: [] });
  policy.validFrom = new Date("2026-10-01");
  assert.deepEqual(published[0].sourcePolicySnapshot.participationOverrides, { A: [] });
  assert.equal((await worker.runOne())?.status, "PUBLISHED");
  assert.deepEqual(published[1].sourcePolicySnapshot.participationOverrides, { A: ["AD_SPEND"] });
  policy.active = false;
  assert.equal((await worker.runOne())?.status, "PUBLISHED");
  assert.deepEqual(published[2].sourcePolicySnapshot.participationOverrides, {});
  assert.deepEqual(published[1].sourcePolicySnapshot.participationOverrides, { A: ["AD_SPEND"] });
}));
