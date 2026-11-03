import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { sourceProductInventory } from "./source-product-inventory";

const native = (name: string, productName = name) => ({ component: "NATIVE_RESULT", nativeResult: {
  kind: "PRODUCT", group: "COUPANG", productKey: "original-key", productName, quantity: "2", issues: [],
  revenue: { known: "10", complete: "10" }, adSpend: { known: "0", complete: "0" },
  netProfit: { known: "1", complete: "1" }, profitBeforeAds: { known: "1", complete: "1" }, sourceUpdatedAt: null,
  audit: { sourceProductName: name }
} });
const rules = [{ id: "link", canonicalProductName: "두줄무릎보호대", matchType: "EXACT" as const, terms: ["두줄보호대 2개입"],
  platform: "COUPANG" as const, scopeKey: "LEGACY_COUPANG_SINGLE_UPLOAD", nameField: "native:COUPANG", validFrom: "2026-10-01" }];
function fixture() {
  const calls: any[] = [];
  const tx = { sourceConnection: { findMany: async () => [] }, unifiedSourcePublication: { findMany: async (args: any) => {
    calls.push(args); return [{ runId: "new", scopeKey: "LEGACY_COUPANG_SINGLE_UPLOAD", businessDate: new Date("2026-10-21") },
      { runId: "old", scopeKey: "LEGACY_COUPANG_SINGLE_UPLOAD", businessDate: new Date("2026-10-20") }];
  } }, unifiedDailyFact: { findMany: async (args: any) => { calls.push(args); return [
    { runId: "new", payload: native("두줄보호대 2개입") }, { runId: "old", payload: native("두줄보호대 2개입") },
    { runId: "new", payload: { nativeResult: { ...native("summary").nativeResult, kind: "SUMMARY" } } }
  ]; } } } as unknown as Prisma.TransactionClient;
  return { tx, calls };
}
test("inventory reads only authorized published partitions and exposes pending links with original names and inclusive date coverage", async () => {
  const { tx, calls } = fixture();
  const result = await sourceProductInventory(tx, { from: "2026-10-20", to: "2026-10-21" }, [
    { canonicalName: "두줄무릎보호대" }, { canonicalName: "두줄보호대 2개입" }
  ], rules, "v");
  assert.equal(result.products.length, 1);
  assert.deepEqual(result.products[0], { key: JSON.stringify(["COUPANG", "LEGACY_COUPANG_SINGLE_UPLOAD", "두줄보호대 2개입"]),
    group: "COUPANG", platform: "COUPANG", scopeKey: "LEGACY_COUPANG_SINGLE_UPLOAD", sourceName: "두줄보호대 2개입",
    nameField: "native:COUPANG", firstDate: "2026-10-20", lastDate: "2026-10-21", publishedName: "두줄보호대 2개입",
    targetName: "두줄무릎보호대", matchStatus: "MATCHED", pending: true, ruleIds: ["link"] });
  assert.ok(calls[0].where.OR.some((scope: any) => scope.platform === "COUPANG" && scope.scopeKey === "LEGACY_COUPANG_SINGLE_UPLOAD"));
  assert.deepEqual(calls[1].where, { runId: { in: ["new", "old"] }, component: "NATIVE_RESULT" });
});
test("invalid and overlong inventory ranges fail before source data reads", async () => {
  for (const dates of [{ from: "2026-10-22", to: "2026-10-20" }, { from: "2026-01-01", to: "2026-10-21" }]) {
    const { tx, calls } = fixture(); await assert.rejects(sourceProductInventory(tx, dates, [], [], "v")); assert.equal(calls.length, 0);
  }
});
