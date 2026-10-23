// Only the two legacy restore helpers and their original deleteUpload caller.
// All records/storage interfaces are synthetic; no HTTP or external transport.
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Prisma, PrismaClient } from "@prisma/client";
import { inspectOldAppRollbackReadiness } from "../../../apps/api/src/daily-sync/old-app-rollback-readiness";
const raw = process.env.PHASE10_OLD_HISTORY_LOCAL_URL;
const stable = (v: any): string => v === null || typeof v !== "object" ? typeof v === "bigint" ? JSON.stringify(v.toString()) : JSON.stringify(v)
  : v instanceof Date ? JSON.stringify(v.toISOString()) : Prisma.Decimal.isDecimal(v) ? JSON.stringify(v.toString())
  : Array.isArray(v) ? `[${v.map(stable).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
const hash = (v: any) => createHash("sha256").update(stable(v)).digest("hex");
test("HEAD old restore/delete preserve or reject retained API history: actual old Prisma and real 51-migration PG", { skip: !raw }, async () => {
  assert(raw); const url = new URL(raw);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55436"); assert.equal(url.pathname, "/phase10_old_history_synthetic_20261020");
  assert.equal(url.searchParams.get("schema"), "meta_ads");
  const root = process.env.PHASE10_OLD_HISTORY_ROOT!;
  assert.match(root, /^C:\/Users\/seong\/AppData\/Local\/MetaAdsPhase10Evaluation\/api-20261020-old-history-v(?:9|10)$/);
  const require = createRequire(import.meta.url), Old = require(`${root}/old-client`);
  const old = new Old.PrismaClient({ datasourceUrl: raw }), db = new PrismaClient({ datasourceUrl: raw });
  const Legacy = (await import(pathToFileURL(`${root}/old-source/apps/api/src/uploads/upload-lifecycle.service.ts`).href)).UploadLifecycleService;
  let storageCalls = 0;
  const storage = { retain: async () => { storageCalls++; throw Error("SYNTHETIC_STORAGE_MUST_NOT_RUN"); }, restore: async () => { storageCalls++; throw Error("SYNTHETIC_STORAGE_MUST_NOT_RUN"); } };
  const service = new Legacy(old, storage);
  const results: any[] = [], date = new Date("2026-10-19Z"), priorDate = new Date("2026-10-01Z");
  const modelFor = (kind: string) => kind === "META_AD" ? "metaAdDailyMetric" : "metaAdsetDailyMetric";
  const allTables = async () => {
    const names = await db.$queryRaw<Array<{ table: string }>>`SELECT tablename AS table FROM pg_tables WHERE schemaname='meta_ads' ORDER BY tablename`;
    const rows = [];
    for (const { table } of names) {
      assert.match(table, /^[a-z0-9_]+$/);
      const [r] = await db.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS rows,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS md5 FROM meta_ads."${table}" t`);
      rows.push({ table, ...r });
    }
    return hash(rows);
  };
  try {
    assert.deepEqual(await db.$queryRaw`SELECT current_database() AS database,current_schema() AS schema,current_user AS role`,
      [{ database: "phase10_old_history_synthetic_20261020", schema: "meta_ads", role: "phase10_harness" }]);
    for (const kind of ["META_AD", "META_ADSET"]) for (const operation of ["RESTORE_HELPER", "DELETE_UPLOAD"]) for (const variant of ["API_HIGHEST", "CSV_HIGHEST", "NO_API_CONTROL"]) {
      const model = modelFor(kind), table = kind === "META_AD" ? "meta_ad_daily_metrics" : "meta_adset_daily_metrics";
      const conn = await db.sourceConnection.create({ data: { provider: "META", externalAccountId: randomUUID(), shopKey: "default", displayName: "Synthetic", currencyCode: "USD", timeZone: "Asia/Seoul", enabled: false } });
      const run = await db.syncRun.create({ data: { connectionId: conn.id, trigger: "MANUAL", requestKey: randomUUID(), fromDate: date, toDate: date, status: "SUCCEEDED" } });
      const policy = await db.sourcePolicy.create({ data: { connectionId: conn.id, dataKind: kind as any, fromDate: date, primarySource: "CSV", version: 4, reason: "SYNTHETIC_LATER_USER_SELECTION" } });
      const product = await db.product.create({ data: { code: randomUUID(), name: "Synthetic", displayName: "LATER_USER_EDIT" } });
      const campaign = await db.metaCampaign.create({ data: { connectionId: conn.id, externalCampaignId: randomUUID(), campaignName: "Synthetic" } });
      const adset = await db.metaAdset.create({ data: { connectionId: conn.id, campaignRefId: campaign.id, adsetName: "Synthetic", adsetNameKey: randomUUID() } });
      const ad = kind === "META_AD" ? await db.metaAd.create({ data: { connectionId: conn.id, campaignRefId: campaign.id, metaAdsetRefId: adset.id,
        metaCampaignId: randomUUID(), metaAdsetId: randomUUID(), syntheticAdKey: randomUUID(), adIdentityKey: randomUUID(), adName: "Synthetic" } }) : null;
      const batchData = () => ({ originalFilename: "synthetic.csv", fileHashSha256: hash(randomUUID()), columnSchema: [], status: "IMPORTED" as const });
      const targetBatch = await db.uploadBatch.create({ data: batchData() }), laterBatch = await db.uploadBatch.create({ data: batchData() });
      const shared: any = { metricDate: date, dateStart: date, dateEnd: date, connectionId: conn.id, productId: product.id,
        spendUsd: new Prisma.Decimal("149.1234"), resultCount: 0, reach: 0, shopClicks: 0, landingPageViews: 0, createdAt: priorDate, updatedAt: priorDate };
      if (kind === "META_ADSET") Object.assign(shared, { metaAdsetId: adset.id, adsetName: "Synthetic", adsetNameKey: adset.adsetNameKey });
      else Object.assign(shared, { campaignRefId: campaign.id, metaAdsetRefId: adset.id, metaAdRefId: ad!.id,
        metaCampaignId: ad!.metaCampaignId, campaignNameSnapshot: "Synthetic", metaAdsetId: ad!.metaAdsetId,
        adsetNameSnapshot: "Synthetic", syntheticAdKey: ad!.syntheticAdKey, adIdentityKey: ad!.adIdentityKey, adNameSnapshot: "Synthetic" });
      const create = (data: any) => (db as any)[model].create({ data: { ...shared, ...data } });
      const target = await create({ source: "CSV", uploadBatchId: targetBatch.id, importVersion: 2, isCurrent: false, rawRow: { synthetic: true } });
      const later = await create({ source: "CSV", uploadBatchId: laterBatch.id, importVersion: 4, isCurrent: true, rawRow: { synthetic: true } });
      const unrelated = await create({ source: "CSV", uploadBatchId: laterBatch.id, importVersion: 1, isCurrent: true,
        metricDate: new Date("2026-10-18Z"), dateStart: new Date("2026-10-18Z"), dateEnd: new Date("2026-10-18Z"), rawRow: { synthetic: true } });
      const api = variant === "NO_API_CONTROL" ? null : await create({ source: "API", syncRunId: run.id, sourceRevision: "synthetic-retained-api",
        importVersion: variant === "API_HIGHEST" ? 5 : 1, isCurrent: false, resultCount: null,
        ...(kind === "META_ADSET" ? { reach: null, shopClicks: null, landingPageViews: null } : {}) });
      if (api) await db.sourceRecordLink.create({ data: { connectionId: conn.id, dataKind: kind as any, source: "API", recordTable: table,
        recordId: api.id, canonicalKeyHash: hash(randomUUID()), version: api.importVersion, syncRunId: run.id, isCurrent: false, bindingMethod: "EXACT_ID" } });
      await db.sourceCoverage.create({ data: { connectionId: conn.id, dataKind: kind as any, metricDate: date, source: "API", state: "FAILED",
        lastSuccessRunId: run.id, lastSuccessAt: priorDate, rowCount: 1 } });
      const held = { stopConfirmed: true, schedulesPausedConfirmed: true, policyScope: { connectionIds: [conn.id], fromDate: date, toDate: date } };
      const gate = await db.$transaction(tx => inspectOldAppRollbackReadiness(tx, held), { isolationLevel: "RepeatableRead" });
      assert.equal(gate.ready, true); assert.equal(gate.retainedApiHistoryAllowed, true);
      const preserved = async () => ({ api: api ? await (db as any)[model].findUniqueOrThrow({ where: { id: api.id } }) : null,
        later: await (db as any)[model].findUniqueOrThrow({ where: { id: later.id } }),
        unrelated: await (db as any)[model].findUniqueOrThrow({ where: { id: unrelated.id } }),
        links: await db.sourceRecordLink.findMany({ where: { connectionId: conn.id }, orderBy: { id: "asc" } }),
        coverage: await db.sourceCoverage.findMany({ where: { connectionId: conn.id }, orderBy: { dataKind: "asc" } }),
        policy: await db.sourcePolicy.findUniqueOrThrow({ where: { id: policy.id } }), product: await db.product.findUniqueOrThrow({ where: { id: product.id } }) });
      const before = await preserved(), allBefore = await allTables();
      const key = kind === "META_AD" ? { id: target.id, creativeId: null, metricDate: date, metaCampaignId: shared.metaCampaignId,
        metaAdsetId: shared.metaAdsetId, adIdentityKey: shared.adIdentityKey, adNameSnapshot: "Synthetic" } : { id: target.id, metricDate: date, metaAdsetId: adset.id };
      let code: string | null = null, completed = false;
      try {
        if (operation === "DELETE_UPLOAD") await service.deleteUpload(targetBatch.id);
        else await old.$transaction((tx: any) => kind === "META_AD" ? service.restoreCurrentAdMetrics(tx, [key]) : service.restoreCurrentAdsetMetrics(tx, [key]));
        completed = true;
      } catch (error: any) { code = /^[A-Z0-9_]{3,64}$/.test(error?.code ?? "") ? error.code : "SAFE_LEGACY_FAILURE"; }
      const after = await preserved(), allAfter = await allTables();
      const changedApiKeys = api ? Object.keys(before.api).filter(k => stable(before.api[k]) !== stable(after.api[k])).sort() : [];
      const laterPayload = (r: any) => { const { updatedAt, ...payload } = r; return hash(payload); };
      assert.equal(hash(before.unrelated), hash(after.unrelated)); assert.equal(hash(before.product), hash(after.product));
      assert.equal(hash(before.policy), hash(after.policy)); assert.equal(hash(before.links), hash(after.links)); assert.equal(hash(before.coverage), hash(after.coverage));
      assert.equal(laterPayload(before.later), laterPayload(after.later)); assert.equal(after.later.isCurrent, true);
      if (variant === "API_HIGHEST") { assert.equal(code, "P2032"); assert.equal(completed, false); assert.equal(allBefore, allAfter); assert.equal(hash(before.api), hash(after.api)); }
      else { assert.equal(code, null); assert.equal(completed, true); assert.deepEqual(changedApiKeys, api ? ["updatedAt"] : []); }
      const gateAfter = await db.$transaction(tx => inspectOldAppRollbackReadiness(tx, held), { isolationLevel: "RepeatableRead" });
      assert.equal(gateAfter.ready, true);
      assert.equal(await db.sourcePolicy.count({ where: { id: policy.id, version: 4, primarySource: "CSV" } }), 1);
      results.push({ kind, operation, variant, gateReady: gate.ready, retainedApiHistoryAllowed: gate.retainedApiHistoryAllowed,
        completed, code, allTablesHashEqual: allBefore === allAfter, apiFullHashPreserved: hash(before.api) === hash(after.api), changedApiKeys,
        apiPayloadPreserved: !api || laterPayload(before.api) === laterPayload(after.api), apiStillNoncurrent: !api || after.api.isCurrent === false,
        laterCsvPayloadAndCurrentPreserved: true, laterCsvFullHashPreserved: hash(before.later) === hash(after.later),
        unrelatedCsvProductPolicyLinksCoverageHashesPreserved: true, policyVersionCasStillMatches: true,
        targetBatchPreserved: !!await db.uploadBatch.findUnique({ where: { id: targetBatch.id } }), storageCalls });
    }
    assert.equal(storageCalls, 0);
    const report = { kind: "SYNTHETIC_ORIGINAL_OLD_LIFECYCLE_RETAINED_API_HISTORY", cases: results,
      caseCount: results.length, actualOldService: true, oldSchemaMigrationCount: 37, currentSchemaMigrationCount: 51,
      storageImplementation: "MOCK_UNCALLED_NO_STORED_FILES", providerCalls: 0, remoteWrites: 0, actualImageSwitch: false,
      noGeneralOldAppGo: true, diagnosis: "Gate permits history, but original source-unscoped restore mutates API updatedAt when CSV wins; API winner triggers P2032 and rolls back the entire old transaction." };
    writeFileSync(`${root}/lifecycle-result.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ kind: report.kind, cases: results.length, apiHighestP2032RollbackCases: 4,
      csvHighestApiMetadataMutationCases: 4, noApiControlCases: 4, storageCalls, noGeneralOldAppGo: true }));
  } finally { await old.$disconnect(); await db.$disconnect(); }
});
