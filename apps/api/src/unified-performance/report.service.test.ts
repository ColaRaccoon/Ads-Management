import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { randomUUID } from "node:crypto";
import { REQUIRED_PERMISSIONS } from "../auth/route-decorators";
import { UnifiedReportController } from "./report.controller";
import { ReportQueryDto, RebuildInputDto } from "./report.dto";
import { parseReportQuery, reportBuckets, datesIn } from "./report-query";
import { missingCoverage, selectReportScopes, type ReportSnapshot, UnifiedReportRepository } from "./report.repository";
import type { UnifiedManagementRepository } from "./management.repository";
import { UnifiedReportService } from "./report.service";
import type { UnifiedAggregationRepository } from "./aggregation.repository";
import type { PublishedReportFact } from "./report-contract";
import { CONTRACT_VERSION } from "./types";

const actor = { id: randomUUID(), permissions: ["data.read" as const, "operations.run" as const] };
const readActor = { ...actor, permissions: ["data.read" as const] };
const query = { from: "2026-10-26", to: "2026-10-26", compareFrom: "2026-10-25", compareTo: "2026-10-25", platforms: ["META", "CAFE24"] };
async function enabled(work: () => Promise<void>) {
  const saved = process.env.UNIFIED_PERFORMANCE_ENABLED; process.env.UNIFIED_PERFORMANCE_ENABLED = "true";
  try { await work(); } finally { if (saved === undefined) delete process.env.UNIFIED_PERFORMANCE_ENABLED; else process.env.UNIFIED_PERFORMANCE_ENABLED = saved; }
}
function fixture() {
  const scopes = [{ platform: "CAFE24" as const, scopeKey: "sale", label: "판매" }, { platform: "META" as const, scopeKey: "ads", label: "광고" }];
  const coverage = ["2026-10-25", "2026-10-26"].flatMap(day => scopes.flatMap(scope => missingCoverage(scope, day).map(c => ({ ...c,
    collectionState: "COMPLETE" as const, rowsPresent: 1, mappedRows: 1, lastSuccessAt: "2026-10-27T00:00:00Z", quality: { ...c.quality, issues: [] } }))));
  const facts: PublishedReportFact[] = ["2026-10-25", "2026-10-26"].flatMap(date => ["A", "B"].flatMap(productName => scopes.map(scope => ({
    ...scope, date, productName, component: scope.platform === "CAFE24" ? "SALE" as const : "AD_SPEND" as const,
    factKey: productName, saleUnitName: scope.platform === "CAFE24" ? "단품" : null,
    amountKrw: scope.platform === "CAFE24" ? "100.000000" : "10.000000", completeAmountKrw: scope.platform === "CAFE24" ? "100.000000" : "10.000000",
    profitBeforeAds: scope.platform === "CAFE24" ? "70.000000" : null, completeProfitBeforeAds: scope.platform === "CAFE24" ? "70.000000" : null,
    originalAmount: null, currency: "KRW", quantity: null, attribution: "DIRECT" as const,
    medium: scope.platform === "META" ? "META" : null, marketplace: scope.platform === "CAFE24" ? "CAFE24" : null,
    commonKind: null, rowsCount: 1, quality: { isEstimate: false, confidence: "SOURCE_REPORTED" as const, issues: [] }
  }))));
  const snapshot = { scopes, coverage, facts, publications: [], availableDateRanges: [], snapshotHash: "snapshot-one",
    products: ["A", "B"].map(canonicalName => ({ id: canonicalName, canonicalName, active: true })), rules: [], versions: {} } as unknown as ReportSnapshot;
  const captured: Record<string, unknown>[] = [], enqueued: unknown[] = [];
  const repository = { snapshot: async (value: Record<string, unknown>) => { captured.push(value); return snapshot; },
    access: async (platforms: string[], keys?: string[]) => selectReportScopes(scopes.filter(s => platforms.includes(s.platform)), keys) } as unknown as UnifiedReportRepository;
  const aggregation = { enqueue: async (...args: unknown[]) => { enqueued.push(args); return { jobs: [{ jobId: "queued" }] }; }, readJobs: async () => [] } as unknown as UnifiedAggregationRepository;
  return { service: new UnifiedReportService(repository, aggregation), snapshot, captured, enqueued };
}
test("queries normalize platform order, preserve explicit empty scope and bound both date ranges", () => {
  const a = parseReportQuery({ ...query, platforms: '["CAFE24","META","META"]', scopeKeys: "[]" });
  const b = parseReportQuery({ ...query, platforms: ["META", "CAFE24"], scopeKeys: [] });
  assert.equal(a.selectionHash, b.selectionHash); assert.deepEqual(a.scopeKeys, []);
  assert.deepEqual(parseReportQuery({ ...query, platforms: "[]" }).platforms, []);
  assert.equal(parseReportQuery({}, new Date("2026-10-27T16:00:00Z")).to, "2026-10-27");
  for (const input of [{ ...query, platforms: '["INVALID"]' }, { ...query, from: "2026-02-30" }, { ...query, from: "2025-01-01", to: "2026-10-26" },
    { ...query, compareTo: undefined }, { ...query, scopeKeys: "bad" }, { ...query, limit: 101 }]) assert.throws(() => parseReportQuery(input));
  assert.equal(datesIn("2024-02-28", "2024-03-01").length, 3);
});
test("week/month buckets use inclusive partial boundaries", () => {
  const week = reportBuckets("2026-10-27", "2026-11-03", "week");
  assert.deepEqual(week.map(b => [b.bucketFrom, b.bucketTo, b.partial]), [["2026-10-27", "2026-11-01", true], ["2026-11-02", "2026-11-03", true]]);
  const month = reportBuckets("2026-10-31", "2026-11-01", "month"); assert.equal(month.length, 2); assert(month.every(b => b.partial));
});
test("all HTTP routes have read/operation permissions and strict DTO validation", () => {
  for (const method of ["options", "summary", "timeseries", "diagnostics"] as const)
    assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, UnifiedReportController.prototype[method]), ["data.read"]);
  for (const method of ["rebuild", "job"] as const)
    assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, UnifiedReportController.prototype[method]), ["operations.run"]);
  assert.equal(validateSync(plainToInstance(ReportQueryDto, { ...query, platforms: '["META"]' })).length, 0);
  assert(validateSync(plainToInstance(ReportQueryDto, { from: "2026-02-30", limit: "101" })).length > 0);
  assert(validateSync(plainToInstance(RebuildInputDto, { ...query, reason: "x", expectedContractVersion: CONTRACT_VERSION, platforms: [123] })).length > 0);
});
test("service blocks unauthorized reads/rebuild before touching repository", async () => enabled(async () => {
  const f = fixture();
  await assert.rejects(f.service.read("summary", query, { ...actor, permissions: [] }), /실행 권한/);
  await assert.rejects(f.service.rebuild({ ...query, reason: "test", expectedContractVersion: CONTRACT_VERSION }, readActor), /실행 권한/);
  assert.equal(f.captured.length, 0); assert.equal(f.enqueued.length, 0);
}));
test("summary and comparisons use independent sales/ads sums and stable paginated scope", async () => enabled(async () => {
  const f = fixture();
  const first = await f.service.read("summary", { ...query, limit: 1 }, actor) as any;
  assert.equal(first.knownTotals.revenue, "200.000000"); assert.equal(first.knownTotals.adSpend, "20.000000");
  assert.equal(first.knownTotals.estimatedProfit, "120.000000"); assert.equal(first.comparison.known.revenue.change, "0.000000");
  assert.equal(first.items.length, 1); assert.equal(first.total, 2); assert(first.nextCursor);
  const second = await f.service.read("summary", { ...query, limit: 1, cursor: first.nextCursor }, actor) as any;
  assert.equal(second.items[0].productName, "B");
  f.snapshot.snapshotHash = "changed";
  await assert.rejects(f.service.read("summary", { ...query, cursor: first.nextCursor }, actor), /발행 버전/);
  assert.deepEqual(f.captured[0].platforms, ["META", "CAFE24"]);
}));
test("read paths have no queue side effect, return empty selection and equal bucket totals", async () => enabled(async () => {
  const f = fixture();
  const empty = await f.service.read("summary", { ...query, platforms: [] }, actor) as any;
  assert.equal(empty.knownTotals.revenue, null); assert.equal(empty.metricAvailability.state, "EMPTY_SELECTION");
  for (const kind of ["options", "timeseries", "diagnostics"] as const) {
    const output = await f.service.read(kind, query, actor) as any;
    assert.equal(output.knownTotals.estimatedProfit, "120.000000");
    if (kind === "timeseries") assert.equal(output.items[0].knownTotals.revenue, output.knownTotals.revenue);
  }
  assert.equal(f.enqueued.length, 0);
}));
test("rebuild queues bounded complete day partitions, preserving product hints without breaking allocation", async () => enabled(async () => {
  const f = fixture(), input = { from: query.from, to: query.to, platforms: ["META"], scopeKeys: ["ads"], reason: "과거 원가 변경", expectedContractVersion: CONTRACT_VERSION };
  const response = await f.service.rebuild(input, actor);
  assert.equal(response.status, "QUEUED"); assert.equal(response.execution, "ASYNC_WORKER");
  assert.deepEqual((f.enqueued[0] as unknown[])[0], [{ platform: "META", scopeKey: "ads", date: query.from }]);
  const productJob = await f.service.rebuild({ ...input, productNames: ["A"] }, actor);
  assert.equal(productJob.executionScope, "FULL_SOURCE_DAY"); assert.deepEqual(productJob.requestedProductNames, ["A"]);
  for (const override of [{ from: "2026-01-01", to: "2026-04-03" }, { platforms: [] }, { productNames: [123] }, { expectedContractVersion: "old" }, { reason: " " }])
    await assert.rejects(f.service.rebuild({ ...input, ...override }, actor));
  assert.equal(f.enqueued.length, 2);
}));
test("explicit product scope policy makes unselected applicability N/A without suppressing valid sale profit", async () => enabled(async () => {
  const f = fixture();
  f.snapshot.rules.push({ id: randomUUID(), productId: "A", kind: "SCOPE_POLICY", platform: "CAFE24", scopeKey: "sale", active: true,
    validFrom: new Date("2026-01-01"), validTo: null, payload: { components: ["SALE", "DIRECT_COST"] } } as any);
  const result = await f.service.read("summary", { ...query, productName: "A" }, actor) as any;
  assert.equal(result.metricAvailability.state, "SALE_ONLY"); assert.equal(result.completeTotals.estimatedProfit, "70.000000");
  assert.equal(result.knownTotals.adSpend, null);
}));
test("catalog renames retain published historical product rows until an explicit rebuild replaces them", async () => enabled(async () => {
  const f = fixture(); f.snapshot.products[0].canonicalName = "A 새이름";
  const report = await f.service.read("summary", query, actor) as any;
  assert.equal(report.items.find((row: any) => row.productName === "A").knownTotals.revenue, "100.000000");
  assert.equal(report.knownTotals.revenue, "200.000000");
  const options = await f.service.read("options", query, actor) as any;
  assert.equal(options.products.find((row: any) => row.productName === "A").historical, true);
}));

test("long timeseries pages preserve every day, scope totals and cursor invalidation", async () => enabled(async () => {
  const f = fixture(), input = { ...query, from: "2025-10-26", productName: "A", limit: 100 };
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const result = await f.service.read("timeseries", { ...input, cursor }, actor) as any;
    assert.equal(result.total, 366);
    assert.equal(result.knownTotals.revenue, "200.000000");
    rows.push(...result.items);
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(rows.map(row => row.date), datesIn(input.from, input.to));
  assert.equal(rows.find(row => row.date === "2026-10-25").knownTotals.revenue, "100.000000");
  assert.equal(rows.find(row => row.date === "2026-10-26").knownTotals.estimatedProfit, "60.000000");
  const first = await f.service.read("timeseries", input, actor) as any;
  f.snapshot.snapshotHash = "new-publication";
  await assert.rejects(f.service.read("timeseries", { ...input, cursor: first.nextCursor }, actor), /발행 버전/);
  assert.equal(f.enqueued.length, 0);
}));

test("request participation reuse preserves date policy bounds and refreshes after settings change", async () => enabled(async () => {
  const f = fixture();
  f.snapshot.rules.push({ id: randomUUID(), productId: "A", kind: "SCOPE_POLICY", platform: "CAFE24", scopeKey: "sale", active: true,
    validFrom: new Date("2026-10-26"), validTo: null, payload: { components: ["SALE", "DIRECT_COST"] } } as any);
  const input = { ...query, from: "2026-10-25", productName: "A" };
  const output = await f.service.read("timeseries", input, actor) as any;
  assert.equal(output.knownTotals.revenue, "100.000000");
  assert.equal(output.items[0].knownTotals.revenue, null);
  assert.equal(output.items[1].knownTotals.revenue, "100.000000");
  f.snapshot.rules = [];
  const refreshed = await f.service.read("timeseries", input, actor) as any;
  assert.equal(refreshed.knownTotals.revenue, "200.000000");
  assert.equal(refreshed.items[0].knownTotals.revenue, "100.000000");
}));

function inFlightFixture(checkClosed = false) {
  let reads = 0, gate = Promise.resolve(), release: (() => void) | undefined, fail = false;
  let inRead = false;
  const scopeKey = "LEGACY_COUPANG_SINGLE_UPLOAD";
  const state = { revision: 1, configurationVersion: "config-1", amount: "100.000000" };
  const tx = {
    $queryRaw: async (statement: any) => {
      const scopeIndex = statement.values.findIndex((value: unknown) => typeof value === "string" && value.includes('"scopeKey"'));
      const fixed = scopeIndex >= 0 ? JSON.parse(statement.values[scopeIndex]) : [];
      const requested = typeof statement.values[scopeIndex+1] === "string" && statement.values[scopeIndex+1].startsWith("[") ? JSON.parse(statement.values[scopeIndex+1]) : undefined;
      const included = fixed.some((scope: any) => scope.platform === "COUPANG") && (requested === undefined || requested.includes(scopeKey));
      return [{ frame: {
        get products() { if(checkClosed) assert.equal(inRead,false,"frame hydration must follow transaction release"); return [{id:"A",canonical_name:"A",normalized_name:"a",active:true,version:Number(state.configurationVersion.split("-")[1]),created_at:"2026-10-01T00:00:00Z",updated_at:"2026-10-01T00:00:00Z"}]; },
        rules: [], connections: [], publications: included ? [{
          publication:{source_system:"COUPANG",platform:"COUPANG",scope_key:scopeKey,business_date:"2026-10-26",run_id:`run-${state.revision}`,revision:state.revision,updated_at:"2026-10-27T00:00:00Z"},
          run:{versions:{},control_totals:[],published_at:"2026-10-27T00:00:00Z",started_at:"2026-10-27T00:00:00Z"}
        }] : [],
        facts: included ? [{run_id:`run-${state.revision}`,payload:{...fixture().snapshot.facts[0],marketplace:"COUPANG",amountKrw:state.amount,completeAmountKrw:state.amount}}] : [],
        coverage: [], failures: [], ranges: []
      }}];
    }
  };
  const management = {
    read: async (work: (tx: unknown) => Promise<unknown>) => {
      reads++; const barrier = gate; await barrier;
      if (fail) { fail = false; throw Error("SYNTHETIC_SNAPSHOT_FAILURE"); }
      inRead=true;
      try { return await work(tx); } finally { inRead=false; }
    },
    snapshot: async () => ({ products: [{ id: "A", canonicalName: "A", active: true }], rules: [],
      versions: { configurationVersion: state.configurationVersion } })
  } as unknown as UnifiedManagementRepository;
  return { repository: new UnifiedReportRepository(management), management, state,
    query: parseReportQuery({ ...query, platforms: ["COUPANG"], scopeKeys: [scopeKey], productName: "A" }),
    reads: () => reads, hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); },
    resume: () => { release?.(); gate = Promise.resolve(); }, failNext: () => { fail = true; } };
}

test("historical frame hydration and missing-day expansion run after releasing the read transaction", async () => {
  const f=inFlightFixture(true);
  const snapshot=await f.repository.snapshot({...f.query,from:"2026-05-13",to:"2026-10-28"});
  assert.equal(snapshot.facts[0].amountKrw,"100.000000");
  assert(snapshot.coverage.some(c=>c.date==="2026-05-13"&&c.collectionState==="NOT_COLLECTED"));
  assert.equal(f.reads(),1);
});

test("concurrent effective report reads share one RR load while pagination and grain stay response-local", async () => {
  const f = inFlightFixture(); f.hold();
  const first = f.repository.snapshot(f.query);
  const second = f.repository.snapshot({ ...f.query, limit: 1, cursor: "response-local", grain: "month", selectionHash: "response-local" });
  assert.equal(first, second); assert.equal(f.reads(), 1);
  f.resume();
  const [a, b] = await Promise.all([first, second]); assert.equal(a, b);
  await f.repository.snapshot(f.query); assert.equal(f.reads(), 2, "settled results must never remain cached");
});

test("in-flight reads separate account/date/product/lookback and repository runtime-role instances", async () => {
  const f = inFlightFixture(); f.hold();
  const requests = [f.repository.snapshot(f.query),
    f.repository.snapshot({ ...f.query, platforms: [], scopeKeys: undefined }),
    f.repository.snapshot({ ...f.query, scopeKeys: [] }), f.repository.snapshot({ ...f.query, scopeKeys: undefined }),
    f.repository.snapshot({ ...f.query, from: "2026-10-25" }), f.repository.snapshot({ ...f.query, compareFrom: "2026-10-24" }),
    f.repository.snapshot({ ...f.query, productName: undefined }), f.repository.snapshot(f.query, "2026-10-12"),
    new UnifiedReportRepository(f.management).snapshot(f.query)];
  assert.equal(f.reads(), requests.length);
  f.resume(); await Promise.all(requests);
});

test("scope allowlist changes create separate in-flight reads and each read pins its captured policy", async () => {
  const savedNaver = process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS, savedLegacy = process.env.UNIFIED_REPORT_LEGACY_PLATFORMS;
  try {
    const f = inFlightFixture(); f.hold();
    const input = { ...f.query, platforms: ["NAVER" as const], scopeKeys: undefined };
    process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS = "store-a";
    const before = f.repository.snapshot(input);
    process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS = "store-b";
    const after = f.repository.snapshot(input);
    assert.equal(f.reads(), 2);
    f.resume(); const [a,b] = await Promise.all([before,after]);
    assert.deepEqual(a.scopes.map(scope => scope.scopeKey), ["store-a"]);
    assert.deepEqual(b.scopes.map(scope => scope.scopeKey), ["store-b"]);
    f.hold(); process.env.UNIFIED_REPORT_LEGACY_PLATFORMS = "META";
    const withLegacy = f.repository.snapshot({ ...input, platforms: ["META"] });
    process.env.UNIFIED_REPORT_LEGACY_PLATFORMS = "";
    const noLegacy = f.repository.snapshot({ ...input, platforms: ["META"] });
    assert.equal(f.reads(), 4); f.resume();
    const [c,d] = await Promise.all([withLegacy,noLegacy]);
    assert.deepEqual(c.scopes.map(scope => scope.scopeKey), ["LEGACY_UNBOUND"]); assert.deepEqual(d.scopes, []);
  } finally {
    if (savedNaver === undefined) delete process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS; else process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS = savedNaver;
    if (savedLegacy === undefined) delete process.env.UNIFIED_REPORT_LEGACY_PLATFORMS; else process.env.UNIFIED_REPORT_LEGACY_PLATFORMS = savedLegacy;
  }
});

test("failed singleflight is evicted and the next request retries the database", async () => {
  const f = inFlightFixture(); f.hold(); f.failNext();
  const first = f.repository.snapshot(f.query), second = f.repository.snapshot(f.query);
  assert.equal(first, second); assert.equal(f.reads(), 1); f.resume();
  await assert.rejects(Promise.all([first,second]), /SYNTHETIC_SNAPSHOT_FAILURE/);
  await f.repository.snapshot(f.query); assert.equal(f.reads(), 2);
});

test("the first request after settlement sees changed configuration and a new publication immediately", async () => {
  const f = inFlightFixture(), before = await f.repository.snapshot(f.query);
  f.state.configurationVersion = "config-2"; f.state.revision = 2; f.state.amount = "200.000000";
  const after = await f.repository.snapshot(f.query);
  assert.equal(f.reads(), 2); assert.notEqual(before.snapshotHash, after.snapshotHash);
  assert.notEqual(before.versions.configurationVersion, after.versions.configurationVersion);
  assert.equal(before.publications[0].runId, "run-1"); assert.equal(after.publications[0].runId, "run-2");
  assert.equal(before.facts[0].amountKrw, "100.000000"); assert.equal(after.facts[0].amountKrw, "200.000000");
});

test("concurrent endpoint calculations leave the shared snapshot unchanged and still enforce caller permission", async () => enabled(async () => {
  const f = inFlightFixture(), original = f.repository.snapshot.bind(f.repository);
  let shared: ReportSnapshot | undefined, before = "";
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  f.repository.snapshot = (input, lookback) => original(input,lookback).then(snapshot => {
    if (!shared) { shared = snapshot; before = JSON.stringify(snapshot); freeze(snapshot); }
    return snapshot;
  });
  const service = new UnifiedReportService(f.repository, {} as UnifiedAggregationRepository);
  f.hold();
  const requests = (["summary","timeseries","diagnostics","options"] as const).map(kind => service.read(kind,{ ...f.query },readActor));
  await assert.rejects(service.read("summary",{ ...f.query },{ ...actor, permissions: [] }), /실행 권한/);
  assert.equal(f.reads(), 1); f.resume();
  const results = await Promise.all(requests);
  assert(results.every(result => result.snapshotHash === results[0].snapshotHash));
  assert.equal(JSON.stringify(shared), before, "shared arrays, rows, dates and versions must not be mutated by consumers");
  shared = undefined; before = ""; f.hold();
  const analyses = [service.read("relationships",{ ...f.query, analysisMedia: ["COUPANG_ADS"] },readActor),
    service.read("relationships",{ ...f.query, analysisMedia: [] },readActor)];
  assert.equal(f.reads(), 2, "relationship lookback has its own load shared across analysis-media choices");
  f.resume(); const relationships = await Promise.all(analyses);
  assert.deepEqual(relationships[0].knownTotals, relationships[1].knownTotals);
  assert.equal(JSON.stringify(shared), before, "relationship calculations must also preserve shared input");
}));
