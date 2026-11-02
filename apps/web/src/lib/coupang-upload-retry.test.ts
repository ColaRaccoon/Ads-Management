import assert from "node:assert/strict";
import test from "node:test";
import { retryCoupangUpload } from "./coupang-upload-retry";

test("a lost proxy response retries once and returns the server's deduplicated result", async () => {
  let calls = 0, waits = 0;
  const result = await retryCoupangUpload(async () => {
    if (++calls === 1) throw { status: 500, code: null };
    return { batchId: "already-committed", duplicate: true };
  }, async () => { waits++; });
  assert.deepEqual(result, { batchId: "already-committed", duplicate: true });
  assert.equal(calls, 2);
  assert.equal(waits, 1);
});

test("network and explicitly retryable rolled-back imports may retry", async () => {
  for (const failure of [new TypeError("Failed to fetch"), {status:502}, {status:504},
    {status:503,code:"COUPANG_IMPORT_RETRYABLE_FAILURE"}]) {
    let calls = 0;
    assert.equal(await retryCoupangUpload(async () => { if (++calls === 1) throw failure; return "ok"; }, async()=>{}), "ok");
    assert.equal(calls, 2);
  }
});

test("validation, authentication, busy reservations and real internal errors are not retried", async () => {
  for (const failure of [{status:400}, {status:401}, {status:403}, {status:413},
    {status:409,code:"COUPANG_UPLOAD_IN_PROGRESS"}, {status:503,code:"HEAVY_OPERATION_BUSY"},
    {status:500,code:"INTERNAL_SERVER_ERROR"}]) {
    let calls = 0;
    await assert.rejects(retryCoupangUpload(async () => { calls++; throw failure; }, async()=>{}), error=>error===failure);
    assert.equal(calls, 1);
  }
});

test("a repeated proxy failure is surfaced after one retry", async () => {
  let calls = 0;
  const failure = {status:500,code:null};
  await assert.rejects(retryCoupangUpload(async () => { calls++; throw failure; }, async()=>{}), error=>error===failure);
  assert.equal(calls, 2);
});
