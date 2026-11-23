import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import {HttpException} from "@nestjs/common";
import {assertCafe24AppVersionEvidence} from "../../../apps/api/src/daily-sync/sync-contract";
import {Cafe24OrdersClient} from "../../../apps/api/src/daily-sync/cafe24-orders.client";

const confirmation = () => ({
  DAILY_SYNC_CAFE24_APP_API_VERSION: "2026-09-01",
  DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT: "2026-10-24"
});
const unverified = (error: unknown) => error instanceof HttpException &&
  (error.getResponse() as {code: string}).code === "PROVIDER_VERSION_UNVERIFIED";

test("confirmed app version remains valid after 30 days and one year", () => {
  for (const date of ["2026-11-23", "2026-11-24", "2027-11-24"])
    assert.doesNotThrow(() => assertCafe24AppVersionEvidence(confirmation(), new Date(`${date}T02:00:00+09:00`)));
});

test("unknown, malformed, future and explicitly revoked version evidence is rejected", () => {
  for (const patch of [
    {DAILY_SYNC_CAFE24_APP_API_VERSION: undefined},
    {DAILY_SYNC_CAFE24_APP_API_VERSION: "2026-12-01"},
    {DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT: undefined},
    {DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT: "2026-02-30"},
    {DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT: "2026-11-25"},
    {DAILY_SYNC_CAFE24_APP_API_VERSION_REVIEW_REQUIRED: "invalid"}
  ]) assert.throws(() => assertCafe24AppVersionEvidence({...confirmation(), ...patch}, new Date("2026-11-24T02:00:00+09:00")), unverified);
  const changed = {...confirmation(), DAILY_SYNC_CAFE24_APP_API_VERSION_REVIEW_REQUIRED: "true"};
  changed.DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT = "2026-11-24";
  assert.throws(() => assertCafe24AppVersionEvidence(changed, new Date("2026-11-24T02:00:00+09:00")), unverified);
  changed.DAILY_SYNC_CAFE24_APP_API_VERSION_REVIEW_REQUIRED = "false";
  assert.doesNotThrow(() => assertCafe24AppVersionEvidence(changed, new Date("2026-11-24T02:00:00+09:00")));
});

test("manual and scheduled callers accept old confirmation and enforce explicit revocation before provider access", async () => {
  const configured = {...confirmation(), DAILY_SYNC_FEATURE_ENABLED: "true",
    DAILY_SYNC_CAFE24_SELLER_DROPDOWN: "true", DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT: "2026-10-24",
    DAILY_SYNC_CAFE24_APP_API_VERSION_REVIEW_REQUIRED: "false"};
  const previous = Object.keys(configured).map(key => [key, process.env[key]] as const);
  let reads = 0;
  const reachedDatabase = Error("SYNTHETIC_DATABASE_BOUNDARY");
  const read = async () => { reads++; throw reachedDatabase; };
  const client = new Cafe24OrdersClient({sourceConnection: {findUnique: read}} as any, {accessToken: read} as any);
  try {
    Object.assign(process.env, configured);
    await assert.rejects(client.fetchDaySnapshot("synthetic", "2026-11-23"), error => error === reachedDatabase);
    await assert.rejects(client.fetchScheduledChunk("synthetic", "2026-11-23", Date.now()+55_000, null), error => error === reachedDatabase);
    assert.equal(reads, 2);
    process.env.DAILY_SYNC_CAFE24_APP_API_VERSION_REVIEW_REQUIRED = "true";
    await assert.rejects(client.fetchDaySnapshot("synthetic", "2026-11-23"), unverified);
    await assert.rejects(client.fetchScheduledChunk("synthetic", "2026-11-23", Date.now()+55_000, null), unverified);
    assert.equal(reads, 2);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
