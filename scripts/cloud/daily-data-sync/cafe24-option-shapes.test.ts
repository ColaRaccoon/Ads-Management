import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { Cafe24OrdersClient } from "../../../apps/api/src/daily-sync/cafe24-orders.client";

process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
process.env.DAILY_SYNC_ALLOWED_ACCOUNTS = JSON.stringify(["CAFE24/didadi0729/shop1"]);
const day = "2026-11-07";
const connection = { provider: "CAFE24", externalAccountId: "didadi0729", shopKey: "shop1",
  currencyCode: "KRW", timeZone: "Asia/Seoul" };
const order = (i: number) => ({ order_id: `PRIVATE_ORDER_${i}`, shop_no: 1,
  order_date: `${day}T12:00:00+09:00`, currency: "KRW" });
const line = (value: unknown, i = 0) => ({ order_item_code: `PRIVATE_LINE_${i}`, option_value: value });
function fixture(orders: unknown[], items: unknown[], scope = connection) {
  const calls: URL[] = [];
  let credentialReads = 0, connectionReads = 0;
  const client = new Cafe24OrdersClient({ sourceConnection: { findUnique: async () => {
    connectionReads++; return scope;
  } } } as any, { accessToken: async () => { credentialReads++; return "PRIVATE_ACCESS"; } } as any,
  async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input)); calls.push(url);
    return Response.json(url.pathname.endsWith("/items") ? { items } : { orders });
  });
  return { client, calls, counts: () => ({ credentialReads, connectionReads }) };
}

test("classifies every rejected option shape without returning provider identifiers or values", async () => {
  const items = [
    { order_item_code: "PRIVATE_ABSENT" }, line(null, 1), line("", 2), line("  ", 3),
    line(" PRIVATE_PADDED", 4), line("PRIVATE\nCONTROL", 5), line("X".repeat(257), 6),
    line({ private: "PRIVATE_OBJECT" }, 7), line("PRIVATE_VALID", 8)
  ];
  const f = fixture([order(1)], items);
  const result = await f.client.probeOptionShapes("connection", day);
  assert.deepEqual(result.shapes, { absent: 1, null: 1, empty: 1, whitespaceOnly: 1, padded: 1,
    controlCharacters: 1, overLimit: 1, unsupportedType: 1, valid: 1 });
  assert.equal(result.itemCount, 9);
  assert.equal(result.nextOffset, null);
  assert.equal(result.snapshotComplete, false);
  assert.equal(result.canonicalMappingVerified, false);
  assert(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].searchParams.get("fields"), "order_item_code,option_value");
});

test("a full bounded page returns the next offset and reads at most ten orders", async () => {
  const f = fixture(Array.from({length: 10}, (_, i) => order(i)), [line("S")]);
  const result = await f.client.probeOptionShapes("connection", day, "120");
  assert.equal(result.nextOffset, 130);
  assert.equal(result.orderCount, 10);
  assert.equal(f.calls.length, 11);
  assert.equal(f.calls[0].searchParams.get("limit"), "10");
  assert.equal(f.calls[0].searchParams.get("offset"), "120");
  assert.equal(f.calls[0].searchParams.get("date_type"), "order_date");
});

test("invalid offsets are rejected before database or credential access", async () => {
  for (const offset of ["-1", "01", "1.5", "10000", "x", ""]) {
    const f = fixture([], []);
    await assert.rejects(f.client.probeOptionShapes("connection", day, offset));
    assert.deepEqual(f.counts(), { credentialReads: 0, connectionReads: 0 });
    assert.equal(f.calls.length, 0);
  }
});

test("foreign account scope is rejected before credentials and provider access", async () => {
  const f = fixture([], [], {...connection, externalAccountId: "unapproved"});
  await assert.rejects(f.client.probeOptionShapes("connection", day));
  assert.equal(f.counts().credentialReads, 0);
  assert.equal(f.calls.length, 0);
});

test("truncated, duplicated or foreign observations never yield usable diagnostics", async () => {
  for (const [orders, items] of [
    [Array.from({length: 11}, (_, i) => order(i)), [line("S")]],
    [[order(1), order(1)], [line("S")]],
    [[{...order(1), shop_no: 2}], [line("S")]],
    [[{...order(1), order_date: "2026-11-06T12:00:00+09:00"}], [line("S")]],
    [[order(1)], []], [[order(1)], [line("S"), line("S")]],
    [[order(1)], Array.from({length: 100}, (_, i) => line("S", i))]
  ]) {
    const f = fixture(orders, items);
    await assert.rejects(f.client.probeOptionShapes("connection", day));
  }
});
