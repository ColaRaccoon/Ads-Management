import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceProvider } from "@prisma/client";
import { occurrence, schedules } from "../../../apps/api/src/daily-sync/scheduled-occurrence";
import { ScheduledSyncService } from "../../../apps/api/src/daily-sync/scheduled-sync.service";
import { SyncFoundationService } from "../../../apps/api/src/daily-sync/sync-foundation.service";

const definition = { key: "test-cafe24", connectionId: "12345678-1234-1234-1234-123456789abc",
  anchorAt: "2026-10-11T17:00:00.000Z", windowMinutes: 30 };
test("daily occurrence chooses exactly completed prior Seoul day", () => {
  const result = occurrence(definition, SourceProvider.CAFE24, "Asia/Seoul", definition.anchorAt, new Date("2026-10-11T17:01Z"));
  assert.equal(result.fromDate, "2026-10-11"); assert.equal(result.toDate, "2026-10-11");
  assert.equal(result.deadlineAt.toISOString(), "2026-10-11T17:30:00.000Z");
});
test("weekly occurrence is seven completed account-local days and never grows after outage", () => {
  const d = { ...definition, key: "test-google" };
  const result = occurrence(d, SourceProvider.GOOGLE, "America/Los_Angeles", d.anchorAt, new Date("2026-10-20Z"));
  assert.equal(result.fromDate, "2026-10-04"); assert.equal(result.toDate, "2026-10-10");
  assert.equal(result.requestKey, occurrence(d, SourceProvider.GOOGLE, "America/Los_Angeles", d.anchorAt,
    new Date("2026-10-30Z")).requestKey);
});
for (const scheduled of ["2026-10-12T17:00:00.000Z", "2026-10-11T17:00:00.001Z", "2026-10-11T17:01:00.000Z"]) {
  test(`weekly rejects off-cadence slot ${scheduled}`, () => {
    assert.throws(() => occurrence(definition, SourceProvider.META, "Asia/Seoul", scheduled, new Date("2026-11-01Z")));
  });
}
test("invalid date, future, pre-anchor, storage-overlap and duplicate schedules fail closed", () => {
  for (const scheduled of ["2026-02-30T17:00:00.000Z", "2026-10-10T17:00:00.000Z", "2026-10-12T17:00:00.000Z"])
    assert.throws(() => occurrence(definition, SourceProvider.CAFE24, "Asia/Seoul", scheduled, new Date("2026-10-11T18:00Z")));
  const overlap = { ...definition, anchorAt: "2026-10-11T18:50:00.000Z" };
  assert.throws(() => occurrence(overlap, SourceProvider.META, "Asia/Seoul", overlap.anchorAt, new Date("2026-10-11T19:00Z")));
  assert.throws(() => schedules({ DAILY_SYNC_SCHEDULES: JSON.stringify([definition, definition]) }));
  assert.throws(() => schedules({ DAILY_SYNC_SCHEDULES: JSON.stringify([{ ...definition, injected: true }]) }));
});
test("expired occurrence never queues or calls provider; committed success remains success", async () => {
  const prior = { ...process.env };
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  process.env.DAILY_SYNC_SCHEDULE_ENABLED = "true";
  process.env.DAILY_SYNC_ALLOWED_ACCOUNTS = JSON.stringify(["CAFE24/testmall/1"]);
  process.env.DAILY_SYNC_SCHEDULES = JSON.stringify([definition]);
  try {
    let queued = 0, calls = 0;
    const prisma: any = { $executeRaw: async () => 0, sourceConnection: { findUnique: async () => ({ ...definition,id:definition.connectionId, provider: "CAFE24",
      externalAccountId: "testmall", shopKey: "1", timeZone: "Asia/Seoul" }) }, syncRun: {
      findUnique: async () => ({ id: "safe-run", connectionId:definition.connectionId,trigger:"SCHEDULED",status: "SUCCEEDED",fromDate:new Date("2026-10-11Z"),toDate:new Date("2026-10-11Z"),units: [{unitKey:"2026-10-11", status: "SUCCEEDED",publishedCount:0 }] }) } };
    prisma.$transaction=async(fn:any)=>fn(prisma);
    prisma.sourcePolicy={findMany:async()=>[{primarySource:"API",version:2,fromDate:new Date("2026-10-11Z"),toDate:new Date("2026-10-12Z"),reason:"CAFE24_SCHEDULED_API_ONLY",couponInputSource:"UNKNOWN"}]};
    prisma.sourceCoverage={findUnique:async()=>({source:"API",state:"COMPLETE_ZERO",lastSuccessRunId:"safe-run",lastAttemptRunId:"safe-run",lastSuccessAt:new Date(),rowCount:0,reconciliationStatus:"CAFE24_API_ONLY_VERIFIED",warningCodes:[]})};
    prisma.securityAuditEvent={findMany:async()=>[{afterJson:{sourcePolicyVersion:1}}]};
    prisma.$queryRaw=async()=>[{rows:0n,valid:0n,versions:0n}];
    const service = new ScheduledSyncService(prisma, { queueRun: async () => { queued++; } } as any,
      { execute: async () => { calls++; } } as any, {} as any, {} as any);
    const result = await service.step({ scheduleKey: definition.key, scheduledFor: definition.anchorAt });
    assert.equal(result.status, "SUCCEEDED"); assert.equal(result.completedUnits, 1);
    assert.equal(queued, 0); assert.equal(calls, 0); assert.equal("connectionId" in result, false);
  } finally { process.env = prior; }
});
test("retry preserves successful units and refuses live lease, exhausted scope and expired deadline", async () => {
  const prior = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    let writes = 0; let lease: any = null; let attempts = 0;
    const tx: any = { $executeRaw: async () => 1, $queryRaw: async () => [{ id: "connection" }],
      syncRun: { findUnique: async () => ({ id: "run", trigger: "SCHEDULED", status: "PARTIAL", connectionId: "connection", fromDate: new Date("2026-10-11Z"), toDate: new Date("2026-10-12Z"),
        units: [{ status: "SUCCEEDED", attempts: 1 }, { status: "QUEUED", attempts }] }), update: async () => { writes++; } },
      syncLease: { findUnique: async () => lease } };
    const service = new SyncFoundationService({ $transaction: async (fn: any) => fn(tx) } as any, {} as any);
    assert.equal(await service.prepareScheduledRetry("run", new Date(Date.now() + 60_000)), true);
    assert.equal(writes, 0);
    lease = { expiresAt: new Date(Date.now() + 60_000) };
    assert.equal(await service.prepareScheduledRetry("run", new Date(Date.now() + 60_000)), false);
    lease = null; attempts = 3;
    assert.equal(await service.prepareScheduledRetry("run", new Date(Date.now() + 60_000)), false);
    assert.equal(await service.prepareScheduledRetry("run", new Date(0)), false);
  } finally { if (prior === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = prior; }
});
test("new successful slot retains old missing warning; explicit successful day recovery clears it without queuing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-13T17:05:00.000Z").getTime() });
  const prior = { ...process.env };
  const d = { ...definition, anchorAt: "2026-10-12T17:00:00.000Z" };
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  process.env.DAILY_SYNC_SCHEDULES = JSON.stringify([d]);
  process.env.DAILY_SYNC_ALLOWED_ACCOUNTS = JSON.stringify(["CAFE24/testmall/shop1"]);
  let manual = false; let recoveredSource = "API";
  try {
    const currentKey = occurrence(d, SourceProvider.CAFE24, "Asia/Seoul", "2026-10-13T17:00:00.000Z").requestKey;
    const prisma: any = { sourceConnection: { findUnique: async () => ({ id: d.connectionId,
      provider: "CAFE24", externalAccountId: "testmall", shopKey: "shop1", timeZone: "Asia/Seoul" }) },
      syncRun: { findMany: async () => [{ requestKey: currentKey, id: "new-success", status: "SUCCEEDED", units: [{ status: "SUCCEEDED", unitKey: "2026-10-13" }] }] },
      sourceCoverage: { findMany: async () => [{source:"API",dataKind:"CAFE24_ORDER",metricDate:new Date("2026-10-13Z"),lastSuccessRunId:"new-success",lastSuccessAt:new Date(),state:"COMPLETE_NONZERO",reconciliationStatus:"CAFE24_API_ONLY_VERIFIED",warningCodes:[]},...(manual ? [{ source: recoveredSource, dataKind: "CAFE24_ORDER", metricDate: new Date("2026-10-12Z"),
        lastSuccessRunId: "manual-day", lastSuccessAt: new Date(), state: "COMPLETE_NONZERO",reconciliationStatus:"CAFE24_API_ONLY_VERIFIED",warningCodes:[] }] : [])] } };
    const service = new ScheduledSyncService(prisma, {} as any, {} as any, {} as any, {} as any);
    const first = await service.warnings(); assert.equal(first.items.length, 1);
    assert.deepEqual(first.items[0].missingDates, ["2026-10-12"]);
    assert.equal(first.automaticBackfill, false);
    assert.equal(first.history[0].truncatedEarlierWindows, false);
    manual = true; recoveredSource = "CSV"; assert.equal((await service.warnings()).items.length, 1);
    recoveredSource = "API"; assert.equal((await service.warnings()).items.length, 0);
    process.env.DAILY_SYNC_SCHEDULES = JSON.stringify([{ ...d, anchorAt: "2026-08-01T17:00:00.000Z" }]);
    const truncated = await service.warnings();
    assert.equal(truncated.history[0].truncatedEarlierWindows, true);
    assert.equal(truncated.history[0].warningCode, "OLDER_SCHEDULE_HISTORY_NOT_SCANNED");
  } finally { process.env = prior; }
});
test("last publish commit then process loss finalizes expired original run after stale lease without provider reads", async () => {
  const prior = process.env.DAILY_SYNC_FEATURE_ENABLED; process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  try {
    let updated: any; let audits = 0;
    const run: any = { id: "run", trigger: "SCHEDULED", status: "RUNNING", connectionId: "connection",
      requestKey: "schedule:test-key", fromDate: new Date("2026-10-11Z"), toDate: new Date("2026-10-11Z"),
      units: [{ unitKey: "2026-10-11", status: "SUCCEEDED", attempts: 1 }] };
    const tx: any = { $queryRaw: async () => [{ id: "connection" }], syncRun: {
      findUnique: async () => run, update: async (input: any) => { updated = input.data; } },
      syncLease: { findUnique: async () => ({ expiresAt: new Date(0) }) },
      securityAuditEvent: { create: async () => { audits++; } } };
    const service = new SyncFoundationService({ $transaction: async (fn: any) => fn(tx) } as any, {} as any);
    assert.equal(await service.prepareScheduledRetry("run", new Date(0)), false);
    assert.equal(updated.status, "SUCCEEDED"); assert.equal(updated.deadlineAt, null);
    assert.equal(updated.safeErrorCode, null); assert.equal(audits, 1);
  } finally { if (prior === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = prior; }
});
