import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PrismaClient, SourceDataKind } from "@prisma/client";
import { validatedMetaApiDays, validatedMetaApiDaysBatch } from "../../../apps/api/src/common/meta-source-read-coverage";

const raw = process.env.PHASE10_META_SQL_LOCAL_URL;
test("single-statement Meta evidence equals frozen v1 on real synthetic PG corruption/boundary matrix", { skip: !raw }, async () => {
  assert(raw); const url = new URL(raw);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55437");
  assert.equal(url.pathname, "/phase10_independent_relations_20261020_v1"); assert.equal(url.searchParams.get("schema"), "meta_ads");
  const db = new PrismaClient({ datasourceUrl: raw, log: [{ emit: "event", level: "query" }] });
  let queries = 0; db.$on("query", () => { queries++; });
  const old = (await import(pathToFileURL("C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v1/apps/api/src/common/meta-source-read-coverage.ts").href)).validatedMetaApiDays;
  const date = new Date("2026-10-14T00:00:00Z");
  const variants = ["positive", "zero", "missing-coverage", "coverage-csv", "null-run", "null-success-time", "negative-count", "null-count", "wrong-count",
    "missing-link", "wrong-version", "noncurrent-link", "noncurrent-metric", "csv-metric", "csv-link", "wrong-table", "wrong-kind", "wrong-link-connection",
    "missing-unit", "failed-unit", "wrong-unit-day", "wrong-run-connection", "failed-coverage", "failed-overall-run", "duplicate-valid-link", "duplicate-invalid-link",
    "stale-unjoined-link", "zero-stale-unjoined-link", "other-date", "other-connection", "other-kind"];
  const passing = new Set(["positive", "zero", "failed-coverage", "failed-overall-run", "stale-unjoined-link", "zero-stale-unjoined-link"]);
  const results: any[] = [];
  try {
    const identity = await db.$queryRaw<any[]>`SELECT current_database() AS database, current_schema() AS schema, current_user AS role`;
    assert.deepEqual(identity, [{ database: "phase10_independent_relations_20261020_v1", schema: "meta_ads", role: "phase10_harness" }]);
    // Corruption-only duplicate-link cases require relaxing this one unique
    // index in the fresh synthetic database. No deployed schema is changed.
    await db.$executeRawUnsafe('DROP INDEX "source_record_links_connection_id_data_kind_source_record_t_key"');
    await db.$executeRawUnsafe('ALTER TABLE source_coverage DROP CONSTRAINT "source_coverage_count_check"');
    for (const kind of [SourceDataKind.META_AD, SourceDataKind.META_ADSET]) for (const variant of variants) {
      const c = await db.sourceConnection.create({ data: { provider: "META", externalAccountId: randomUUID(), shopKey: "synthetic", displayName: "Synthetic", currencyCode: "USD", timeZone: "Asia/Seoul", enabled: false } });
      const other = await db.sourceConnection.create({ data: { provider: "META", externalAccountId: randomUUID(), shopKey: "synthetic", displayName: "Synthetic", currencyCode: "USD", timeZone: "Asia/Seoul", enabled: false } });
      const run = await db.syncRun.create({ data: { connectionId: variant === "wrong-run-connection" ? other.id : c.id, trigger: "MANUAL", requestKey: randomUUID(), fromDate: date, toDate: date,
        status: variant === "failed-overall-run" ? "FAILED" : "SUCCEEDED" } });
      if (variant !== "missing-unit") await db.runUnit.create({ data: { runId: run.id, unitKey: variant === "wrong-unit-day" ? "2026-10-13" : "2026-10-14", status: variant === "failed-unit" ? "FAILED" : "SUCCEEDED" } });
      const zero = variant === "zero" || variant === "zero-stale-unjoined-link";
      if (variant !== "missing-coverage") await db.sourceCoverage.create({ data: { connectionId: c.id, dataKind: kind, metricDate: date,
        source: variant === "coverage-csv" ? "CSV" : "API", state: variant === "failed-coverage" ? "FAILED" : "COMPLETE_NONZERO",
        lastSuccessRunId: variant === "null-run" ? null : run.id, lastSuccessAt: variant === "null-success-time" ? null : date,
        rowCount: variant === "negative-count" ? -1 : variant === "null-count" ? null : variant === "wrong-count" ? 2 : zero ? 0 : 1 } });
      const table = kind === "META_AD" ? "meta_ad_daily_metrics" : "meta_adset_daily_metrics";
      let metricId = randomUUID();
      if (!zero) {
        const campaign = await db.metaCampaign.create({ data: { connectionId: c.id, externalCampaignId: randomUUID(), campaignName: "Synthetic" } });
        const adset = await db.metaAdset.create({ data: { connectionId: c.id, campaignRefId: campaign.id, adsetName: "Synthetic", adsetNameKey: randomUUID() } });
        const batch = variant === "csv-metric" ? await db.uploadBatch.create({ data: { originalFilename: "synthetic.csv", fileHashSha256: randomUUID().replaceAll("-", "").repeat(2), columnSchema: [] } }) : null;
        const shared = { id: metricId, connectionId: c.id, syncRunId: batch ? null : run.id, sourceRevision: batch ? null : "synthetic-v1", uploadBatchId: batch?.id ?? null, metricDate: date, dateStart: date, dateEnd: date,
          source: variant === "csv-metric" ? "CSV" as const : "API" as const, isCurrent: variant !== "noncurrent-metric" };
        if (kind === "META_ADSET") await db.metaAdsetDailyMetric.create({ data: { ...shared, metaAdsetId: adset.id, adsetName: "Synthetic", adsetNameKey: randomUUID() } });
        else {
          const ad = await db.metaAd.create({ data: { connectionId: c.id, campaignRefId: campaign.id, metaAdsetRefId: adset.id,
            metaCampaignId: "synthetic", metaAdsetId: "synthetic", syntheticAdKey: randomUUID(), adIdentityKey: randomUUID(), adName: "Synthetic" } });
          await db.metaAdDailyMetric.create({ data: { ...shared, campaignRefId: campaign.id, metaAdsetRefId: adset.id, metaAdRefId: ad.id,
            metaCampaignId: "synthetic", campaignNameSnapshot: "Synthetic", metaAdsetId: "synthetic", adsetNameSnapshot: "Synthetic",
            syntheticAdKey: randomUUID(), adIdentityKey: randomUUID(), adNameSnapshot: "Synthetic" } });
        }
        if (variant !== "missing-link") await db.sourceRecordLink.create({ data: { connectionId: variant === "wrong-link-connection" ? other.id : c.id,
          dataKind: variant === "wrong-kind" ? "CAFE24_ORDER" : kind, canonicalKeyHash: "a".repeat(64), source: variant === "csv-link" ? "CSV" : "API",
          recordTable: variant === "wrong-table" ? "cafe24_order_lines" : table, recordId: metricId, syncRunId: run.id,
          version: variant === "wrong-version" ? 2 : 1, isCurrent: variant !== "noncurrent-link", bindingMethod: "EXACT_ID" } });
        if (variant.startsWith("duplicate-")) await db.sourceRecordLink.create({ data: { connectionId: c.id, dataKind: kind,
          canonicalKeyHash: "b".repeat(64), source: "API", recordTable: table, recordId: metricId, syncRunId: run.id,
          version: variant === "duplicate-invalid-link" ? 2 : 1, bindingMethod: "EXACT_ID" } });
      }
      if (variant.includes("stale-unjoined-link")) await db.sourceRecordLink.create({ data: { connectionId: c.id, dataKind: kind,
        canonicalKeyHash: "c".repeat(64), source: "API", recordTable: table, recordId: randomUUID(), syncRunId: run.id, version: 1, bindingMethod: "EXACT_ID" } });
      const ids = variant === "other-connection" ? [other.id] : [c.id];
      const queryKind = variant === "other-kind" ? kind === "META_AD" ? "META_ADSET" : "META_AD" : kind;
      const queryDate = variant === "other-date" ? new Date("2026-10-15Z") : date;
      const result = await db.$transaction(async tx => {
        const before = queries; const expected = await old(tx, queryKind, ids, queryDate, queryDate); const oldQueries = queries - before;
        const next = queries; const actual = await validatedMetaApiDays(tx, queryKind, ids, queryDate, queryDate); const newQueries = queries - next;
        assert.deepEqual(actual, expected, `${kind}/${variant}`);
        assert.equal(actual.size, passing.has(variant) ? 1 : 0, `${kind}/${variant}/expected outcome`);
        assert.equal(newQueries, 1); assert(oldQueries >= 2);
        const expectedKinds = new Map();
        for (const k of [SourceDataKind.META_AD, SourceDataKind.META_ADSET]) expectedKinds.set(k, await old(tx, k, ids, queryDate, queryDate));
        const batchBefore = queries;
        const batch = await validatedMetaApiDaysBatch(tx, [SourceDataKind.META_AD, SourceDataKind.META_ADSET], ids, queryDate, queryDate);
        const batchQueries = queries - batchBefore; assert.equal(batchQueries, 1);
        assert.deepEqual(batch, expectedKinds, `${kind}/${variant}/both kinds batch`);
        return { kind, variant, pass: true, validDays: actual.size, oldPhysicalQueries: oldQueries, newPhysicalQueries: newQueries, batchPhysicalQueries: batchQueries, batchKindsEqualOldOracle: true };
      }, { isolationLevel: "RepeatableRead", timeout: 30000 });
      results.push(result);
    }
    const before = queries;
    assert.deepEqual(await validatedMetaApiDays(db, "META_AD", [], date, date), new Set());
    assert.equal(queries, before);
    console.log(JSON.stringify({ kind: "REAL_SYNTHETIC_PG_META_SINGLE_SQL_ORACLE", matrixCases: results.length, allPass: true,
      cases: results, emptyAccountCommands: 0, syntheticDuplicateIndexRelaxed: true, syntheticNegativeCountConstraintRelaxed: true,
      providerCalls: 0, remoteWrites: 0, actualSlaMeasured: false }));
  } finally { await db.$disconnect(); }
});
