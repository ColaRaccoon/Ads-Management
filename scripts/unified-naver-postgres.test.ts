import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { NaverPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/naver.adapter";
import { naverQueries } from "../apps/api/src/unified-performance/adapters/naver-reader";
import { CONTRACT_VERSION, type AdapterRequest } from "../apps/api/src/unified-performance/types";
import { ExactDecimal as D } from "../apps/api/src/unified-performance/domain/decimal";

const ownerUrl = "postgresql://unified_fixture_owner@127.0.0.1:55450/unified_stage05?schema=meta_ads";
const readerUrl = "postgresql://unified_source_reader@127.0.0.1:55450/unified_stage05?schema=meta_ads";
const scope = "11111111-1111-4111-8111-111111111111", date = "2026-10-26", at = "2026-10-27T01:00:00.000Z";
const total = (values: Array<string | null>) => values.reduce((sum, value) => sum.plus(value ?? "0"), new D(0)).toFixed();

test("Naver actual non-owner reader: source conservation, narrow projections, replacement/zero, failed SELECT recovery and minimum privileges", { skip: !process.env.UNIFIED_STAGE05_READER_URL }, async () => {
  assert.equal(process.env.UNIFIED_STAGE05_FIXTURE_URL, ownerUrl); assert.equal(process.env.UNIFIED_STAGE05_READER_URL, readerUrl);
  const owner = new PrismaClient({ datasourceUrl: ownerUrl }), reader = new PrismaClient({ datasourceUrl: readerUrl });
  const web = new PrismaClient({ datasourceUrl: readerUrl.replace("unified_source_reader", "unified_web_role") });
  try {
    const [identity] = await owner.$queryRaw<Array<{ db: string; usr: string; host: string }>>`SELECT current_database() db,current_user usr,inet_server_addr()::text host`;
    assert.equal(identity.db, "unified_stage05"); assert.equal(identity.usr, "unified_fixture_owner"); assert.match(identity.host, /^127\.0\.0\.1/);
    const [role] = await reader.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>>`SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`;
    assert(Object.values(role).every(value => value === false));
    // Every insertion is synthetic and happens only after loopback/database identity assertions.
    const put = async (table: string, id: string, payload: Record<string, unknown>) => {
      assert(/^[a-z_]+$/.test(table));
      await owner.$executeRaw(Prisma.sql`INSERT INTO public.${Prisma.raw(table)}(id,payload,updated_at) VALUES (${id},${JSON.stringify({ id, storeId: scope, updatedAt: at, ...payload })}::jsonb,${new Date(at)}) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`);
    };
    await owner.unifiedProduct.create({ data: { canonicalName: "버닝웨이브바", normalizedName: "버닝웨이브바" } });
    await put("stores", scope, { platformType: "NAVER_SMARTSTORE", deliveryUnitCost: 2800, sellerAccountId: "FORBIDDEN_CUSTOMER_SENTINEL" });
    await put("canonical_sales_units", "parent", { displayName: "버닝웨이브", matchAliases: [], isGroup: true, isActive: true });
    await put("canonical_sales_units", "unit", { displayName: "버닝웨이브바", matchAliases: ["단품"], isGroup: false, isActive: true, parentSalesUnitId: "parent" });
    await put("order_source_signatures", "signature", { rawProductNameSnapshot: "버닝웨이브바", rawOptionInfoSnapshot: "단품", sampleExternalProductId: "FORBIDDEN_CUSTOMER_SENTINEL" });
    const order = { orderSourceSignatureId: "signature", canonicalSalesUnitId: "unit", rawProductName: null, rawOptionInfo: null,
      paymentDate: date, saleStatus: "SALE", quantity: 1, productPaymentAmount: 100.05, paymentCommission: 0,
      knowledgeShoppingSellingInterlockCommission: null, saleCommission: null, channelCommission: null, packageNumber: "one-package", orderId: "one-order",
      deliveryFeeAmount: 1500, rawPayload: { receiverName: "FORBIDDEN_CUSTOMER_SENTINEL" } };
    await put("order_items", "first", { ...order, externalProductOrderId: "first-order" });
    await put("order_items", "second", { ...order, externalProductOrderId: "second-order" });
    await put("order_items", "cancel", { ...order, externalProductOrderId: "cancel", saleStatus: "CANCELED" });
    await put("order_items", "foreign", { ...order, externalProductOrderId: "other-store", storeId: "other-store" });
    await put("sales_unit_cost_settings", "cost", { canonicalSalesUnitId: "unit", unitCost: 20, otherCost: 0, feeRate: 0.1, isActive: true, effectiveFrom: "2026-01-01", effectiveTo: null });
    await put("ad_excel_uploads", "old", { reportDate: date, sourceType: "NAVER_DA_XLSX", isActive: false, state: "REPLACED", weekdayValidationStatus: "PASSED" });
    await put("ad_excel_uploads", "current", { reportDate: date, sourceType: "NAVER_DA_XLSX", isActive: true, state: "CONFIRMED", weekdayValidationStatus: "PASSED", replacedUploadId: "old" });
    await put("ad_campaign_daily_costs", "ad-old", { reportDate: date, sourceUploadId: "old", campaignId: "x", campaignName: "버닝웨이브", totalCost: 9999 });
    await put("ad_campaign_daily_costs", "ad-current", { reportDate: date, sourceUploadId: "current", campaignId: "new", campaignName: "버닝웨이브", totalCost: 10 });
    await put("daily_fake_purchases", "fake", { date, amount: 7 });
    await put("daily_sales_unit_profits", "stored-parent", { date, canonicalSalesUnitId: "parent", totalProductRevenue: 999999, calculationVersion: "profit-v1", calculatedAt: "2026-10-26T00:00:00Z" });
    await put("daily_sales_unit_profits", "stored-child", { date, canonicalSalesUnitId: "unit", totalProductRevenue: 999999, calculationVersion: "profit-v1", calculatedAt: "2026-10-26T00:00:00Z" });
    await put("order_sync_batches", "sync", { mode: "YESTERDAY", requestedRange: { dateFrom: date, dateTo: date } });
    await put("order_sync_batch_items", "sync-item", { batchId: "sync", operationId: "op", eligibility: "ELIGIBLE" });
    await put("operations", "op", { operationType: "ORDER_SYNC", status: "SUCCEEDED", finishedAt: at, resultJson: { paymentDateMissingCount: 0, unknownOrderStatusCount: 0 } });
    const repository = new UnifiedManagementRepository(reader as unknown as PrismaService), snapshot = await repository.snapshot();
    const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: randomUUID(), readSnapshotId: "stage05", from: date, to: date,
      scopeKeys: [scope], platforms: ["NAVER"], ...snapshot.versions, calculationVersion: "naver-profit-v2-preserved", fxVersion: "KRW", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 10000 };
    const adapter = new NaverPerformanceAdapter(repository), batch = await adapter.read(request);
    assert.equal(batch.sales.length, 2); assert.equal(total(batch.sales.map(f => f.operatingRevenue)), "200.1");
    assert(batch.sales.every(f => f.productName === "버닝웨이브바" && f.name.restorationPath === "public.order_source_signatures.rawProductNameSnapshot"));
    assert.equal(total(batch.sales.map(f => f.productCost)), "40"); assert.equal(total(batch.sales.map(f => f.vatExpense)), "20");
    assert.equal(total(batch.adSpends.map(f => f.amountKrw)), "10"); assert.equal(batch.adSpends[0].productName, "버닝웨이브바");
    assert.equal(batch.commonExpenses.find(f => f.kind === "SHIPPING_COST")?.amountKrw, "2800.000000");
    assert.equal(batch.commonExpenses.find(f => f.kind === "SHIPPING_INCOME")?.amountKrw, "3000.000000");
    assert.equal(batch.commonExpenses.find(f => f.kind === "FAKE_PURCHASE")?.amountKrw, "7.000000");
    assert(batch.commonExpenses.every(f => f.productName === null && f.allocationStatus === "UNALLOCATED"));
    assert.equal(batch.coverage.find(c => c.component === "SALE")?.collectionState, "COMPLETE");
    assert(batch.coverage.some(c => c.quality.issues.includes("NAVER_STORED_CALCULATION_VERSION_OLD")));
    assert(batch.sourceControlTotals.every(c => c.difference === "0.000000"));
    assert(!JSON.stringify(batch).includes("FORBIDDEN_CUSTOMER_SENTINEL"));
    assert.equal((await adapter.read(request)).sourceFingerprint, batch.sourceFingerprint);
    const projected = await reader.$queryRaw<Record<string, unknown>[]>(naverQueries(scope, date).order_items);
    assert(projected.every(row => !Object.keys(row).some(k => ["payload", "rawPayload", "receiverName"].includes(k))));
    await owner.$executeRawUnsafe("REVOKE SELECT ON public.sales_unit_cost_settings FROM unified_source_reader");
    const costsDenied = await adapter.read(request);
    assert.equal(costsDenied.sales.length, 2); assert(costsDenied.sales.every(s => s.productCost === null)); assert.equal(costsDenied.adSpends.length, 1);
    await owner.$executeRawUnsafe("GRANT SELECT ON public.sales_unit_cost_settings TO unified_source_reader");
    await owner.$executeRawUnsafe("REVOKE SELECT ON public.products FROM unified_source_reader");
    const productDenied = await adapter.read(request); assert.equal(productDenied.sales.length, 2); assert.equal(productDenied.adSpends.length, 1);
    assert(productDenied.sales.every(s => s.operatingRevenue !== null));
    await owner.$executeRawUnsafe("GRANT SELECT ON public.products TO unified_source_reader");
    await owner.$executeRawUnsafe("REVOKE SELECT ON public.ad_campaign_daily_costs FROM unified_source_reader");
    const adsDenied = await adapter.read(request); assert.equal(adsDenied.sales.length, 2); assert.equal(adsDenied.adSpends.length, 0);
    assert.equal(adsDenied.coverage.find(c => c.component === "AD_SPEND")?.collectionState, "PARTIAL");
    await owner.$executeRawUnsafe("GRANT SELECT ON public.ad_campaign_daily_costs TO unified_source_reader");
    await owner.$executeRawUnsafe("REVOKE SELECT ON public.stores FROM unified_source_reader");
    const storeDenied = await adapter.read(request); assert.equal(storeDenied.sales.length, 2);
    assert.equal(storeDenied.commonExpenses.find(e => e.kind === "SHIPPING_COST"), undefined);
    assert.equal(storeDenied.coverage.find(c => c.component === "COMMON_EXPENSE")?.collectionState, "PARTIAL");
    await owner.$executeRawUnsafe("GRANT SELECT ON public.stores TO unified_source_reader");
    await put("ad_excel_uploads", "current", { reportDate: date, sourceType: "NAVER_DA_XLSX", isActive: false, state: "REPLACED", weekdayValidationStatus: "PASSED" });
    await put("ad_excel_uploads", "zero", { reportDate: date, sourceType: "NAVER_DA_XLSX", isActive: true, state: "CONFIRMED", weekdayValidationStatus: "PASSED", replacedUploadId: "current" });
    const zeroAds = await adapter.read(request); assert.equal(zeroAds.adSpends.length, 0); assert.equal(zeroAds.coverage.find(c => c.component === "AD_SPEND")?.zeroConfirmed, true);
    await put("operations", "op", { operationType: "ORDER_SYNC", status: "FAILED", finishedAt: at });
    const failure = await adapter.read(request); assert.equal(failure.coverage.find(c => c.component === "SALE")?.collectionState, "PARTIAL");
    await owner.$executeRawUnsafe("DELETE FROM public.order_items");
    const noOrders = await adapter.read(request); assert.equal(noOrders.coverage.find(c => c.component === "SALE")?.zeroConfirmed, false);
    assert.equal(noOrders.sourceControlTotals.find(c => c.measure === "OPERATING_REVENUE")?.selectedAmount, null);
    assert.throws(() => adapter.read({ ...request, platforms: [] }));
    assert.throws(() => adapter.read({ ...request, scopeKeys: ["22222222-2222-4222-8222-222222222222"] }), /NOT_AUTHORIZED/);
    await assert.rejects(adapter.read({ ...request, nameRuleVersion: "stale" }), /STALE_CONFIGURATION/);
    await assert.rejects(reader.$executeRaw`UPDATE public.order_items SET payload='{}'::jsonb`, /permission denied/);
    await assert.rejects(reader.$executeRaw`DELETE FROM public.order_items`, /permission denied/);
    await assert.rejects(reader.$executeRaw`INSERT INTO public.order_items(id,payload) VALUES('forbidden','{}')`, /permission denied/);
    await assert.rejects(reader.$queryRaw`SELECT payload FROM public.commerce_api_credentials`, /permission denied/);
    await assert.rejects(web.$queryRaw`SELECT id FROM public.order_items LIMIT 1`, /permission denied/);
    await repository.read(async tx => {
      const [settings] = await tx.$queryRaw<Array<{ ro: string; isolation: string }>>`SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation`;
      assert.equal(settings.ro, "on"); assert.equal(settings.isolation, "repeatable read");
    });
  } finally { await reader.$disconnect(); await owner.$disconnect(); await web.$disconnect(); }
});
