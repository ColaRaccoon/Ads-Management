import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePublications, reconciliationCandidates, reconciliationOptions, publicationEvidence } from "./reconciliation";
import { assertReconciliationRole } from "./reconciliation-entrypoint";
import { ReconciliationRepository, sourceDateStatement, type ReconciliationCandidate, type ReconciliationCheckOutcome } from "./reconciliation.repository";
import type { SourcePartition } from "./report-contract";
import type { AdapterBatch } from "./types";
import { REPORT_CALCULATION_VERSION } from "./report-contract";
import type { PrismaService } from "../common/prisma.service";

const scope = { platform: "META" as const, scopeKey: "allowed-account", label: "account" };
const part: ReconciliationCandidate = { ...scope, date: "2026-11-01", published: false };
const versions = { scopePolicyVersion: "scope", nameRuleVersion: "name", saleUnitRuleVersion: "unit", allocationRuleVersion: "allocation" };
const allVersions = { ...versions, calculationVersion: REPORT_CALCULATION_VERSION, fxVersion: "stored-daily-fx-v1" };
const batch = (fingerprint = "fp"): AdapterBatch => ({ sales: [], adSpends: [{ amountKrw: "10" }], commonExpenses: [], coverage: [], sourceControlTotals: [], sourceFingerprint: fingerprint, nextCursor: null } as unknown as AdapterBatch);
function fixture() {
  let time = Date.parse("2026-11-02T01:10:00Z"), fingerprint = "fp", published: unknown = null, fail = false, reads = 0;
  const keys: string[] = [], jobs = new Map<string, { jobId: string; status: string }>(), attempted: string[] = [];
  const checks: Array<{ partition: SourcePartition; checkedAt: Date; outcome: ReconciliationCheckOutcome }> = [];
  const input = { scopes: [scope], options: { through: "2026-11-02", lookback: 7, limit: 4, deadlineMs: 1200000 }, now: () => time,
    repository: { pending: async () => [], discover: async () => ({ candidates: [part], failures: [] }), published: async () => published,
      recordCheck: async (partition: SourcePartition, checkedAt: Date, outcome: ReconciliationCheckOutcome) => { checks.push({ partition, checkedAt, outcome }); } },
    management: { snapshot: async () => ({ products: [], rules: [], versions }) },
    aggregation: { enqueue: async (_parts: unknown, actor: unknown, _reason: string, key: string) => {
      assert.equal(actor, null); keys.push(key);
      if (!jobs.has(key)) jobs.set(key, { jobId: `job-${jobs.size}`, status: "STAGING" });
      return { jobs: [jobs.get(key)!] };
    } },
    worker: { runOne: async (id: string) => {
      attempted.push(id); const job = [...jobs.values()].find(job => job.jobId === id)!;
      job.status = fail ? "FAILED" : "PUBLISHED";
      if (!fail) published = { runId: id, run: { sourceFingerprint: fingerprint, versions: { ...allVersions, ...versions } } };
      return { jobId: id, platform: "META", status: fail ? "FAILED" : "PUBLISHED" };
    } }, adapters: { META: { read: async () => { reads++; return batch(fingerprint); } } } };
  const run = () => reconcilePublications(input as unknown as Parameters<typeof reconcilePublications>[0]);
  return { input, run, keys, jobs, attempted, checks, reads: () => reads, setFingerprint: (value: string) => { fingerprint = value; },
    setFail: (value: boolean) => { fail = value; }, advanceFiveMinutes: () => { time += 300000; } };
}

test("unchanged source fingerprint and versions create no jobs or publication writes", async () => {
  const f = fixture(); assert.equal((await f.run()).published, 1);
  assert.equal((await f.run()).unchanged, 1); assert.equal(f.keys.length, 1);
  f.setFingerprint("changed-source"); assert.equal((await f.run()).published, 1); assert.equal(f.keys.length, 2);
  assert.equal(f.reads(), 3);
  assert.deepEqual(f.checks.map(check => check.outcome), ["PUBLISHED", "UNCHANGED", "PUBLISHED"]);
});
test("failed idempotency retries in the next five-minute window rather than waiting an hour", async () => {
  const f = fixture(); f.setFail(true);
  assert.equal((await f.run()).failed, 1); assert.equal((await f.run()).failed, 1);
  assert.equal(f.keys[0], f.keys[1]); assert.equal(f.jobs.size, 1);
  f.advanceFiveMinutes(); f.setFail(false);
  assert.equal((await f.run()).published, 1); assert.notEqual(f.keys[1], f.keys[2]); assert.equal(f.jobs.size, 2);
  assert.deepEqual(f.checks.map(check => check.outcome), ["FAILED", "FAILED", "PUBLISHED"]);
});
test("source gaps and empty unknown days do not become published zero days", async () => {
  const empty = { sales: [], adSpends: [], commonExpenses: [], coverage: [], sourceControlTotals: [], sourceFingerprint: "empty", nextCursor: null } as AdapterBatch;
  assert.equal(publicationEvidence(empty), false);
  assert.equal(publicationEvidence({ ...empty, coverage: [{ participation: "INCLUDED", component: "AD_SPEND", collectionState: "NOT_COLLECTED", rowsPresent: 0, zeroConfirmed: false }] } as AdapterBatch), false);
  assert.equal(publicationEvidence({ ...empty, coverage: [{ participation: "INCLUDED", component: "AD_SPEND", collectionState: "COMPLETE", rowsPresent: 0, zeroConfirmed: true }] } as AdapterBatch), true);
  const missing = { known: null, complete: null }, zero = { known: "0", complete: "0" };
  const native = { kind: "SUMMARY" as const, group: "NAVER" as const, productKey: "summary", productName: null, quantity: null,
    revenue: missing, adSpend: missing, netProfit: missing, profitBeforeAds: missing, sourceUpdatedAt: null, issues: [] };
  assert.equal(publicationEvidence({ ...empty, nativeResults: [native] }), false);
  assert.equal(publicationEvidence({ ...empty, nativeResults: [{ ...native, netProfit: zero }] }), true, "a directly stored native final result needs no reconstructed ledger evidence");
  const f = fixture(); f.input.adapters.META.read = async () => empty;
  assert.equal((await f.run()).unavailable, 1); assert.equal(f.keys.length, 0);
  assert.equal(f.checks[0].outcome, "UNAVAILABLE");
});
test("permission/source failures stay isolated and never overwrite a last-good publication", async () => {
  const f = fixture(); await f.run();
  f.input.adapters.META.read = async () => { throw Error("private credential/provider error"); };
  const result = await f.run(); assert.equal(result.failed, 1); assert.equal(f.keys.length, 1);
  assert(!JSON.stringify(result).includes("credential"));
  assert.equal(f.checks.at(-1)!.outcome, "FAILED");
});
test("candidate planning reserves historical catch-up while excluding unauthorized/future/bad dates", () => {
  const recent = [1, 2, 3, 4].map(day => ({ ...part, date: `2026-10-${27 + day}`, published: true }));
  const old = { ...part, date: "2026-09-01" };
  const result = reconciliationCandidates([...recent, old, { ...part, scopeKey: "forbidden" }, { ...part, date: "2026-12-01" }, { ...part, date: "2026-02-30" }], [scope], "2026-10-26", "2026-11-02", 4);
  assert.equal(result.length, 4); assert(result.some(row => row.date === old.date));
  assert(result.every(row => row.scopeKey === scope.scopeKey));
});

test("old published and failed dates rotate durably despite a full recent workload", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({ ...part, scopeKey: `account-${index}`, date: "2026-11-02", published: true }));
  const historical = Array.from({ length: 8 }, (_, index): ReconciliationCandidate => ({ ...part, date: `2026-08-${String(index + 1).padStart(2, "0")}`, published: true }));
  const allowed = [scope, ...recent.map(row => ({ ...scope, scopeKey: row.scopeKey }))];
  const checked = new Set<string>();
  for (let iteration = 0; iteration < historical.length; iteration++) {
    const selected = reconciliationCandidates([...recent, ...historical], allowed, "2026-11-01", "2026-11-02", 4, iteration % 4 === 0);
    assert.equal(selected.length, 4); assert.equal(selected.filter(row => row.date >= "2026-11-01").length, 3);
    if (iteration % 4 === 0) assert(selected[0].date < "2026-11-01", "periodic history-first order survives short execution deadlines");
    for (const selectedRow of selected) {
      selectedRow.lastCheckedAt = new Date(Date.UTC(2026, 10, 3, 0, iteration * 5)).toISOString();
      if (selectedRow.date < "2026-11-01") checked.add(selectedRow.date);
    }
  }
  assert.equal(checked.size, historical.length, "unchanged/failed checks advance instead of permanently repeating oldest publication");
});

test("a scheduling-metadata write failure is reported without undoing a successful publication", async () => {
  const f = fixture();
  f.input.repository.recordCheck = async () => { throw Error("private database error"); };
  const result = await f.run();
  assert.equal(result.published, 1); assert.equal(result.failed, 1);
  assert.deepEqual(result.discoveryFailures, ["CHECK_RECORD_FAILED"]);
  assert(!JSON.stringify(result).includes("private"));
});
test("existing queued jobs retain a bounded share so discovery can make progress", async () => {
  const f = fixture(); let pendingLimit = 0;
  f.input.repository.pending = async (...args: unknown[]) => { pendingLimit = args[1] as number; return []; };
  await f.run(); assert.equal(pendingLimit, 2);
  let clockCalls = 0;
  f.input.now = () => Date.parse("2026-11-02T01:10:00Z") + clockCalls++ * 2000000;
  const result = await f.run(); assert.equal(result.exhausted, true);
});
test("CLI defaults to Korea today and rejects future dates and unbounded execution", () => {
  const options = reconciliationOptions([], new Date("2026-11-01T16:00:00Z"));
  assert.equal(options.through, "2026-11-02"); assert.equal(options.lookback, 7);
  assert.deepEqual(reconciliationOptions(["--lookback=1", "--limit=24", "--deadline-seconds=90"], new Date("2026-11-02T01:00:00Z")),
    { through: "2026-11-02", lookback: 1, limit: 24, deadlineMs: 90000 });
  for (const args of [["--through=2026-02-30"], ["--through=2099-01-01"], ["--limit=0"], ["--limit=501"], ["--lookback=32"], ["--deadline-seconds=99999"], ["--limit=4", "--limit=4"]]) assert.throws(() => reconciliationOptions(args));
});
test("runtime only accepts the dedicated restricted worker identity", () => {
  const role = { role: "meta_ads_unified_worker", rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, owns: 0n };
  assert.doesNotThrow(() => assertReconciliationRole(role));
  for (const change of [{ role: "postgres" }, { role: "meta_ads_unified_report" }, { rolsuper: true }, { rolbypassrls: true }, { owns: 1n }])
    assert.throws(() => assertReconciliationRole({ ...role, ...change }));
});
test("source discovery queries date evidence only, including Naver/Coupang and confirmed API zeros", () => {
  for (const platform of ["META", "GOOGLE", "CAFE24", "COUPANG", "NAVER"] as const) {
    const sql = sourceDateStatement({ ...scope, platform }, "2026-10-26", "2026-11-02", 4);
    assert(sql.text.includes("classified")); assert(sql.text.includes("UNION ALL"));
    assert(sql.text.includes("unified_reconciliation_checks")); assert(sql.text.includes("NULLS FIRST")); assert(sql.text.includes("LIMIT"));
    assert(!sql.text.includes("AND NOT published"), "previously published historical days remain eligible");
    assert(sql.text.includes("t.business_date"), "deleted source dates remain discoverable via previous publications");
    assert(!sql.text.includes("raw_row")); assert(!sql.text.includes("product_name"));
    assert(sql.values.includes(scope.scopeKey));
  }
  const zero = sourceDateStatement({ ...scope, platform: "GOOGLE" }, "2026-10-26", "2026-11-02", 4).text;
  assert(zero.includes("COMPLETE_ZERO")); assert(zero.includes("last_success_run_id IS NOT NULL"));
  const naver = sourceDateStatement({ ...scope, platform: "NAVER" }, "2026-10-26", "2026-11-02", 4).text;
  assert(naver.includes("daily_store_summaries")); assert(naver.includes("daily_sales_unit_profits"));
  assert(naver.includes("daily_fake_purchases"));
  assert(!naver.includes("order_items")); assert(!naver.includes("ad_campaign_daily_costs"));
  const coupang = sourceDateStatement({ ...scope, platform: "COUPANG" }, "2026-11-01", "2026-11-02", 24).text;
  assert(coupang.includes("coupang_manual_purchases"));
  const cafe = sourceDateStatement({ ...scope, platform: "CAFE24" }, "2026-11-01", "2026-11-02", 24).text;
  assert(cafe.includes("meta_adset_daily_metrics")); assert(cafe.includes("google_campaign_daily_costs"));
  assert(cafe.includes("NOT EXISTS(SELECT 1 FROM meta_ads.source_connections"));
});

test("sole configured Cafe24 owner discovers legacy CSV dates without claiming another shop or projecting money", () => {
  const configured = sourceDateStatement({ ...scope, platform: "CAFE24" }, "2026-11-01", "2026-11-02", 24);
  const legacyBranch = configured.text.split(" UNION ALL ").find(branch => branch.includes("t.connection_id IS NULL"));
  assert(legacyBranch, "CSV-only historical dates must reach the configured native owner even without ads");
  assert(legacyBranch.includes("t.is_current AND t.validation_status<>'ERROR'"));
  assert(legacyBranch.includes("t.source='CSV'"));
  assert.match(legacyBranch, /AND EXISTS\(SELECT 1 FROM meta_ads\.source_connections c WHERE c\.provider='CAFE24' AND c\.id::text=\$\d+\)/,
    "the target must actually be a configured Cafe24 shop");
  assert.match(legacyBranch, /AND NOT EXISTS\(SELECT 1 FROM meta_ads\.source_connections c WHERE c\.provider='CAFE24' AND c\.id::text<>\$\d+\)/,
    "any other configured shop disables historical ownership inference");
  assert(legacyBranch.includes("SELECT t.order_date::text AS date"));
  assert(!/amount|revenue|profit|quantity|product_name/i.test(legacyBranch));
  const legacy = sourceDateStatement({ ...scope, platform: "CAFE24", scopeKey: "LEGACY_UNBOUND" }, "2026-11-01", "2026-11-02", 24);
  assert.equal(legacy.text.split(" UNION ALL ").filter(branch => branch.includes("cafe24_order_lines")).length, 1,
    "legacy keeps its own date discovery and never acquires a configured shop's money");
});

test("check timestamps are bound and a slower overlapping worker cannot overwrite a newer check", async () => {
  const writes: Array<{ text: string; values: unknown[] }> = [];
  const prisma = { $executeRaw: async (query: { text: string; values: unknown[] }) => { writes.push(query); } } as unknown as PrismaService;
  const date = new Date("2026-11-03T01:00:00Z");
  await new ReconciliationRepository(prisma).recordCheck(part, date, "UNCHANGED");
  assert.equal(writes.length, 1);
  assert(writes[0].text.includes("ON CONFLICT"));
  assert(writes[0].text.includes("last_checked_at<=EXCLUDED.last_checked_at"));
  assert(writes[0].values.includes(part.scopeKey)); assert(writes[0].values.includes(date)); assert(writes[0].values.includes("UNCHANGED"));
  assert(!writes[0].text.includes(part.scopeKey));
});
test("discovery enforces a server-side statement timeout and isolates a denied scope", async () => {
  const statements: string[] = [];
  const prisma = { $transaction: async (work: (tx: unknown) => unknown) => work({
    $executeRaw: async (sql: { text: string }) => { statements.push(sql.text); },
    $queryRaw: async () => [{ date: part.date, published: false }]
  }) } as unknown as PrismaService;
  const result = await new ReconciliationRepository(prisma).discover([scope], "2026-10-26", "2026-11-02", 4);
  assert.equal(result.candidates.length, 1); assert(statements.some(sql => sql.includes("statement_timeout")));
  const failed = new ReconciliationRepository({ $transaction: async () => { throw Error("secret"); } } as unknown as PrismaService);
  assert.deepEqual((await failed.discover([scope], "2026-10-26", "2026-11-02", 4)).failures, ["META"]);
});
