import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { Cafe24ProductMatcher, type Cafe24RuleInput } from "../domain/cafe24-matcher";
import { GoogleReadService } from "./google-read.service";
import type { PrismaService } from "../common/prisma.service";
import { createGoogleSaleMatcher } from "./google-sale-matcher";

const products = [{ id: "mask", name: "방한마스크", displayName: "방한마스크" }];
const date = new Date("2026-10-29");
const rules: Cafe24RuleInput[] = [
  { id: "single", productId: "mask", displayName: "방한마스크 단품", productNumbers: ["202"],
    productNameAliases: [], productNameIncludeKeywords: ["방한", "마스크"], matchTarget: "SEPARATE",
    optionIncludeKeywords: [], optionExcludeKeywords: ["+"], priority: 100, validFrom: "2026-10-12" },
  { id: "bundle", productId: "mask", displayName: "방한마스크 1+1", productNumbers: ["202"],
    productNameAliases: [], productNameIncludeKeywords: ["방한", "마스크"], matchTarget: "SEPARATE",
    optionIncludeKeywords: ["+"], optionExcludeKeywords: [], priority: 100, validFrom: "2026-10-12" }
];
const sale = { productNo: "230", productName: "[유튜브][파티마 방한마스크] 1+1 할인",
  optionName: "상품명(색상=블랙 단품)", optionValue: "블랙 단품", orderDate: date };

test("only YouTube product names bypass common product-number restrictions and keep original option matching", () => {
  const before = JSON.stringify(rules);
  const match = createGoogleSaleMatcher(rules, products);
  assert.equal(match(sale).matchRuleId, "single", "title's 1+1 must not select the bundle option");
  assert.equal(match({ ...sale, optionValue: "블랙1+1" }).matchRuleId, "bundle");
  assert.equal(match({ ...sale, productName: "파티마 방한마스크" }).productId, null);
  assert.equal(match({ ...sale, productName: "파티마 방한마스크", optionName: "[유튜브] 옵션" }).productId, null);
  assert.equal(new Cafe24ProductMatcher().match(sale, rules).productId, null, "shared Meta matching is unchanged");
  assert.equal(JSON.stringify(rules), before);
});

test("unrecognized, ambiguous, expired and unavailable-option YouTube sales remain unmatched", () => {
  const match = createGoogleSaleMatcher(rules, products);
  assert.equal(match({ ...sale, productName: "[유튜브] 알 수 없는 상품" }).productId, null);
  assert.equal(match({ ...sale, orderDate: new Date("2026-10-11") }).productId, null);
  assert.equal(match({ ...sale, optionValue: null }).productId, null);
  assert.equal(createGoogleSaleMatcher(rules.map(rule => ({ ...rule, validTo: "2026-10-28" })), products)(sale).productId, null);
  assert.equal(createGoogleSaleMatcher(rules.map(rule => ({ ...rule, isActive: false })), products)(sale).productId, null);
  assert.equal(createGoogleSaleMatcher(rules, [])(sale).productId, null);
  const ambiguous = createGoogleSaleMatcher([...rules, { ...rules[0], id: "duplicate" }], products)(sale);
  assert.equal(ambiguous.reason, "AMBIGUOUS_MATCH");
  assert.equal(ambiguous.productId, null);
});

test("number-only common rules require the catalog product name when matching another YouTube number", () => {
  const match = createGoogleSaleMatcher([{ ...rules[0], productNameIncludeKeywords: [] }], products);
  assert.equal(match(sale).productId, "mask");
  assert.equal(match({ ...sale, productName: "[유튜브] 다른 상품" }).productId, null);
});

test("Google ignores only YouTube channel exclusions while retaining other sale and option exclusions", () => {
  const common = [{ ...rules[0], productNameExcludeKeywords: ["[유튜브]", "공동구매"], optionExcludeKeywords: ["유튜브", "+"] }];
  const match = createGoogleSaleMatcher(common, products);
  assert.equal(match(sale).matchRuleId, "single");
  assert.equal(match({ ...sale, productName: `${sale.productName} 공동구매` }).productId, null);
  assert.equal(match({ ...sale, optionValue: "블랙1+1" }).productId, null);
  assert.deepEqual(common[0].productNameExcludeKeywords, ["[유튜브]", "공동구매"]);
});

test("report recomputes stored unmatched YouTube sales using dated common option prices without Google overrides or source writes", async () => {
  const previous = { google: process.env.GOOGLE_PERFORMANCE_ENABLED, daily: process.env.DAILY_SYNC_FEATURE_ENABLED };
  process.env.GOOGLE_PERFORMANCE_ENABLED = "true";
  process.env.DAILY_SYNC_FEATURE_ENABLED = "false";
  const d = (value: number) => new Prisma.Decimal(value);
  let bundlePrice = 24600;
  const lines = ["블랙1+1", "블랙1+1", "블랙 단품"].map((optionValue, i) => ({
    ...sale, id: `line-${i}`, orderNo: `order-${i}`, connectionId: "shop", source: "CSV", uploadBatchId: "batch",
    orderDate: date, optionValue, optionName: `방한마스크 1+1 할인(${optionValue})`,
    quantity: d(1), salePriceKrw: d(14800), productId: null, matchRule: null,
    totalOrderKrw: d(14800), totalPaidKrw: d(14800), paymentMethod: "카드", validationStatus: "UNMATCHED"
  }));
  const snapshot = JSON.stringify(lines);
  const tx = {
    sourceConnection: { findMany: async () => [
      { id: "g", provider: "GOOGLE", currencyCode: "KRW", timeZone: "Asia/Seoul", externalAccountId: "google" },
      { id: "shop", provider: "CAFE24", currencyCode: "KRW", timeZone: "Asia/Seoul" }
    ] },
    sourceCoverage: { findMany: async () => [] }, sourcePolicy: { findMany: async () => [] },
    googleCampaignDailyCost: { findMany: async () => [{ id: "ad", source: "CSV", connectionId: "g", metricDate: date,
      campaignId: "campaign", campaignName: "방한마스크", costMicros: 10000000000n, impressions: 1000n, clicks: 10n }] },
    cafe24UploadBatch: { findMany: async () => [{ id: "batch", rowCount: 3, _count: { rows: 3 } }] },
    exchangeRate: { findMany: async () => [] },
    productCostRule: { findMany: async () => [{ id: "cost", productId: "mask", effectiveFrom: date, effectiveTo: null,
      salePriceKrw: d(14800), vatKrw: d(1480), productCostKrw: d(2700), shippingKrw: d(0), extraCostKrw: d(0) }] },
    cafe24ProductRule: { findMany: async () => rules.map(rule => ({ ...rule, validFrom: new Date("2026-10-12"), validTo: null,
      isActive: true, salePriceKrwOverride: rule.id === "bundle" ? d(bundlePrice) : null,
      productCostKrwOverride: rule.id === "bundle" ? d(5400) : null, shippingKrwOverride: null, extraCostKrwOverride: null })) },
    cafe24CouponRule: { findMany: async () => [] }, cafe24OrderLine: { findMany: async () => lines },
    googlePerformanceMapping: { findMany: async () => { throw Error("Google-only configuration must not be read"); } },
    product: { findMany: async () => products }, sourceRecordLink: { findMany: async () => [] }
  };
  const db = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
  try {
    const read = () => new GoogleReadService(db).report({ from: "2026-10-29", to: "2026-10-29" });
    const report = await read();
    assert.equal(report.summary.unmappedSalesCount, 0);
    assert.equal(report.summary.quantity, 5);
    assert.equal(report.summary.revenueKrw, 64000);
    assert.equal(report.summary.grossCostKrw, 19900);
    assert.equal(report.summary.marginKrw, 34100);
    assert.equal(report.summary.complete, true);
    bundlePrice = 25000;
    assert.equal((await read()).summary.revenueKrw, 64800, "common setting changes apply on next read");
    assert.equal(JSON.stringify(lines), snapshot);
  } finally {
    for (const [key, value] of [["GOOGLE_PERFORMANCE_ENABLED", previous.google], ["DAILY_SYNC_FEATURE_ENABLED", previous.daily]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
