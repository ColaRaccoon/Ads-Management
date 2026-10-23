import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { Reflector } from "@nestjs/core";
import { PermissionGuard } from "../../../apps/api/src/auth/permission.guard";
import { ROLE_PERMISSIONS } from "../../../apps/api/src/auth/role-permissions";
import { StorefrontController } from "../../../apps/api/src/storefront/storefront.controller";
import { StorefrontReadService, StorefrontDecimal, legacyRevenue, storefrontRange } from "../../../apps/api/src/storefront/storefront-read.service";

const D = Prisma.Decimal;
const date = new Date("2026-10-07T00:00:00Z");
const stamp = new Date("2026-10-08T00:00:00Z");
function fixture(overrides: Record<string, unknown> = {}) {
  const data: any = { sourceConnection: [], sourceCoverage: [], sourcePolicy: [],
    googleCampaignDailyCost: [], metaAdsetDailyMetric: [], cafe24UploadBatch: [],
    exchangeRate: [], productCostRule: [], cafe24OrderLine: [], runUnit: [], ...overrides };
  const tx: any = {};
  for (const [model, rows] of Object.entries(data)) tx[model] = { findMany: async () => rows };
  const client: any = { $transaction: async (action: any, options: any) => {
    assert.equal(options.isolationLevel, "RepeatableRead");
    return action(tx);
  } };
  return new StorefrontReadService(client);
}
const google = (costMicros: bigint, index = 0) => ({ id: `g${index}`, source: "CSV", connectionId: null,
  metricDate: date, costMicros, campaignId: `campaign-${index}`, campaignName: "Synthetic campaign",
  channelType: "SEARCH", impressions: 0n, clicks: 0n, fetchedAt: stamp });

test("independent: full 50,000-row signed-BigInt micros aggregate is exact to six places", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  try {
    const max = 9223372036854775807n;
    const rows = Array.from({ length: 50_000 }, (_, i) => google(i === 49_999 ? max - 1n : max, i));
    const result = await fixture({ googleCampaignDailyCost: rows }).summary("2026-10-07", "2026-10-07");
    assert.equal(result.channels.find(c => c.provider === "GOOGLE")!.amount, "461168601842738790.349999");
    assert.equal(result.totals.knownSpendKrw, "461168601842738790.349999");
  } finally { if (previous == null) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("independent: never turn Kakao not connected into verified total or MER", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  try {
    const result = await fixture({ googleCampaignDailyCost: [google(0n)],
      metaAdsetDailyMetric: [{ source: "CSV", connectionId: null, metricDate: date, spendUsd: new D(0), productId: null }],
      cafe24OrderLine: [{ source: "CSV", connectionId: null, orderDate: date, productId: "p", product: { isActive: true },
        quantity: new D(1), salePriceKrw: new D(100), matchRule: null }] }).summary("2026-10-07", "2026-10-07");
    assert.equal(result.channels.find(c => c.provider === "KAKAO")!.amount, null);
    assert.equal(result.complete, false);
    assert.equal(result.totals.totalSpendKrw, null);
    assert.equal(result.totals.mer, null);
    assert.equal(result.totals.knownSpendKrw, "0");
  } finally { if (previous == null) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("independent: all unset sources are missing, not successful zero", async () => {
  const result = await fixture().summary("2026-10-07", "2026-10-07");
  assert.equal(result.totals.revenueKrw, null);
  assert.equal(result.totals.knownSpendKrw, null);
  assert.ok(result.channels.every(c => c.amount === null && !c.complete));
});

test("independent: effective price, bundle fallback, unmatched and exact Decimal revenue", () => {
  const line = { productId: "p", product: { isActive: true }, quantity: new D("3.5"), salePriceKrw: new D("0.1"),
    matchRule: { displayName: "1 + 1", optionIncludeKeywords: [], productNameAliases: [], salePriceKrwOverride: null } };
  assert.equal(legacyRevenue(line, null)!.toString(), "0.7");
  assert.equal(legacyRevenue(line, { salePriceKrw: new D("1.1") })!.toString(), "3.85");
  assert.equal(legacyRevenue({ ...line, matchRule: { ...line.matchRule, salePriceKrwOverride: new D("2.2") } }, null)!.toString(), "7.7");
  assert.equal(legacyRevenue({ ...line, product: { isActive: false } }, null), null);
  assert.equal(legacyRevenue({ ...line, productId: null }, null), null);
});

test("independent: range rejects invalid calendar and 93 days", () => {
  assert.throws(() => storefrontRange("2026-02-30", "2026-03-01"));
  assert.throws(() => storefrontRange("2026-01-01", "2026-04-03"));
  assert.equal(storefrontRange("2026-01-01", "2026-04-02").to, "2026-04-02");
});

const connection = (extra: Record<string, unknown> = {}) => ({ id: "g", provider: "GOOGLE", displayName: "Synthetic Google",
  externalAccountId: "123", currencyCode: "KRW", timeZone: "Asia/Seoul", accessState: "READY", enabled: true,
  updatedAt: stamp, credentialExpiresAt: null, runs: [], coverage: [], ...extra });
test("independent: zero requires successful unit and previous success survives latest failure", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const cov = { connectionId: "g", dataKind: "GOOGLE_CAMPAIGN", metricDate: date, source: "API",
      state: "FAILED", rowCount: 0, totalAmount: new D(0), lastSuccessRunId: "success", lastSuccessAt: stamp,
      lastAttemptAt: new Date("2026-10-09T00:00:00Z"), lastAttemptRun: { status: "FAILED" }, warningCodes: [] };
    const policy = { connectionId: "g", dataKind: "GOOGLE_CAMPAIGN", fromDate: date, toDate: null, primarySource: "API" };
    const unit = { runId: "success", unitKey: "2026-10-07", publishedCount: 0, run: { connectionId: "g" } };
    const result = await fixture({ sourceConnection: [connection()], sourceCoverage: [cov], sourcePolicy: [policy], runUnit: [unit] }).summary("2026-10-07", "2026-10-07");
    assert.equal(result.coverage[0].complete, true);
    assert.equal(result.coverage[0].lastAttemptStatus, "FAILED");
    assert.equal(result.coverage[0].lastSuccessRunId, "success");
    assert.equal(result.channels.find(c => c.provider === "GOOGLE")!.amount, "0");
    assert.equal(result.channels.find(c => c.provider === "GOOGLE")!.state, "PARTIAL");
    const corrupt = await fixture({ sourceConnection: [connection()], sourceCoverage: [cov], sourcePolicy: [policy] }).summary("2026-10-07", "2026-10-07");
    assert.equal(corrupt.coverage[0].complete, false);
    assert.equal(corrupt.channels.find(c => c.provider === "GOOGLE")!.amount, null);
    for (const invalid of [{ ...unit, publishedCount: 1 }, { ...unit, run: { connectionId: "other" } }]) {
      const bad = await fixture({ sourceConnection: [connection()], sourceCoverage: [cov], sourcePolicy: [policy], runUnit: [invalid] }).summary("2026-10-07", "2026-10-07");
      assert.equal(bad.coverage[0].complete, false);
      assert.equal(bad.channels.find(c => c.provider === "GOOGLE")!.amount, null);
    }
  } finally { if (previous == null) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("independent: positive spend without FX stays unknown, successful zero needs no invented FX", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  try {
    for (const [value, expected] of [["1.0001", null], ["0", "0"]]) {
      const result = await fixture({ metaAdsetDailyMetric: [{ source: "CSV", connectionId: null,
        metricDate: date, productId: null, spendUsd: new D(value!) }] }).summary("2026-10-07", "2026-10-07");
      assert.equal(result.channels.find(c => c.provider === "META")!.spendKrw, expected);
      assert.equal(result.currencyStatus, expected == null ? "MISSING_EXCHANGE_RATE" : "ALIGNED");
    }
  } finally { if (previous == null) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("independent: source-off never displays API coverage amount as selected CSV", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  try {
    const result = await fixture({ sourceConnection: [connection()], sourceCoverage: [{ connectionId: "g",
      dataKind: "GOOGLE_CAMPAIGN", metricDate: date, source: "API", state: "COMPLETE_NONZERO", rowCount: 1,
      totalAmount: new D(888), lastSuccessAt: stamp, lastSuccessRunId: "prior", warningCodes: [] }] }).summary("2026-10-07", "2026-10-07");
    assert.equal(result.coverage[0].selectedSource, "CSV");
    assert.equal(result.coverage[0].amount, null);
    assert.equal(result.coverage[0].state, "NOT_COLLECTED");
    assert.equal(result.channels.find(c => c.provider === "GOOGLE")!.amount, null);
  } finally { if (previous == null) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("independent: server PermissionGuard rejects anonymous and existing ADMIN settings mutation", () => {
  const guard = new PermissionGuard(new Reflector());
  const context = (handler: any, permissions?: readonly string[]) => ({ getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ authenticatedUser: permissions ? { permissions } : undefined }) }) }) as any;
  assert.throws(() => guard.canActivate(context(StorefrontController.prototype.summary)), (error: any) => error.getStatus() === 401);
  assert.equal(guard.canActivate(context(StorefrontController.prototype.summary, ROLE_PERMISSIONS.GUEST)), true);
  assert.throws(() => guard.canActivate(context(StorefrontController.prototype.enabled, ROLE_PERMISSIONS.ADMIN)), (error: any) => error.getStatus() === 403);
  assert.throws(() => guard.canActivate(context(StorefrontController.prototype.runs, ROLE_PERMISSIONS.USER)), (error: any) => error.getStatus() === 403);
  assert.equal(guard.canActivate(context(StorefrontController.prototype.enabled, ROLE_PERMISSIONS.SUPER_ADMIN)), true);
});

test("independent: overlapping CSV/API policies hide conflicted money with an actionable warning", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const policy = { connectionId: "g", dataKind: "GOOGLE_CAMPAIGN", fromDate: date, toDate: null };
    const result = await fixture({ sourceConnection: [connection()],
      sourcePolicy: [{ ...policy, primarySource: "CSV" }, { ...policy, primarySource: "API" }],
      googleCampaignDailyCost: [{ ...google(1000000n), connectionId: "g" }] }).summary("2026-10-07", "2026-10-07");
    assert.ok(result.warningCodes.includes("SOURCE_SELECTION_REQUIRED"));
    assert.equal(result.channels.find(c => c.provider === "GOOGLE")!.amount, null);
    assert.equal(result.totals.knownSpendKrw, null);
    assert.equal(result.coverage[0].complete, false);
  } finally { if (previous == null) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("independent: different account time zone keeps original money but blocks KRW conversion", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  try {
    const result = await fixture({ sourceConnection: [connection({ timeZone: "America/Los_Angeles" })],
      googleCampaignDailyCost: [{ ...google(1000000n), connectionId: "g" }] }).summary("2026-10-07", "2026-10-07");
    assert.equal(result.channels.find(c => c.provider === "GOOGLE")!.amount, "1");
    assert.equal(result.channels.find(c => c.provider === "GOOGLE")!.spendKrw, null);
    assert.equal(result.currencyStatus, "INCOMPATIBLE_SCOPE");
    assert.equal(result.totals.knownSpendKrw, null);
  } finally { if (previous == null) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("independent: actual legacy FX provenance remains separate per product and excludes inactive fallback", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  try {
    const cost = (id: string, rate: string) => ({ id, productId: id, effectiveFrom: date, effectiveTo: null,
      createdAt: date, updatedAt: stamp, fxRateKrwPerUsd: new D(rate) });
    const meta = (id: string, value: string, active = true) => ({ source: "CSV", connectionId: null,
      metricDate: date, productId: id, product: { isActive: active }, spendUsd: new D(value) });
    const result = await fixture({ metaAdsetDailyMetric: [meta("p1", "1"), meta("p2", "2")],
      productCostRule: [cost("p1", "10"), cost("p2", "20")] }).summary("2026-10-07", "2026-10-07");
    assert.equal(result.channels.find(c => c.provider === "META")!.spendKrw, "50");
    assert.equal(result.exchangeRates.length, 2);
    assert.deepEqual(result.exchangeRates.map(r => [r.provider, r.date, r.rate, r.sourceDate]), [
      ["PRODUCT_COST_RULE", "2026-10-07", "10", "2026-10-07"],
      ["PRODUCT_COST_RULE", "2026-10-07", "20", "2026-10-07"]
    ]);
    const inactive = await fixture({ metaAdsetDailyMetric: [meta("p1", "1", false)],
      productCostRule: [cost("p1", "10")] }).summary("2026-10-07", "2026-10-07");
    assert.equal(inactive.channels.find(c => c.provider === "META")!.spendKrw, null);
    assert.equal(inactive.exchangeRates.length, 0);
    assert.equal(inactive.currencyStatus, "MISSING_EXCHANGE_RATE");
  } finally { if (previous == null) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("independent: a registered but never-collected day is not a CSV/API conflict", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const result = await fixture({ sourceConnection: [connection({ provider: "CAFE24" })] }).summary("2026-10-07", "2026-10-07");
    assert.equal(result.coverage[0].state, "NOT_COLLECTED");
    assert.equal(result.coverage[0].complete, false);
    assert.equal(result.coverage[0].warningCodes.includes("SOURCE_SELECTION_REQUIRED"), false);
  } finally { if (previous == null) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("independent: allowed extreme Cafe24 revenue and tiny FX amounts serialize as plain decimals for UI", () => {
  const line = { productId: "p", product: { isActive: true }, quantity: new D("9999999999.9999"),
    salePriceKrw: new D("999999999999.99"), matchRule: null };
  const units = 99999999999999n * 99999999999999n;
  const expected = `${units / 1000000n}.${(units % 1000000n).toString().padStart(6, "0")}`;
  assert.equal(legacyRevenue(line, null)!.toString(), expected);
  assert.equal(new StorefrontDecimal("0.0001").times("0.000001").toString(), "0.0000000001");
});

test("independent: multiple Google account currencies never become a mixed-unit numeric subtotal", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  try {
    const result = await fixture({ sourceConnection: [connection({ id: "krw" }), connection({ id: "usd", currencyCode: "USD" })],
      googleCampaignDailyCost: [{ ...google(1000000n, 0), connectionId: "krw" }, { ...google(1000000n, 1), connectionId: "usd" }] }).summary("2026-10-07", "2026-10-07");
    assert.equal(result.channels.find(c => c.provider === "GOOGLE")!.amount, null);
    assert.equal(result.daily[0].googleSpend, null);
    assert.equal(result.totals.knownSpendKrw, null);
    assert.deepEqual(result.googleCampaigns.map(c => [c.amount, c.currency]), [["1", "KRW"], ["1", "USD"]]);
    assert.deepEqual(result.coverage.map(c => c.currency), ["KRW", "USD"]);
  } finally { if (previous == null) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});
