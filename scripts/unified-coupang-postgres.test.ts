import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { CoupangPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/coupang.adapter";
import { COUPANG_UPLOAD_SCOPE } from "../apps/api/src/unified-performance/adapters/coupang-ads";
import { CONTRACT_VERSION, type AdapterRequest } from "../apps/api/src/unified-performance/types";
import { ExactDecimal as D } from "../apps/api/src/unified-performance/domain/decimal";

const ownerUrl = "postgresql://unified_fixture_owner@127.0.0.1:55449/unified_stage04?schema=meta_ads";
const readerUrl = "postgresql://unified_source_reader@127.0.0.1:55449/unified_stage04?schema=meta_ads";
const date = new Date("2026-10-26"), importedAt = new Date("2026-10-27");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const total = (values: Array<string | null>) => values.reduce((s, v) => s.plus(v ?? "0"), new D(0)).toFixed();

test("Coupang actual non-owner reader preserves versions, name units, costs, and immutable sources", { skip: !process.env.UNIFIED_STAGE04_READER_URL }, async () => {
  assert.equal(process.env.UNIFIED_STAGE04_FIXTURE_URL, ownerUrl); assert.equal(process.env.UNIFIED_STAGE04_READER_URL, readerUrl);
  const owner = new PrismaClient({ datasourceUrl: ownerUrl }), reader = new PrismaClient({ datasourceUrl: readerUrl });
  try {
    const [identity] = await owner.$queryRaw<Array<{ db: string; usr: string; host: string }>>`SELECT current_database() db,current_user usr,inet_server_addr()::text host`;
    assert.equal(identity.db, "unified_stage04"); assert.equal(identity.usr, "unified_fixture_owner"); assert.match(identity.host, /^127\.0\.0\.1/);
    const [role] = await reader.$queryRaw<Array<{ usr: string; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>>`SELECT current_user usr,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`;
    assert.equal(role.usr, "unified_source_reader"); assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false); assert.equal(role.rolcreatedb, false); assert.equal(role.rolcreaterole, false);
    for (const name of ["버닝웨이브바", "별도상품"]) await owner.unifiedProduct.create({ data: { canonicalName: name, normalizedName: name } });
    const product = await owner.coupangProduct.create({ data: { standardName: "버닝웨이브바 2개입", displayName: "버닝웨이브바 2개입" } });
    await owner.coupangProductRule.create({ data: { coupangProductId: product.id, displayName: "세트", includeKeywords: ["버닝웨이브바", "2개"], validFrom: new Date("2026-01-01") } });
    await owner.coupangCostRule.create({ data: { coupangProductId: product.id, salePriceKrw: "1100", productCostKrw: "100", sellerShippingFeeKrw: "10", hanaroShippingFeeKrw: "20", growthInboundFeeKrw: "3", growthShippingFeeKrw: "7", returnRate: "0", returnCostPerUnitKrw: "0", extraCostKrw: "0", effectiveFrom: new Date("2026-01-01") } });
    await owner.coupangSalesFeeRule.create({ data: { salesFeeRate: "0.1", effectiveFrom: new Date("2026-01-01") } });
    const salesBatch = await owner.coupangUploadBatch.create({ data: { sourceType: "SALES", originalFilename: "synthetic.xlsx", fileHashSha256: digest("s04-sale"), columnSchema: {}, status: "IMPORTED", importedAt } });
    const adBatch = await owner.coupangUploadBatch.create({ data: { sourceType: "ADS", originalFilename: "synthetic.xlsx", fileHashSha256: digest("s04-ad"), columnSchema: {}, status: "IMPORTED", importedAt } });
    const sale = async (key: string, method: string, current = true, version = 1, net = "1100") => owner.coupangSaleLine.create({ data: { uploadBatchId: salesBatch.id, rowNumber: version * 100 + (method === "판매자배송" ? 1 : 2), sourceRowHash: digest(`${key}:${version}`), saleLineKey: key,
      saleDate: date, productName: "버닝웨이브바", optionName: "2개", registeredProductId: `replacement-${version}`, optionId: `option-${version}`, saleMethod: method,
      salesKrw: "1200", cancelAmountKrw: "100", netSalesKrw: net, salesQuantity: "1", orderCount: 1, isCurrent: current, importVersion: version } });
    const first = await sale("seller-key", "판매자배송"); await sale("growth-key", "로켓그로스");
    await owner.coupangAdMetric.create({ data: { uploadBatchId: adBatch.id, rowNumber: 1, sourceRowHash: digest("s04-ad1"), adMetricKey: "ad-key", metricDate: date,
      adExecutionProductName: "버닝웨이브바 2개", conversionProductName: "별도상품", adSpendKrw: "40", totalConversionSales1dKrw: "999999" } });
    await owner.coupangManualPurchase.create({ data: { purchaseDate: date, coupangProductId: product.id, productDisplayName: "버닝웨이브바 2개입", quantity: 1,
      salesAmountKrw: "1100", productCostKrw: "0", vendorFeePerUnitKrw: "15", vendorFeeTotalKrw: "15", coupangSalesFeeKrw: "0", salesFeeRateApplied: "0", shippingCostKrw: "0", totalCostKrw: "15" } });
    const repository = new UnifiedManagementRepository(reader as unknown as PrismaService);
    const config = await repository.snapshot();
    const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: randomUUID(), readSnapshotId: "s04", from: "2026-10-26", to: "2026-10-26", scopeKeys: [COUPANG_UPLOAD_SCOPE], platforms: ["COUPANG"], ...config.versions,
      calculationVersion: "coupang-normal-v1", fxVersion: "KRW", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 };
    const adapter = new CoupangPerformanceAdapter(repository);
    const before = await owner.coupangSaleLine.count();
    const batch = await adapter.read(request);
    assert.equal(batch.sales.length, 3); assert.equal(batch.adSpends.length, 1);
    assert.equal(total(batch.sales.map(f => f.operatingRevenue)), "1100");
    assert.equal(total(batch.sales.map(f => f.productCost)), "100");
    assert.equal(total(batch.sales.map(f => f.directShippingCost)), "30");
    assert.equal(total(batch.sales.map(f => f.manualVendorFee)), "15");
    assert.equal(total(batch.sales.map(f => f.profitBeforeAds)), "745");
    assert.equal(batch.adSpends[0].productName, "버닝웨이브바"); assert.equal(total(batch.adSpends.map(f => f.amountKrw)), "40");
    assert(batch.sales.filter(f => f.ref.recordKind === "SALE").every(f => f.saleUnitName === "2개입" && f.unitsPerSaleUnit === "2"));
    assert(batch.sourceControlTotals.every(c => c.difference === null || new D(c.difference).isZero()));
    assert.equal(await owner.coupangSaleLine.count(), before);
    const same = await adapter.read(request); assert.equal(same.sourceFingerprint, batch.sourceFingerprint);
    const duplicate = await owner.coupangSaleLine.create({ data: { uploadBatchId: salesBatch.id, rowNumber: 999, sourceRowHash: digest("duplicate"), saleLineKey: "seller-key",
      saleDate: date, productName: "버닝웨이브바", optionName: "2개", salesKrw: "1100", netSalesKrw: "1100", salesQuantity: "1" } });
    const failedSales = await adapter.read(request);
    assert.equal(failedSales.sales.length, 0); assert.equal(failedSales.adSpends.length, 1);
    assert.equal(failedSales.coverage.find(c => c.component === "SALE")?.collectionState, "PARTIAL");
    assert(failedSales.coverage.find(c => c.component === "SALE")?.quality.issues.includes("COUPANG_SALES_NORMALIZATION_FAILED"));
    await owner.coupangSaleLine.delete({ where: { id: duplicate.id } });
    await owner.$executeRawUnsafe("REVOKE SELECT ON meta_ads.coupang_sale_lines FROM unified_source_reader");
    const deniedSales = await adapter.read(request);
    assert.equal(deniedSales.sales.length, 0); assert.equal(deniedSales.adSpends.length, 1);
    assert(deniedSales.coverage.find(c => c.component === "SALE")?.quality.issues.includes("COUPANG_SALES_READ_FAILED"));
    assert.equal(deniedSales.coverage.find(c => c.component === "SALE")?.collectionState, "PARTIAL");
    await owner.$executeRawUnsafe("GRANT SELECT ON meta_ads.coupang_sale_lines TO unified_source_reader");
    await owner.$executeRawUnsafe("REVOKE SELECT ON meta_ads.coupang_ad_metrics FROM unified_source_reader");
    const deniedAds = await adapter.read(request);
    assert.equal(deniedAds.sales.length, 3); assert.equal(deniedAds.adSpends.length, 0);
    assert(deniedAds.coverage.find(c => c.component === "AD_SPEND")?.quality.issues.includes("COUPANG_ADS_READ_FAILED"));
    assert.equal(deniedAds.coverage.find(c => c.component === "AD_SPEND")?.collectionState, "PARTIAL");
    await owner.$executeRawUnsafe("GRANT SELECT ON meta_ads.coupang_ad_metrics TO unified_source_reader");
    await owner.coupangSaleLine.update({ where: { id: first.id }, data: { isCurrent: false } });
    await sale("seller-key", "판매자배송", true, 2, "1000");
    const corrected = await adapter.read(request); assert.equal(corrected.sales.length, 3);
    assert.notEqual(corrected.sourceFingerprint, batch.sourceFingerprint); assert.equal(total(corrected.sales.map(f => f.operatingRevenue)), "1000");
    await owner.coupangSaleLine.updateMany({ data: { isCurrent: false } });
    await owner.coupangManualPurchase.deleteMany();
    const empty = await adapter.read(request); assert.equal(empty.sales.length, 0); assert.equal(empty.adSpends.length, 1);
    assert.equal(empty.coverage.find(c => c.component === "SALE")?.collectionState, "NOT_COLLECTED");
    assert.equal(empty.coverage.find(c => c.component === "SALE")?.zeroConfirmed, false);
    assert.throws(() => adapter.read({ ...request, platforms: [] }));
    assert.throws(() => adapter.read({ ...request, scopeKeys: ["guessed-account"] }));
    await assert.rejects(adapter.read({ ...request, nameRuleVersion: "stale" }), /STALE_CONFIGURATION/);
    await assert.rejects(reader.$executeRaw`UPDATE meta_ads.coupang_sale_lines SET net_sales_krw=0`, /permission denied/);
    await assert.rejects(reader.$queryRaw`SELECT * FROM meta_ads.source_credentials LIMIT 1`, /permission denied/);
    await repository.read(async tx => {
      const [settings] = await tx.$queryRaw<Array<{ ro: string; isolation: string }>>`SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation`;
      assert.equal(settings.ro, "on"); assert.equal(settings.isolation, "repeatable read");
      await assert.rejects(tx.$executeRaw`DELETE FROM meta_ads.coupang_ad_metrics`);
    });
  } finally { await reader.$disconnect(); await owner.$disconnect(); }
});
