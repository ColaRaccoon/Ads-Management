import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { Reflector } from "@nestjs/core";
import { ExecutionContext } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { PermissionGuard } from "../auth/permission.guard";
import { permissionsForRole } from "../auth/role-permissions";
import { StorefrontController } from "./storefront.controller";
import { StorefrontControlService } from "./storefront-control.service";
import { legacyRevenue, StorefrontDecimal, StorefrontReadService, storefrontRange } from "./storefront-read.service";

const dec = (value: string | number) => new Prisma.Decimal(value);
const date = new Date("2026-10-07T00:00:00.000Z");
const id = "00000000-0000-4000-8000-000000000001";
const connection = (provider: "GOOGLE" | "META" | "CAFE24", accountId = provider) => ({
  id: accountId, provider, displayName: provider, externalAccountId: "account", currencyCode: provider === "META" ? "USD" : "KRW",
  timeZone: "Asia/Seoul", accessState: "READY", enabled: true, updatedAt: date, credentialExpiresAt: null, runs: [], coverage: []
});
function fixture() {
  const data = { connections: [connection("GOOGLE"), connection("META"), connection("CAFE24")],
    coverage: [] as any[], policies: [] as any[], google: [] as any[], meta: [] as any[], cafe: [] as any[],
    rates: [] as any[], costs: [] as any[] };
  const tx = {
    $queryRaw: async () => data.connections.map(c => ({ ...c, latestSuccessAt: (c.coverage as any[])[0]?.lastSuccessAt ?? null,
      latestRunId: (c.runs as any[])[0]?.id ?? null, latestRunStatus: (c.runs as any[])[0]?.status ?? null,
      latestRunStartedAt: (c.runs as any[])[0]?.startedAt ?? null, latestRunSafeErrorCode: (c.runs as any[])[0]?.safeErrorCode ?? null })),
    sourceConnection: { findMany: async () => data.connections },
    sourceCoverage: { findMany: async () => data.coverage },
    sourcePolicy: { findMany: async () => data.policies },
    googleCampaignDailyCost: { findMany: async () => data.google },
    metaAdsetDailyMetric: { findMany: async () => data.meta },
    cafe24UploadBatch: { findMany: async () => [{ id: "batch", rowCount: data.cafe.length, _count: { rows: data.cafe.length } }] },
    cafe24OrderLine: { findMany: async () => data.cafe },
    exchangeRate: { findMany: async () => data.rates }, productCostRule: { findMany: async () => data.costs },
    runUnit: { findMany: async () => [{ runId: "success", unitKey: "2026-10-07", publishedCount: data.google.length, run: { connectionId: "GOOGLE" } }] }
  };
  const prisma = { $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } as unknown as PrismaService;
  return { data, tx, service: new StorefrontReadService(prisma) };
}
function googleRow(micros = 1_000_000n) {
  return { id, connectionId: "GOOGLE", source: "CSV", metricDate: date, costMicros: micros,
    campaignId: "campaign", campaignName: "Test campaign", channelType: "SEARCH", impressions: 9007199254740993n,
    clicks: 12n, fetchedAt: date, syncRunId: "success" };
}
function cafeRow() {
  return { id, connectionId: "CAFE24", source: "CSV", orderDate: date, productId: "product", product: { isActive: true },
    quantity: dec(2), salePriceKrw: dec(10000), matchRule: null, createdAt: date };
}
function metaRow(value = "1.25") {
  return { id, connectionId: "META", source: "CSV", metricDate: date, spendUsd: dec(value), productId: null, createdAt: date };
}
test("legacy matched-only revenue preserves effective price, override, bundle fallback and inactive exclusions", () => {
  const line = cafeRow();
  assert.equal(legacyRevenue(line, { salePriceKrw: dec(9000) })?.toString(), "18000");
  const bundle = { ...line, matchRule: { displayName: "1+1", optionIncludeKeywords: [], productNameAliases: [], salePriceKrwOverride: null } };
  assert.equal(legacyRevenue(bundle, null)?.toString(), "40000");
  assert.equal(legacyRevenue(bundle, { salePriceKrw: dec(9000) })?.toString(), "18000");
  assert.equal(legacyRevenue({ ...bundle, matchRule: { ...bundle.matchRule, salePriceKrwOverride: dec(7000) } }, null)?.toString(), "14000");
  assert.equal(legacyRevenue({ ...line, productId: null }, null), null);
  assert.equal(legacyRevenue({ ...line, product: { isActive: false } }, null), null);
});
test("money clone retains micros at the maximum 50k BigInt accumulation without changing Prisma globals", () => {
  const precision = Prisma.Decimal.precision;
  const high = 9223372036854775807n;
  let value = new StorefrontDecimal(0);
  for (let i = 0; i < 50_000; i++) value = value.plus(new StorefrontDecimal((i === 49_999 ? high - 1n : high).toString()).div(1_000_000));
  assert.equal(value.toFixed(6), "461168601842738790.349999");
  assert.equal(Prisma.Decimal.precision, precision);
});
test("92-day inclusive read bound and invalid calendar dates fail closed", () => {
  assert.equal(storefrontRange("2026-07-01", "2026-09-30").from, "2026-07-01");
  assert.throws(() => storefrontRange("2026-07-01", "2026-10-01"));
  assert.throws(() => storefrontRange("2026-02-30", "2026-03-01"));
});
test("read-only summary uses only selected Meta adsets, exact micros and Cafe24 legacy revenue; Kakao stays unknown", async () => {
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  const { data, service } = fixture();
  data.google = [googleRow(9007199254740993n)]; data.meta = [metaRow()]; data.cafe = [cafeRow()];
  data.rates = [{ rateDate: date, rate: dec(1400), sourceDate: date, provider: "KOREA_EXIM", fallbackType: "EXACT", fetchedAt: date }];
  const result = await service.summary("2026-10-07", "2026-10-07");
  assert.equal(result.totals.revenueKrw, "20000");
  assert.equal(result.channels.find(c => c.provider === "META")?.amount, "1.25");
  assert.equal(result.totals.knownSpendKrw, "9007201004.740993");
  assert.equal(result.googleCampaigns[0].impressions, "9007199254740993");
  assert.equal(result.googleCampaigns[0].costMicros, "9007199254740993");
  assert.equal(result.complete, false); assert.equal(result.totals.totalSpendKrw, null); assert.equal(result.totals.mer, null);
  assert.equal(result.channels.find(c => c.provider === "KAKAO")?.state, "NOT_CONNECTED");
  assert.equal(result.channels.find(c => c.provider === "KAKAO")?.amount, null);
  assert.ok(result.missingSources.includes("KAKAO"));
  assert.equal(JSON.stringify(result).includes("credentialRef"), false);
});
test("missing FX keeps known Google spend and refuses a complete converted Meta subtotal", async () => {
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  const { data, service } = fixture(); data.google = [googleRow()]; data.meta = [metaRow()]; data.cafe = [cafeRow()];
  const result = await service.summary("2026-10-07", "2026-10-07");
  assert.equal(result.currencyStatus, "MISSING_EXCHANGE_RATE");
  assert.equal(result.channels.find(c => c.provider === "META")?.spendKrw, null);
  assert.equal(result.totals.knownSpendKrw, "1"); assert.equal(result.totals.mer, null);
});
test("legacy product FX provenance preserves different product rates and inactive products cannot borrow them", async () => {
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  const { data, service } = fixture();
  data.meta = [
    { ...metaRow("1"), productId: "first", product: { isActive: true, displayName: "First" } },
    { ...metaRow("1"), id: "second", productId: "second", product: { isActive: true, displayName: "Second" } }
  ];
  data.costs = ["first", "second"].map((productId, index) => ({ id: productId, productId, effectiveFrom: date, effectiveTo: null,
    createdAt: date, updatedAt: date, salePriceKrw: dec(1), fxRateKrwPerUsd: dec(index ? 1300 : 1400) }));
  let result = await service.summary("2026-10-07", "2026-10-07");
  assert.equal(result.daily[0].metaSpendKrw, "2700");
  assert.deepEqual(result.exchangeRates.map(r => [r.productId, r.rate, r.provider]), [["first", "1400", "PRODUCT_COST_RULE"], ["second", "1300", "PRODUCT_COST_RULE"]]);
  data.meta[0].product.isActive = false;
  result = await service.summary("2026-10-07", "2026-10-07");
  assert.equal(result.daily[0].metaSpendKrw, null); assert.equal(result.currencyStatus, "MISSING_EXCHANGE_RATE");
});
test("complete API Google zero differs from absent coverage, failed latest attempt preserves success", async () => {
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  const { data, service } = fixture(); data.connections = [connection("GOOGLE")];
  data.policies = [{ connectionId: "GOOGLE", dataKind: "GOOGLE_CAMPAIGN", primarySource: "API", fromDate: date, toDate: null }];
  data.coverage = [{ connectionId: "GOOGLE", dataKind: "GOOGLE_CAMPAIGN", metricDate: date, source: "API",
    state: "FAILED", lastSuccessRunId: "success", lastSuccessAt: date, lastAttemptAt: new Date("2026-10-08"),
    lastAttemptRun: { status: "FAILED" }, rowCount: 0, totalAmount: dec(0), warningCodes: [] }];
  let result = await service.summary("2026-10-07", "2026-10-07");
  assert.equal(result.channels.find(c => c.provider === "GOOGLE")?.amount, "0");
  assert.equal(result.coverage[0].complete, true); assert.equal(result.coverage[0].lastAttemptStatus, "FAILED");
  data.coverage = [];
  result = await service.summary("2026-10-07", "2026-10-07");
  assert.equal(result.channels.find(c => c.provider === "GOOGLE")?.amount, null);
  assert.equal(result.coverage[0].complete, false);
});
test("overlapping source policies refuse amounts without fallback to CSV", async () => {
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  const { data, service } = fixture(); data.google = [googleRow()];
  data.policies = ["CSV", "API"].map(source => ({ connectionId: "GOOGLE", dataKind: "GOOGLE_CAMPAIGN", primarySource: source, fromDate: date, toDate: null }));
  const result = await service.summary("2026-10-07", "2026-10-07");
  assert.equal(result.channels.find(c => c.provider === "GOOGLE")?.amount, null);
  assert.ok(result.warningCodes.includes("SOURCE_SELECTION_REQUIRED"));
});
test("Google current rows without a bound successful publish cannot be exposed as known spend", async () => {
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  const { data, service } = fixture(); data.google = [{ ...googleRow(), source: "API" }];
  data.policies = [{ connectionId: "GOOGLE", dataKind: "GOOGLE_CAMPAIGN", primarySource: "API", fromDate: date, toDate: null }];
  const result = await service.summary("2026-10-07", "2026-10-07");
  assert.equal(result.channels.find(c => c.provider === "GOOGLE")?.amount, null);
  assert.equal(result.googleCampaigns.length, 0); assert.equal(result.totals.knownSpendKrw, null);
});
test("CSV selection never labels shadow API coverage as selected CSV success", async () => {
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  const { data, service } = fixture(); data.google = [googleRow()];
  data.coverage = [{ connectionId: "GOOGLE", dataKind: "GOOGLE_CAMPAIGN", metricDate: date, source: "API",
    state: "COMPLETE_ZERO", lastSuccessAt: date, totalAmount: dec(0), rowCount: 0, warningCodes: ["SHADOW"] }];
  const row = (await service.summary("2026-10-07", "2026-10-07")).coverage.find(c => c.provider === "GOOGLE")!;
  assert.equal(row.selectedSource, "CSV"); assert.equal(row.state, "COMPLETE_NONZERO"); assert.equal(row.amount, null);
  assert.equal(row.warningCodes.includes("SHADOW"), false);
});
test("mismatched currency/time zone makes converted totals unavailable", async () => {
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  const { data, service } = fixture(); data.google = [googleRow()]; data.connections[0].timeZone = "America/New_York";
  const result = await service.summary("2026-10-07", "2026-10-07");
  assert.equal(result.currencyStatus, "INCOMPATIBLE_SCOPE"); assert.equal(result.daily[0].googleSpendKrw, null);
});
test("server permission guard keeps data reads, imports and connection settings separate", () => {
  const guard = new PermissionGuard(new Reflector());
  const allowed = (method: keyof StorefrontController, role: "USER" | "ADMIN" | "SUPER_ADMIN") => {
    const context = { getHandler: () => StorefrontController.prototype[method], switchToHttp: () => ({ getRequest: () => ({ authenticatedUser: { permissions: permissionsForRole(role) } }) }) } as unknown as ExecutionContext;
    try { return guard.canActivate(context); } catch { return false; }
  };
  assert.equal(allowed("summary", "USER"), true); assert.equal(allowed("runs", "USER"), false);
  assert.equal(allowed("runs", "ADMIN"), true); assert.equal(allowed("enabled", "ADMIN"), false);
  assert.equal(allowed("enabled", "SUPER_ADMIN"), true);
});
test("connection pause/resume checks lease, stale version, access and audit under the canonical lock", async () => {
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  process.env.DAILY_SYNC_ALLOWED_ACCOUNTS = '["GOOGLE/account/default"]';
  let active = false, audits = 0;
  const c = { ...connection("GOOGLE"), id, shopKey: "default", credentialRef: "protected-reference", enabled: true };
  const tx = { $queryRaw: async () => [{ id }], sourceConnection: { findUnique: async () => c,
    update: async ({ data }: any) => Object.assign(c, data, { updatedAt: new Date(c.updatedAt.getTime() + 1) }) },
    syncLease: { findFirst: async () => active ? { connectionId: id } : null },
    sourcePolicy: { findMany: async () => [{ id: "policy" }] },
    securityAuditEvent: { create: async () => { audits++; } } };
  const service = new StorefrontControlService({ $transaction: async (fn: any) => fn(tx) } as unknown as PrismaService);
  const original = c.updatedAt.toISOString();
  active = true; await assert.rejects(service.setEnabled(id, { enabled: false, expectedUpdatedAt: original }, "actor"));
  assert.equal(audits, 0); active = false;
  const paused = await service.setEnabled(id, { enabled: false, expectedUpdatedAt: original }, "actor");
  assert.equal(paused.enabled, false); assert.equal(audits, 1);
  await assert.rejects(service.setEnabled(id, { enabled: true, expectedUpdatedAt: original }, "actor"));
  const resumed = await service.setEnabled(id, { enabled: true, expectedUpdatedAt: paused.updatedAt }, "actor");
  assert.equal(resumed.enabled, true); assert.equal(audits, 2);
  c.enabled = false; c.accessState = "PENDING";
  await assert.rejects(service.setEnabled(id, { enabled: true, expectedUpdatedAt: c.updatedAt.toISOString() }, "actor"));
  assert.equal(audits, 2);
});
