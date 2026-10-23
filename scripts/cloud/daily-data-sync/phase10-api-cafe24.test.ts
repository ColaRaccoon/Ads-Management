// Synthetic provider observations; no account, network or database access.
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { cafe24Chunk, type Cafe24ChunkState } from "../../../apps/api/src/daily-sync/cafe24-scheduled-chunk";
import { ProviderFailure } from "../../../apps/api/src/daily-sync/bounded-request";

process.env.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES = JSON.stringify(["N00", "N20"]);
const now = Date.parse("2026-10-19T01:00:00.000Z");
const order = () => ({ order_id: "SYNTHETIC-PRIVATE-ORDER", shop_no: 1,
  order_date: "2026-10-18T12:00:00+09:00", payment_amount: "100", currency: "KRW",
  order_status: "N00", payment_method: ["card"] });
const item = () => ({ order_item_code: "SYNTHETIC-PRIVATE-LINE", product_no: "1",
  product_name: "Synthetic product", option_value: "Synthetic option", quantity: "1",
  product_price: "100", order_status: "N20" });
const state = (): Cafe24ChunkState => ({ version: 1, connectionId: "phase10-synthetic", day: "2026-10-18",
  startedAt: new Date(now).toISOString(), stage: "ITEMS_FIRST", count: 1, pages: 1,
  first: [order()], second: [], items: [], cursor: 0, verifiedItems: 0 });
function input(saved: Cafe24ChunkState | null, row = order(), line = item()) {
  return { connectionId: "phase10-synthetic", mallId: "didadi0729", shopKey: "shop1", day: "2026-10-18",
    deadlineAt: now + 55_000, now: () => now, state: saved, count: async () => 1,
    listing: async () => [row], items: async () => [line], wait: async () => {} };
}
const rejects = (code: string) => (error: unknown) => {
  assert(error instanceof ProviderFailure);
  assert.equal(error.safeCode, "FIELD_UNSUPPORTED");
  assert.equal(error.retryable, false);
  assert.equal(error.diagnosticCode, code);
  assert.equal(JSON.stringify(error).includes("SYNTHETIC-PRIVATE"), false);
  return true;
};
test("unapproved item status records only its fixed diagnostic and leaves checkpoint untouched", async () => {
  const saved = state(), before = JSON.stringify(saved);
  await assert.rejects(cafe24Chunk(input(saved, order(), { ...item(), order_status: "N10" })), rejects("CAFE24_STATUS_APPROVAL_MISMATCH"));
  assert.equal(JSON.stringify(saved), before);
});
test("unapproved listing order status records the same fixed diagnostic before checkpoint mutation", async () => {
  await assert.rejects(cafe24Chunk(input(null, { ...order(), order_status: "N10" })), rejects("CAFE24_STATUS_APPROVAL_MISMATCH"));
});
test("future provider timestamp in item continuation is separate from status mismatch", async () => {
  const saved = state(); saved.first[0].updated_date = "2026-10-19T01:00:01.000Z";
  await assert.rejects(cafe24Chunk(input(saved)), rejects("CAFE24_PROVIDER_TIME_FUTURE"));
});
test("future provider timestamp in listing reports only the fixed time diagnostic", async () => {
  await assert.rejects(cafe24Chunk(input(null, { ...order(), updated_date: "2026-10-19T01:00:01.000Z" } as any)), rejects("CAFE24_PROVIDER_TIME_FUTURE"));
});
test("explicitly approved N20 remains the original provider status and exact amounts are preserved", async () => {
  const result = await cafe24Chunk(input(state()));
  assert.equal(result.state.stage, "LIST_VERIFY");
  assert.equal((result.state.items[0][0] as any).order_status, "N20");
  assert.equal((result.state.items[0][0] as any).product_price, "100");
  assert.equal(result.snapshot, null);
});
