import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { CoupangPerformanceAdapter, coupangPageDate, readCoupangDay } from "./coupang.adapter";
import { Prisma } from "@prisma/client";
import { CONTRACT_VERSION, type AdapterRequest } from "../types";
import type { UnifiedManagementRepository } from "../management.repository";

const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: "r", readSnapshotId: "s", from: "2026-10-20", to: "2026-10-26",
  scopeKeys: ["LEGACY_COUPANG_SINGLE_UPLOAD"], platforms: ["COUPANG"], scopePolicyVersion: "p", nameRuleVersion: "n", saleUnitRuleVersion: "u",
  allocationRuleVersion: "a", calculationVersion: "c", fxVersion: "f", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 };

test("Coupang rejects excluded, unconfirmed account and bad cursors before any repository read", () => {
  const previous = process.env.UNIFIED_PERFORMANCE_ENABLED; process.env.UNIFIED_PERFORMANCE_ENABLED = "true";
  let reads = 0;
  const adapter = new CoupangPerformanceAdapter({ read() { reads++; throw new Error("must not read"); } } as unknown as UnifiedManagementRepository);
  try {
    assert.throws(() => adapter.read({ ...request, platforms: [] }), /Excluded source/);
    assert.throws(() => adapter.read({ ...request, scopeKeys: ["guessed-account"] }), /SCOPE_FORBIDDEN/);
    assert.throws(() => adapter.read({ ...request, cursor: "2026-10-27" }), /CURSOR_OUT_OF_RANGE/);
    assert.throws(() => adapter.read({ ...request, cursor: "2026-02-30" }), /Business date/);
    assert.throws(() => adapter.read({ ...request, limit: 10001 }), /page limit/);
    assert.equal(reads, 0);
    process.env.UNIFIED_PERFORMANCE_ENABLED = "false";
    assert.throws(() => adapter.read(request)); assert.equal(reads, 0);
  } finally { if (previous === undefined) delete process.env.UNIFIED_PERFORMANCE_ENABLED; else process.env.UNIFIED_PERFORMANCE_ENABLED = previous; }
});

test("Coupang pages use the stored business day without timezone shifts", () => {
  assert.equal(coupangPageDate(request), "2026-10-20");
  assert.equal(coupangPageDate({ ...request, cursor: "2026-10-26" }), "2026-10-26");
});

test("oversized Coupang source pages preserve their healthy sibling", async () => {
  const config = { products: [], rules: [], versions: { scopePolicyVersion: "p", nameRuleVersion: "n", saleUnitRuleVersion: "u", allocationRuleVersion: "a" } };
  const at = new Date("2026-10-20");
  const common = { id: "row", uploadBatchId: "upload", importVersion: 1, validationStatus: "VALID", createdAt: at };
  const sale = { ...common, saleLineKey: "sale", productName: "상품", optionName: "", saleMethod: "판매자배송", salesKrw: new Prisma.Decimal(100),
    cancelAmountKrw: new Prisma.Decimal(0), netSalesKrw: new Prisma.Decimal(100), salesQuantity: new Prisma.Decimal(1), orderCount: 1, batch: { status: "IMPORTED", sourceType: "SALES", importedAt: at } };
  const ad = { ...common, adMetricKey: "ad", adExecutionProductName: "상품", adSpendKrw: new Prisma.Decimal(10), totalConversionSales1dKrw: new Prisma.Decimal(999),
    batch: { status: "IMPORTED", sourceType: "ADS", importedAt: at } };
  for (const overflowing of ["sales", "ads"]) {
    const tx = { $executeRawUnsafe: async () => 0,
      coupangProduct: { findMany: async () => [{ id: "product", standardName: "상품", displayName: "상품", isActive: true }] },
      coupangProductRule: { findMany: async () => [] }, coupangCostRule: { findMany: async () => [] },
      coupangSalesFeeRule: { findMany: async () => [] }, coupangManualPurchase: { findMany: async () => [] },
      coupangSaleLine: { findMany: async () => overflowing === "sales" ? Array(10001).fill(sale) : [sale] },
      coupangAdMetric: { findMany: async () => overflowing === "ads" ? Array(10001).fill(ad) : [ad] } };
    const result = await readCoupangDay(tx as unknown as Prisma.TransactionClient, { snapshot: async () => config } as unknown as UnifiedManagementRepository, request);
    assert.equal(result.sales.length, overflowing === "sales" ? 0 : 1);
    assert.equal(result.adSpends.length, overflowing === "ads" ? 0 : 1);
    const failed = result.coverage.find(c => c.component === (overflowing === "sales" ? "SALE" : "AD_SPEND"));
    assert.equal(failed?.collectionState, "PARTIAL"); assert.equal(failed?.zeroConfirmed, false);
  }
});
