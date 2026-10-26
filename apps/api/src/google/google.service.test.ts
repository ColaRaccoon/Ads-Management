import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { REQUIRED_PERMISSIONS, AUTH_ROUTE_ACCESS, PERMISSION_ROUTE } from "../auth/route-decorators";
import { GoogleController } from "./google.controller";
import { GoogleMappingInput, GoogleQuery } from "./google.dto";
import { GoogleMappingsService, mappingConfiguration, mappingIdentity } from "./google-mappings.service";
import { GoogleReadService, googleRange } from "./google-read.service";
import { PrismaService } from "../common/prisma.service";
import { GooglePerformanceMapping, Prisma } from "@prisma/client";
import { resolveGoogleSaleConfiguration } from "./google-sale-configuration";

test("all Google routes require read or mapping permission; preview cannot bypass write permission", () => {
  for (const name of ["options", "summary", "profit", "campaigns", "list", "preview", "create", "update"] as const) {
    const handler = GoogleController.prototype[name];
    assert.equal(Reflect.getMetadata(AUTH_ROUTE_ACCESS, handler), PERMISSION_ROUTE);
    assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler),
      [["preview", "create", "update"].includes(name) ? "mappings.manage" : "data.read"]);
  }
});

test("sale configuration rejects incomplete, imprecise, invalid amounts and unit labels without a configuration", () => {
  const base = { kind: "SALE", connectionId: "c", productId: "p", productNo: "181", startDate: "2026-10-26" } as GoogleMappingInput;
  assert.throws(() => mappingConfiguration({ ...base, salePriceKrwOverride: 34900 }), /모두/);
  assert.throws(() => mappingConfiguration({ ...base, saleUnitLabel: "1+1 세트" }), /4개/);
  const complete = { ...base, salePriceKrwOverride: 34900, productCostKrwOverride: 9000, shippingKrwOverride: 0, extraCostKrwOverride: 0 };
  for (const value of [-1, NaN, Infinity, 0.00001, 1.001, 1000000000000])
    assert.throws(() => mappingConfiguration({ ...complete, salePriceKrwOverride: value }));
  assert.throws(() => mappingConfiguration({ ...complete, kind: "CAMPAIGN" }), /캠페인/);
  assert.throws(() => mappingConfiguration({ ...complete, optionScope: "PRODUCT", optionName: "블랙" }), /옵션명/);
  assert.throws(() => mappingConfiguration({ ...complete, saleUnitLabel: "가".repeat(65) }), /64자/);
  assert.equal(mappingConfiguration({ ...complete, optionScope: "PRODUCT", saleUnitLabel: "1+1 세트" }).saleUnitLabel, "1+1 세트");
});

test("product-wide mapping identity differs from every exact scope marker while legacy exact keys remain stable", () => {
  assert.equal(mappingIdentity("SALE", null, "181", "블랙"), mappingIdentity("SALE", null, "181", "블랙", "EXACT"));
  assert.notEqual(mappingIdentity("SALE", null, "181", "", "PRODUCT"), mappingIdentity("SALE", null, "181", "PRODUCT"));
  assert.notEqual(mappingIdentity("SALE", null, "181", "", "PRODUCT"), mappingIdentity("SALE", null, "181", ""));
});

test("Google complete sale configuration uses three collected sets without legacy bundle doubling or shared cost fallback", () => {
  const d = (v: number) => new Prisma.Decimal(v);
  const mapping = { salePriceKrwOverride: d(34900), productCostKrwOverride: d(9000), shippingKrwOverride: d(0), extraCostKrwOverride: d(0),
    saleUnitLabel: "1+1 세트" };
  const match = { displayName: "1+1", optionIncludeKeywords: ["+"], productNameAliases: [],
    salePriceKrwOverride: d(14900), productCostKrwOverride: d(4500), shippingKrwOverride: null, extraCostKrwOverride: null };
  const before = JSON.stringify({ mapping, match });
  const configured = resolveGoogleSaleConfiguration(3, mapping, null, match);
  assert.equal(configured.quantity, 3);
  assert.equal(configured.calculationQuantity, 3);
  assert.equal(configured.saleUnitLabel, "1+1 세트");
  assert.equal(configured.cost?.salePriceKrw, 34900);
  assert.equal(configured.cost?.productCostKrw, 9000);
  assert.equal(configured.cost?.vatKrw, 3490);
  assert.equal(JSON.stringify({ mapping, match }), before);
  const rule = { salePriceKrw: d(14900), vatKrw: d(1490), productCostKrw: d(4500), shippingKrw: d(0), extraCostKrw: d(0) };
  const legacy = resolveGoogleSaleConfiguration(3, undefined, rule, match);
  assert.equal(legacy.quantity, 6);
  assert.equal(legacy.calculationQuantity, 3);
  assert.equal(legacy.cost?.salePriceKrw, 14900);
  assert.equal(legacy.saleUnitLabel, null);
  assert.equal(resolveGoogleSaleConfiguration(3, { saleUnitLabel: "1+1 세트" } as GooglePerformanceMapping, rule, match).saleUnitLabel, null);
});

test("disabled feature never reaches DB for reads, mappings, or mutation", async () => {
  const old = process.env.GOOGLE_PERFORMANCE_ENABLED;
  process.env.GOOGLE_PERFORMANCE_ENABLED = "false";
  try {
    const db = new Proxy({}, { get() { throw Error("database must not be reached"); } }) as PrismaService;
    const read = new GoogleReadService(db), mappings = new GoogleMappingsService(db);
    assert.deepEqual(await read.options(), { enabled: false, connections: [], products: [] });
    await assert.rejects(read.report({ from: "2026-10-01", to: "2026-10-01" }), /비활성화/);
    await assert.rejects(mappings.list({}), /비활성화/);
    await assert.rejects(mappings.save({} as GoogleMappingInput, "actor"), /비활성화/);
  } finally { if (old === undefined) delete process.env.GOOGLE_PERFORMANCE_ENABLED; else process.env.GOOGLE_PERFORMANCE_ENABLED = old; }
});

test("query rejects partial/unbounded ranges and transport rejects arbitrary accounts and page sizes", () => {
  assert.throws(() => googleRange({ from: "2026-10-01" }), /함께/);
  assert.throws(() => googleRange({ from: "2026-01-01", to: "2026-10-01" }), /92일/);
  assert.equal(googleRange({ from: "2026-10-01", to: "2026-10-01" }).from, "2026-10-01");
  assert.equal(validateSync(plainToInstance(GoogleQuery, { page: "1", pageSize: "100" })).length, 0);
  assert.ok(validateSync(plainToInstance(GoogleQuery, { connectionId: "another-account", pageSize: "101" })).length >= 2);
});

test("campaign ID preview and saves are rejected before any database access, including legacy edits", async () => {
  const old = process.env.GOOGLE_PERFORMANCE_ENABLED;
  process.env.GOOGLE_PERFORMANCE_ENABLED = "true";
  try {
    const db = new Proxy({}, { get() { throw Error("database must not be reached"); } }) as PrismaService;
    const service = new GoogleMappingsService(db);
    const campaign = { kind: "CAMPAIGN" as const, connectionId: "cafe", campaignId: "123", productId: null, startDate: "2026-10-01" };
    await assert.rejects(service.preview(campaign), /캠페인명/);
    await assert.rejects(service.save(campaign, "actor"), /캠페인명/);
    await assert.rejects(service.save({ ...campaign, id: "old" }, "actor", "old"), /캠페인명/);
  } finally { if (old === undefined) delete process.env.GOOGLE_PERFORMANCE_ENABLED; else process.env.GOOGLE_PERFORMANCE_ENABLED = old; }
});

test("SALE empty identifiers still normalize before preview, persistence and audit after campaign writes are disabled", async () => {
  const old = process.env.GOOGLE_PERFORMANCE_ENABLED;
  process.env.GOOGLE_PERFORMANCE_ENABLED = "true";
  const written: Record<string, unknown>[] = [], audits: Record<string, unknown>[] = [];
  try {
    const tx = {
      $queryRaw: async () => [],
      sourceConnection: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, provider: where.id === "google" ? "GOOGLE" : "CAFE24" }) },
      product: { findFirst: async () => ({ id: "product" }) },
      cafe24OrderLine: { findFirst: async () => ({ id: "sale" }) },
      googleCampaignDailyCost: { findFirst: async () => ({ id: "campaign" }) },
      googlePerformanceMapping: {
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => {
          // Mirror the database's existing identifier CHECK; do not relax it.
          if (data.kind === "SALE") { assert.equal(data.campaignId, null); assert.equal(data.productNo, "181"); }
          else { assert.equal(data.productNo, null); assert.equal(data.campaignId, "123"); assert.equal(data.optionName, ""); }
          written.push(data);
          return { ...data, id: `mapping-${written.length}`, createdAt: new Date("2026-10-26"), updatedAt: new Date("2026-10-26"),
            ...Object.fromEntries(["salePriceKrwOverride", "productCostKrwOverride", "shippingKrwOverride", "extraCostKrwOverride"]
              .map(key => [key, data[key] == null ? null : new Prisma.Decimal(data[key] as number)])) };
        }
      },
      googleMappingAudit: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; } }
    };
    const db = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
    const service = new GoogleMappingsService(db);
    const sale: GoogleMappingInput = { kind: "SALE", connectionId: "cafe", campaignId: "", productNo: "181", optionName: "",
      optionScope: "PRODUCT", productId: "product", startDate: "2026-10-23", endDate: null,
      salePriceKrwOverride: 34900, productCostKrwOverride: 9000, shippingKrwOverride: 0, extraCostKrwOverride: 0, saleUnitLabel: "1+1 세트" };
    const preview = await service.preview(sale);
    assert.equal(preview.after.campaignId, null);
    assert.equal(preview.after.optionName, "");
    const result = await service.save(sale, "actor");
    assert.equal(result.mapping.campaignId, null);
    assert.equal(written[0].salePriceKrwOverride, 34900);
    assert.equal((audits[0].after as Record<string, unknown>).campaignId, null);
    assert.equal(sale.campaignId, "");
    await assert.rejects(service.save({ kind: "CAMPAIGN", connectionId: "google", campaignId: "123", productNo: "", optionName: "",
      productId: "product", startDate: "2026-10-23" }, "actor"), /캠페인명/);
    assert.equal(written.length, 1);
    assert.equal(audits.length, 1);
    await assert.rejects(service.preview({ ...sale, campaignId: "unexpected" }), /상품번호/);
  } finally { if (old === undefined) delete process.env.GOOGLE_PERFORMANCE_ENABLED; else process.env.GOOGLE_PERFORMANCE_ENABLED = old; }
});

test("mapping list exposes bounded active name candidates while preserving legacy campaign history", async () => {
  const old = process.env.GOOGLE_PERFORMANCE_ENABLED;
  process.env.GOOGLE_PERFORMANCE_ENABLED = "true";
  let products = [{ id: "p", name: "상품", displayName: "상품 표시명" }];
  const legacy = { id: "legacy", kind: "CAMPAIGN", productId: "p", campaignId: "123", startDate: new Date("2026-10-23"),
    endDate: null, createdAt: new Date("2026-10-26"), updatedAt: new Date("2026-10-26") };
  const tx = {
    googlePerformanceMapping: { findMany: async () => [legacy], count: async () => 1 },
    googleMappingAudit: { findMany: async () => [{ mappingId: "legacy", actorUserId: "actor" }] },
    product: { findMany: async ({ where, take }: { where: { isActive: boolean }; take: number }) => {
      assert.equal(where.isActive, true); assert.equal(take, 10001); return products;
    } }
  };
  const db = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
  try {
    const service = new GoogleMappingsService(db);
    const result = await service.list({});
    assert.equal(result.campaignMappingMode, "CAMPAIGN_NAME");
    assert.deepEqual(result.nameAutomaticProducts, products);
    assert.equal(result.campaignMappings[0].id, "legacy");
    assert.equal(result.audit[0].mappingId, "legacy");
    products = Array.from({ length: 10001 }, (_, index) => ({ id: String(index), name: "p", displayName: "p" }));
    await assert.rejects(service.list({}));
  } finally { if (old === undefined) delete process.env.GOOGLE_PERFORMANCE_ENABLED; else process.env.GOOGLE_PERFORMANCE_ENABLED = old; }
});

test("reader uses each dated campaign name and ignores conflicting legacy ID mappings without writes", async () => {
  const previous = { google: process.env.GOOGLE_PERFORMANCE_ENABLED, daily: process.env.DAILY_SYNC_FEATURE_ENABLED };
  process.env.GOOGLE_PERFORMANCE_ENABLED = "true";
  process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
  const dates = [new Date("2026-10-20"), new Date("2026-10-21"), new Date("2026-10-22")];
  const names = ["풀 업 바 첫 광고", "자이로볼 이름 변경", "이름 없는 상품"];
  const ads = dates.map((metricDate, i) => ({ id: `ad-${i}`, connectionId: "g", campaignId: "same-campaign-id",
    campaignName: names[i], metricDate, source: "API", costMicros: 20000000000n, impressions: 1000n,
    clicks: 10n, syncRunId: `run-${i}`, version: 1 }));
  const tx = {
    sourceConnection: { findMany: async () => [{ id: "g", provider: "GOOGLE", displayName: "Google", externalAccountId: "account", currencyCode: "KRW", timeZone: "Asia/Seoul" }] },
    sourceCoverage: { findMany: async () => dates.map((metricDate, i) => ({ connectionId: "g", dataKind: "GOOGLE_CAMPAIGN", metricDate,
      source: "API", rowCount: 1, totalAmount: new Prisma.Decimal(20000), state: "COMPLETE_NONZERO",
      lastSuccessRunId: `run-${i}`, lastSuccessAt: metricDate, lastAttemptAt: metricDate, warningCodes: [] })) },
    sourcePolicy: { findMany: async () => [{ connectionId: "g", dataKind: "GOOGLE_CAMPAIGN", primarySource: "API", fromDate: dates[0], toDate: null }] },
    googleCampaignDailyCost: { findMany: async () => ads },
    cafe24UploadBatch: { findMany: async () => [] }, exchangeRate: { findMany: async () => [] },
    productCostRule: { findMany: async () => [] }, cafe24CouponRule: { findMany: async () => [] }, cafe24OrderLine: { findMany: async () => [] },
    googlePerformanceMapping: { findMany: async ({ where }: { where: { kind: string } }) => {
      assert.equal(where.kind, "SALE", "legacy campaign rows are not requested by the report reader");
      // Even a stray legacy result must not override the name or provide a fallback.
      return [{ kind: "CAMPAIGN", connectionId: "g", identityKey: mappingIdentity("CAMPAIGN", "same-campaign-id"),
        productId: "p-wrong", startDate: dates[0], endDate: null }];
    } },
    product: { findMany: async () => [{ id: "p-bar", name: "풀업바", displayName: "풀업 바" },
      { id: "p-ball", name: "자이로볼", displayName: "자이로볼" }, { id: "p-wrong", name: "옛 상품", displayName: "옛 상품" }] },
    runUnit: { findMany: async () => dates.map((date, i) => ({ run: { connectionId: "g" }, runId: `run-${i}`,
      unitKey: date.toISOString().slice(0, 10), publishedCount: 1 })) },
    sourceRecordLink: { findMany: async () => ads.map(ad => ({ recordId: ad.id, connectionId: "g", version: 1, syncRunId: ad.syncRunId })) }
  };
  const snapshot = JSON.stringify(ads, (_, value) => typeof value === "bigint" ? value.toString() : value);
  const db = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
  try {
    const result = await new GoogleReadService(db).report({ from: "2026-10-20", to: "2026-10-22" });
    assert.deepEqual(result.products.map(row => row.productId), ["p-ball", "p-bar"]);
    assert.equal(result.daily.find(row => row.date === "2026-10-20")!.productId, "p-bar");
    assert.equal(result.daily.find(row => row.date === "2026-10-21")!.productId, "p-ball");
    assert.equal(result.daily.find(row => row.date === "2026-10-22")!.productId, null);
    assert.equal(result.summary.unallocatedAdSpendKrw, 20000);
    assert.equal(result.summary.allocatedAdSpendKrw, 40000);
    assert.equal(result.campaigns[0].mappingMode, "CAMPAIGN_NAME");
    assert.deepEqual(result.campaigns[0].productIds, ["p-ball", "p-bar"]);
    assert.ok(result.campaigns[0].warningCodes.includes("CAMPAIGN_PRODUCT_NOT_FOUND"));
    assert.equal(JSON.stringify(ads, (_, value) => typeof value === "bigint" ? value.toString() : value), snapshot);
  } finally {
    if (previous.google === undefined) delete process.env.GOOGLE_PERFORMANCE_ENABLED; else process.env.GOOGLE_PERFORMANCE_ENABLED = previous.google;
    if (previous.daily === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous.daily;
  }
});
