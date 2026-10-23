import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { DashboardMetricsService } from "../../../apps/api/src/metrics/dashboard-metrics.service";
import { MetaAdsetMetricDecorationService } from "../../../apps/api/src/metrics/meta-adset-metric-decoration.service";
import { metaCollectionSummary } from "../../../apps/api/src/common/meta-collection-summary";

const D = Prisma.Decimal, date = (value: string) => new Date(value + "T00:00:00Z");
const days = ["2026-10-13", "2026-10-14"], connectionId = "00000000-0000-4000-8000-000000000001";
const root = "C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v4/apps/api/src/";
async function before() {
  const [dashboard, decoration, collection] = await Promise.all([
    import(pathToFileURL(root + "metrics/dashboard-metrics.service.ts").href),
    import(pathToFileURL(root + "metrics/meta-adset-metric-decoration.service.ts").href),
    import(pathToFileURL(root + "common/meta-collection-summary.ts").href)
  ]);
  return { Dashboard: dashboard.DashboardMetricsService ?? dashboard.default?.DashboardMetricsService,
    Decoration: decoration.MetaAdsetMetricDecorationService ?? decoration.default?.MetaAdsetMetricDecorationService,
    collection: collection.metaCollectionSummary ?? collection.default?.metaCollectionSummary };
}
const inRange = (d: Date, range: any) => !range || (range.in ? range.in.some((t: Date) => +t === +d) : d >= range.gte && d <= range.lte);
function fixture({ feature = false, empty = false, missingKind = "", zero = false } = {}) {
  const calls: { operation: string; query?: any }[] = [];
  const rows = empty ? [] : days.flatMap((day, i) => [true, false].map((matched, n) => ({
    id: day + n, metricDate: date(day), isCurrent: true, source: feature ? "API" : "CSV", connectionId: feature ? connectionId : null,
    metaAdsetId: "adset" + n, adsetName: "Synthetic", stage: i ? "SC" : "CBO", productId: matched ? "product" : null,
    deliveryStatus: n ? "inactive" : "active", spendUsd: new D(zero ? 0 : i ? "24.84" : "25.83"), resultCount: zero ? 0 : 1,
    purchaseCount: null, purchaseValueUsd: null, currentMetadata: null,
    attributionSetting: null, actionReportTime: feature ? "impression" : null, attributionWindows: [],
    impressions: 9007199254740993n, linkClicks: 3, clicksAll: 5, landingPageViews: 1, shopClicks: 0
  })));
  const policies = ["META_AD", "META_ADSET"].map(dataKind => ({ dataKind, connectionId, primarySource: "API", fromDate: date("2026-10-09"), toDate: null, connection: { externalAccountId: "SYNTHETIC" } }));
  const coverage = days.flatMap(day => ["META_AD", "META_ADSET"].map(dataKind => ({ connectionId, dataKind, metricDate: date(day), source: "API",
    state: dataKind === "META_AD" ? "FAILED" : "RUNNING", lastAttemptAt: date(day), lastSuccessAt: date(day) })));
  const log = (operation: string, query?: any) => { calls.push({ operation, query }); };
  const client: any = {
    metaAdsetDailyMetric: { findMany: async (query: any) => {
      log("adsets", query);
      return rows.filter(r => inRange(r.metricDate, query.where.metricDate) && (!query.where.deliveryStatus || r.deliveryStatus === query.where.deliveryStatus.equals)).map(r => ({
        ...r, ...(query.include?.product ? { product: r.productId ? query.include.product === true ? { id: "product", displayName: "Display:Product", isActive: false, name: "Other name", sortOrder: 99 } : { displayName: "Display:Product" } : null } : {}),
        ...(query.include?.metaAdset ? { metaAdset: { id: r.metaAdsetId, name: "Unused relation" } } : {})
      }));
    } },
    metaAdDailyMetric: { findMany: async (query: any) => { log("ad-descriptors", query); return []; } },
    productCostRule: { findMany: async () => { log("costs"); return [{ productId: "product", effectiveFrom: date("2026-01-01"), effectiveTo: null, salePriceKrw: new D("100000.25"), productCostKrw: new D("10.01"), shippingKrw: new D("20.02"), extraCostKrw: new D("0.03"), fxRateKrwPerUsd: new D("1350.1234") }]; } },
    productCpaRule: { findMany: async () => { log("cpas"); return []; } },
    exchangeRate: { findMany: async () => { log("fx"); return []; } },
    sourcePolicy: { findMany: async (query: any) => { log("policies", query); return feature ? policies.filter(p => typeof query.where.dataKind === "string" ? p.dataKind === query.where.dataKind : true) : []; } },
    sourceCoverage: { findMany: async (query: any) => { log("coverage", query); return coverage.filter(r => inRange(r.metricDate, query.where.metricDate)); } },
    $queryRaw: async (query: any) => {
      log("lineage", query);
      const kinds = [...new Set(query.values.filter((v: unknown) => v === "META_AD" || v === "META_ADSET"))] as string[];
      const bounds = [...new Set(query.values.filter((v: unknown) => typeof v === "string" && /^2026-\d{2}-\d{2}$/.test(v as string)))] as string[];
      return kinds.flatMap(dataKind => dataKind === missingKind ? [] : days.filter(day => (!bounds.length || day >= bounds[0] && day <= bounds[1])).map(day => ({ dataKind, connectionId, metricDate: date(day) })));
    },
    uploadRowError: { count: async () => { log("upload-errors"); return 2; } },
    decisionLog: { findMany: async () => { log("decisions"); return [{ id: "decision", decision: "WATCH", severity: 2, reason: "Synthetic" }]; } }
  };
  return { client, calls };
}
async function flag<T>(enabled: boolean, work: () => Promise<T>) {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = String(enabled);
  try { return await work(); } finally { if (saved === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
}
test("projection-only summary and all trend groupings exactly match frozen v4 for active/all/inactive, API/CSV, zero/empty and prior periods", async () => {
  const old = await before();
  const evidence: unknown[] = [];
  const stable = (value: any): any => value && typeof value === "object" ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
  for (const feature of [false, true]) for (const state of ["positive", "zero", "empty"]) await flag(feature, async () => {
    for (const delivery of ["all", "active", "inactive"]) {
      const a = fixture({ feature, zero: state === "zero", empty: state === "empty" }), b = fixture({ feature, zero: state === "zero", empty: state === "empty" });
      const previous = new old.Dashboard(a.client, new old.Decoration(a.client)), current = new DashboardMetricsService(b.client, new MetaAdsetMetricDecorationService(b.client));
      const summary = await current.dashboardSummary("2026-10-14", "2026-10-14", undefined, delivery), expectedSummary = await previous.dashboardSummary("2026-10-14", "2026-10-14", undefined, delivery);
      assert.deepEqual(summary, expectedSummary);
      evidence.push({ feature, state, delivery, endpoint: "summary", exact: true, actualSha256: hash(summary), expectedSha256: hash(expectedSummary) });
      for (const grouping of ["date", "stage", "product"]) {
        const trend = await current.dashboardTrends("2026-10-13", "2026-10-14", grouping, delivery), expectedTrend = await previous.dashboardTrends("2026-10-13", "2026-10-14", grouping, delivery);
        assert.deepEqual(trend, expectedTrend);
        evidence.push({ feature, state, delivery, endpoint: "trends", grouping, exact: true, actualSha256: hash(trend), expectedSha256: hash(expectedTrend) });
      }
    }
  });
  assert.equal(evidence.length, 72);
  if (process.env.PHASE10_DASHBOARD_PROJECTION_EVIDENCE) {
    assert(process.env.PHASE10_DASHBOARD_PROJECTION_EVIDENCE.startsWith("C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/"));
    writeFileSync(process.env.PHASE10_DASHBOARD_PROJECTION_EVIDENCE, JSON.stringify({ kind: "PHASE10_DASHBOARD_PROJECTION_FROZEN_V4_ORACLE", frozenSourceRoot: root, exactCases: 72, summaryCases: 18, trendCases: 54, rawResponsesSaved: false, fixturesSynthetic: true, httpRequests: 0, realDatabaseRequests: 0, cases: evidence }, null, 2) + "\n", { flag: "wx" });
  }
});
test("summary fetches no relations; product trend fetches displayName only; date/stage trend preserves signals with scalar rows", async () => flag(false, async () => {
  const f = fixture(), service = new DashboardMetricsService(f.client, new MetaAdsetMetricDecorationService(f.client));
  const summary = await service.dashboardSummary("2026-10-14", "2026-10-14", undefined, "all");
  assert.equal(f.calls.find(c => c.operation === "adsets")!.query.include, undefined);
  assert.deepEqual(summary.health, { unmatchedCount: 1, missingCostRuleCount: 0, missingCpaRuleCount: 1, missingExchangeRateCount: 0, uploadErrorCount: 2 });
  assert.equal(summary.decisions.topRecommendations[0].id, "decision");
  f.calls.length = 0;
  const product = await service.dashboardTrends("2026-10-13", "2026-10-14", "product", "all");
  assert.deepEqual(f.calls.find(c => c.operation === "adsets")!.query.include, { product: { select: { displayName: true } } });
  assert.deepEqual(new Set(product.map(r => r.group)), new Set(["Display", "미매칭"])); // Existing colon delimiter behavior remains unchanged.
  for (const group of ["date", "stage"]) { f.calls.length = 0; await service.dashboardTrends("2026-10-13", "2026-10-14", group, "all"); assert.equal(f.calls.find(c => c.operation === "adsets")!.query.include, undefined); }
}));
test("summary batch keeps kind separation, latest coverage status and failure/zero-day semantics with one fresh statement per call", async () => {
  const old = await before();
  await flag(true, async () => {
    for (const missingKind of ["", "META_AD", "META_ADSET"]) {
      const a = fixture({ feature: true, missingKind }), b = fixture({ feature: true, missingKind });
      const actual = await metaCollectionSummary(b.client, date("2026-10-14"), date("2026-10-14"));
      assert.deepEqual(actual, await old.collection(a.client, date("2026-10-14"), date("2026-10-14")));
      assert.equal(a.calls.filter(c => c.operation === "lineage").length, 2); assert.equal(b.calls.filter(c => c.operation === "lineage").length, 1);
      assert.equal(actual.items.find(r => r.dataKind === "META_AD")!.failedDays, 1); assert.equal(actual.items.find(r => r.dataKind === "META_ADSET")!.runningDays, 1);
      const second = await metaCollectionSummary(b.client, date("2026-10-14"), date("2026-10-14")); assert.deepEqual(second, actual); assert.equal(b.calls.filter(c => c.operation === "lineage").length, 2);
    }
  });
});
test("reduced projection retains missing selected-kind lineage 409, policy cap and feature-off no-query behavior", async () => {
  const old = await before();
  await flag(true, async () => {
    for (const isOld of [false, true]) {
      const f = fixture({ feature: true, missingKind: "META_ADSET" });
      const service = isOld ? new old.Dashboard(f.client, new old.Decoration(f.client)) : new DashboardMetricsService(f.client, new MetaAdsetMetricDecorationService(f.client));
      await assert.rejects(service.dashboardSummary("2026-10-14", "2026-10-14", undefined, "all"), (e: any) => e.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
    }
    const f = fixture({ feature: true }); f.client.sourcePolicy.findMany = async () => Array.from({ length: 401 }, () => ({}));
    await assert.rejects(metaCollectionSummary(f.client, date("2026-10-14"), date("2026-10-14")), (e: any) => e.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
  });
  await flag(false, async () => { const f = fixture(); assert.deepEqual(await metaCollectionSummary(f.client, date("2026-10-14"), date("2026-10-14")), { mode: "DISABLED", items: [] }); assert.equal(f.calls.length, 0); });
});
