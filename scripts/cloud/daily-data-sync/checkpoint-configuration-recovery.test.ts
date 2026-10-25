// Synthetic credentials/provider only. No production data or real network.
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { assertScheduledCheckpointConfigured } from "../../../apps/api/src/daily-sync/scheduled-checkpoint";
import { Cafe24SyncRunnerService } from "../../../apps/api/src/daily-sync/cafe24-sync-runner.service";
import { SyncFoundationService } from "../../../apps/api/src/daily-sync/sync-foundation.service";
import { Cafe24OauthService } from "../../../apps/api/src/daily-sync/cafe24-oauth.service";
import { ProviderFailure } from "../../../apps/api/src/daily-sync/bounded-request";
import { SourceConnectionsService } from "../../../apps/api/src/daily-sync/source-connections.service";
import { computeCafe24ActivationEvidence } from "../../../apps/api/src/daily-sync/cafe24-activation-evidence";

const id = "be140e7e-3994-406e-94ff-b50dfc7ac7b2", runId = "10000000-0000-4000-8000-000000000002";
const actor = "10000000-0000-4000-8000-000000000003", day = "2026-10-24", date = new Date(day + "T00:00:00Z");
async function env(work: () => Promise<void>) {
  const before = { ...process.env };
  Object.assign(process.env, { DAILY_SYNC_FEATURE_ENABLED: "true", DAILY_SYNC_ALLOWED_ACCOUNTS: '["CAFE24/didadi0729/shop1"]',
    DAILY_SYNC_CHECKPOINT_KEY_B64: randomBytes(32).toString("base64") });
  try { await work(); } finally { process.env = before; }
}
const code = (expected: string) => (error: any) => error.getResponse?.().code === expected;

test("checkpoint configuration rejects missing, malformed and reused keys with its own safe code", async () => env(async () => {
  for (const value of ["", "invalid", Buffer.alloc(31).toString("base64")]) {
    process.env.DAILY_SYNC_CHECKPOINT_KEY_B64 = value;
    assert.throws(assertScheduledCheckpointConfigured, code("CHECKPOINT_CONFIGURATION_REQUIRED"));
  }
  const key = randomBytes(32).toString("base64"); process.env.DAILY_SYNC_CHECKPOINT_KEY_B64 = key;
  for (const name of ["DAILY_SYNC_CREDENTIAL_KEY_V2", "DAILY_SYNC_MACHINE_TOKEN", "INTERNAL_PROBE_TOKEN"]) {
    process.env[name] = key;
    assert.throws(assertScheduledCheckpointConfigured, code("CHECKPOINT_CONFIGURATION_REQUIRED")); delete process.env[name];
  }
  assert.doesNotThrow(assertScheduledCheckpointConfigured);
}));

test("actual runner/failure writer keeps READY on local configuration failure and disables on genuine provider auth failure", async () => env(async () => {
  for (const missing of [true, false]) {
    if (missing) delete process.env.DAILY_SYNC_CHECKPOINT_KEY_B64;
    else process.env.DAILY_SYNC_CHECKPOINT_KEY_B64 = randomBytes(32).toString("base64");
    const connection: any = { id, provider: "CAFE24", externalAccountId: "didadi0729", shopKey: "shop1", currencyCode: "KRW", timeZone: "Asia/Seoul", enabled: true, accessState: "READY" };
    const run: any = { id: runId, connectionId: id, status: "QUEUED", trigger: "SCHEDULED", fromDate: date, toDate: date, requestKey: "synthetic-recovery", connection,
      units: [{ unitKey: day, status: "RUNNING", attempts: 1 }] };
    let providerRequests = 0; const audits: any[] = [];
    const db: any = { syncRun: { findUnique: async () => run, findUniqueOrThrow: async () => run,
      update: async ({ data }: any) => Object.assign(run, data) },
      sourcePolicy: { findFirst: async () => ({ primarySource: "CSV", version: 3 }) },
      sourceConnection: { findUnique: async () => connection, updateMany: async ({ data }: any) => Object.assign(connection, data) },
      runUnit: { findUnique: async () => run.units[0], upsert: async () => {} },
      sourceCoverage: { findUnique: async () => null, upsert: async () => {} },
      securityAuditEvent: { create: async ({ data }: any) => audits.push(data) },
      $queryRaw: async (query: any) => query.strings.join("").includes("sync_unit_checkpoints") ? [] : [{ generation: 1n }], $transaction: async (fn: any) => fn(db) };
    const realFoundation = new SyncFoundationService(db, {} as any);
    const foundation: any = { claimRun: async () => { run.status = "RUNNING"; return { runId, connectionId: id, generation: 1n, release() {} }; },
      beginScheduledUnit: async () => {}, finishRun: async () => {}, failUnit: realFoundation.failUnit.bind(realFoundation) };
    const client: any = { fetchScheduledChunk: async () => { providerRequests++; throw new ProviderFailure("PROVIDER_AUTH_REQUIRED", false); } };
    await new Cafe24SyncRunnerService(db, foundation, client, {} as any).execute(runId, { maxUnits: 1, deadlineAt: Date.now() + 55_000 });
    assert.equal(providerRequests, missing ? 0 : 1);
    assert.equal(run.safeErrorCode, missing ? "CHECKPOINT_CONFIGURATION_REQUIRED" : "PROVIDER_AUTH_REQUIRED");
    assert.equal(connection.enabled, missing); assert.equal(connection.accessState, missing ? "READY" : "REAUTH_REQUIRED");
    assert.equal(audits.some(a => a.action === "SOURCE_REAUTH_REQUIRED"), !missing);
  }
}));

test("guarded recovery uses existing refresh once, validates provider identity, and never returns tokens or enables collection", async () => env(async () => {
  Object.assign(process.env, { DAILY_SYNC_CAFE24_CLIENT_ID: "syntheticclient", DAILY_SYNC_CAFE24_CLIENT_SECRET: "synthetic-secret",
    DAILY_SYNC_CAFE24_REDIRECT_URI: "https://synthetic.invalid/backend-api/integrations/cafe24/oauth/callback", DAILY_SYNC_CAFE24_ISOLATED_ORIGIN: "https://synthetic.invalid" });
  for (const mode of ["valid", "stale", "blocked", "enabled", "expired", "busy", "missing-key", "revision-race", "foreign-provider", "provider-rejected"]) {
    const connection: any = { provider: "CAFE24", externalAccountId: "didadi0729", shopKey: "shop1", enabled: mode === "enabled", accessState: mode === "blocked" ? "BLOCKED" : "REAUTH_REQUIRED",
      credentialRef: `source_credentials:${id}:CAFE24_REFRESH`, updatedAt: new Date("2026-10-25T00:00:00Z") };
    let claims = 0, requests = 0, stored: any, releases = 0;
    const db: any = { sourceConnection: { findUnique: async () => connection }, sourceCredential: { findUnique: async () => ({ revision: 2, expiresAt: new Date(Date.now() + (mode === "expired" ? -1 : 86400_000)) }) }, syncLease: { findFirst: async () => mode === "busy" ? {} : null } };
    const vault: any = { claimCafe24Refresh: async () => { claims++; return { token: "synthetic-existing-refresh", revision: mode === "revision-race" ? 3 : 2, owner: "synthetic-owner" }; },
      storeCafe24Pair: async (input: any) => { stored = input; connection.accessState = "READY"; },
      releaseRefreshClaim: async () => { releases++; }, markCafe24ReauthIfRevision: async () => {} };
    const request: any = async (url: string, options: any) => {
      requests++; assert.equal(url, "https://didadi0729.cafe24api.com/api/v2/oauth/token");
      assert.equal(new URLSearchParams(options.body).get("grant_type"), "refresh_token");
      if (mode === "provider-rejected") return new Response("{}", { status: 401 });
      return Response.json({ mall_id: mode === "foreign-provider" ? "foreign" : "didadi0729", shop_no: 1, client_id: "syntheticclient", token_type: "Bearer", scopes: ["mall.read_order"],
        access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", expires_at: new Date(Date.now() + 7200_000).toISOString(), refresh_token_expires_at: new Date(Date.now() + 86400_000).toISOString() });
    };
    const service = new Cafe24OauthService(db, vault, request);
    const key = process.env.DAILY_SYNC_CHECKPOINT_KEY_B64;
    if (mode === "missing-key") delete process.env.DAILY_SYNC_CHECKPOINT_KEY_B64;
    try {
      const promise = service.recoverConnection(id, { expectedUpdatedAt: mode === "stale" ? "stale" : connection.updatedAt.toISOString(), expectedRefreshRevision: 2 }, actor);
      if (mode === "valid") {
        const result = await promise; assert.deepEqual(result, { connectionId: id, enabled: false, accessState: "READY", refreshed: true });
        assert.equal(stored.expectedRefreshRevision, 2); assert.equal(stored.actorUserId, actor); assert.equal(stored.refreshOwner, "synthetic-owner");
      } else { await assert.rejects(promise); assert.equal(stored, undefined); }
      assert.equal(requests, ["valid", "foreign-provider", "provider-rejected"].includes(mode) ? 1 : 0);
      assert.equal(claims, ["valid", "revision-race", "foreign-provider", "provider-rejected"].includes(mode) ? 1 : 0);
      assert.equal(releases, claims); assert.equal(connection.enabled, mode === "enabled");
    } finally { process.env.DAILY_SYNC_CHECKPOINT_KEY_B64 = key; }
  }
}));

test("manual API-only recovery carries only the already approved production coupon baseline into tomorrow", async () => env(async () => {
  const coupon = "API_ACTUAL_PRODUCT_PLUS_SHIPPING";
  Object.assign(process.env, { DAILY_SYNC_CAFE24_DAY_ACTIVATION_ENABLED: "true", DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION: "2", DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64: randomBytes(32).toString("base64"),
    SUPABASE_DATABASE_PROJECT_REF: "iygjmosbelbosfxidqxv", SUPABASE_DATABASE_SCHEMA: "meta_ads", SUPABASE_DATABASE_RUNTIME_USER: "meta_ads_prod_runtime", RUNTIME_API_TARGET_ID: "bundle-loopback-api",
    DAILY_SYNC_CAFE24_SCHEDULED_REVIEWED_BASELINE: JSON.stringify({ connectionId: id, fromDate: day, policyVersion: 3, reviewedDay: "2026-10-23", couponInputSource: coupon }) });
  const current: any = { id: "current", fromDate: date, toDate: null, primarySource: "CSV", version: 3, couponInputSource: null };
  const coverage: any = { source: "API", state: "COMPLETE_ZERO", rowCount: 0, lastSuccessRunId: runId, lastAttemptRunId: runId, lastSuccessAt: new Date(), warningCodes: ["CAFE24_SHADOW_NOT_PRIMARY"] };
  const created: any[] = []; const audits: any[] = [];
  const db: any = { $transaction: async (fn: any) => fn(db), $queryRaw: async () => [],
    sourceConnection: { findUnique: async () => ({ provider: "CAFE24", externalAccountId: "didadi0729", shopKey: "shop1", currencyCode: "KRW", timeZone: "Asia/Seoul" }) },
    sourcePolicy: { findMany: async ({ where }: any) => where.primarySource ? [{ version: 2 }] : [current], update: async ({ data }: any) => Object.assign(current, data), create: async ({ data }: any) => created.push(data) },
    sourceCoverage: { findUnique: async ({ where }: any) => where.connectionId_dataKind_metricDate.metricDate.getTime() === date.getTime() ? coverage : { source: "API", state: "COMPLETE_NONZERO", reconciliationStatus: "CSV_API_INPUTS_REVIEWED", lastSuccessRunId: "reviewed", warningCodes: [] }, update: async ({ data }: any) => Object.assign(coverage, data) },
    securityAuditEvent: { findFirst: async () => ({ afterJson: { sourceChoice: "CSV_REVIEWED", couponInputSource: coupon, successRunId: "reviewed", version: 2 } }), create: async ({ data }: any) => audits.push(data) },
    syncRun: { findUnique: async () => ({ id: runId, connectionId: id, status: "SUCCEEDED", trigger: "MANUAL", fromDate: date, toDate: date }) },
    runUnit: { findUnique: async () => ({ status: "SUCCEEDED", publishedCount: 0 }) },
    cafe24OrderLine: { findMany: async () => [], count: async () => 0 }, cafe24OrderApiVersion: { findMany: async () => [] }, sourceRecordLink: { findMany: async () => [] } };
  const expectedSnapshotDigest = await computeCafe24ActivationEvidence(db, id, day, { mode: "API_ONLY", couponInputSource: coupon });
  await new SourceConnectionsService(db).activateCafe24Day(id, { day, expectedPolicyVersion: 3, expectedSuccessRunId: runId, reason: "CAFE24_CHECKPOINT_RECOVERY", mode: "API_ONLY", couponInputSource: coupon, expectedSnapshotDigest }, actor);
  assert.equal(current.primarySource, "API"); assert.equal(created.length, 1); assert.equal(created[0].fromDate.toISOString().slice(0, 10), "2026-10-25");
  assert.equal(created[0].couponInputSource, coupon); assert.equal(created[0].primarySource, "CSV");
  assert.equal(audits.at(-1).afterJson.reviewedCouponHandoff, true);
}));
