import "reflect-metadata";
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Prisma } from "@prisma/client";
import { StorefrontReadService } from "../../../apps/api/src/storefront/storefront-read.service";
import { createSourceReadContext, selectCurrentSourceRows } from "../../../apps/api/src/common/source-read-policy";

const at = (value: string) => new Date(`${value}T00:00:00Z`), dec = (value: string | number) => new Prisma.Decimal(value);
const from = "2026-10-09", to = "2026-10-15";
const dates = Array.from({ length: 7 }, (_, i) => new Date(at(from).getTime() + i * 86400_000));
let OldStorefront: typeof StorefrontReadService;
before(async () => {
  OldStorefront = (await import(pathToFileURL("C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261019-v5/apps/api/src/storefront/storefront-read.service.ts").href)).StorefrontReadService;
});
function fixture(variant = "zero", rtt = 0) {
  const providers = ["CAFE24", "META", "GOOGLE"];
  const kinds = ["CAFE24_ORDER", "META_ADSET", "GOOGLE_CAMPAIGN"];
  const connections = providers.map((provider, i) => ({ id: provider, provider, displayName: provider, externalAccountId: "synthetic",
    currencyCode: provider === "META" ? "USD" : "KRW", timeZone: "Asia/Seoul", accessState: "READY", credentialRef: "synthetic-ref",
    credentialExpiresAt: null, enabled: true, updatedAt: at(from), coverage: [{ lastSuccessAt: at(to) }], runs: [] as any[] }));
  const policies: any[] = providers.map((connectionId, i) => ({ connectionId, dataKind: kinds[i], primarySource: "API", fromDate: at("2026-10-01"), toDate: null }));
  const coverage = providers.flatMap((connectionId, i) => dates.map(metricDate => ({ connectionId, dataKind: kinds[i], metricDate, source: "API", state: "FAILED",
    lastSuccessRunId: `${connectionId}-${metricDate.toISOString().slice(0, 10)}`, lastSuccessAt: at(to), lastAttemptAt: at(to), lastAttemptRun: { status: "FAILED" },
    rowCount: 0, totalAmount: dec(0), reconciliationStatus: "CAFE24_API_ONLY_VERIFIED", warningCodes: [] as string[] })));
  const units = coverage.map(c => ({ runId: c.lastSuccessRunId, unitKey: c.metricDate.toISOString().slice(0, 10), status: "SUCCEEDED", publishedCount: c.rowCount, run: { connectionId: c.connectionId } }));
  const rows: Record<string, any[]> = { CAFE24: [], META: [], GOOGLE: [] };
  if (variant !== "zero") for (const date of dates) {
    const key = date.toISOString().slice(0, 10);
    rows.CAFE24.push({ id: `c-${key}`, source: "API", connectionId: "CAFE24", orderDate: date, productId: "p", product: { isActive: true },
      quantity: dec(2), salePriceKrw: dec(7777), createdAt: date, matchRule: { displayName: "1+1", optionIncludeKeywords: [], productNameAliases: [], salePriceKrwOverride: null } });
    rows.META.push({ id: `m-${key}`, source: "API", connectionId: "META", metricDate: date, productId: "p", product: { isActive: true, displayName: "Synthetic" }, spendUsd: dec("1.23456789"), createdAt: date });
    rows.GOOGLE.push({ id: `g-${key}`, source: "API", connectionId: "GOOGLE", metricDate: date, costMicros: 9007199254740993n,
      campaignId: "campaign", campaignName: "Synthetic", channelType: "SEARCH", impressions: 9007199254740993n, clicks: 12n, fetchedAt: date, syncRunId: `GOOGLE-${key}` });
    for (const c of coverage.filter(c => c.metricDate.getTime() === date.getTime())) { c.rowCount = 1; c.totalAmount = c.connectionId === "GOOGLE" ? dec("9007199254.740993") : dec(1); }
    for (const u of units.filter(u => u.unitKey === key)) u.publishedCount = 1;
  }
  if (variant === "missing-meta-unit") units.splice(units.findIndex(u => u.runId === `META-${to}`), 1);
  if (variant === "row-count") coverage.find(c => c.connectionId === "CAFE24")!.rowCount = 2;
  if (variant === "overlap") policies.push({ ...policies[0], primarySource: "CSV", fromDate: at("2026-10-12"), toDate: at("2026-10-13") });
  if (variant === "missing-policy") policies.splice(0, 1);
  if (variant === "unbound") rows.META.push({ ...rows.META[0], id: "unbound", source: "CSV", connectionId: null });
  if (variant === "csv-only") rows.CAFE24.forEach(r => { r.source = "CSV"; });
  if (variant === "csv") { policies.forEach(p => { p.primarySource = "CSV"; }); Object.values(rows).flat().forEach(r => { r.source = "CSV"; }); }
  if (variant === "currency") connections[2].currencyCode = "USD";
  const rates = dates.filter((_, i) => i % 2 === 0).map(rateDate => ({ rateDate, rate: dec(1400), sourceDate: rateDate, provider: "KOREA_EXIM", fallbackType: "EXACT", fetchedAt: rateDate }));
  const costs = [{ id: "new", productId: "p", effectiveFrom: at("2026-10-12"), effectiveTo: null, createdAt: at("2026-10-12"), updatedAt: at(to), salePriceKrw: dec(12000), fxRateKrwPerUsd: dec(1500) },
    { id: "old", productId: "p", effectiveFrom: at("2026-10-01"), effectiveTo: at("2026-10-11"), createdAt: at("2026-10-01"), updatedAt: at(to), salePriceKrw: dec(9000), fxRateKrwPerUsd: dec(1300) }];
  const calls: Record<string, number> = {}; let tail = Promise.resolve();
  const query = <T>(label: string, action: () => T) => {
    calls[label] = (calls[label] ?? 0) + 1;
    const result = tail.then(async () => { if (rtt) await new Promise(resolve => setTimeout(resolve, rtt)); return action(); });
    tail = result.then(() => undefined); return result;
  };
  const within = (d: Date, w: any) => (!w?.gte || d >= w.gte) && (!w?.lte || d <= w.lte);
  const tx: any = {
    sourceConnection: { findMany: () => query("connections", () => connections) },
    sourcePolicy: { findMany: ({ where }: any) => query("policies", () => policies.filter(p => (!where.dataKind || where.dataKind === p.dataKind) &&
      (!where.connectionId || where.connectionId.in.includes(p.connectionId)) && p.fromDate <= where.fromDate.lte && (p.toDate == null || p.toDate > where.OR[1].toDate.gt))) },
    sourceCoverage: { findMany: ({ where }: any) => query("coverage", () => coverage.filter(c => (!where.dataKind || where.dataKind === c.dataKind) &&
      (!where.connectionId || where.connectionId.in.includes(c.connectionId)) && within(c.metricDate, where.metricDate))) },
    googleCampaignDailyCost: { findMany: ({ where }: any) => query("google", () => rows.GOOGLE.filter(r => within(r.metricDate, where.metricDate))) },
    metaAdsetDailyMetric: { findMany: ({ where }: any) => query("meta", () => rows.META.filter(r => within(r.metricDate, where.metricDate))) },
    cafe24OrderLine: { findMany: ({ where }: any) => query("cafe", () => rows.CAFE24.filter(r => within(r.orderDate, where.orderDate))) },
    cafe24UploadBatch: { findMany: () => query("batches", () => [{ id: "batch", rowCount: rows.CAFE24.length, _count: { rows: rows.CAFE24.length } }]) },
    exchangeRate: { findMany: ({ where }: any) => query("rates", () => rates.filter(r => within(r.rateDate, where.rateDate))) },
    productCostRule: { findMany: () => query("costs", () => costs) },
    runUnit: { findMany: ({ where }: any) => query("units", () => units.filter(u => where.runId.in.includes(u.runId))) },
    $queryRaw: (sql: any) => query("lineage", () => {
      const cafe = sql.strings.join("").includes("cafe24_order_lines"), provider = cafe ? "CAFE24" : "META";
      return rows[provider].filter(r => r.source === "API").map(r => ({ connectionId: provider, metricDate: r.metricDate, orderDate: r.orderDate,
        rowCount: 1, linkedCount: variant === "cafe-link" && cafe ? 0 : 1, validLinkedCount: 1, validVersionCount: variant === "version" && cafe ? 0 : 1,
        validMappingCount: variant === "mapping" && cafe ? 0 : 1, linkedRows: 1, validLinks: variant === "meta-link" ? 0 : 1, allLinks: 1 }));
    })
  };
  const client: any = { $transaction: async (fn: any, options: any) => {
    assert.equal(options.isolationLevel, "RepeatableRead"); assert.equal(options.timeout, 30000); return fn(tx);
  } };
  return { tx, client, calls, policies, stats: () => Object.values(calls).reduce((a, b) => a + b, 0) };
}

test("Storefront whole output equals frozen v5 for zero/nonzero/failed latest/lineage/policy/FX/precision boundaries", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED;
  try {
    for (const variant of ["zero", "positive", "missing-meta-unit", "row-count", "overlap", "missing-policy", "unbound", "csv-only", "csv", "currency", "version", "mapping", "meta-link", "cafe-link"]) {
      process.env.DAILY_SYNC_FEATURE_ENABLED = variant === "csv" ? "false" : "true";
      for (const [start, end] of [[from, to], [to, to]]) {
        const old = fixture(variant), current = fixture(variant);
        assert.deepEqual(await new StorefrontReadService(current.client).summary(start, end), await new OldStorefront(old.client).summary(start, end), variant);
      }
    }
  } finally { process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});

test("reused evidence still fails closed for missing policy, Cafe24 links and Meta successful unit", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    for (const [variant, provider] of [["missing-policy", "CAFE24"], ["cafe-link", "CAFE24"], ["missing-meta-unit", "META"]]) {
      const f = fixture(variant), result = await new StorefrontReadService(f.client).summary(from, to);
      assert.ok(result.warningCodes.includes("SOURCE_SELECTION_REQUIRED"), variant);
      assert.equal(result.channels.find(c => c.provider === provider)?.amount, null, variant);
      assert.equal(result.channels.find(c => c.provider === provider)?.complete, false, variant);
    }
  } finally { process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});

test("zero-day lineage evidence is validated once per kind in the same request snapshot", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const old = fixture(), current = fixture();
    assert.deepEqual(await new StorefrontReadService(current.client).summary(from, to), await new OldStorefront(old.client).summary(from, to));
    assert.equal(old.calls.lineage, 14); assert.equal(current.calls.lineage, 2);
    assert.equal(current.calls.policies, 1); assert.equal(current.calls.coverage, 3);
    assert.ok(current.stats() < old.stats() / 2, `${old.stats()} -> ${current.stats()}`);
    console.log(JSON.stringify({ classification: "SYNTHETIC_SERIAL_TRANSACTION_QUERY_COUNT", before: old.stats(), after: current.stats(), beforeLineage: old.calls.lineage, afterLineage: current.calls.lineage, providerRequests: 0 }));
  } finally { process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});

test("source context refuses a different transaction, invalid date, or date outside its range", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const f = fixture(), context = createSourceReadContext(f.tx, at(from), at(to), f.policies);
    const row: any = { connectionId: "CAFE24", source: "API", metricDate: at(from) };
    await assert.rejects(selectCurrentSourceRows({ ...f.tx }, "CAFE24_ORDER", [row], r => r.metricDate, context));
    await assert.rejects(selectCurrentSourceRows(f.tx, "CAFE24_ORDER", [{ ...row, metricDate: at("2026-10-08") }], r => r.metricDate, context));
    await assert.rejects(selectCurrentSourceRows(f.tx, "CAFE24_ORDER", [{ ...row, metricDate: new Date(NaN) }], r => r.metricDate, context));
    assert.throws(() => createSourceReadContext(f.tx, at(to), at(from), f.policies));
    assert.equal(f.stats(), 0);
  } finally { process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});

test("separate summaries do not reuse validation across requests", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const f = fixture(), service = new StorefrontReadService(f.client);
    await service.summary(from, to); const first = f.stats();
    await service.summary(from, to); assert.equal(f.stats(), first * 2); assert.equal(f.calls.lineage, 4);
  } finally { process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});

test("contexts on the same client cannot mix policy evidence and empty input remains query-free", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const f = fixture(), good = createSourceReadContext(f.tx, at(from), at(to), f.policies);
    const missing = createSourceReadContext(f.tx, at(from), at(to), []);
    const row: any = { connectionId: "CAFE24", source: "API", metricDate: at(from) };
    assert.equal((await selectCurrentSourceRows(f.tx, "CAFE24_ORDER", [row], r => r.metricDate, good)).length, 1);
    await assert.rejects(selectCurrentSourceRows(f.tx, "CAFE24_ORDER", [row], r => r.metricDate, missing));
    const n = f.stats();
    assert.deepEqual(await selectCurrentSourceRows(f.tx, "CAFE24_ORDER", [], () => null, good), []);
    assert.equal(f.stats(), n);
  } finally { process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});

test("serial same-transaction RTT fixture retains whole output with fewer round trips", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const old = fixture("zero", 2), current = fixture("zero", 2);
    const startOld = performance.now(), before = await new OldStorefront(old.client).summary(from, to), oldMs = performance.now() - startOld;
    const startNew = performance.now(), after = await new StorefrontReadService(current.client).summary(from, to), newMs = performance.now() - startNew;
    assert.deepEqual(after, before); assert.equal(old.stats(), 59); assert.equal(current.stats(), 15);
    console.log(JSON.stringify({ classification: "SYNTHETIC_2MS_SERIAL_TRANSACTION_RTT_NOT_ACTUAL_SLA", beforeMs: oldMs, afterMs: newMs, providerRequests: 0, remoteDatabaseRequests: 0 }));
  } finally { process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});
