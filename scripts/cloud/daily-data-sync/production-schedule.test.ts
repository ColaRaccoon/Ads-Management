import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { reviewedCafe24ScheduledBaseline } from "../../../apps/api/src/daily-sync/cafe24-scheduled-review";
import { ScheduledSyncService } from "../../../apps/api/src/daily-sync/scheduled-sync.service";

const cafe = "be140e7e-3994-406e-94ff-b50dfc7ac7b2";
const meta = "2155a401-bd86-4111-9280-3c95ed207546";
const coupon = "API_ACTUAL_PRODUCT_PLUS_SHIPPING";
async function env(work: () => Promise<void>) {
  const before = { ...process.env };
  Object.assign(process.env, { DAILY_SYNC_FEATURE_ENABLED: "true", DAILY_SYNC_SCHEDULE_ENABLED: "true",
    SUPABASE_DATABASE_PROJECT_REF: "iygjmosbelbosfxidqxv", SUPABASE_DATABASE_SCHEMA: "meta_ads",
    SUPABASE_DATABASE_RUNTIME_USER: "meta_ads_prod_runtime", RUNTIME_API_TARGET_ID: "bundle-loopback-api" });
  try { await work(); } finally { process.env = before; }
}
function reviewFixture() {
  const policy = { version: 3, fromDate: new Date("2026-10-24T00:00:00Z"), toDate: null,
    primarySource: "CSV", couponInputSource: null };
  const config = { connectionId: cafe, fromDate: "2026-10-24", policyVersion: 3,
    reviewedDay: "2026-10-23", couponInputSource: coupon };
  const state: any = { prior: [{ version: 2 }], coverage: { source: "API", state: "COMPLETE_NONZERO",
    reconciliationStatus: "CSV_API_INPUTS_REVIEWED", lastSuccessRunId: "reviewed-run", warningCodes: [] },
    after: { version: 2, successRunId: "reviewed-run", sourceChoice: "CSV_REVIEWED", couponInputSource: coupon } };
  const db: any = { sourcePolicy: { findMany: async () => state.prior },
    sourceCoverage: { findUnique: async () => state.coverage },
    securityAuditEvent: { findFirst: async () => ({ afterJson: state.after }) } };
  return { db, policy, config, state };
}
test("production scheduled baseline requires the explicit reviewed day, current version and committed audit/coverage", async () => env(async () => {
  const f = reviewFixture(); process.env.DAILY_SYNC_CAFE24_SCHEDULED_REVIEWED_BASELINE = JSON.stringify(f.config);
  assert.equal(await reviewedCafe24ScheduledBaseline(f.db, cafe, "2026-10-24", f.policy, coupon), true);
  // A missed earlier day is never fetched by this proof; the occurrence layer
  // decides the current day, and this remains the same open CSV baseline.
  assert.equal(await reviewedCafe24ScheduledBaseline(f.db, cafe, "2026-10-25", f.policy, coupon), true);
  assert.equal(await reviewedCafe24ScheduledBaseline(f.db, cafe, "2026-10-23", f.policy, coupon), false);
  assert.equal(await reviewedCafe24ScheduledBaseline(f.db, meta, "2026-10-24", f.policy, coupon), false);
  assert.equal(await reviewedCafe24ScheduledBaseline(f.db, cafe, "2026-10-24", { ...f.policy, version: 4 }, coupon), false);
  f.state.coverage.warningCodes = ["CAFE24_SHADOW_NOT_PRIMARY"];
  assert.equal(await reviewedCafe24ScheduledBaseline(f.db, cafe, "2026-10-24", f.policy, coupon), false);
  f.state.coverage.warningCodes = []; f.state.after.sourceChoice = "API_ONLY";
  assert.equal(await reviewedCafe24ScheduledBaseline(f.db, cafe, "2026-10-24", f.policy, coupon), false);
}));
test("foreign runtime, missing or expanded configuration cannot approve a null coupon baseline", async () => env(async () => {
  const f = reviewFixture();
  delete process.env.DAILY_SYNC_CAFE24_SCHEDULED_REVIEWED_BASELINE;
  assert.equal(await reviewedCafe24ScheduledBaseline(f.db, cafe, "2026-10-24", f.policy, coupon), false);
  process.env.DAILY_SYNC_CAFE24_SCHEDULED_REVIEWED_BASELINE = JSON.stringify({ ...f.config, arbitrary: true });
  assert.equal(await reviewedCafe24ScheduledBaseline(f.db, cafe, "2026-10-24", f.policy, coupon), false);
  process.env.DAILY_SYNC_CAFE24_SCHEDULED_REVIEWED_BASELINE = JSON.stringify(f.config);
  process.env.SUPABASE_DATABASE_PROJECT_REF = "ehnfrrmbkvlsbpvqcvkr";
  assert.equal(await reviewedCafe24ScheduledBaseline(f.db, cafe, "2026-10-24", f.policy, coupon), false);
}));
test("a scheduled Meta unit obtains its dated FX before provider execution; FX failure never fetches ads", async (t) => env(async () => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-30T17:05:00Z") });
  const definition = { key: "prod-meta", connectionId: meta, anchorAt: "2026-10-30T17:02:00.000Z", windowMinutes: 90 };
  process.env.DAILY_SYNC_SCHEDULES = JSON.stringify([definition]);
  process.env.DAILY_SYNC_ALLOWED_ACCOUNTS = '["META/2138525300002203/default"]';
  for (const fail of [false, true]) {
    const calls: string[] = [];
    const db: any = { sourceConnection: { findUnique: async () => ({ id: meta, provider: "META",
      externalAccountId: "2138525300002203", shopKey: "default", timeZone: "Asia/Seoul" }) },
      syncRun: { findUnique: async () => ({ id: "scheduled-run", status: "QUEUED" }) },
      runUnit: { findFirst: async () => ({ unitKey: "2026-10-24" }) } };
    const rates: any = { ensureUsdKrwRatesForDates: async (days: Date[]) => {
      assert.equal(days[0].toISOString(), "2026-10-24T00:00:00.000Z"); calls.push("fx");
      if (fail) throw Error("FX_UNAVAILABLE");
    } };
    const runner: any = { execute: async () => { calls.push("provider"); } };
    const service = new ScheduledSyncService(db, { prepareScheduledRetry: async () => true } as any,
      {} as any, {} as any, runner, rates);
    service.status = async () => ({ status: "PARTIAL" } as any);
    const input = { scheduleKey: definition.key, scheduledFor: definition.anchorAt };
    if (fail) await assert.rejects(service.step(input), /FX_UNAVAILABLE/); else await service.step(input);
    assert.deepEqual(calls, fail ? ["fx"] : ["fx", "provider"]);
  }
}));
