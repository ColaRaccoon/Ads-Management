import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Prisma, PrismaClient, SourceKind } from "@prisma/client";
import { materialNumberKey, numberedCreative } from "./influencer-matching";
import { backfillInfluencerCollaboration, projectInfluencerDay } from "./influencer-projector";
import { InfluencerRecordsService } from "./influencer-records.service";
import type { PrismaService } from "../common/prisma.service";

test("requires the influencer marker, handler, and exact number in the ad name", () => {
  assert.deepEqual(numberedCreative("261110_버닝웨이브바_인플（ 혜민 ）0013_IG"), {
    number: "0013", managerKey: "혜민", creativeName: "버닝웨이브바_인플( 혜민 )0013"
  });
  assert.deepEqual(numberedCreative("인플(혜민)0013"), {
    number: "0013", managerKey: "혜민", creativeName: "인플(혜민)0013"
  });
  assert.deepEqual(numberedCreative("제품_인플( ＨＹＥＭＩＮ )0013"), {
    managerKey: "hyemin", number: "0013", creativeName: "제품_인플( HYEMIN )0013"
  });
  for (const name of ["버닝웨이브바_0013", "제품_비인플(혜민)0013", "제품_인플()0013",
    "제품_인플(혜민)", "제품_인플(혜민)_0013", "제품_인플(혜민)_인플(지민)0013"]) {
    assert.equal(numberedCreative(name), null, name);
  }
  assert.equal(materialNumberKey("product", " 혜민 ", "0013"), materialNumberKey("product", "혜민", "13"));
  assert.notEqual(materialNumberKey("product", "혜민", "0013"), materialNumberKey("product", "한별", "0013"));
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
  const day3 = new Date("2038-11-03");
  const now = new Date("2038-11-04");
  const name = `혜민 ${randomUUID()}`;
  const adName = `두줄보호대_인플(${name})0015`;
  const previousSourceFlag = process.env.DAILY_SYNC_FEATURE_ENABLED;
  try {
    await assert.rejects(db.$transaction(async tx => {
      const product = await tx.product.create({ data: { code: randomUUID(), name: "fixture", displayName: "fixture" } });
      await tx.productCostRule.create({ data: {
        productId: product.id, salePriceKrw: 15_000, productCostKrw: 10_000, fxRateKrwPerUsd: 1000, effectiveFrom: day1
      } });
      const numbered = await tx.influencerCollaboration.create({ data: {
        influencerName: "different nickname", influencerKey: "different nickname", managerName: name, productId: product.id,
        numberingRequired: true, startDate: day3, feeKrw: 5000
      } });
      const transactionalClient = new Proxy(tx, {
        get(target, key, receiver) {
          if (key === "$transaction") return (work: (client: Prisma.TransactionClient) => Promise<unknown>) => work(tx);
          return Reflect.get(target, key, receiver);
        }
      });
      const records = new InfluencerRecordsService(transactionalClient as unknown as PrismaService);
      const reserved = await records.numbering(numbered.id, { version: numbered.version, numbers: ["0015"] });
      assert.deepEqual(reserved.numbers, ["0015"]);
      assert.equal(reserved.netPerformanceKrw, -5000);
      assert.deepEqual(await records.creatives(numbered.id), { items: [] });
      const otherHandler = await records.create({
        nickname: "another influencer", managerName: "다른담당자", productId: product.id,
        startDate: "2038-11-03", feeKrw: 1000, note: null
      });
      await records.numbering(otherHandler.id, { version: otherHandler.version, numbers: ["0015"] });
      const campaign = await tx.metaCampaign.create({ data: { externalCampaignId: randomUUID(), campaignName: "fixture" } });
      const adset = await tx.metaAdset.create({ data: { campaignRefId: campaign.id, adsetName: "fixture", adsetNameKey: randomUUID() } });
      const creative = await tx.creative.create({ data: { creativeKey: adName, displayName: adName, materialNo: `인플(${name})0015` } });
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
        uploadBatchId: batch.id, creativeId: creative.id
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

      process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
      const otherProduct = await tx.product.create({ data: { code: randomUUID(), name: "other", displayName: "other" } });
      const day3Fields = { metricDate: day3, dateStart: day3, dateEnd: day3 };
      const delivered = await tx.metaAdDailyMetric.create({ data: {
        ...metric, ...day3Fields, creativeId: null, spendUsd: 30, purchaseCount: 11
      } });
      for (const [productId, adNameSnapshot] of [[otherProduct.id, adName], [product.id, "두줄보호대_인플(" + name + ")00150"],
        [product.id, "두줄보호대_0015"], [product.id, "두줄보호대_인플(다른담당자)0015"]]) {
        const adIdentityKey = randomUUID();
        await tx.metaAdDailyMetric.create({ data: {
          ...metric, ...day3Fields, productId, adNameSnapshot, campaignNameSnapshot: "인플(" + name + ")0015", adIdentityKey, syntheticAdKey: adIdentityKey, spendUsd: 99
        } });
      }
      // Collection after numbering publishes the first match without a second admin action.
      await projectInfluencerDay(tx, day3, now);
      const daily = await records.daily({ date: "2038-11-03", managerName: name });
      assert.equal(daily.items.length, 1);
      assert.equal(daily.items[0].nickname, "different nickname");
      assert.equal(daily.items[0].adSpendKrw, 30_000);
      assert.equal(daily.items[0].adMarginKrw, 25_000);
      const otherDaily = await records.daily({ date: "2038-11-03", managerName: "다른담당자" });
      assert.equal(otherDaily.items.length, 1);
      assert.equal(otherDaily.items[0].nickname, "another influencer");
      assert.equal(otherDaily.items[0].adSpendKrw, 99_000);
      assert.deepEqual((await records.daily({ date: "2038-11-03", managerName: "different manager" })).items, []);
      await tx.metaAdDailyMetric.update({ where: { id: delivered.id }, data: { spendUsd: 0 } });
      await projectInfluencerDay(tx, day3, now);
      assert.deepEqual((await records.daily({ date: "2038-11-03", managerName: name })).items, []);
      const updated = await tx.influencerCollaboration.findUniqueOrThrow({ where: { id: numbered.id } });
      assert.equal(updated.netPerformanceKrw?.toNumber(), 50_000);
      await records.numbering(numbered.id, { version: reserved.version, numbers: [] });
      await backfillInfluencerCollaboration(tx, numbered.id, now);
      const cleared = await tx.influencerCollaboration.findUniqueOrThrow({ where: { id: numbered.id } });
      assert.equal(cleared.netPerformanceKrw?.toNumber(), -5000);
      throw rollback;
    }, { timeout: 20_000 }), error => error === rollback);
  } finally {
    if (previousSourceFlag === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED;
    else process.env.DAILY_SYNC_FEATURE_ENABLED = previousSourceFlag;
    await db.$disconnect();
  }
});
