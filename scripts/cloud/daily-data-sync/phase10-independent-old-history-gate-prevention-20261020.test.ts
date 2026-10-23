import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { inspectOldAppRollbackReadiness, assertOldAppRollbackReady } from "../../../apps/api/src/daily-sync/old-app-rollback-readiness";
const raw = process.env.PHASE10_API_SYNTHETIC_TEST_URL;
test("new gate prevents entry to exact old restore/delete in the eight demonstrated API-history scenarios", { skip: !raw }, async () => {
  assert(raw); const url = new URL(raw);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55437"); assert.equal(url.pathname, "/phase10_independent_history_20261020_v1");
  const db = new PrismaClient({ datasourceUrl: raw }), require = createRequire(import.meta.url);
  const Old = require(process.env.PHASE10_API_OLD_CLIENT_PATH!); const old = new Old.PrismaClient({ datasourceUrl: raw });
  const original = "C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-20261020-old-history-v10/old-source/apps/api/src/uploads/upload-lifecycle.service.ts";
  assert.equal(createHash("sha256").update(readFileSync(original)).digest("hex"), "d7e51963b70c91e03c9e21a31bfc69be7452b51432ef8df7b6e6d939027e6259");
  const Legacy = (await import(pathToFileURL(original).href)).UploadLifecycleService;
  const oldGate = (await import(pathToFileURL("C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v3/apps/api/src/daily-sync/old-app-rollback-readiness.ts").href)).inspectOldAppRollbackReadiness;
  let legacyEntries = 0, storageCalls = 0;
  const service = new Legacy(old, { retain: async () => { storageCalls++; throw Error("NO_STORAGE"); }, restore: async () => { storageCalls++; throw Error("NO_STORAGE"); } });
  const date = new Date("2026-10-19Z"), cases: any[] = [];
  const digest = async () => {
    const names = await db.$queryRaw<Array<{ name: string }>>`SELECT tablename AS name FROM pg_tables WHERE schemaname='meta_ads' ORDER BY tablename`;
    const parts = [];
    for (const { name } of names) {
      assert.match(name, /^[a-z0-9_]+$/);
      const [r] = await db.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS rows,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS md5 FROM meta_ads."${name}" t`);
      parts.push({ name, ...r });
    }
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  };
  try {
    const emptyHeld = { stopConfirmed: true, schedulesPausedConfirmed: true, policyScope: { connectionIds: [randomUUID()], fromDate: date, toDate: date } };
    const noHistory = await db.$transaction(tx => assertOldAppRollbackReady(tx, emptyHeld), { isolationLevel: "RepeatableRead" });
    assert.equal(noHistory.ready, true); assert.equal(noHistory.retainedApiHistoryAllowed, false);
    for (const kind of ["META_AD", "META_ADSET"]) for (const operation of ["RESTORE_HELPER", "DELETE_UPLOAD"]) for (const version of [1, 5]) {
      const conn = await db.sourceConnection.create({ data: { provider: "META", externalAccountId: randomUUID(), shopKey: "default", displayName: "Synthetic", currencyCode: "USD", timeZone: "Asia/Seoul", enabled: false } });
      const run = await db.syncRun.create({ data: { connectionId: conn.id, trigger: "MANUAL", requestKey: randomUUID(), fromDate: date, toDate: date, status: "SUCCEEDED" } });
      await db.sourcePolicy.create({ data: { connectionId: conn.id, dataKind: kind as any, fromDate: date, primarySource: "CSV", version: 4, reason: "SYNTHETIC_USER_SELECTION" } });
      const adset = await db.metaAdset.create({ data: { connectionId: conn.id, adsetName: "Synthetic", adsetNameKey: randomUUID() } });
      const batch = await db.uploadBatch.create({ data: { originalFilename: "synthetic.csv", fileHashSha256: randomUUID().replaceAll("-", "").repeat(2), columnSchema: [], status: "IMPORTED" } });
      const common: any = { connectionId: conn.id, metricDate: date, dateStart: date, dateEnd: date };
      let model: any, key: any;
      if (kind === "META_ADSET") { model = db.metaAdsetDailyMetric; Object.assign(common, { metaAdsetId: adset.id, adsetName: "Synthetic", adsetNameKey: adset.adsetNameKey }); key = { metricDate: date, metaAdsetId: adset.id }; }
      else {
        model = db.metaAdDailyMetric;
        const campaign = await db.metaCampaign.create({ data: { connectionId: conn.id, externalCampaignId: randomUUID(), campaignName: "Synthetic" } });
        const ad = await db.metaAd.create({ data: { connectionId: conn.id, campaignRefId: campaign.id, metaAdsetRefId: adset.id, metaCampaignId: randomUUID(), metaAdsetId: randomUUID(), syntheticAdKey: randomUUID(), adIdentityKey: randomUUID(), adName: "Synthetic" } });
        Object.assign(common, { campaignRefId: campaign.id, metaAdsetRefId: adset.id, metaAdRefId: ad.id, metaCampaignId: ad.metaCampaignId, campaignNameSnapshot: "Synthetic", metaAdsetId: ad.metaAdsetId, adsetNameSnapshot: "Synthetic", syntheticAdKey: ad.syntheticAdKey, adIdentityKey: ad.adIdentityKey, adNameSnapshot: "Synthetic" });
        key = { metricDate: date, metaCampaignId: ad.metaCampaignId, metaAdsetId: ad.metaAdsetId, adIdentityKey: ad.adIdentityKey, creativeId: null, adNameSnapshot: "Synthetic" };
      }
      await model.create({ data: { ...common, source: "CSV", uploadBatchId: batch.id, importVersion: 4, isCurrent: true, resultCount: 0, reach: 0, shopClicks: 0, landingPageViews: 0, rawRow: { synthetic: true } } });
      await model.create({ data: { ...common, source: "API", syncRunId: run.id, sourceRevision: "synthetic-retained-history", importVersion: version, isCurrent: false, resultCount: null } });
      const held = { ...emptyHeld, policyScope: { connectionIds: [conn.id], fromDate: date, toDate: date } };
      const oldResult = await db.$transaction(tx => oldGate(tx, held), { isolationLevel: "RepeatableRead" }); assert.equal(oldResult.ready, true); assert.equal(oldResult.retainedApiHistoryAllowed, true);
      const before = await digest();
      const guardedEntry = async () => {
        await db.$transaction(tx => assertOldAppRollbackReady(tx, held), { isolationLevel: "RepeatableRead" });
        legacyEntries++;
        if (operation === "DELETE_UPLOAD") await service.deleteUpload(batch.id);
        else await old.$transaction((tx: any) => kind === "META_AD" ? service.restoreCurrentAdMetrics(tx, [key]) : service.restoreCurrentAdsetMetrics(tx, [key]));
      };
      await assert.rejects(guardedEntry(), (e: any) => e.safeCode === "SOURCE_SELECTION_REQUIRED" && e.diagnosticCode === "OLD_APP_ROLLBACK_NOT_READY");
      const result = await db.$transaction(tx => inspectOldAppRollbackReadiness(tx, held), { isolationLevel: "RepeatableRead" });
      assert.equal(result.ready, false); assert.deepEqual(result.reasons, ["API_HISTORY_REMAINS"]); assert.equal(result.retainedApiHistoryAllowed, false); assert.equal(result.dataWrites, 0);
      assert.equal(await digest(), before); assert.equal(legacyEntries, 0); assert.equal(storageCalls, 0);
      cases.push({ kind, operation, apiVersion: version, oldGateReady: true, newGateBlocked: true, allTablesHashPreserved: true });
    }
    const foreignScope = await db.$transaction(tx => inspectOldAppRollbackReadiness(tx, emptyHeld), { isolationLevel: "RepeatableRead" });
    assert.equal(foreignScope.ready, false); assert(foreignScope.reasons.includes("API_HISTORY_REMAINS"));
    console.log(JSON.stringify({ kind: "REAL_LOCAL_PG_OLD_HISTORY_GATE_PREVENTION", caseCount: cases.length, cases, noApiGlobalControlReady: true,
      legacyFunctionEntries: legacyEntries, storageCalls, allTablesPreserved: true, oldGateComparedFrozenV3: true,
      foreignManifestHistoryStillBlocked: true, gateCallerRequired: true, launcherWiringTested: false, providerCalls: 0, remoteWrites: 0 }));
  } finally { await old.$disconnect(); await db.$disconnect(); }
});
