// Synthetic fixtures on the dedicated, newly-created phase10 loopback cluster.
// Never opt in with an external or preserved 05-09 database URL.
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Reflector } from "@nestjs/core";
import { Prisma, SourceDataKind, SourceKind, SyncTrigger } from "@prisma/client";
import { PrismaService } from "../../../apps/api/src/common/prisma.service";
import { HeavyOperationGate } from "../../../apps/api/src/common/heavy-operation";
import { SyncFoundationService } from "../../../apps/api/src/daily-sync/sync-foundation.service";

const raw = process.env.PHASE10_API_SYNTHETIC_TEST_URL;
test("real local PG current foundation publishes exact Meta zero pair and rolls back writer/fence faults", { skip: !raw }, async () => {
  assert(raw); const url = new URL(raw);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55434");
  assert.equal(url.pathname, "/phase10_api_synthetic_20261019"); assert.equal(url.searchParams.get("schema"), "meta_ads");
  const previous = { ...process.env }, account = `phase10-synthetic-${randomUUID()}`;
  Object.assign(process.env, { DATABASE_URL: raw, DAILY_SYNC_FEATURE_ENABLED: "true", PRISMA_IDLE_DISCONNECT_MS: "0",
    DAILY_SYNC_ALLOWED_ACCOUNTS: JSON.stringify([`META/${account}/default`]) });
  const prisma = new PrismaService();
  const heavy = new HeavyOperationGate({ heavyOperationConcurrency: 1 } as any, new Reflector());
  const foundation = new SyncFoundationService(prisma, heavy);
  let claim: Awaited<ReturnType<SyncFoundationService["claimRun"]>> = null;
  try {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const end = Date.parse(`${today}T00:00:00Z`) - 86400_000;
    const fromDate = new Date(end - 6 * 86400_000).toISOString().slice(0, 10), toDate = new Date(end).toISOString().slice(0, 10);
    const connection = await prisma.sourceConnection.create({ data: { provider: "META", externalAccountId: account, shopKey: "default",
      displayName: "Synthetic phase10 foundation", currencyCode: "USD", timeZone: "Asia/Seoul", enabled: true, accessState: "READY", credentialExpiresAt: new Date(Date.now() + 3600000) } });
    for (const dataKind of [SourceDataKind.META_AD, SourceDataKind.META_ADSET]) await prisma.sourcePolicy.create({ data: {
      connectionId: connection.id, dataKind, fromDate: new Date(`${fromDate}Z`), primarySource: "API", version: 1, effectiveAt: new Date(), reason: "SYNTHETIC_PHASE10" } });
    const run = await foundation.queueRun({ connectionId: connection.id, fromDate, toDate, trigger: SyncTrigger.SCHEDULED, actorUserId: null, requestKey: `phase10:${randomUUID()}` });
    claim = await foundation.claimRun(run.id, Date.now() + 65_000); assert(claim);
    await foundation.beginScheduledUnit(claim, fromDate);
    const header = { runId: run.id, generation: claim.generation, unitKey: fromDate, metricDate: new Date(`${fromDate}Z`),
      slices: [SourceDataKind.META_AD, SourceDataKind.META_ADSET].map(dataKind => ({ dataKind, source: SourceKind.API, policyVersion: 1, fetchedCount: 0, pageCount: 1, complete: true, totalAmount: new Prisma.Decimal(0) })) };
    const writerCode = `phase10-writer-fault-${randomUUID()}`;
    await assert.rejects(foundation.publishUnit({ ...header, writeRows: async tx => {
      await tx.product.create({ data: { code: writerCode, name: "Synthetic", displayName: "Synthetic" } });
      throw Error("SYNTHETIC_WRITER_FAULT");
    } }), /SYNTHETIC_WRITER_FAULT/);
    assert.equal(await prisma.product.count({ where: { code: writerCode } }), 0);
    assert.equal(await prisma.sourceCoverage.count({ where: { connectionId: connection.id } }), 0);
    const fenceCode = `phase10-fence-fault-${randomUUID()}`;
    await assert.rejects(foundation.publishUnit({ ...header, writeRows: async tx => {
      await tx.product.create({ data: { code: fenceCode, name: "Synthetic", displayName: "Synthetic" } });
      await tx.syncLease.update({ where: { connectionId: connection.id }, data: { expiresAt: new Date(0) } });
      return { META_AD: 0, META_ADSET: 0 };
    } }));
    assert.equal(await prisma.product.count({ where: { code: fenceCode } }), 0);
    assert.equal(await prisma.sourceCoverage.count({ where: { connectionId: connection.id } }), 0);
    assert((await prisma.syncLease.findUniqueOrThrow({ where: { connectionId: connection.id } })).expiresAt > new Date());
    const success = await foundation.publishUnit({ ...header, writeRows: async () => ({ META_AD: 0, META_ADSET: 0 }) });
    assert.equal(success.published, 0);
    assert.equal(await prisma.sourceCoverage.count({ where: { connectionId: connection.id, state: "COMPLETE_ZERO", lastSuccessRunId: run.id, rowCount: 0 } }), 2);
    const audits = await prisma.securityAuditEvent.count({ where: { targetId: `${run.id}:${fromDate}`, action: "SYNC_UNIT_PUBLISHED" } });
    assert.equal(audits, 1);
    assert.equal((await foundation.publishUnit({ ...header, writeRows: async () => { throw Error("DUPLICATE_WRITER_MUST_NOT_RUN"); } })).published, 0);
    assert.equal(await prisma.securityAuditEvent.count({ where: { targetId: `${run.id}:${fromDate}`, action: "SYNC_UNIT_PUBLISHED" } }), 1);
    await foundation.finishRun(claim);
    console.log(JSON.stringify({ kind: "PHASE10_SYNTHETIC_REAL_PG_FOUNDATION", checks: 4, providerRequests: 0, writerFaultRollback: true, finalFenceRollback: true, exactMetaZeroPair: true, duplicatePublishSkipped: true }));
  } finally {
    claim?.release(); await prisma.$disconnect();
    for (const name of ["DATABASE_URL", "DAILY_SYNC_FEATURE_ENABLED", "PRISMA_IDLE_DISCONNECT_MS", "DAILY_SYNC_ALLOWED_ACCOUNTS"]) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});
