import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaClient, SourceKind } from "@prisma/client";
import { classifyInfluencerCreative } from "./influencer-matching";
import { backfillInfluencerCollaboration, projectInfluencerDay } from "./influencer-projector";

test("classifies the creative marker before falling back to the campaign", () => {
  assert.deepEqual(classifyInfluencerCreative("261110_두줄보호대_인플（ 혜민 ）0015_IG", "인플(다른 사람)"), {
    influencerKey: "혜민", creativeName: "두줄보호대_인플( 혜민 )0015"
  });
  assert.deepEqual(classifyInfluencerCreative("두줄보호대_0015", "두줄보호대_인플( ＨＹＥＭＩＮ )"), {
    influencerKey: "hyemin", creativeName: "두줄보호대_0015"
  });
  assert.equal(classifyInfluencerCreative("두줄보호대_인플(혜민)_인플(지민)", "인플(혜민)"), null);
  assert.equal(classifyInfluencerCreative("두줄보호대_0015", "일반 캠페인"), null);
});

const databaseUrl = process.env.INFLUENCER_FIXTURE_DATABASE_URL;

test("publishes day replacements, removes stale totals and keeps incomplete amounts unknown", { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl!);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.username, "fixture_owner");
  assert.equal(url.pathname, "/influencer_fixture");
  assert.equal(url.searchParams.get("schema"), "meta_ads");
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  const rollback = new Error("rollback synthetic fixture");
  const day1 = new Date("2038-11-01");
  const day2 = new Date("2038-11-02");
  const now = new Date("2038-11-03");
  const name = `혜민 ${randomUUID()}`;
  const adName = `두줄보호대_인플(${name})0015`;
  const previousSourceFlag = process.env.DAILY_SYNC_FEATURE_ENABLED;
  try {
    await assert.rejects(db.$transaction(async tx => {
      const product = await tx.product.create({ data: { code: randomUUID(), name: "fixture", displayName: "fixture" } });
      await tx.productCostRule.create({ data: {
        productId: product.id, salePriceKrw: 15_000, productCostKrw: 10_000, fxRateKrwPerUsd: 1000, effectiveFrom: day1
      } });
      const campaign = await tx.metaCampaign.create({ data: { externalCampaignId: randomUUID(), campaignName: "fixture" } });
      const adset = await tx.metaAdset.create({ data: { campaignRefId: campaign.id, adsetName: "fixture", adsetNameKey: randomUUID() } });
      const ad = await tx.metaAd.create({ data: {
        campaignRefId: campaign.id, metaAdsetRefId: adset.id, metaCampaignId: campaign.externalCampaignId,
        metaAdsetId: adset.id, syntheticAdKey: randomUUID(), adIdentityKey: randomUUID(), adName
      } });
      const batch = await tx.uploadBatch.create({ data: {
        originalFilename: "fixture.csv", fileHashSha256: randomBytes(32).toString("hex"), columnSchema: {}, level: "AD"
      } });
      const metric = {
        campaignRefId: campaign.id, metaAdsetRefId: adset.id, metaAdRefId: ad.id,
        metaCampaignId: campaign.externalCampaignId, metaAdsetId: adset.id,
        campaignNameSnapshot: campaign.campaignName, adsetNameSnapshot: adset.adsetName, adNameSnapshot: adName,
        syntheticAdKey: ad.syntheticAdKey, adIdentityKey: ad.adIdentityKey, productId: product.id, source: SourceKind.CSV,
        uploadBatchId: batch.id
      };
      await tx.metaAdDailyMetric.create({ data: {
        ...metric, metricDate: day1, dateStart: day1, dateEnd: day1, spendUsd: 120, purchaseCount: 15
      } });
      const second = await tx.metaAdDailyMetric.create({ data: {
        ...metric, metricDate: day2, dateStart: day2, dateEnd: day2, spendUsd: 30, purchaseCount: 11
      } });
      const collaboration = await tx.influencerCollaboration.create({ data: {
        influencerName: name, influencerKey: name, startDate: day1, endDate: day2,
        feeKrw: 150_000, netPerformanceKrw: -150_000
      } });
      async function expectTotals(spend: number, margin: number | null, net: number | null, through: Date) {
        const row = await tx.influencerCollaboration.findUniqueOrThrow({ where: { id: collaboration.id } });
        assert.equal(row.adSpendKrw?.toNumber(), spend);
        assert.equal(row.adMarginKrw?.toNumber() ?? null, margin);
        assert.equal(row.netPerformanceKrw?.toNumber() ?? null, net);
        assert.deepEqual(row.dataThrough, through);
        assert.equal(row.creativeCount, 1);
        assert.deepEqual(row.creativeTotals, [{ creativeName: adName, adSpendKrw: spend, adMarginKrw: margin,
          dataThrough: through.toISOString().slice(0, 10) }]);
      }

      await projectInfluencerDay(tx, day1, now);
      await expectTotals(120_000, -45_000, -195_000, day1);
      await projectInfluencerDay(tx, day2, now);
      await expectTotals(150_000, -20_000, -170_000, day2);
      await projectInfluencerDay(tx, day2, now);
      await expectTotals(150_000, -20_000, -170_000, day2);

      await tx.metaAdDailyMetric.update({ where: { id: second.id }, data: { productId: null } });
      await tx.exchangeRate.create({ data: { rateDate: day2, sourceDate: day2, rate: 1000 } });
      await projectInfluencerDay(tx, day2, now);
      await expectTotals(150_000, null, null, day2);

      await tx.metaAdDailyMetric.delete({ where: { id: second.id } });
      await projectInfluencerDay(tx, day2, now);
      await expectTotals(120_000, -45_000, -195_000, day1);

      process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
      const connection = await tx.sourceConnection.create({ data: {
        provider: "META", externalAccountId: randomUUID(), displayName: "fixture", currencyCode: "USD", timeZone: "Asia/Seoul"
      } });
      const accountDay = { connectionId: connection.id, metricDate: day2 };
      const reportDay = { ...accountDay, dateStart: day2, dateEnd: day2 };
      await tx.sourcePolicy.create({ data: {
        connectionId: connection.id, dataKind: "META_AD", fromDate: day2, primarySource: "API", version: 1, reason: "fixture"
      } });
      const run = await tx.syncRun.create({ data: {
        connectionId: connection.id, trigger: "SCHEDULED", requestKey: randomUUID(), fromDate: day2, toDate: day2, status: "SUCCEEDED"
      } });
      await tx.metaAdDailyMetric.create({ data: { ...metric, ...reportDay, spendUsd: 999, purchaseCount: 11 } });
      const apiRow = await tx.metaAdDailyMetric.create({ data: {
        ...metric, ...reportDay, source: "API", uploadBatchId: null, syncRunId: run.id, sourceRevision: "fixture",
        spendUsd: 30, purchaseCount: 11, attributionSetting: "different attribution"
      } });
      await assert.rejects(projectInfluencerDay(tx, day2, now), { name: "ConflictException" });
      await expectTotals(120_000, -45_000, -195_000, day1);

      await tx.runUnit.create({ data: { runId: run.id, unitKey: "2038-11-02", status: "SUCCEEDED", publishedCount: 1 } });
      await tx.sourceRecordLink.create({ data: {
        connectionId: connection.id, dataKind: "META_AD", source: "API", recordId: apiRow.id, syncRunId: run.id,
        recordTable: "meta_ad_daily_metrics", canonicalKeyHash: randomBytes(32).toString("hex"), version: 1, bindingMethod: "EXACT_ID"
      } });
      await tx.sourceCoverage.create({ data: {
        ...accountDay, dataKind: "META_AD", source: "API", state: "FAILED",
        lastSuccessRunId: run.id, lastSuccessAt: now, rowCount: 1
      } });
      await projectInfluencerDay(tx, day2, now);
      await expectTotals(150_000, null, null, day2);
      await tx.metaAdDailyMetric.update({ where: { id: apiRow.id }, data: { attributionSetting: null } });
      await projectInfluencerDay(tx, day2, now);
      await expectTotals(150_000, -20_000, -170_000, day2);

      await tx.influencerCollaboration.update({ where: { id: collaboration.id }, data: {
        needsBackfill: true, startDate: new Date("2038-11-04"), endDate: null, adMarginKrw: null
      } });
      await backfillInfluencerCollaboration(tx, collaboration.id, now);
      const empty = await tx.influencerCollaboration.findUniqueOrThrow({ where: { id: collaboration.id } });
      assert.equal(empty.netPerformanceKrw?.toNumber(), -150_000);
      assert.equal(empty.dataThrough, null);
      assert.deepEqual(empty.creativeTotals, []);
      throw rollback;
    }, { timeout: 20_000 }), error => error === rollback);
  } finally {
    if (previousSourceFlag === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED;
    else process.env.DAILY_SYNC_FEATURE_ENABLED = previousSourceFlag;
    await db.$disconnect();
  }
});
