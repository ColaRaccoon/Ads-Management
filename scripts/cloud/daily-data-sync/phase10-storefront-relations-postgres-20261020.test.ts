// Synthetic records in a fresh loopback cluster only. No provider or remote DB.
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaService } from "../../../apps/api/src/common/prisma.service";
import { createSourceReadContext, selectCurrentSourceRows } from "../../../apps/api/src/common/source-read-policy";
import { StorefrontReadService } from "../../../apps/api/src/storefront/storefront-read.service";
import { metaCollectionSummary } from "../../../apps/api/src/common/meta-collection-summary";

const raw = process.env.PHASE10_API_SYNTHETIC_TEST_URL;
test("real local PG Storefront equals frozen v4 and context preserves RR snapshot with concurrent coverage change", { skip: !raw }, async () => {
  assert(raw); const url = new URL(raw);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55436");
  assert.equal(url.pathname, "/phase10_meta_sql_synthetic_20261020"); assert.equal(url.searchParams.get("schema"), "meta_ads");
  const saved = { ...process.env }, from = new Date("2026-10-09Z"), to = new Date("2026-10-15Z");
  Object.assign(process.env, { DATABASE_URL: raw, DAILY_SYNC_FEATURE_ENABLED: "true", PRISMA_IDLE_DISCONNECT_MS: "0", PRISMA_CONNECTION_LIMIT: "3" });
  const db = new PrismaClient({ datasourceUrl: raw, log: [{ emit: "event", level: "query" }] }); let commands = 0, physical = 0; db.$on("query", () => { physical++; });
  db.$use(async (params, next) => { commands++; return next(params); });
  try {
    const identity = await db.$queryRaw<any[]>`SELECT current_database() AS database,current_schema() AS schema,current_user AS role`;
    assert.deepEqual(identity, [{ database: "phase10_meta_sql_synthetic_20261020", schema: "meta_ads", role: "phase10_harness" }]);
    const ids: Record<string, string> = {};
    for (const provider of ["CAFE24", "META"] as const) {
      const c = await db.sourceConnection.create({ data: { provider, externalAccountId: `local-context-${randomUUID()}`, shopKey: "default",
        displayName: "Synthetic read context", currencyCode: provider === "META" ? "USD" : "KRW", timeZone: "Asia/Seoul", enabled: true, accessState: "READY", credentialRef: "synthetic-only" } });
      ids[provider] = c.id;
      const dataKind = provider === "META" ? "META_ADSET" : "CAFE24_ORDER";
      await db.sourcePolicy.create({ data: { connectionId: c.id, dataKind, primarySource: "API", fromDate: from, version: 1, effectiveAt: new Date(), reason: "SYNTHETIC_READ_CONTEXT" } });
      if (provider === "META") await db.sourcePolicy.create({ data: { connectionId: c.id, dataKind: "META_AD", primarySource: "API", fromDate: from, version: 1, effectiveAt: new Date(), reason: "SYNTHETIC_AD_ZERO" } });
      const run = await db.syncRun.create({ data: { connectionId: c.id, requestKey: `context-${randomUUID()}`, trigger: "MANUAL", fromDate: from, toDate: to, status: "SUCCEEDED" } });
      for (let t = from.getTime(); t <= to.getTime(); t += 86400_000) {
        const metricDate = new Date(t);
        await db.sourceCoverage.create({ data: { connectionId: c.id, dataKind, metricDate, source: "API", state: "COMPLETE_ZERO", lastSuccessRunId: run.id,
          lastSuccessAt: new Date("2026-10-16Z"), rowCount: 0, totalAmount: new Prisma.Decimal(0), reconciliationStatus: "CAFE24_API_ONLY_VERIFIED" } });
        await db.runUnit.create({ data: { runId: run.id, unitKey: metricDate.toISOString().slice(0, 10), status: "SUCCEEDED", fetchedCount: 0, publishedCount: 0 } });
        if (provider === "META") await db.sourceCoverage.create({ data: { connectionId: c.id, dataKind: "META_AD", metricDate, source: "API", state: "FAILED", lastSuccessRunId: run.id,
          lastSuccessAt: new Date("2026-10-16Z"), rowCount: 0, totalAmount: new Prisma.Decimal(0) } });
      }
    }
    const extra = await db.sourceConnection.create({ data: { provider: "GOOGLE", externalAccountId: randomUUID(), shopKey: "default", displayName: "Disabled synthetic", currencyCode: "KRW", timeZone: "Asia/Seoul", enabled: false } });
    await db.sourceCoverage.create({ data: { connectionId: ids.META, dataKind: "META_ADSET", metricDate: new Date("2026-10-20Z"), source: "CSV", rowCount: 0, lastSuccessAt: new Date("2026-10-22Z") } });
    const highId = "ffffffff-ffff-4fff-afff-ffffffffffff", lowId = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
    for (const [id, startedAt] of [[lowId, new Date("2026-10-20Z")], [highId, new Date("2026-10-20Z")], [randomUUID(), null]] as const)
      await db.syncRun.create({ data: { id, connectionId: ids.META, requestKey: randomUUID(), trigger: "MANUAL", fromDate: from, toDate: to, status: "FAILED", startedAt, safeErrorCode: "SYNTHETIC_FAILURE" } });
    const product = await db.product.create({ data: { code: randomUUID(), name: "Synthetic", displayName: "Synthetic" } });
    const batch = await db.uploadBatch.create({ data: { originalFilename: "synthetic.csv", fileHashSha256: randomUUID().replaceAll("-", "").repeat(2), columnSchema: [] } });
    const set = await db.metaAdset.create({ data: { connectionId: ids.META, adsetName: "Synthetic", adsetNameKey: randomUUID() } });
    const metric = await db.metaAdsetDailyMetric.create({ data: { connectionId: ids.META, source: "CSV", uploadBatchId: batch.id, rawRow: { synthetic: true }, metaAdsetId: set.id, productId: product.id,
      metricDate: from, dateStart: from, dateEnd: from, adsetName: "Synthetic", adsetNameKey: set.adsetNameKey, resultCount: 0, reach: 0, shopClicks: 0, landingPageViews: 0 } });
    physical = 0; await db.metaAdsetDailyMetric.findMany({ where: { id: metric.id }, include: { product: true, metaAdset: true } }); const includedRelationPhysical = physical;
    physical = 0; await db.metaAdsetDailyMetric.findMany({ where: { id: metric.id } }); const noRelationPhysical = physical;
    physical = 0; await db.metaAdsetDailyMetric.findMany({ where: { id: metric.id }, include: { product: { select: { displayName: true } } } }); const displayNameRelationPhysical = physical;
    assert.equal(includedRelationPhysical, 3); assert.equal(noRelationPhysical, 1); assert.equal(displayNameRelationPhysical, 2);
    const OldCollection = (await import(pathToFileURL("C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v4/apps/api/src/common/meta-collection-summary.ts").href)).metaCollectionSummary;
    physical = 0; const previousCollection = await OldCollection(db, from, to), collectionOldPhysical = physical;
    physical = 0; const currentCollection = await metaCollectionSummary(db as any, from, to), collectionNewPhysical = physical;
    assert.deepEqual(currentCollection, previousCollection); assert.equal(collectionNewPhysical, collectionOldPhysical - 1);
    assert.equal(currentCollection.items.length, 2); assert(currentCollection.items.every(item => item.collectedDays === 7));
    const Old = (await import(pathToFileURL("C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v4/apps/api/src/storefront/storefront-read.service.ts").href)).StorefrontReadService;
    physical = 0; commands = 0; const old = await new Old(db).summary("2026-10-09", "2026-10-15"), oldCommands = commands, oldPhysical = physical;
    physical = 0; commands = 0; const current = await new StorefrontReadService(db).summary("2026-10-09", "2026-10-15"), currentCommands = commands, newPhysical = physical;
    assert.deepEqual(current, old);
    assert.equal(current.connections.find(c => c.id === ids.META)?.latestAttempt?.id, highId);
    assert.equal(current.connections.find(c => c.id === ids.META)?.lastSuccessAt, "2026-10-22T00:00:00.000Z");
    assert.equal(current.connections.find(c => c.id === extra.id)?.enabled, false);
    assert.equal(current.coverage.filter(c => Object.values(ids).includes(c.connectionId) && c.complete).length, 14);
    assert.equal(currentCommands, oldCommands); assert.equal(newPhysical, oldPhysical - 2);
    const row = { source: "API" as const, connectionId: ids.CAFE24, metricDate: from };
    await db.$transaction(async tx => {
      const isolation = await tx.$queryRaw<any[]>`SELECT current_setting('transaction_isolation') AS isolation`;
      assert.equal(isolation[0].isolation, "repeatable read");
      const policies = await tx.sourcePolicy.findMany({ where: { connectionId: ids.CAFE24 } });
      const coverage = await tx.sourceCoverage.findMany({ where: { metricDate: { gte: from, lte: to } } });
      const context = createSourceReadContext(tx, from, to, policies, coverage);
      assert.equal((await selectCurrentSourceRows(tx, "CAFE24_ORDER", [row], r => r.metricDate, context)).length, 1);
      // A separately committed connection removes successful coverage while
      // the original read transaction keeps its original snapshot and proof.
      await db.sourceCoverage.update({ where: { connectionId_dataKind_metricDate: { connectionId: ids.CAFE24, dataKind: "CAFE24_ORDER", metricDate: from } }, data: { lastSuccessRunId: null } });
      assert.equal((await selectCurrentSourceRows(tx, "CAFE24_ORDER", [row], r => r.metricDate, context)).length, 1);
      assert.equal((await selectCurrentSourceRows(tx, "CAFE24_ORDER", [row], r => r.metricDate)).length, 1);
    }, { isolationLevel: "RepeatableRead", timeout: 30000 });
    await db.$transaction(async tx => {
      const policies = await tx.sourcePolicy.findMany({ where: { connectionId: ids.CAFE24 } });
      await assert.rejects(selectCurrentSourceRows(tx, "CAFE24_ORDER", [row], r => r.metricDate, createSourceReadContext(tx, from, to, policies)), /exactly one selected source/);
    }, { isolationLevel: "RepeatableRead", timeout: 30000 });
    for (let i = 3; i < 100; i++) await db.sourceConnection.create({ data: { provider: "GOOGLE", externalAccountId: randomUUID(), shopKey: "default", displayName: "Bound synthetic", currencyCode: "KRW", timeZone: "Asia/Seoul", enabled: false } });
    assert.deepEqual(await new StorefrontReadService(db as any).summary("2026-10-09", "2026-10-15"), await new Old(db as any).summary("2026-10-09", "2026-10-15"));
    await db.sourceConnection.create({ data: { provider: "GOOGLE", externalAccountId: randomUUID(), shopKey: "default", displayName: "Excess synthetic", currencyCode: "KRW", timeZone: "Asia/Seoul", enabled: false } });
    for (const Service of [Old, StorefrontReadService]) await assert.rejects(new Service(db as any).summary("2026-10-09", "2026-10-15"), (e: any) => e.getResponse?.().code === "STOREFRONT_ROW_LIMIT");
    console.log(JSON.stringify({ kind: "PHASE10_REAL_LOCAL_PG_STOREFRONT_RELATIONS_20261020", wholeOutputEqualFrozenV4: true, verifiedZeroCoverage: 14,
      beforeMiddlewareCommands: oldCommands, afterMiddlewareCommands: currentCommands, beforePhysicalQueries: oldPhysical, afterPhysicalQueries: newPhysical, sameRepeatableReadConcurrentCommitPreserved: true,
      nextRequestFreshEvidenceRejects: true, latestRunNullAndUuidTieOrderEqual: true, disabledAndEmptyConnectionsEqual: true,
      hundredConnectionsEqual: true, oneHundredOneConnectionsBothRejected: true, includedRelationPhysical, noRelationPhysical, displayNameRelationPhysical,
      metaCollectionWholeOutputEqualFrozenV4: true, collectionOldPhysical, collectionNewPhysical,
      providerRequests: 0, remoteWrites: 0, actualSlaValidated: false }));
  } finally {
    await db.$disconnect();
    for (const name of ["DATABASE_URL", "DAILY_SYNC_FEATURE_ENABLED", "PRISMA_IDLE_DISCONNECT_MS", "PRISMA_CONNECTION_LIMIT"]) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});
