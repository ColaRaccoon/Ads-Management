import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { GoogleMappingsService, mappingIdentity } from "../apps/api/src/google/google-mappings.service";
import { PrismaService } from "../apps/api/src/common/prisma.service";
import { legacyChannelSnapshot } from "./google-performance-regression.test";
import { GoogleReadService } from "../apps/api/src/google/google-read.service";
import { SalesMetricsService } from "../apps/api/src/sales/sales-metrics.service";
import { GoogleMappingInput } from "../apps/api/src/google/google.dto";

const url = process.env.GOOGLE_PERFORMANCE_TEST_URL;
// Never accept an arbitrary database target: this fixture writes synthetic rows.
function database() {
  assert.equal(url, "postgresql://postgres@127.0.0.1:55438/postgres?schema=meta_ads");
  return new PrismaClient({ datasources: { db: { url } } });
}

test("PostgreSQL mapping writes retain source facts/legacy margins, dates, account isolation and audit", { skip: !url }, async () => {
  const db = database(), previous = process.env.GOOGLE_PERFORMANCE_ENABLED;
  process.env.GOOGLE_PERFORMANCE_ENABLED = "true";
  const service = new GoogleMappingsService(db as unknown as PrismaService);
  const day = new Date("2026-10-20T00:00:00Z"), token = randomUUID();
  try {
    const actor = await db.appUser.create({ data: { name: `Google fixture ${token}` } });
    const first = await db.product.create({ data: { code: `ga-${token}`, name: "First", displayName: "First" } });
    const second = await db.product.create({ data: { code: `gb-${token}`, name: "Second", displayName: "Second" } });
    const connection = await db.sourceConnection.create({ data: { provider: "GOOGLE", externalAccountId: token,
      shopKey: "default", displayName: "Synthetic Google", currencyCode: "KRW", timeZone: "Asia/Seoul" } });
    const other = await db.sourceConnection.create({ data: { provider: "GOOGLE", externalAccountId: `other-${token}`,
      shopKey: "default", displayName: "Synthetic Other", currencyCode: "KRW", timeZone: "Asia/Seoul" } });
    const run = await db.syncRun.create({ data: { connectionId: connection.id, trigger: "MANUAL", requestKey: token,
      fromDate: day, toDate: day, status: "SUCCEEDED" } });
    const source = await db.googleCampaignDailyCost.create({ data: { connectionId: connection.id, syncRunId: run.id,
      metricDate: day, campaignId: "same-id", campaignName: "Campaign", channelType: "VIDEO", costMicros: 20000000000n,
      impressions: 1000n, clicks: 50n, source: "API", fetchedAt: day, version: 1 } });
    const snapshot = legacyChannelSnapshot();
    const input = { kind: "CAMPAIGN" as const, connectionId: connection.id, campaignId: "same-id", productId: first.id,
      startDate: "2026-10-20", endDate: "2026-10-21" };
    const preview = await service.preview(input);
    assert.equal(preview.canSave, true);
    const saved = await service.save(input, actor.id);
    assert.equal(saved.mapping.productId, first.id);
    await assert.rejects(service.save({ ...input, startDate: "2026-10-21", endDate: "2026-10-22" }, actor.id));
    await service.save({ ...input, startDate: "2026-10-22", endDate: null, productId: second.id }, actor.id);
    // Database exclusion still protects writes bypassing API validation.
    await assert.rejects(db.googlePerformanceMapping.create({ data: { kind: "CAMPAIGN", connectionId: connection.id,
      campaignId: "same-id", identityKey: mappingIdentity("CAMPAIGN", "same-id"), productId: second.id, startDate: day } }));
    await assert.rejects(service.save({ ...input, connectionId: other.id }, actor.id));
    const changed = await service.save({ ...input, productId: null, expectedUpdatedAt: saved.mapping.updatedAt }, actor.id, saved.mapping.id);
    assert.equal(changed.mapping.productId, null);
    await assert.rejects(service.save({ ...input, expectedUpdatedAt: saved.mapping.updatedAt }, actor.id, saved.mapping.id));
    const audits = await db.googleMappingAudit.findMany({ where: { mappingId: saved.mapping.id }, orderBy: { createdAt: "asc" } });
    assert.equal(audits.length, 2);
    assert.equal((audits[1].before as any).productId, first.id);
    assert.equal((audits[1].after as any).productId, null);
    assert.equal(audits[1].actorUserId, actor.id);
    assert.deepEqual(await db.googleCampaignDailyCost.findUnique({ where: { id: source.id } }), source);
    assert.deepEqual(legacyChannelSnapshot(), snapshot);
    assert.equal(await db.googleCampaignDailyCost.count({ where: { connectionId: connection.id } }), 1);
    // Same campaign id on another account has its own interval.
    await db.googlePerformanceMapping.create({ data: { kind: "CAMPAIGN", connectionId: other.id,
      campaignId: "same-id", identityKey: mappingIdentity("CAMPAIGN", "same-id"), productId: first.id, startDate: day } });
    const plans = await db.$queryRawUnsafe<any[]>(`EXPLAIN SELECT * FROM google_performance_mappings WHERE connection_id='${connection.id}'::uuid AND kind='CAMPAIGN' AND identity_key='${mappingIdentity("CAMPAIGN", "same-id")}' AND start_date <= '2026-10-20'::date`);
    assert.match(plans.map(row => row["QUERY PLAN"]).join("\n"), /Index|Bitmap/);
    process.env.GOOGLE_PERFORMANCE_ENABLED = "false";
    await assert.rejects(service.preview(input));
    await assert.rejects(service.save(input, actor.id));
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_PERFORMANCE_ENABLED;
    else process.env.GOOGLE_PERFORMANCE_ENABLED = previous;
    await db.$disconnect();
  }
});

test("real reader joins selected current sales and campaign costs once; Google changes do not change legacy sales", { skip: !url }, async () => {
  const db = database(), previous = { google: process.env.GOOGLE_PERFORMANCE_ENABLED, daily: process.env.DAILY_SYNC_FEATURE_ENABLED };
  process.env.GOOGLE_PERFORMANCE_ENABLED = "true";
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  const google = new GoogleReadService(db as unknown as PrismaService);
  const mappings = new GoogleMappingsService(db as unknown as PrismaService);
  const legacy = new SalesMetricsService(db as unknown as PrismaService);
  const date = new Date("2026-10-19Z"), token = randomUUID();
  try {
    const actor = await db.appUser.create({ data: { name: token } });
    const product = await db.product.create({ data: { code: token, name: token, displayName: token } });
    const otherProduct = await db.product.create({ data: { code: `other-${token}`, name: token, displayName: token } });
    for (const productId of [product.id, otherProduct.id]) await db.productCostRule.create({ data: {
      productId, salePriceKrw: 100000, vatKrw: 10000, productCostKrw: 25000, shippingKrw: 4000,
      extraCostKrw: 1000, fxRateKrwPerUsd: 1400, effectiveFrom: date
    } });
    const ads = await db.sourceConnection.create({ data: { provider: "GOOGLE", externalAccountId: token,
      displayName: token, shopKey: "default", currencyCode: "KRW", timeZone: "Asia/Seoul" } });
    const shop = await db.sourceConnection.create({ data: { provider: "CAFE24", externalAccountId: token,
      displayName: token, shopKey: "shop1", currencyCode: "KRW", timeZone: "Asia/Seoul" } });
    await db.sourcePolicy.createMany({ data: [
      { connectionId: ads.id, dataKind: "GOOGLE_CAMPAIGN", primarySource: "API", version: 1, fromDate: date, reason: "fixture" },
      { connectionId: shop.id, dataKind: "CAFE24_ORDER", primarySource: "CSV", version: 1, fromDate: date, reason: "fixture" }
    ] });
    const batch = await db.cafe24UploadBatch.create({ data: { originalFilename: "fixture.csv", fileHashSha256: token.replaceAll("-", "").repeat(2),
      columnSchema: [], status: "IMPORTED", rowCount: 2, validRowCount: 2, orderStart: date, orderEnd: date } });
    for (const [i, productName] of ["[유튜브] 상품", "일반 상품"].entries()) await db.cafe24OrderLine.create({ data: {
      connectionId: shop.id, uploadBatchId: batch.id, rowNumber: i + 1, sourceRowHash: String(i).repeat(64), source: "CSV", orderLineKey: `${token}-${i}`,
      orderNo: token, lineOrderNo: `${token}-${i}`, productNo: "77", productName, optionName: productName,
      quantity: 1, salePriceKrw: 100000, totalOrderKrw: 200000, totalPaidKrw: 190000, paymentMethod: "쿠폰",
      orderDate: date, productId: product.id, validationStatus: "VALID"
    } });
    await db.cafe24CouponRule.create({ data: { name: token, scope: "PRODUCT", productId: product.id,
      discountKrw: 10000, validFrom: date, validTo: date, priority: 1 } });
    const run = await db.syncRun.create({ data: { connectionId: ads.id, trigger: "MANUAL", requestKey: token,
      fromDate: date, toDate: date, status: "SUCCEEDED" } });
    await db.runUnit.create({ data: { runId: run.id, unitKey: "2026-10-19", status: "SUCCEEDED", publishedCount: 2 } });
    await db.sourceCoverage.create({ data: { connectionId: ads.id, dataKind: "GOOGLE_CAMPAIGN", metricDate: date,
      source: "API", state: "COMPLETE_NONZERO", rowCount: 2, totalAmount: 20000, lastSuccessRunId: run.id, lastSuccessAt: date } });
    for (const campaignId of ["one", "two"]) {
      const metric = await db.googleCampaignDailyCost.create({ data: {
      connectionId: ads.id, metricDate: date, campaignId, campaignName: "Same display name", channelType: "VIDEO",
      costMicros: 10000000000n, impressions: 1000n, clicks: 10n, source: "API", syncRunId: run.id, fetchedAt: date, version: 2
      } });
      await db.sourceRecordLink.create({ data: { connectionId: ads.id, dataKind: "GOOGLE_CAMPAIGN", source: "API",
        canonicalKeyHash: (campaignId === "one" ? "a" : "b").repeat(64), recordTable: "google_campaign_daily_costs",
        recordId: metric.id, syncRunId: run.id, version: 2, bindingMethod: "EXACT_ID" } });
    }
    await db.googleCampaignDailyCost.create({ data: { connectionId: ads.id, metricDate: date, campaignId: "one", campaignName: "Old name",
      channelType: "VIDEO", costMicros: 90000000000n, impressions: 1n, clicks: 1n, source: "API", syncRunId: run.id, fetchedAt: date, version: 1, isCurrent: false } });
    const query = { from: "2026-10-19", to: "2026-10-19", connectionId: ads.id, cafe24ConnectionId: shop.id };
    const baseline = await legacy.productPerformance(query);
    const unmapped = await google.report(query);
    assert.equal(unmapped.summary.marginKrw, null);
    assert.equal(unmapped.summary.unallocatedAdSpendKrw, 20000);
    for (const campaignId of ["one", "two"]) await mappings.save({ kind: "CAMPAIGN", connectionId: ads.id,
      campaignId, productId: product.id, startDate: "2026-10-19", endDate: "2026-10-19" }, actor.id);
    const report = await google.report(query);
    assert.equal(report.summary.revenueKrw, 100000);
    assert.equal(report.summary.grossCostKrw, 40000);
    assert.equal(report.summary.couponDeductionKrw, 5000);
    assert.equal(report.summary.adSpendKrw, 20000);
    assert.equal(report.summary.marginKrw, 35000);
    assert.equal(report.summary.marginRate, 0.35);
    assert.equal(report.summary.roas, 5);
    assert.equal(report.products.length, 1);
    assert.equal(report.campaigns.length, 2);
    assert.equal(report.summary.quantity, 1);
    assert.equal(report.reconciliation.collectedAdSpendKrwExact, "20000");
    assert.deepEqual(await google.report(query), report);
    // Successful same-data D-7 reread keeps original fact/link run IDs.
    const recheck = await db.syncRun.create({ data: { connectionId: ads.id, trigger: "MANUAL", requestKey: `recheck-${token}`,
      fromDate: date, toDate: date, status: "SUCCEEDED" } });
    await db.runUnit.create({ data: { runId: recheck.id, unitKey: "2026-10-19", status: "SUCCEEDED", publishedCount: 2 } });
    await db.sourceCoverage.update({ where: { connectionId_dataKind_metricDate: { connectionId: ads.id, dataKind: "GOOGLE_CAMPAIGN", metricDate: date } },
      data: { lastSuccessRunId: recheck.id } });
    assert.equal((await google.report(query)).summary.marginKrw, 35000);
    const selected = await google.report({ ...query, productId: product.id });
    assert.equal(selected.summary.couponDeductionKrw, 5000);
    await mappings.save({ kind: "SALE", connectionId: shop.id, productNo: "77", optionName: "[유튜브] 상품",
      productId: otherProduct.id, startDate: "2026-10-19" }, actor.id);
    assert.deepEqual(await legacy.productPerformance(query), baseline);
    const changed = await google.report(query);
    assert.equal(changed.products.length, 2);
    assert.equal(changed.products.find(p => p.productId === product.id)?.revenueKrw, 0);
    assert.equal(await db.googleCampaignDailyCost.count({ where: { connectionId: ads.id } }), 3);
    assert.equal(await db.cafe24OrderLine.count({ where: { connectionId: shop.id, productId: product.id } }), 2);
  } finally {
    for (const [key, value] of [["GOOGLE_PERFORMANCE_ENABLED", previous.google], ["DAILY_SYNC_FEATURE_ENABLED", previous.daily]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await db.$disconnect();
  }
});

test("migration grants runtime mapping writes but keeps audit append-only and Data API roles denied", { skip: !url }, () => {
  assert.equal(url, "postgresql://postgres@127.0.0.1:55438/postgres?schema=meta_ads");
  // Run the exact final migration with deliberately broad default ACLs in a rolled-back schema.
  const migration = readFileSync("apps/api/prisma/migrations/20261026120000_google_performance_mappings/migration.sql", "utf8");
  const sql = `BEGIN; CREATE SCHEMA google_migration_fixture;
    SET search_path=google_migration_fixture,meta_ads,pg_catalog;
    CREATE TABLE google_migration_fixture.app_users (LIKE meta_ads.app_users INCLUDING ALL);
    CREATE TABLE google_migration_fixture.source_connections (LIKE meta_ads.source_connections INCLUDING ALL);
    CREATE TABLE google_migration_fixture.products (LIKE meta_ads.products INCLUDING ALL);
    DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['meta_ads_prod_runtime','anon','authenticated','service_role'] LOOP
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',r); END IF;
    END LOOP; END $$;
    ALTER DEFAULT PRIVILEGES IN SCHEMA google_migration_fixture GRANT ALL ON TABLES TO meta_ads_prod_runtime,anon,authenticated,service_role;
    ${migration}
    GRANT USAGE ON SCHEMA google_migration_fixture TO meta_ads_prod_runtime;
    INSERT INTO app_users(id,name,updated_at) VALUES('10000000-0000-4000-8000-000000000001','fixture',now());
    INSERT INTO source_connections(id,provider,external_account_id,shop_key,display_name,currency_code,time_zone,updated_at)
      VALUES('10000000-0000-4000-8000-000000000002','GOOGLE','rls-fixture','default','fixture','KRW','Asia/Seoul',now());
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('google_performance_mappings'::regclass,'google_mapping_audits'::regclass) AND (NOT relrowsecurity OR NOT relforcerowsecurity)) THEN RAISE EXCEPTION 'RLS missing'; END IF;
      IF has_table_privilege('anon','google_performance_mappings','SELECT') OR has_table_privilege('authenticated','google_performance_mappings','INSERT') OR has_table_privilege('service_role','google_mapping_audits','SELECT') THEN RAISE EXCEPTION 'Data API exposed'; END IF;
      IF has_table_privilege('meta_ads_prod_runtime','google_mapping_audits','UPDATE') OR has_table_privilege('meta_ads_prod_runtime','google_mapping_audits','DELETE') OR has_table_privilege('meta_ads_prod_runtime','google_performance_mappings','DELETE') THEN RAISE EXCEPTION 'excessive privilege'; END IF;
    END $$;
    SET ROLE meta_ads_prod_runtime;
    INSERT INTO google_performance_mappings(id,kind,connection_id,identity_key,campaign_id,start_date,updated_at)
      VALUES('10000000-0000-4000-8000-000000000003','CAMPAIGN','10000000-0000-4000-8000-000000000002','fixture','campaign','2026-10-20',now());
    UPDATE google_performance_mappings SET end_date='2026-10-21' WHERE id='10000000-0000-4000-8000-000000000003';
    INSERT INTO google_mapping_audits(id,mapping_id,actor_user_id,after) VALUES('10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','{}');
    DO $$ BEGIN
      IF (SELECT count(*) FROM google_mapping_audits) <> 1 THEN RAISE EXCEPTION 'runtime read denied'; END IF;
      BEGIN UPDATE google_mapping_audits SET after='{}'; RAISE EXCEPTION 'audit update allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END $$;
    ROLLBACK;`;
  const result = spawnSync("docker", ["exec", "-i", "google-performance-test-20261026", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});

test("Google product-number scope prices all 181 options as sets without changing shared costs or historical channels", { skip: !url }, async () => {
  const db = database(), previous = { google: process.env.GOOGLE_PERFORMANCE_ENABLED, daily: process.env.DAILY_SYNC_FEATURE_ENABLED };
  process.env.GOOGLE_PERFORMANCE_ENABLED = "true";
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  const reader = new GoogleReadService(db as unknown as PrismaService);
  const mappings = new GoogleMappingsService(db as unknown as PrismaService);
  const legacy = new SalesMetricsService(db as unknown as PrismaService);
  const proposal = JSON.parse(readFileSync("scripts/google-performance-mapping-proposal.json", "utf8")) as { salesMappings: GoogleMappingInput[] };
  const proposed = proposal.salesMappings[0];
  assert.deepEqual([proposed.kind, proposed.productNo, proposed.optionScope, proposed.optionName, proposed.startDate, proposed.endDate,
    proposed.salePriceKrwOverride, proposed.productCostKrwOverride, proposed.shippingKrwOverride, proposed.extraCostKrwOverride, proposed.saleUnitLabel],
    ["SALE", "181", "PRODUCT", "", "2026-10-24", null, 34900, 9000, 0, 0, "1+1 세트"]);
  const token = randomUUID(), beforeDate = new Date("2026-10-23Z"), date = new Date("2026-10-24Z");
  try {
    const actor = await db.appUser.create({ data: { name: `Set fixture ${token}` } });
    const product = await db.product.create({ data: { code: `sets-${token}`, name: "무릎보호대", displayName: "무릎보호대" } });
    const sharedCost = await db.productCostRule.create({ data: { productId: product.id,
      salePriceKrw: 19800, vatKrw: 1980, productCostKrw: 3500, shippingKrw: 1100, extraCostKrw: 0,
      fxRateKrwPerUsd: 1400, effectiveFrom: beforeDate } });
    const shop = await db.sourceConnection.create({ data: { provider: "CAFE24", externalAccountId: token,
      displayName: "Synthetic set shop", shopKey: "shop1", currencyCode: "KRW", timeZone: "Asia/Seoul" } });
    const ads = await db.sourceConnection.create({ data: { provider: "GOOGLE", externalAccountId: token,
      displayName: "Synthetic set ads", shopKey: "default", currencyCode: "KRW", timeZone: "Asia/Seoul" } });
    await db.sourcePolicy.createMany({ data: [
      { connectionId: shop.id, dataKind: "CAFE24_ORDER", primarySource: "CSV", version: 1, fromDate: beforeDate, reason: "fixture" },
      { connectionId: ads.id, dataKind: "GOOGLE_CAMPAIGN", primarySource: "API", version: 1, fromDate: beforeDate, reason: "fixture" }
    ] });
    const batch = await db.cafe24UploadBatch.create({ data: { originalFilename: "sets.csv", columnSchema: [],
      fileHashSha256: token.replaceAll("-", "").repeat(2), rowCount: 5, validRowCount: 5, status: "IMPORTED",
      orderStart: beforeDate, orderEnd: date } });
    const options = ["1+1 블랙 M", "네이비 L", "신규 색상:라벤더 XL"];
    const samples = [
      { date: beforeDate, optionName: options[0], youtube: true },
      ...options.map(optionName => ({ date, optionName, youtube: true })),
      { date, optionName: "일반 단품", youtube: false }
    ];
    for (const [index, sample] of samples.entries()) await db.cafe24OrderLine.create({ data: {
      connectionId: shop.id, uploadBatchId: batch.id, rowNumber: index + 1, sourceRowHash: String(index).repeat(64),
      source: "CSV", orderLineKey: `set-${token}-${index}`, orderNo: `set-${token}-${index}`, lineOrderNo: String(index),
      productNo: sample.youtube ? "181" : "146", productName: sample.youtube ? "[유튜브] 무릎보호대" : "일반 무릎보호대",
      optionName: sample.optionName, quantity: 1, salePriceKrw: sample.youtube ? 34900 : 19800,
      totalOrderKrw: sample.youtube ? 34900 : 19800, totalPaidKrw: sample.youtube ? 34900 : 19800,
      paymentMethod: "카드", orderDate: sample.date, productId: sample.youtube ? null : product.id,
      validationStatus: sample.youtube ? "UNMATCHED" : "VALID"
    } });
    for (const metricDate of [beforeDate, date]) {
      const isAfter = metricDate.getTime() === date.getTime();
      const run = await db.syncRun.create({ data: { connectionId: ads.id, trigger: "MANUAL",
        requestKey: `set-${token}-${metricDate.toISOString()}`, fromDate: metricDate, toDate: metricDate, status: "SUCCEEDED" } });
      await db.runUnit.create({ data: { runId: run.id, unitKey: metricDate.toISOString().slice(0, 10),
        status: "SUCCEEDED", publishedCount: isAfter ? 2 : 0 } });
      await db.sourceCoverage.create({ data: { connectionId: ads.id, dataKind: "GOOGLE_CAMPAIGN", metricDate,
        source: "API", state: isAfter ? "COMPLETE_NONZERO" : "COMPLETE_ZERO", rowCount: isAfter ? 2 : 0,
        totalAmount: isAfter ? 10000 : 0, lastSuccessRunId: run.id, lastSuccessAt: metricDate } });
      if (isAfter) for (const [index, campaignId] of ["set-campaign-a", "set-campaign-b"].entries()) {
        const fact = await db.googleCampaignDailyCost.create({ data: { connectionId: ads.id, metricDate,
          campaignId, campaignName: "무릎보호대 캠페인", channelType: "VIDEO", costMicros: index ? 6000000000n : 4000000000n,
          impressions: 1000n, clicks: 20n, source: "API", syncRunId: run.id, fetchedAt: metricDate, version: 1 } });
        await db.sourceRecordLink.create({ data: { connectionId: ads.id, dataKind: "GOOGLE_CAMPAIGN", source: "API",
          canonicalKeyHash: String(index + 5).repeat(64), recordTable: "google_campaign_daily_costs", recordId: fact.id,
          syncRunId: run.id, version: 1, bindingMethod: "EXACT_ID" } });
        await mappings.save({ kind: "CAMPAIGN", connectionId: ads.id, campaignId, productId: product.id,
          startDate: "2026-10-24", endDate: "2026-10-25" }, actor.id);
      }
    }
    const query = { from: "2026-10-24", to: "2026-10-24", connectionId: ads.id, cafe24ConnectionId: shop.id };
    const beforeQuery = { ...query, from: "2026-10-23", to: "2026-10-23" };
    const historicalBefore = await reader.report(beforeQuery);
    const legacyBefore = await legacy.productPerformance(query);
    const legacyDomainsBefore = legacyChannelSnapshot();
    const sourceBefore = await db.cafe24OrderLine.findMany({ where: { connectionId: shop.id }, orderBy: { id: "asc" } });
    assert.equal((await reader.report(query)).summary.unmappedSalesCount, 3);
    // Exercise the prepared user-reviewed payload unchanged except synthetic account/product IDs.
    const configured: GoogleMappingInput = { ...proposed, connectionId: shop.id, productId: product.id };
    const preview = await mappings.preview(configured);
    assert.equal(preview.canSave, true);
    const saved = await mappings.save(configured, actor.id);
    const report = await reader.report(query);
    assert.equal(report.summary.unmappedSalesCount, 0);
    assert.equal(report.summary.quantity, 3, "one sold unit is one full 1+1 set, never six units");
    assert.equal(report.summary.saleUnitLabel, "1+1 세트");
    assert.equal(report.summary.revenueKrw, 104700);
    assert.equal(report.summary.grossCostKrw, 37470);
    assert.equal(report.summary.couponDeductionKrw, 0);
    assert.equal(report.summary.adSpendKrw, 10000);
    assert.equal(report.summary.marginKrw, 57230);
    assert.equal(report.campaigns.length, 2);
    assert.equal(report.products.length, 1);
    assert.equal(report.products[0].saleUnitLabel, "1+1 세트");
    assert.equal(report.daily[0].quantity, 3);
    assert.deepEqual(await reader.report(beforeQuery), historicalBefore, "start-date-before history stays unmapped");
    assert.deepEqual(await legacy.productPerformance(query), legacyBefore);
    assert.deepEqual(legacyChannelSnapshot(), legacyDomainsBefore);
    assert.deepEqual(await db.productCostRule.findUnique({ where: { id: sharedCost.id } }), sharedCost);
    assert.deepEqual(await db.cafe24OrderLine.findMany({ where: { connectionId: shop.id }, orderBy: { id: "asc" } }), sourceBefore);

    // Product-wide periods conflict with exact options in either direction;
    // different exact options may coexist during the same period.
    await assert.rejects(mappings.save({ ...configured, optionScope: "EXACT", optionName: options[0] }, actor.id));
    await assert.rejects(mappings.save({ ...configured, optionScope: "EXACT", optionName: options[1],
      startDate: "2026-10-23", endDate: "2026-10-24" }, actor.id));
    for (const optionName of options.slice(0, 2)) await mappings.save({ ...configured,
      optionScope: "EXACT", optionName, startDate: "2026-10-23", endDate: "2026-10-23" }, actor.id);
    await assert.rejects(mappings.save({ ...configured, startDate: "2026-10-23", endDate: "2026-10-23" }, actor.id));
    // DB must also reject the cross-scope overlap from a writer bypassing the service.
    await assert.rejects(db.googlePerformanceMapping.create({ data: {
      kind: "SALE", connectionId: shop.id, productNo: "181", optionScope: "EXACT", optionName: options[2],
      identityKey: mappingIdentity("SALE", null, "181", options[2]), productId: product.id,
      startDate: date, endDate: date
    } }));

    await mappings.save({ ...configured, productCostKrwOverride: 9500, expectedUpdatedAt: saved.mapping.updatedAt }, actor.id, saved.mapping.id);
    const audits = await db.googleMappingAudit.findMany({ where: { mappingId: saved.mapping.id }, orderBy: { createdAt: "asc" } });
    assert.equal(audits.length, 2);
    const first = audits[0].after as Record<string, unknown>, old = audits[1].before as Record<string, unknown>, updated = audits[1].after as Record<string, unknown>;
    assert.equal(first.optionScope, "PRODUCT");
    assert.equal(first.saleUnitLabel, "1+1 세트");
    assert.equal(Number(first.salePriceKrwOverride), 34900);
    assert.equal(Number(first.productCostKrwOverride), 9000);
    assert.equal(Number(first.shippingKrwOverride), 0);
    assert.equal(Number(first.extraCostKrwOverride), 0);
    assert.equal(Number(old.productCostKrwOverride), 9000);
    assert.equal(Number(updated.productCostKrwOverride), 9500);
    assert.equal((await reader.report(query)).summary.grossCostKrw, 38970);
    assert.deepEqual(await legacy.productPerformance(query), legacyBefore);
    assert.deepEqual(await db.productCostRule.findUnique({ where: { id: sharedCost.id } }), sharedCost);
  } finally {
    for (const [key, value] of [["GOOGLE_PERFORMANCE_ENABLED", previous.google], ["DAILY_SYNC_FEATURE_ENABLED", previous.daily]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await db.$disconnect();
  }
});
