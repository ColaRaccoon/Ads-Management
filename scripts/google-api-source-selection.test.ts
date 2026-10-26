import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../apps/api/src/common/prisma.service";
import { GoogleReadService } from "../apps/api/src/google/google-read.service";
import { mappingIdentity } from "../apps/api/src/google/google-mappings.service";

const url = process.env.GOOGLE_PERFORMANCE_TEST_URL;
const exactLocalUrl = "postgresql://postgres@127.0.0.1:55438/postgres?schema=meta_ads";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("real PostgreSQL reader selects verified current Cafe24 API versions and excludes CSV shadows", { skip: !url }, async () => {
  // Synthetic fixture writes are permitted only in the dedicated local test database.
  assert.equal(url, exactLocalUrl, "Refusing to write fixture data outside the exact disposable local database");
  const db = new PrismaClient({ datasources: { db: { url } } });
  const previous = { google: process.env.GOOGLE_PERFORMANCE_ENABLED, daily: process.env.DAILY_SYNC_FEATURE_ENABLED };
  process.env.GOOGLE_PERFORMANCE_ENABLED = "true";
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  const token = randomUUID(), date = new Date("2026-10-18T00:00:00Z");
  try {
    const product = await db.product.create({ data: { code: `source-${token}`, name: token, displayName: token } });
    await db.productCostRule.create({ data: { productId: product.id, salePriceKrw: 100000,
      vatKrw: 10000, productCostKrw: 25000, shippingKrw: 4000, extraCostKrw: 1000,
      fxRateKrwPerUsd: 1400, effectiveFrom: date } });
    const shop = await db.sourceConnection.create({ data: { provider: "CAFE24", externalAccountId: token,
      shopKey: "shop1", displayName: "Synthetic API source fixture", currencyCode: "KRW", timeZone: "Asia/Seoul" } });
    const ads = await db.sourceConnection.create({ data: { provider: "GOOGLE", externalAccountId: token,
      shopKey: "default", displayName: "Synthetic verified zero ads", currencyCode: "KRW", timeZone: "Asia/Seoul" } });
    await db.sourcePolicy.createMany({ data: [
      { connectionId: shop.id, dataKind: "CAFE24_ORDER", primarySource: "API", version: 1,
        fromDate: date, reason: "isolated fixture", couponInputSource: "API_ACTUAL_PRODUCT_PLUS_SHIPPING" },
      { connectionId: ads.id, dataKind: "GOOGLE_CAMPAIGN", primarySource: "API", version: 1,
        fromDate: date, reason: "isolated fixture" }
    ] });
    const run = await db.syncRun.create({ data: { connectionId: shop.id, trigger: "MANUAL", requestKey: token,
      fromDate: date, toDate: date, status: "SUCCEEDED" } });
    const adRun = await db.syncRun.create({ data: { connectionId: ads.id, trigger: "MANUAL", requestKey: `ads-${token}`,
      fromDate: date, toDate: date, status: "SUCCEEDED" } });
    await db.runUnit.create({ data: { runId: adRun.id, unitKey: "2026-10-18", status: "SUCCEEDED", publishedCount: 0 } });
    await db.sourceCoverage.create({ data: { connectionId: ads.id, dataKind: "GOOGLE_CAMPAIGN", metricDate: date,
      source: "API", state: "COMPLETE_ZERO", rowCount: 0, totalAmount: 0, lastSuccessRunId: adRun.id, lastSuccessAt: date } });
    await db.sourceCoverage.create({ data: { connectionId: shop.id, dataKind: "CAFE24_ORDER", metricDate: date,
      source: "API", state: "COMPLETE_NONZERO", rowCount: 2, totalAmount: 300000,
      lastSuccessRunId: run.id, lastSuccessAt: date, reconciliationStatus: "CAFE24_API_ONLY_VERIFIED" } });

    let currentLinkId = "", currentVersionId = "";
    for (const [item, version, quantity, isCurrent] of [
      ["youtube", 1, 99, false], ["youtube", 2, 2, true], ["normal", 1, 1, true]
    ] as const) {
      const canonicalKeyHash = hash(`${token}:${item}`);
      const storedVersion = await db.cafe24OrderApiVersion.create({ data: {
        connectionId: shop.id, canonicalKeyHash, orderNo: token, lineOrderNo: item, productNo: item === "youtube" ? "77" : "88",
        optionName: "", orderedAt: date, orderDate: date, fetchedAt: date,
        contentFingerprint: hash(`${token}:${item}:${version}`), fingerprintKeyVersion: 1,
        quantity, salePriceKrw: 100000, totalOrderKrw: 300000, totalPaidKrw: 300000,
        providerCouponSignal: false, actualOrderPriceKrw: 300000, actualShippingFeeKrw: 0,
        version, isCurrent, syncRunId: run.id
      } });
      const line = await db.cafe24OrderLine.create({ data: {
        connectionId: shop.id, syncRunId: run.id, source: "API", uploadBatchId: null,
        orderLineKey: `${token}:API:${item}`, orderNo: token, lineOrderNo: item,
        productNo: item === "youtube" ? "77" : "88", productName: item === "youtube" ? "[유튜브] 상품" : "일반 상품", optionName: "",
        quantity, salePriceKrw: 100000, totalOrderKrw: 300000, totalPaidKrw: 300000,
        providerCouponSignal: false, actualOrderPriceKrw: 300000, actualShippingFeeKrw: 0,
        orderedAt: date, orderDate: date, importVersion: version, isCurrent,
        validationStatus: "UNMATCHED", matchSource: "UNMATCHED"
      } });
      const link = await db.sourceRecordLink.create({ data: {
        connectionId: shop.id, dataKind: "CAFE24_ORDER", canonicalKeyHash, source: "API",
        recordTable: "cafe24_order_lines", recordId: line.id, syncRunId: run.id,
        version, isCurrent, bindingMethod: "EXACT_ID"
      } });
      if (item === "youtube" && isCurrent) { currentLinkId = link.id; currentVersionId = storedVersion.id; }
    }
    // CSV is a complete imported batch, valid and current, with the same provider
    // order/item identity but an exaggerated value to expose accidental double counting.
    const batch = await db.cafe24UploadBatch.create({ data: { originalFilename: "synthetic-shadow.csv",
      fileHashSha256: hash(token), columnSchema: [], status: "IMPORTED", rowCount: 1, validRowCount: 1,
      orderStart: date, orderEnd: date } });
    await db.cafe24OrderLine.create({ data: { connectionId: shop.id, uploadBatchId: batch.id,
      rowNumber: 1, sourceRowHash: hash(`csv:${token}`), source: "CSV", orderLineKey: `${token}:CSV:youtube`,
      orderNo: token, lineOrderNo: "youtube", productNo: "77", productName: "[유튜브] 상품", optionName: "",
      quantity: 500, salePriceKrw: 100000, totalOrderKrw: 50000000, totalPaidKrw: 50000000,
      orderDate: date, productId: product.id, validationStatus: "VALID" } });
    await db.googlePerformanceMapping.create({ data: { kind: "SALE", connectionId: shop.id,
      identityKey: mappingIdentity("SALE", null, "77", ""), productNo: "77", optionName: "",
      productId: product.id, startDate: date, endDate: date } });

    const reader = new GoogleReadService(db as unknown as PrismaService);
    const query = { from: "2026-10-18", to: "2026-10-18", connectionId: ads.id, cafe24ConnectionId: shop.id };
    const before = await db.cafe24OrderLine.findMany({ where: { connectionId: shop.id }, orderBy: { id: "asc" } });
    const result = await reader.report(query);
    assert.equal(result.summary.quantity, 2, "only corrected v2 YouTube sale is selected");
    assert.equal(result.summary.revenueKrw, 200000);
    assert.equal(result.summary.grossCostKrw, 80000);
    assert.equal(result.summary.adSpendKrw, 0, "verified Google zero collection is not missing");
    assert.equal(result.summary.couponDeductionKrw, 0);
    assert.equal(result.summary.marginKrw, 120000);
    assert.equal(result.completeness.complete, true);
    assert.equal(result.coverage.find(row => row.provider === "CAFE24")?.selectedSource, "API");
    assert.equal(result.coverage.find(row => row.provider === "CAFE24")?.rowCount, 2);
    assert.deepEqual(await reader.report(query), result, "refresh does not duplicate facts");
    assert.deepEqual(await db.cafe24OrderLine.findMany({ where: { connectionId: shop.id }, orderBy: { id: "asc" } }), before,
      "read-only Google calculation preserves CSV and API historical facts");

    // Break one evidence link: the real SQL source guard must fail closed rather
    // than selecting CSV or treating the API rows as verified.
    await db.sourceRecordLink.update({ where: { id: currentLinkId }, data: { version: 1 } });
    const brokenLink = await reader.report(query);
    assert.equal(brokenLink.summary.marginKrw, null);
    assert.equal(brokenLink.summary.quantity, 0);
    assert.ok(brokenLink.completeness.warningCodes.includes("SOURCE_SELECTION_REQUIRED"));
    await db.sourceRecordLink.update({ where: { id: currentLinkId }, data: { version: 2 } });
    await db.cafe24OrderApiVersion.update({ where: { id: currentVersionId }, data: { isCurrent: false } });
    const brokenVersion = await reader.report(query);
    assert.equal(brokenVersion.summary.marginKrw, null);
    assert.ok(brokenVersion.completeness.warningCodes.includes("SOURCE_SELECTION_REQUIRED"));
    await db.cafe24OrderApiVersion.update({ where: { id: currentVersionId }, data: { isCurrent: true } });
    assert.equal((await reader.report(query)).summary.marginKrw, 120000);
  } finally {
    if (previous.google === undefined) delete process.env.GOOGLE_PERFORMANCE_ENABLED;
    else process.env.GOOGLE_PERFORMANCE_ENABLED = previous.google;
    if (previous.daily === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED;
    else process.env.DAILY_SYNC_FEATURE_ENABLED = previous.daily;
    await db.$disconnect();
  }
});
