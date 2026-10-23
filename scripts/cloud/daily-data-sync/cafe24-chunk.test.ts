import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { cafe24Chunk, Cafe24ChunkState } from "../../../apps/api/src/daily-sync/cafe24-scheduled-chunk";
process.env.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES = JSON.stringify(["N10"]);

const order = (index: number) => ({ order_id: `TEST-${index}`, shop_no: 1, order_date: "2026-10-11T12:00:00+09:00",
  payment_amount: "100", currency: "KRW", payment_method: ["card"], customer_name: "SHOULD_NEVER_PERSIST",
  actual_order_amount: { order_price_amount: "100", payment_amount: "100", shipping_fee: "0", address: "SHOULD_NEVER_PERSIST" } });
const item = (id: string) => ({ order_item_code: `${id}-item`, product_no: "1", product_name: "test product",
  option_value: "test option", quantity: "1", product_price: "100", order_status: "N10", phone: "SHOULD_NEVER_PERSIST" });
async function collect(count: number, mutate?: (stage: string, row: any) => any) {
  let state: Cafe24ChunkState | null = null, calls = 0, itemCalls = 0, last: any;
  while (calls++ < 100) {
    last = await cafe24Chunk({ connectionId: "connection", mallId: "didadi0729", shopKey: "shop1", day: "2026-10-11",
      state, deadlineAt: Date.now() + 55_000, wait: async () => {}, count: async () => count,
      listing: async (offset) => Array.from({ length: Math.min(100, count - offset) }, (_, index) => order(offset + index)),
      items: async (id) => { itemCalls++; const row = item(id); return [mutate ? mutate(state?.stage ?? "", row) : row]; } });
    // Simulate process loss and restoration from a serialized protected checkpoint.
    state = JSON.parse(JSON.stringify(last.state));
    assert.equal(JSON.stringify(state).includes("SHOULD_NEVER_PERSIST"), false);
    if (last.snapshot) return { last, calls, itemCalls };
  }
  throw new Error("bounded chunk test did not finish");
}
test("42-order day crosses process boundaries, checks every sibling twice, then publishes complete snapshot", async () => {
  const result = await collect(42);
  assert.equal(result.itemCalls, 84); assert.equal(result.calls, 8);
  assert.equal(result.last.snapshot.orders.length, 42); assert.equal(result.last.snapshot.orderCount, 42);
  assert.equal(result.last.snapshot.orders.every((line: any) => line.providerUpdatedAt === null), true);
});
test("complete zero day requires both listings and then succeeds with explicit zero", async () => {
  const result = await collect(0); assert.equal(result.last.snapshot.orders.length, 0);
  assert.equal(result.itemCalls, 0); assert.equal(result.calls, 4);
});
test("422 synthetic orders finish in 54 continuations rather than repeat entire day", async () => {
  const result = await collect(422); assert.equal(result.itemCalls, 844); assert.equal(result.calls, 54);
  assert.equal(result.last.snapshot.orders.length, 422);
});
test("same-size item replacement across restart fails complete-day verification", async () => {
  await assert.rejects(collect(2, (stage, row) => stage === "ITEMS_VERIFY" ? { ...row, quantity: "2" } : row),
    (error: any) => error.safeCode === "RECONCILIATION_FAILED");
});
test("foreign connection/day checkpoint and incomplete first list fail before item requests", async () => {
  let requests = 0;
  const state: any = { version: 1, connectionId: "foreign", day: "2026-10-11", stage: "LIST_FIRST", count: 1, first: [], second: [], items: [], cursor: 0, verifiedItems: 0 };
  const input: any = { connectionId: "connection", mallId: "didadi0729", shopKey: "shop1", day: "2026-10-11", deadlineAt: Date.now() + 55_000,
    state, count: async () => 1, listing: async () => [], items: async () => { requests++; return []; } };
  await assert.rejects(cafe24Chunk(input)); state.connectionId = "connection";
  await assert.rejects(cafe24Chunk(input)); assert.equal(requests, 0);
});
