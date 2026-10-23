import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { DashboardMetricsService } from "../../../apps/api/src/metrics/dashboard-metrics.service";
import { MetaAdsetMetricDecorationService } from "../../../apps/api/src/metrics/meta-adset-metric-decoration.service";

const frozen = "C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261019-v4/apps/api/src/metrics";
const date = (value: string) => new Date(`${value}T00:00:00Z`), dec = (value: number) => new Prisma.Decimal(value);
const dataset = Array.from({ length: 14 }, (_, index) => {
  const metricDate = new Date(Date.parse("2026-09-24Z") + index * 86400_000);
  return { id: `metric-${index}`, source: "CSV", connectionId: null, productId: "product", product: { id: "product", isActive: true },
    metaAdsetId: "adset", metaAdset: {}, metricDate, adsetName: "Synthetic", adsetNameKey: "synthetic", deliveryStatus: index % 3 === 0 ? "inactive" : "active",
    spendUsd: dec(index + 0.25), resultCount: index + 1, purchaseCount: null, purchaseValueUsd: null, providerPurchaseCount: null,
    impressions: BigInt(100 + index), linkClicks: index + 2, clicksAll: index + 3, landingPageViews: index + 4, shopClicks: index + 5,
    attributionSetting: null, actionReportTime: null, attributionWindows: [], metricUnavailableReasons: null };
});
const costs = [
  { id: "cost-new", productId: "product", effectiveFrom: date("2026-10-01"), effectiveTo: null, createdAt: date("2026-10-01"), salePriceKrw: dec(20000), vatKrw: dec(2000), productCostKrw: dec(8000), shippingKrw: dec(1000), extraCostKrw: dec(100), fxRateKrwPerUsd: dec(1350) },
  { id: "cost-old", productId: "product", effectiveFrom: date("2026-09-01"), effectiveTo: date("2026-09-30"), createdAt: date("2026-09-01"), salePriceKrw: dec(10000), vatKrw: dec(1000), productCostKrw: dec(3000), shippingKrw: dec(500), extraCostKrw: dec(0), fxRateKrwPerUsd: dec(1300) }
];
const cpas = [
  { id: "cpa-new", productId: "product", effectiveFrom: date("2026-10-03"), effectiveTo: null, createdAt: date("2026-10-03"), targetRatio: dec(0.8), watchRatio: dec(1.1), stopRatio: dec(1.3) },
  { id: "cpa-old", productId: "product", effectiveFrom: date("2026-09-01"), effectiveTo: date("2026-10-01"), createdAt: date("2026-09-01"), targetRatio: dec(0.7), watchRatio: dec(1), stopRatio: dec(1.2) }
];
const rates = [{ rateDate: date("2026-09-30"), rate: dec(1400) }, { rateDate: date("2026-10-02"), rate: dec(1450) }];
function fixture(empty = false, rttMs = 0) {
  let queries = 0, metricReads = 0, active = 0; const queued: Array<() => void> = [];
  const query = async <T>(value: T): Promise<T> => {
    queries++;
    if (active >= 3) await new Promise<void>(resolve => queued.push(resolve));
    active++;
    try { if (rttMs) await new Promise(resolve => setTimeout(resolve, rttMs)); return value; }
    finally { active--; queued.shift()?.(); }
  };
  const client: any = {
    metaAdsetDailyMetric: { findMany: (input: any) => { metricReads++; return query(empty ? [] : dataset.filter(row => row.metricDate >= input.where.metricDate.gte && row.metricDate <= input.where.metricDate.lte && (!input.where.deliveryStatus || row.deliveryStatus === input.where.deliveryStatus.equals))); } },
    productCostRule: { findMany: () => query(costs) }, productCpaRule: { findMany: () => query(cpas) },
    exchangeRate: { findMany: (input: any) => query(rates.filter(row => input.where.rateDate.in.some((at: Date) => at.getTime() === row.rateDate.getTime()))) },
    metaAdDailyMetric: { findMany: () => query([]) }, uploadRowError: { count: () => query(3) },
    decisionLog: { findMany: () => query([]) }, sourcePolicy: { findMany: () => query([]) }
  };
  return { client, stats: () => ({ queries, metricReads }) };
}
async function previousClasses() {
  const oldDashPath = pathToFileURL(`${frozen}/dashboard-metrics.service.ts`).href;
  const oldDecoratePath = pathToFileURL(`${frozen}/meta-adset-metric-decoration.service.ts`).href;
  const dashboard = await import(oldDashPath), decorate = await import(oldDecoratePath);
  return { OldDashboard: dashboard.DashboardMetricsService, OldDecoration: decorate.MetaAdsetMetricDecorationService };
}
test("dashboard results match frozen v4 across one-day, month-end and effective cost/FX/CPA boundaries", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  try {
    const { OldDashboard, OldDecoration } = await previousClasses();
    for (const [from, to] of [["2026-10-07", "2026-10-07"], ["2026-10-01", "2026-10-07"], ["2026-09-30", "2026-10-02"], ["2026-10-01", "2026-10-02"]]) for (const delivery of ["all", "active", "inactive"]) {
      const before = fixture(), after = fixture();
      const expected = await new OldDashboard(before.client, new OldDecoration(before.client)).dashboardSummary(from, to, undefined, delivery);
      const actual = await new DashboardMetricsService(after.client, new MetaAdsetMetricDecorationService(after.client)).dashboardSummary(from, to, undefined, delivery);
      assert.deepEqual(actual, expected, `${from}/${to}/${delivery}`);
      assert.equal(before.stats().metricReads, 5); assert.equal(after.stats().metricReads, 2);
    }
    const f = fixture(), decorated = await new MetaAdsetMetricDecorationService(f.client).decoratedMetrics(date("2026-09-30"), date("2026-10-03"), "all");
    assert.deepEqual(decorated.map(row => [row.metricDate, row.costRule?.id, row.exchangeRate ? row.exchangeRate.rate.toString() : null, row.cpaRule?.id ?? null]), [
      ["2026-09-30", "cost-old", "1400", "cpa-old"], ["2026-10-01", "cost-new", null, "cpa-old"], ["2026-10-02", "cost-new", "1450", null], ["2026-10-03", "cost-new", null, "cpa-new"]
    ]);
  } finally { if (saved === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});
test("empty decoration returns no rows without any cost, CPA, FX or corrected purchase query", async () => {
  const f = fixture(); assert.deepEqual(await new MetaAdsetMetricDecorationService(f.client).decorate([]), []); assert.equal(f.stats().queries, 0);
});
test("API source conflict still rejects the dashboard before any fallback calculation", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const { OldDashboard, OldDecoration } = await previousClasses();
    for (const old of [true, false]) {
      const f = fixture(); f.client.sourcePolicy.findMany = async () => [{ connectionId: "00000000-0000-4000-8000-000000000001", dataKind: "META_ADSET", primarySource: "API", fromDate: date("2026-09-01"), toDate: null }];
      f.client.sourceCoverage = { findMany: async () => [] }; f.client.$queryRaw = async () => [];
      const service = old ? new OldDashboard(f.client, new OldDecoration(f.client)) : new DashboardMetricsService(f.client, new MetaAdsetMetricDecorationService(f.client));
      await assert.rejects(service.dashboardSummary("2026-10-07", "2026-10-07"), (error: any) => error.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
    }
  } finally { if (saved === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});
test("synthetic pool3/10ms RTT pressure reduces empty dashboard round trips without changing output", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const { OldDashboard, OldDecoration } = await previousClasses();
    const run = async (old: boolean) => {
      const f = fixture(true, 10), service = old ? new OldDashboard(f.client, new OldDecoration(f.client)) : new DashboardMetricsService(f.client, new MetaAdsetMetricDecorationService(f.client));
      const latencies: number[] = [], outputs: any[] = []; let index = 0;
      await Promise.all(Array.from({ length: 4 }, async () => { while (index++ < 20) { const start = performance.now(); outputs.push(await service.dashboardSummary("2026-10-07", "2026-10-07")); latencies.push(performance.now() - start); } }));
      latencies.sort((a, b) => a - b); return { ...f.stats(), requests: outputs.length, p95Ms: latencies[Math.ceil(latencies.length * .95) - 1], output: outputs[0] };
    };
    const before = await run(true), after = await run(false); assert.equal(before.requests, 20); assert.equal(after.requests, 20); assert.deepEqual(after.output, before.output);
    assert.equal(before.queries, 460); assert.equal(after.queries, 100); assert.equal(before.metricReads, 100); assert.equal(after.metricReads, 40);
    const result = { kind: "PHASE10_SYNTHETIC_DASHBOARD_QUERY_PRESSURE", pool: 3, syntheticRoundTripMs: 10, concurrency: 4, realDatabaseRequests: 0, realProviderRequests: 0,
      before: { ...before, output: undefined }, after: { ...after, output: undefined }, resultEquivalent: true, productionAcceptanceClaimed: false,
      sourceHashes: Object.fromEntries([`${frozen}/dashboard-metrics.service.ts`, `${frozen}/meta-adset-metric-decoration.service.ts`, "apps/api/src/metrics/dashboard-metrics.service.ts", "apps/api/src/metrics/meta-adset-metric-decoration.service.ts"].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])) };
    if (process.env.PHASE10_API_PERF_EVIDENCE) { assert(process.env.PHASE10_API_PERF_EVIDENCE.startsWith("C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/")); writeFileSync(process.env.PHASE10_API_PERF_EVIDENCE, JSON.stringify(result, null, 2) + "\n", { flag: "wx" }); }
    console.log(JSON.stringify(result));
  } finally { if (saved === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});
