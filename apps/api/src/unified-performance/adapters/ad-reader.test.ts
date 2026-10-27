import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { CONTRACT_VERSION } from "../types";
import type { AdapterRequest } from "../types";
import { UnifiedManagementRepository } from "../management.repository";
import { readAdDay } from "./ad-reader";

const scope = "10000000-0000-4000-8000-000000000001", date = new Date("2026-10-26T00:00:00Z");
const versions = { scopePolicyVersion: "s", nameRuleVersion: "n", saleUnitRuleVersion: "u", allocationRuleVersion: "a", configurationVersion: "v" };
const request = (platform: "META" | "GOOGLE"): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: "run", readSnapshotId: "snapshot",
  from: "2026-10-26", to: "2026-10-26", scopeKeys: [scope], platforms: [platform], ...versions,
  calculationVersion: "c", fxVersion: "f", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 });
const decimal = (value: string) => new Prisma.Decimal(value);

function fixture(platform: "META" | "GOOGLE", options: { rows?: number; badLink?: boolean; provider?: string; lastFailed?: boolean } = {}) {
  const reads: string[] = [];
  const count = options.rows ?? 1;
  const coverage = { connectionId: scope, dataKind: platform === "META" ? "META_ADSET" : "GOOGLE_CAMPAIGN", metricDate: date,
    source: "API", state: options.lastFailed ? "FAILED" : count ? "COMPLETE_NONZERO" : "COMPLETE_ZERO", lastSuccessRunId: "success", lastSuccessAt: date,
    lastAttemptRunId: "attempt", lastAttemptAt: date, rowCount: count, totalAmount: decimal(String(count)), reconciliationStatus: null, warningCodes: [] };
  const meta = Array.from({ length: count }, (_, index) => ({ id: `m${index}`, metaAdsetId: `set${index}`, adsetName: "보호대", connectionId: scope,
    source: "API", importVersion: 2, sourceRevision: "rev", uploadBatchId: null, syncRunId: "old-run", metricDate: date,
    spendUsd: decimal("1"), purchaseValueUsd: null, createdAt: date, updatedAt: date }));
  const google = Array.from({ length: count }, (_, index) => ({ id: `g${index}`, campaignId: `campaign${index}`, campaignName: "보호대", connectionId: scope,
    source: "API", version: 2, syncRunId: "old-run", metricDate: date, costMicros: 1000000n, conversionValue: null, fetchedAt: date }));
  const tx = {
    sourceConnection: { findUnique: async () => { reads.push("connection"); return { provider: options.provider ?? platform, currencyCode: platform === "META" ? "USD" : "KRW", timeZone: "Asia/Seoul" }; } },
    sourcePolicy: { findMany: async () => { reads.push("policy"); return [{ connectionId: scope, dataKind: coverage.dataKind,
      fromDate: new Date("2026-01-01"), toDate: null, primarySource: "API" }]; } },
    sourceCoverage: { findMany: async () => [coverage] },
    exchangeRate: { findMany: async () => [{ rate: decimal("1324.3"), sourceDate: date, provider: "KOREA_EXIM", fallbackType: "EXACT" }] },
    metaAdsetDailyMetric: { findMany: async () => { reads.push("meta"); return [...meta, ...meta.map(row => ({ ...row, id: `${row.id}-csv`, source: "CSV", spendUsd: decimal("999") }))]; } },
    googleCampaignDailyCost: { findMany: async () => { reads.push("google"); return google; } },
    sourceRecordLink: { findMany: async () => google.map(row => ({ connectionId: scope, recordId: row.id,
      version: options.badLink ? 1 : 2, syncRunId: "old-run" })) },
    runUnit: { findMany: async () => [{ runId: "success", unitKey: "2026-10-26", status: "SUCCEEDED", publishedCount: count }] },
    $queryRaw: async () => [{ dataKind: "META_ADSET", connectionId: scope, metricDate: date }]
  } as unknown as Prisma.TransactionClient;
  const management = { snapshot: async () => ({ products: [{ canonicalName: "보호대", active: true }], rules: [], versions }) } as unknown as UnifiedManagementRepository;
  return { tx, management, reads };
}

test("Meta reader selects API over overlapping CSV and never queries ad-level rows", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const f = fixture("META"), batch = await readAdDay(f.tx, f.management, request("META"), "META");
    assert.equal(batch.adSpends.length, 1); assert.equal(batch.adSpends[0].originalAmount, "1.000000");
    assert.equal(batch.adSpends[0].amountKrw, "1324.300000"); assert.equal(batch.sourceControlTotals[0].excludedByPolicyRows, 1);
    assert.equal(batch.coverage[0].collectionState, "COMPLETE"); assert.deepEqual(f.reads.filter(read => ["meta", "google"].includes(read)), ["meta"]);
  } finally { if (previous === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("Google unchanged reread accepts per-row earlier run/version and a later failed attempt keeps prior success", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const f = fixture("GOOGLE", { lastFailed: true });
    const batch = await readAdDay(f.tx, f.management, request("GOOGLE"), "GOOGLE");
    assert.equal(batch.coverage[0].collectionState, "COMPLETE"); assert.equal(batch.adSpends[0].ref.uploadOrRunId, "old-run");
    const zero = fixture("GOOGLE", { rows: 0 });
    const zeroBatch = await readAdDay(zero.tx, zero.management, request("GOOGLE"), "GOOGLE");
    assert.equal(zeroBatch.coverage[0].zeroConfirmed, true); assert.equal(zeroBatch.sourceControlTotals[0].selectedAmount, "0.000000");
  } finally { if (previous === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});

test("Google broken lineage is partial; excluded/foreign scope and stale configuration never proceed to source facts", async () => {
  const previous = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    const broken = fixture("GOOGLE", { badLink: true });
    const batch = await readAdDay(broken.tx, broken.management, request("GOOGLE"), "GOOGLE");
    assert.equal(batch.coverage[0].collectionState, "PARTIAL"); assert.ok(batch.coverage[0].quality.issues.includes("GOOGLE_CURRENT_LINEAGE_UNVERIFIED"));
    assert.equal(batch.adSpends.length, 0); assert.equal(batch.coverage[0].rowsPresent, 1);
    assert.equal(batch.sourceControlTotals[0].selectedAmount, null);
    const excluded = fixture("META");
    await assert.rejects(readAdDay(excluded.tx, excluded.management, { ...request("META"), platforms: ["CAFE24"] }, "META"), /Excluded/);
    assert.deepEqual(excluded.reads, []);
    const foreign = fixture("META", { provider: "CAFE24" });
    await assert.rejects(readAdDay(foreign.tx, foreign.management, request("META"), "META"), /FORBIDDEN/);
    assert.deepEqual(foreign.reads, ["connection"]);
    const stale = fixture("META");
    await assert.rejects(readAdDay(stale.tx, stale.management, { ...request("META"), nameRuleVersion: "stale" }, "META"), /STALE_CONFIGURATION/);
    assert.ok(!stale.reads.includes("meta"));
  } finally { if (previous === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }
});
