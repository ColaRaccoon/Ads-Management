import test from "node:test";
import assert from "node:assert/strict";
import { SourceDataKind } from "@prisma/client";
import { validatedMetaApiDays, validatedMetaApiDaysBatch } from "../../../apps/api/src/common/meta-source-read-coverage";
const from = new Date("2026-10-13Z"), to = new Date("2026-10-14Z"), id = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const calls: any[] = [];
  const client = { $queryRaw: async (sql: any) => { calls.push(sql); return [
    { dataKind: SourceDataKind.META_AD, connectionId: id, metricDate: from },
    { dataKind: SourceDataKind.META_ADSET, connectionId: id, metricDate: to }
  ]; } };
  return { client: client as any, calls };
}
test("batch kind tags keep ad and adset days separate in a single SQL call", async () => {
  const f = fixture(), result = await validatedMetaApiDaysBatch(f.client, ["META_AD", "META_ADSET"], [id], from, to);
  assert.deepEqual(result.get("META_AD"), new Set([`${id}:${from.getTime()}`]));
  assert.deepEqual(result.get("META_ADSET"), new Set([`${id}:${to.getTime()}`])); assert.equal(f.calls.length, 1);
});
test("duplicate kinds and account IDs do not repeat a proof or broaden its scope", async () => {
  const base = fixture(), dup = fixture();
  assert.deepEqual(await validatedMetaApiDaysBatch(base.client, ["META_AD", "META_ADSET"], [id], from, to),
    await validatedMetaApiDaysBatch(dup.client, ["META_AD", "META_ADSET", "META_AD"], [id, id], from, to));
  assert.deepEqual(dup.calls[0].strings, base.calls[0].strings); assert.deepEqual(dup.calls[0].values, base.calls[0].values);
});
test("empty kinds or accounts need no SQL and preserve explicitly requested empty sets", async () => {
  const f = fixture(); assert.deepEqual(await validatedMetaApiDaysBatch(f.client, [], [id], from, to), new Map());
  assert.deepEqual(await validatedMetaApiDaysBatch(f.client, ["META_AD", "META_ADSET"], [], from, to), new Map([["META_AD", new Set()], ["META_ADSET", new Set()]]));
  assert.equal(f.calls.length, 0);
});
for (const invalid of ["CAFE24_ORDER", "GOOGLE_CAMPAIGN", "META_WRONG"] as const) test(`unsupported kind ${invalid} fails before SQL even with no accounts`, async () => {
  const f = fixture(); await assert.rejects(validatedMetaApiDaysBatch(f.client, [invalid as any], [], from, to), (e: any) => e.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
  assert.equal(f.calls.length, 0);
});
test("standalone caller keeps exactly the requested kind", async () => {
  const f = fixture(); assert.deepEqual(await validatedMetaApiDays(f.client, "META_AD", [id], from, to), new Set([`${id}:${from.getTime()}`])); assert.equal(f.calls.length, 1);
});
