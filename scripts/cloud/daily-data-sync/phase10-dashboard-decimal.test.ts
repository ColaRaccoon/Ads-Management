import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { Prisma, ReportType } from "@prisma/client";
import ExcelJS from "exceljs";
import { aggregateDashboardMetrics, compareMoney, divideMoney, DashboardMetricRow } from "../../../apps/api/src/metrics/dashboard-decimal-metrics";
import { MetaAdsetMetricDecorationService } from "../../../apps/api/src/metrics/meta-adset-metric-decoration.service";
import { DashboardMetricsService } from "../../../apps/api/src/metrics/dashboard-metrics.service";
import { ReportsService } from "../../../apps/api/src/reports/reports.service";
import { DecisionClassifier } from "../../../apps/api/src/domain/decision-classifier";
import { overallDashboardDecisionInput } from "../../../apps/api/src/decisions/overall-dashboard-decision";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DashboardController } from "../../../apps/api/src/metrics/dashboard.controller";
import { MetricsService } from "../../../apps/api/src/metrics/metrics.service";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const D = Prisma.Decimal, date = (day = "2026-10-14") => new Date(`${day}T00:00:00Z`);
function row(spend = "24.84", day = "2026-10-14"): DashboardMetricRow {
  return {
    metric: { id: "metric", source: "CSV", connectionId: null, productId: "p", product: { id: "p", displayName: "Synthetic" }, metaAdsetId: "a", metaAdset: {},
      metricDate: date(day), stage: "SC", deliveryStatus: "active", spendUsd: new D(spend), resultCount: 1,
      purchaseCount: null, purchaseValueUsd: null, impressions: 100n, linkClicks: 2, clicksAll: 4,
      landingPageViews: 1, shopClicks: 0, attributionSetting: null, actionReportTime: null, attributionWindows: [], metricUnavailableReasons: null } as any,
    metricDate: day, purchaseCount: 1, ruleStatus: "OK",
    costRule: { productId: "p", effectiveFrom: date("2026-01-01"), effectiveTo: null, salePriceKrw: new D("100000.25"), productCostKrw: new D("1200.01"),
      vatKrw: new D("999"), shippingKrw: new D("20.1"), extraCostKrw: new D("0.02"), fxRateKrwPerUsd: new D("1350.1234") } as any,
    cpaRule: { productId: "p", effectiveFrom: date("2026-01-01"), effectiveTo: null } as any,
    exchangeRate: null
  };
}
function fixture(rows: DashboardMetricRow[]) {
  let metricReads = 0;
  const client: any = {
    metaAdsetDailyMetric: { findMany: async ({ where }: any) => { metricReads++; return rows.map(r => r.metric).filter(r => r.metricDate >= where.metricDate.gte && r.metricDate <= where.metricDate.lte && (!where.deliveryStatus || r.deliveryStatus === where.deliveryStatus.equals)); } },
    productCostRule: { findMany: async () => [rows[0]?.costRule].filter(Boolean) }, productCpaRule: { findMany: async () => [rows[0]?.cpaRule].filter(Boolean) },
    exchangeRate: { findMany: async () => [] }, metaAdDailyMetric: { findMany: async () => [] }, sourcePolicy: { findMany: async () => [] },
    decisionLog: { findMany: async () => [] }, uploadRowError: { count: async () => 0 }
  };
  return { client, metricReads: () => metricReads };
}

test("200 raw Decimal rows serialize exact 4968.99 money, Int counts remain numbers and ratios separate", () => {
  const rows = Array.from({ length: 200 }, (_, i) => row(i === 199 ? "25.83" : "24.84"));
  const { totals } = aggregateDashboardMetrics(rows);
  const json = JSON.parse(JSON.stringify(totals));
  assert.equal(json.spendUsd, "4968.99"); assert.equal(json.spendKrw, "6708749.673366");
  assert.equal(json.revenueKrw, "20000050"); assert.equal(json.marginKrw, "11047269.326634");
  assert.equal(json.cpaUsd, "24.84495"); assert.equal(json.purchaseCount, 200);
  for (const key of ["spendUsd", "spendKrw", "revenueKrw", "marginKrw", "cpaUsd", "cpaKrw", "cpcLinkUsd", "cpcAllUsd"]) assert.equal(typeof json[key], "string", key);
  assert.equal(json.impressions, "20000");
  for (const key of ["purchaseCount", "linkClicks", "ctrLinkPct", "roas"]) assert.equal(typeof json[key], "number", key);
});
test("money beyond Number safe integer and fractional FX retain exact digits", () => {
  const input = row("9007199254740993.01"); input.exchangeRate = { rate: new D("1.000001") } as any;
  const total = aggregateDashboardMetrics([input]).totals;
  assert.equal(total.spendUsd, "9007199254740993.01"); assert.equal(total.spendKrw, "9007208261940247.75099301");
  const first = row(), second = row(); first.metric.impressions = 9007199254740993n; second.metric.impressions = 1n;
  const json = JSON.parse(JSON.stringify(aggregateDashboardMetrics([first, second]).totals));
  assert.equal(json.impressions, "9007199254740994"); assert.equal(typeof json.impressions, "string");
  assert.equal(json.ctrLinkPct, new D(400).div("9007199254740994").toNumber());
});
test("missing FX and unknown purchases propagate null, mixed attribution never becomes a certified zero", () => {
  const noFx = row("2"); noFx.exchangeRate = null; noFx.costRule!.fxRateKrwPerUsd = new D(0);
  const total = aggregateDashboardMetrics([noFx]).totals;
  assert.equal(total.spendKrw, null); assert.equal(total.cpaKrw, null); assert.equal(total.marginKrw, null);
  assert.equal(total.metricUnavailableReasons.spendKrw, "MISSING_EXCHANGE_RATE");
  const unknown = row(); unknown.purchaseCount = null;
  assert.equal(aggregateDashboardMetrics([unknown]).totals.revenueKrw, null);
  const api = row(); api.metric.source = "API"; api.metric.actionReportTime = "impression";
  const mixed = aggregateDashboardMetrics([row(), api]).totals;
  assert.equal(mixed.purchaseCount, null); assert.equal(mixed.revenueKrw, null); assert.equal(mixed.marginKrw, null); assert.equal(mixed.metricUnavailableReasons.purchaseCount, "MIXED_ATTRIBUTION");
});
test("zero/empty and comparison boundaries keep decimal strings and nullable ratios", () => {
  const empty = aggregateDashboardMetrics([]).totals;
  assert.equal(empty.spendUsd, "0"); assert.equal(empty.cpaUsd, null); assert.equal(empty.roas, null);
  assert.deepEqual(compareMoney("9007199254740993.02", "9007199254740993.01"), { current: "9007199254740993.02", previous: "9007199254740993.01", delta: "0.01", deltaPct: new D("0.01").div("9007199254740993.01").mul(100).toNumber() });
  assert.equal(compareMoney("1", "0").deltaPct, null); assert.equal(compareMoney(null, "0").delta, null);
  assert.equal(divideMoney("4968.99", 3), "1656.33"); assert.equal(divideMoney("0", 0), null);
});
test("financial availability is independent: known FX spend survives missing product cost, unknown totals never coalesce to zero", () => {
  for (const unmatched of [false, true]) {
    const input = row("2"); input.costRule = null; input.exchangeRate = { rate: new D("1350.1234") } as any;
    if (unmatched) { input.metric.productId = null; input.ruleStatus = "UNMATCHED"; } else input.ruleStatus = "MISSING_COST_RULE";
    const total = aggregateDashboardMetrics([input]).totals;
    assert.equal(total.spendKrw, "2700.2468"); assert.equal(total.revenueKrw, null); assert.equal(total.marginKrw, null);
    assert.equal(total.ruleStatus, unmatched ? "OK" : "CRITERIA_MISSING");
  }
  const noFx = row("2"); noFx.costRule!.fxRateKrwPerUsd = new D(0);
  assert.equal(aggregateDashboardMetrics([noFx]).totals.revenueKrw, "100000.25");
  assert.equal(aggregateDashboardMetrics([row("1"), noFx]).totals.spendKrw, null);
  noFx.purchaseCount = 0;
  assert.equal(aggregateDashboardMetrics([noFx]).totals.revenueKrw, "0"); assert.equal(aggregateDashboardMetrics([noFx]).totals.marginKrw, null);
  noFx.metric.spendUsd = new D(0);
  const zero = aggregateDashboardMetrics([noFx]).totals;
  assert.equal(zero.spendKrw, "0"); assert.equal(zero.revenueKrw, "0"); assert.equal(zero.marginKrw, "0"); assert.equal(zero.cpaKrw, null);
});
function providerMetadata() {
  const asset = { status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudgetRaw: null, lifetimeBudgetRaw: null, startTime: null, endTime: null, dailyBudgetSourceUnit: null, lifetimeBudgetSourceUnit: null };
  const metadata = { scope: "CURRENT_ACCESSIBLE_ASSETS", currencyCode: "USD", budgetUnit: "UNVERIFIED", campaign: asset, adset: asset, ad: null,
    sourceContext: { transport: "MCP", protocolVersion: "2025-06-18", actionReportTime: "MCP_PROVIDER_DEFAULT_UNVERIFIED", budgetValueFormat: "PROVIDER_DECIMAL",
      purchaseCountValueBasis: "SOURCE_SCALAR", purchaseValueBasis: "SOURCE_MONEY", rawPurchaseNull: false,
      purchaseMeasurement: { countField: "omni_purchase", valueField: "omni_purchase_values", definition: "ATTRIBUTED_OMNI_PURCHASE_EVENTS", reportContext: "MCP_PROVIDER_DEFAULT_UNVERIFIED", snapshotAtomic: false, aliasesCombined: false,
        zeroValuePremise: "EMPTY_PURCHASE_EVENT_SUM", providerScalarZeroObserved: false, derivedZeroAdCount: 0, accountPurchaseCount: 1, catalogSemanticFingerprint: "a".repeat(64), proofSemanticFingerprint: null,
        accountPurchaseValueUsd: "24.8400", adPurchaseValueUsd: "24.8400", selectedAdsetPurchaseValueUsd: "24.8400", parentMinusAdValueUsd: "0.0000" } } };
  return metadata;
}
test("provider purchase value money remains a separate exact string from product-price revenue", () => {
  const metadata = providerMetadata();
  const rows = Array.from({ length: 200 }, (_, i) => {
    const input = row(); input.metric.source = "API"; input.metric.actionReportTime = "MCP_PROVIDER_DEFAULT_UNVERIFIED";
    input.metric.currentMetadata = metadata; input.metric.purchaseCount = 1; input.metric.purchaseValueUsd = new D(i === 199 ? "25.8300" : "24.8400");
    return input;
  });
  const total = aggregateDashboardMetrics(rows).totals;
  assert.equal(total.providerPurchaseValueUsd, "4968.99"); assert.equal(total.providerPurchaseCount, 200); assert.equal(total.providerPurchaseDerivedZeroCount, 0);
  assert.equal(total.revenueKrw, "20000050"); assert.equal(typeof total.providerPurchaseRoas, "number"); assert.equal(typeof total.providerPurchaseCpaUsd, "string");
});
test("actual DashboardMetricsService summary, averages, comparisons and trends avoid legacy Number decoration", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  try {
    const rows = [row("24.84"), row("25.83"), row("1.1", "2026-10-13")], f = fixture(rows);
    const decoration = new MetaAdsetMetricDecorationService(f.client);
    decoration.decorate = async () => { throw new Error("LEGACY_NUMBER_PATH_FORBIDDEN"); };
    const service = new DashboardMetricsService(f.client, decoration);
    const summary = await service.dashboardSummary("2026-10-14", "2026-10-14", undefined, "all");
    assert.equal(summary.totals.spendUsd, "50.67"); assert.equal(summary.totals.spendKrw, "68410.752678");
    assert.equal(summary.averages.dailySpendKrw, summary.totals.spendKrw); assert.equal(summary.totals.purchaseCount, 2);
    assert.equal(summary.comparisons.previousDay.spendKrw.delta, "66925.616938"); assert.equal(f.metricReads(), 1);
    const trend = await service.dashboardTrends("2026-10-14", "2026-10-14", "stage", "all");
    assert.equal(trend[0].spendUsd, "50.67"); assert.equal(trend[0].group, "SC"); assert.equal(trend[0].spendKrw, summary.totals.spendKrw);
  } finally { if (saved === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});
test("actual dashboard reader retains source-selection fail-closed guard", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const f = fixture([row()]); f.client.sourcePolicy.findMany = async () => [{ connectionId: "isolation", dataKind: "META_ADSET", primarySource: "API", fromDate: date("2026-01-01"), toDate: null }];
    f.client.sourceCoverage = { findMany: async () => [] }; f.client.$queryRaw = async () => [];
    await assert.rejects(new MetaAdsetMetricDecorationService(f.client).dashboardMetrics(date(), date()), (error: any) => error.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
  } finally { if (saved === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});

test("union query matches frozen decimal-v1 output across effective rules, month boundary, delivery status and empty periods", async () => {
  const base = "C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v1/apps/api/src/metrics/";
  const beforeDash = await import(pathToFileURL(base + "dashboard-metrics.service.ts").href), beforeDecoration = await import(pathToFileURL(base + "meta-adset-metric-decoration.service.ts").href);
  const OldDashboard = beforeDash.DashboardMetricsService ?? beforeDash.default?.DashboardMetricsService;
  const OldDecoration = beforeDecoration.MetaAdsetMetricDecorationService ?? beforeDecoration.default?.MetaAdsetMetricDecorationService;
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  try {
    const rows = ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].map((day, i) => { const input = row(i % 2 ? "0.01" : "1.1", day); input.metric.deliveryStatus = i % 2 ? "inactive" : "active"; return input; });
    const oldCost = { ...rows[0].costRule!, effectiveFrom: date("2026-09-01"), effectiveTo: date("2026-09-30"), salePriceKrw: new D("100.01") };
    const newCost = { ...oldCost, effectiveFrom: date("2026-10-01"), effectiveTo: null, salePriceKrw: new D("200.02") };
    for (const [from, to] of [["2026-09-30", "2026-10-02"], ["2026-10-01", "2026-10-01"], ["2026-10-04", "2026-10-05"]]) for (const status of ["all", "active", "inactive"]) {
      const before = fixture(rows), after = fixture(rows);
      for (const f of [before, after]) f.client.productCostRule.findMany = async () => [newCost, oldCost];
      const expected = await new OldDashboard(before.client, new OldDecoration(before.client)).dashboardSummary(from, to, undefined, status);
      const actual = await new DashboardMetricsService(after.client, new MetaAdsetMetricDecorationService(after.client)).dashboardSummary(from, to, undefined, status);
      assert.deepEqual(actual, expected, `${from}/${to}/${status}`); assert.equal(before.metricReads(), 2); assert.equal(after.metricReads(), 1);
    }
  } finally { if (saved === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});
test("provider fast path preserves source guards and mixed same-key legacy correction", async () => {
  const provider = row(), fallback = row();
  provider.metric.source = "API"; provider.metric.actionReportTime = "MCP_PROVIDER_DEFAULT_UNVERIFIED"; provider.metric.currentMetadata = providerMetadata();
  provider.metric.purchaseCount = 1; provider.metric.purchaseValueUsd = new D("24.84");
  const f = fixture([provider, fallback]), decoration: any = new MetaAdsetMetricDecorationService(f.client);
  const selected: any[] = [];
  decoration.selectedDashboardMetrics = async () => selected;
  const observedFallback: any[] = [];
  decoration.correctedAdsetPurchaseCounts = async (metrics: any[]) => { observedFallback.push(metrics.map(r => r.id)); return metrics.length ? new Map([["2026-10-14:a", 7]]) : new Map(); };
  provider.metric.id = "provider"; fallback.metric.id = "fallback";
  selected.push(provider.metric);
  assert.equal((await decoration.dashboardMetrics(date(), date()))[0].purchaseCount, 1); assert.equal(observedFallback.length, 0);
  selected.push(fallback.metric);
  const mixed = await decoration.dashboardMetrics(date(), date());
  assert.deepEqual(observedFallback.pop(), ["provider", "fallback"]); assert.deepEqual(mixed.map((r: any) => r.purchaseCount), [1, 7]);
  assert.equal(aggregateDashboardMetrics(mixed).totals.purchaseCount, null); // API/CSV attribution remains mixed.
  fallback.metric.source = "API"; fallback.metric.actionReportTime = "MCP_PROVIDER_DEFAULT_UNVERIFIED"; fallback.metric.currentMetadata = null;
  const partial = await decoration.dashboardMetrics(date(), date());
  assert.deepEqual(observedFallback.pop(), ["provider", "fallback"]); assert.deepEqual(partial.map((r: any) => r.purchaseCount), [1, 7]);
});
test("provider-complete compact descriptors preserve missing-lineage, duplicate-policy and unbound-CSV 409", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    for (const failure of ["missing-lineage", "duplicate-policy", "unbound-csv"]) {
      const input = row(); input.metric.source = "API"; input.metric.currentMetadata = providerMetadata(); input.metric.actionReportTime = "MCP_PROVIDER_DEFAULT_UNVERIFIED";
      input.metric.purchaseCount = 1; input.metric.purchaseValueUsd = new D(1);
      const f = fixture([input]); const conn = "00000000-0000-4000-8000-000000000001";
      const p = { connectionId: conn, primarySource: "API", fromDate: date("2026-01-01"), toDate: null };
      f.client.sourcePolicy.findMany = async () => failure === "duplicate-policy" ? [p, p] : [p];
      f.client.sourceCoverage = { findMany: async () => [] }; f.client.$queryRaw = async () => [];
      let projection: unknown;
      f.client.metaAdDailyMetric.findMany = async (args: any) => { projection = args.select; return [{ metricDate: date(), source: failure === "unbound-csv" ? "CSV" : "API", connectionId: failure === "unbound-csv" ? null : conn }]; };
      const decoration: any = new MetaAdsetMetricDecorationService(f.client); decoration.selectedDashboardMetrics = async () => [input.metric];
      await assert.rejects(decoration.dashboardMetrics(date(), date()), (error: any) => error.getResponse?.().code === "SOURCE_SELECTION_REQUIRED", failure);
      assert.deepEqual(projection, { metricDate: true, source: true, connectionId: true });
    }
  } finally { if (saved === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});
test("union guard windows exclude cross-period adset keys and preserve old single-window scope", async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const rows = [row("1", "2026-10-13"), row("2", "2026-10-14")];
    rows.forEach((r, i) => { r.metric.metaAdsetId = i ? "current" : "previous"; r.metric.source = "API"; r.metric.currentMetadata = providerMetadata(); r.metric.actionReportTime = "MCP_PROVIDER_DEFAULT_UNVERIFIED"; r.metric.purchaseCount = 1; r.metric.purchaseValueUsd = new D(1); });
    const inactive = row("3", "2026-10-14"); inactive.metric.metaAdsetId = "inactive"; inactive.metric.deliveryStatus = "inactive";
    rows.push(inactive);
    const candidates = [
      { metricDate: date("2026-10-13"), metaAdsetRefId: "previous", source: "CSV", connectionId: null },
      { metricDate: date("2026-10-14"), metaAdsetRefId: "current", source: "CSV", connectionId: null },
      { metricDate: date("2026-10-14"), metaAdsetRefId: "previous", source: "API", connectionId: "unselected-invalid-source" },
      { metricDate: date("2026-10-14"), metaAdsetRefId: "inactive", source: "API", connectionId: "unselected-inactive-source" }
    ];
    const f = fixture(rows); const scopes: any[] = [];
    const matches = (r: any, w: any): boolean => w.OR ? w.OR.some((part: any) => matches(r, part)) : w.metricDate.in.some((d: Date) => +d === +r.metricDate) && w.metaAdsetRefId.in.includes(r.metaAdsetRefId);
    f.client.metaAdDailyMetric.findMany = async ({ where }: any) => { scopes.push(where); return candidates.filter(r => matches(r, where)); };
    const decoration: any = new MetaAdsetMetricDecorationService(f.client);
    decoration.selectedDashboardMetrics = async (from: Date, to: Date, delivery: string) => rows.map(r => r.metric).filter(r => r.metricDate >= from && r.metricDate <= to && (delivery === "all" || r.deliveryStatus === delivery));
    const windows = [{ fromDate: date("2026-10-14"), toDate: date("2026-10-14") }, { fromDate: date("2026-10-13"), toDate: date("2026-10-13") }];
    const union = await decoration.dashboardMetrics(date("2026-10-13"), date("2026-10-14"), "active", f.client, windows);
    assert.equal(union.length, 2); assert.equal(scopes[0].OR.length, 2);
    assert.deepEqual(candidates.filter(r => matches(r, scopes[0])).map(r => r.source), ["CSV", "CSV"]);
    for (const window of windows) assert.equal((await decoration.dashboardMetrics(window.fromDate, window.toDate, "active", f.client)).length, 1);
    await assert.rejects(decoration.dashboardMetrics(date("2026-10-13"), date("2026-10-14"), "active", f.client), (error: any) => error.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
    await assert.rejects(decoration.dashboardMetrics(date("2026-10-13"), date("2026-10-14"), "all", f.client, windows), (error: any) => error.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
    await assert.rejects(decoration.dashboardMetrics(date("2026-10-13"), date("2026-10-14"), "active", f.client, windows.slice(0, 1)), /DASHBOARD_GUARD_WINDOW_MISMATCH/);
  } finally { if (saved === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});

test("actual report HTML and XLSX consume decimal strings including negative/large money without coercion", async () => {
  const totals = aggregateDashboardMetrics([row("9007199254740993.01")]).totals;
  const summary = { totals, health: { unmatchedCount: 0, missingCostRuleCount: 0, missingCpaRuleCount: 0 }, metaCollection: { mode: "DISABLED", items: [] } };
  const service: any = Object.create(ReportsService.prototype);
  service.metricsService = { dashboardSummary: async () => summary, productMetrics: async () => [], adsetMetrics: async () => [], unmatchedMetrics: async () => [] };
  service.assertReportSourceRows = async () => {}; service.reportSnapshot = (work: any) => work({ decisionLog: { findMany: async () => [] }, changeLog: { findMany: async () => [] } });
  const html = await service.renderHtml("2026-10-14", "2026-10-14");
  assert(html.includes("9,007,199,254,740,993.01")); assert(html.includes(totals.marginKrw!.split(".")[1]));
  const workbook = await service.renderWorkbook("2026-10-14", "2026-10-14", ReportType.PERIOD_XLSX);
  const reopened = new ExcelJS.Workbook(); await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = reopened.getWorksheet("Summary")!;
  assert.equal(sheet.getCell("B4").value, totals.spendUsd); assert.equal(sheet.getCell("B5").value, totals.spendKrw);
  assert.equal(sheet.getCell("B6").value, 1); assert.equal(sheet.getCell("B9").value, totals.marginKrw);
  assert.equal(typeof sheet.getCell("B9").value, "string"); assert.equal(sheet.getCell("B9").type, ExcelJS.ValueType.String);
});

test("OVERALL adapter preserves positive/negative/zero/null and arbitrary-precision margin sign decisions", () => {
  const classifier = new DecisionClassifier();
  for (const [margin, expected] of [["1", ["PROFIT"]], ["-1", ["LOSS", "STOP_CANDIDATE"]], ["0", ["LOSS"]], [null, []], ["9007199254740993.01", ["PROFIT"]], ["-0.0000000000000000000001", ["LOSS", "STOP_CANDIDATE"]]] as const) {
    const input = overallDashboardDecisionInput({ purchaseCount: 1, marginKrw: margin, dataDays: 2, ctrLinkPct: 0, landingPageViews: 0, goodCtrLinkPct: 1, goodLandingPageViewCount: 1 });
    assert.deepEqual(classifier.classify(input).map(r => r.decision), expected);
    assert.equal(input.scopeType, "OVERALL"); assert.equal(input.stage, "UNKNOWN"); assert.equal(input.stopCpaKrw, null);
  }
  const polluted = overallDashboardDecisionInput({ scopeType: "ADSET", stage: "SC", targetCpaKrw: 100, stopCpaKrw: 1, spendKrw: 999, cpaKrw: 999, purchaseCount: null, marginKrw: "-1", dataDays: 2 } as any);
  assert.equal(polluted.scopeType, "OVERALL"); assert.equal(polluted.stage, "UNKNOWN"); assert.equal(polluted.targetCpaKrw, null); assert.equal(polluted.stopCpaKrw, null);
  assert.deepEqual(classifier.classify(polluted), []);
});

test("local Nest HTTP sample: real dashboard controller/service, synthetic 200-row DB, 40 requests/concurrency4", { skip: process.env.PHASE10_ALLOW_LOCAL_HTTP !== "true" }, async () => {
  const saved = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  const f = fixture(Array.from({ length: 200 }, (_, i) => row(i === 199 ? "25.83" : "24.84")));
  const service = new DashboardMetricsService(f.client, new MetaAdsetMetricDecorationService(f.client));
  class LocalDashboardModule {}
  Module({ controllers: [DashboardController], providers: [{ provide: MetricsService, useValue: service }] })(LocalDashboardModule);
  // tsx does not emit design:paramtypes. Bind the actual controller's sole DI token explicitly.
  Reflect.defineMetadata("design:paramtypes", [MetricsService], DashboardController);
  const app = await NestFactory.create(LocalDashboardModule, { logger: false });
  try {
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl(), paths = ["/dashboard/summary?from=2026-10-14&to=2026-10-14&deliveryStatus=all", "/dashboard/trends?from=2026-10-14&to=2026-10-14&deliveryStatus=all"];
    for (const path of paths) { const response = await fetch(origin + path); assert.equal(response.status, 200); await response.text(); }
    const samples: { endpoint: string; status: number; durationMs: number; bytes: number }[] = [];
    let next = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (true) {
        const index = next++; if (index >= 40) return;
        const at = performance.now(), endpoint = index % 2 ? "trends" : "summary";
        const response = await fetch(origin + paths[index % 2]), text = await response.text(), json = JSON.parse(text);
        const total = Array.isArray(json) ? json[0] : json.totals;
        assert.equal(response.status, 200); assert.equal(total.spendUsd, "4968.99"); assert.equal(total.spendKrw, "6708749.673366");
        samples.push({ endpoint, status: response.status, durationMs: performance.now() - at, bytes: Buffer.byteLength(text) });
      }
    }));
    const summary = (rows: typeof samples) => ({ requests: rows.length, errors: rows.filter(r => r.status !== 200).length,
      p95Ms: rows.map(r => r.durationMs).sort((a, b) => a - b)[Math.ceil(rows.length * .95) - 1], responseBytes: rows.reduce((n, r) => n + r.bytes, 0) });
    const files = ["apps/api/src/metrics/dashboard-decimal-metrics.ts", "apps/api/src/metrics/dashboard-metrics.service.ts", "apps/api/src/metrics/meta-adset-metric-decoration.service.ts", "scripts/cloud/daily-data-sync/phase10-dashboard-decimal.test.ts"];
    const receipt = { kind: "PHASE10_LOCAL_NEST_DASHBOARD_DECIMAL_SAMPLE", observedAt: new Date().toISOString(), host: "127.0.0.1", requests: 40, concurrency: 4, warmupRequests: 2,
      durationMs: performance.now() - started, total: summary(samples), perEndpoint: Object.fromEntries(["summary", "trends"].map(e => [e, summary(samples.filter(r => r.endpoint === e))])),
      syntheticDatabase: true, syntheticRows: 200, realNestControllerAndService: true, authenticationExercised: false, realDatabaseRequests: 0, remoteRequests: 0,
      remoteAcceptanceClaimed: false, sameAsRemoteMixedRouteLoad: false, sourceHashes: Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])), samples };
    if (process.env.PHASE10_DASHBOARD_LOCAL_EVIDENCE) {
      assert(process.env.PHASE10_DASHBOARD_LOCAL_EVIDENCE.startsWith("C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/"));
      writeFileSync(process.env.PHASE10_DASHBOARD_LOCAL_EVIDENCE, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    }
    console.log(JSON.stringify({ kind: receipt.kind, total: receipt.total, perEndpoint: receipt.perEndpoint, remoteAcceptanceClaimed: false }));
  } finally { await app.close(); if (saved === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = saved; }
});
