import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { MetaPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/meta.adapter";
import { GooglePerformanceAdapter } from "../apps/api/src/unified-performance/adapters/google.adapter";
import { Cafe24PerformanceAdapter } from "../apps/api/src/unified-performance/adapters/cafe24.adapter";
import { readStorefrontSources } from "../apps/api/src/unified-performance/adapters/storefront-adapters.service";
import { CONTRACT_VERSION } from "../apps/api/src/unified-performance/types";
import type { AdapterBatch, AdapterRequest, SourceAdapter } from "../apps/api/src/unified-performance/types";
import { ExactDecimal as D } from "../apps/api/src/unified-performance/domain/decimal";

const fixtureUrl = "postgresql://unified_fixture_owner@127.0.0.1:55448/unified_stage03?schema=meta_ads";
const readerUrl = "postgresql://unified_source_reader@127.0.0.1:55448/unified_stage03?schema=meta_ads";
const date = new Date("2026-10-26T00:00:00Z"), at = new Date("2026-10-27T00:00:00Z");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const total = (values: (string | null)[]) => values.reduce((s: InstanceType<typeof D>, v) => s.plus(v ?? "0"), new D(0)).toFixed();

test("actual isolated reader preserves storefront ownership, dated money, missing days and immutable source rows", { skip: !process.env.UNIFIED_STAGE03_READER_URL }, async () => {
  assert.equal(process.env.UNIFIED_STAGE03_FIXTURE_URL, fixtureUrl);
  assert.equal(process.env.UNIFIED_STAGE03_READER_URL, readerUrl);
  const owner = new PrismaClient({ datasourceUrl: fixtureUrl }), db = new PrismaClient({ datasourceUrl: readerUrl });
  try {
    const identity = await owner.$queryRaw<{ db: string; usr: string; host: string; version: string }[]>`SELECT current_database() db,current_user usr,inet_server_addr()::text host,current_setting('server_version_num') version`;
    assert.equal(identity[0].db, "unified_stage03"); assert.equal(identity[0].usr, "unified_fixture_owner");
    assert.match(identity[0].host, /^127\.0\.0\.1(?:\/32)?$/); assert.match(identity[0].version, /^17/);
    const roles = await db.$queryRaw<{ usr: string; rolsuper: boolean; rolbypassrls: boolean }[]>`SELECT current_user usr,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    assert.equal(roles[0].usr, "unified_source_reader"); assert.equal(roles[0].rolsuper, false); assert.equal(roles[0].rolbypassrls, false);
    const product = await owner.unifiedProduct.create({ data: { canonicalName: "Stage03 상품", normalizedName: "stage03 상품" } });
    await owner.unifiedRule.create({ data: { kind: "SALE_UNIT", productId: product.id, platform: "CAFE24", identityKey: digest("stage03-unit"), validFrom: new Date("2026-09-01"),
      payload: { saleUnitName: "단품", optionExact: "", quantityBasis: "SALE_UNIT_TOTAL", unitsPerSaleUnit: "1", salePrice: "100", productCost: "20", shippingCost: "0", otherCost: "0" } } });
    const connections = await Promise.all((["META", "GOOGLE", "CAFE24"] as const).map(provider => owner.sourceConnection.create({ data: {
      provider, externalAccountId: `stage03-${provider}`, displayName: `Synthetic ${provider}`, currencyCode: provider === "META" ? "USD" : "KRW", timeZone: "Asia/Seoul", enabled: true, accessState: "READY"
    } })));
    const [meta, google, cafe] = connections;
    for (const [connectionId, dataKind, primarySource] of [[meta.id, "META_ADSET", "CSV"], [google.id, "GOOGLE_CAMPAIGN", "API"], [cafe.id, "CAFE24_ORDER", "CSV"]] as const)
      await owner.sourcePolicy.create({ data: { connectionId, dataKind, primarySource, fromDate: new Date("2026-09-01"), version: 1, reason: "Synthetic stage03 test" } });
    const metaBatch = await owner.uploadBatch.create({ data: { originalFilename: "synthetic.csv", fileHashSha256: digest("stage03-meta"), columnSchema: {}, rowCount: 2, validRowCount: 2,
      status: "IMPORTED", reportStart: date, reportEnd: date, importedAt: at } });
    for (const [index, amount] of ["1", "2"].entries()) {
      const adset = await owner.metaAdset.create({ data: { connectionId: meta.id, externalAdsetId: `new-id-${index}`, adsetName: "Stage03 상품", adsetNameKey: `fixture-${index}` } });
      await owner.metaAdsetDailyMetric.create({ data: { uploadBatchId: metaBatch.id, metaAdsetId: adset.id, connectionId: meta.id, metricDate: date, dateStart: date, dateEnd: date,
        adsetName: "Stage03 상품", adsetNameKey: `fixture-${index}`, spendUsd: amount, source: "CSV" } });
    }
    await owner.exchangeRate.create({ data: { rateDate: date, sourceDate: date, baseCurrency: "USD", quoteCurrency: "KRW", rate: "1324.3" } });
    const run = await owner.syncRun.create({ data: { connectionId: google.id, trigger: "MANUAL", requestKey: "stage03-google", fromDate: date, toDate: date, status: "SUCCEEDED", finishedAt: at } });
    for (const [index, micros] of [9007199254740993n, 1000001n].entries()) {
      const row = await owner.googleCampaignDailyCost.create({ data: { connectionId: google.id, metricDate: date, campaignId: `replacement-${index}`, campaignName: "Stage03 상품", channelType: "SEARCH",
        costMicros: micros, impressions: 1n, clicks: 1n, source: "API", syncRunId: run.id, fetchedAt: at, version: 1, conversionValue: "999999" } });
      await owner.sourceRecordLink.create({ data: { connectionId: google.id, dataKind: "GOOGLE_CAMPAIGN", source: "API", canonicalKeyHash: digest(`campaign-${index}`),
        recordTable: "google_campaign_daily_costs", recordId: row.id, syncRunId: run.id, version: 1, bindingMethod: "EXACT_ID" } });
    }
    await owner.runUnit.create({ data: { runId: run.id, unitKey: "2026-10-26", status: "SUCCEEDED", publishedCount: 2 } });
    await owner.sourceCoverage.create({ data: { connectionId: google.id, dataKind: "GOOGLE_CAMPAIGN", metricDate: date, source: "API", state: "COMPLETE_NONZERO",
      lastSuccessRunId: run.id, lastSuccessAt: at, rowCount: 2, totalAmount: "9007199255.740994" } });
    const zeroDate = new Date("2026-10-25T00:00:00Z");
    const zeroRun = await owner.syncRun.create({ data: { connectionId: google.id, trigger: "MANUAL", requestKey: "stage03-google-zero", fromDate: zeroDate, toDate: zeroDate, status: "SUCCEEDED", finishedAt: at } });
    await owner.runUnit.create({ data: { runId: zeroRun.id, unitKey: "2026-10-25", status: "SUCCEEDED", publishedCount: 0 } });
    await owner.sourceCoverage.create({ data: { connectionId: google.id, dataKind: "GOOGLE_CAMPAIGN", metricDate: zeroDate, source: "API", state: "COMPLETE_ZERO",
      lastSuccessRunId: zeroRun.id, lastSuccessAt: at, rowCount: 0, totalAmount: "0" } });
    const cafeBatch = await owner.cafe24UploadBatch.create({ data: { originalFilename: "synthetic.csv", fileHashSha256: digest("stage03-cafe"), columnSchema: {}, rowCount: 2, validRowCount: 2,
      status: "IMPORTED", orderStart: date, orderEnd: date, importedAt: at } });
    for (const index of [0, 1]) await owner.cafe24OrderLine.create({ data: { uploadBatchId: cafeBatch.id, connectionId: cafe.id, source: "CSV", orderLineKey: `order-${index}:line`,
      orderNo: `same-name-separate-order-${index}`, lineOrderNo: `line-${index}`, productNo: `replacement-${index}`, productName: "Stage03 상품", optionName: "", quantity: "1",
      salePriceKrw: "100", totalOrderKrw: "100", totalPaidKrw: "100", paymentMethod: "신용카드", orderDate: date, rowNumber: index + 1, sourceRowHash: digest(`cafe-${index}`) } });

    const serviceDb = db as unknown as PrismaService, repository = new UnifiedManagementRepository(serviceDb);
    const config = await repository.snapshot();
    const make = (scopeKey: string, from = "2026-10-26"): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: randomUUID(), readSnapshotId: "synthetic-snapshot", from, to: "2026-10-26",
      scopeKeys: [scopeKey], platforms: ["META", "GOOGLE", "CAFE24"], ...config.versions, calculationVersion: "stage03-test", fxVersion: "stored-dated-v1", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 });
    const adapters = { META: new MetaPerformanceAdapter(serviceDb, repository), GOOGLE: new GooglePerformanceAdapter(serviceDb, repository), CAFE24: new Cafe24PerformanceAdapter(serviceDb, repository) };
    const before = await owner.$queryRaw`SELECT (SELECT count(*) FROM cafe24_order_lines)::int cafe,(SELECT sum(spend_usd)::text FROM meta_adset_daily_metrics) meta,(SELECT sum(cost_micros)::text FROM google_campaign_daily_costs) google`;
    const pages = async (adapter: SourceAdapter, request: AdapterRequest): Promise<AdapterBatch[]> => {
      const output: AdapterBatch[] = []; let cursor: string | null = null;
      do { const batch = await adapter.read({ ...request, cursor }); output.push(batch); cursor = batch.nextCursor; assert(output.length <= 92); } while (cursor);
      return output;
    };
    for (const [days, from] of [[1, "2026-10-26"], [7, "2026-10-20"], [30, "2026-09-27"]] as const) {
      for (const [platform, connection] of [["META", meta], ["GOOGLE", google], ["CAFE24", cafe]] as const) {
        const result = await pages(adapters[platform], make(connection.id, from));
        assert.equal(result.length, days);
        assert(result.flatMap(b => b.sourceControlTotals).every(c => c.difference === null || new D(c.difference).isZero()));
        if (platform === "META") { assert.equal(total(result.flatMap(b => b.adSpends).map(f => f.originalAmount)), "3"); assert.equal(total(result.flatMap(b => b.adSpends).map(f => f.amountKrw)), "3972.9"); }
        if (platform === "GOOGLE") { assert.equal(total(result.flatMap(b => b.adSpends).map(f => f.amountKrw)), "9007199255.740994"); assert(result.every(b => b.sales.length === 0)); }
        if (platform === "CAFE24") { assert.equal(total(result.flatMap(b => b.sales).map(f => f.operatingRevenue)), "200"); assert.equal(total(result.flatMap(b => b.sales).map(f => f.profitBeforeAds)), "140"); assert.equal(result.flatMap(b => b.sales).length, 2); }
        if (days > 1) assert(result[0].coverage.every(c => c.collectionState === "NOT_COLLECTED" && !c.zeroConfirmed));
        if (days > 1 && platform === "GOOGLE") {
          const zero = result.find(b => b.coverage[0].date === "2026-10-25")!;
          assert.equal(zero.coverage[0].zeroConfirmed, true);
          assert.equal(zero.sourceControlTotals[0].selectedAmount, "0.000000");
        }
      }
    }
    const selected = await readStorefrontSources([
      { platform: "META", request: { ...make(meta.id), platforms: ["CAFE24"] } },
      { platform: "GOOGLE", request: { ...make(google.id), platforms: ["CAFE24"] } },
      { platform: "CAFE24", request: { ...make(cafe.id), platforms: ["CAFE24"] } }
    ], adapters);
    assert.deepEqual(selected.map(r => r.status), ["EXCLUDED_BY_USER", "EXCLUDED_BY_USER", "READ"]);
    const failure = await readStorefrontSources([
      { platform: "META", request: make(google.id) }, { platform: "GOOGLE", request: make(google.id) }, { platform: "CAFE24", request: make(cafe.id) }
    ], adapters);
    assert.deepEqual(failure.map(r => r.status), ["FAILED", "READ", "READ"]);
    await owner.sourceRecordLink.updateMany({ where: { connectionId: google.id }, data: { version: 2 } });
    const brokenLineage = await adapters.GOOGLE.read(make(google.id));
    assert.equal(brokenLineage.adSpends.length, 0);
    assert.equal(brokenLineage.coverage[0].rowsPresent, 2);
    assert.equal(brokenLineage.coverage[0].collectionState, "PARTIAL");
    assert.equal(brokenLineage.sourceControlTotals[0].selectedAmount, null);
    await assert.rejects(repository.read(tx => tx.cafe24OrderLine.updateMany({ data: { quantity: "999" } })), /read.only|permission|읽기.?전용/i);
    await assert.rejects(db.sourceCredential.findMany(), /permission|권한/i);
    assert.deepEqual(await owner.$queryRaw`SELECT (SELECT count(*) FROM cafe24_order_lines)::int cafe,(SELECT sum(spend_usd)::text FROM meta_adset_daily_metrics) meta,(SELECT sum(cost_micros)::text FROM google_campaign_daily_costs) google`, before);
  } finally { await owner.$disconnect(); await db.$disconnect(); }
});
