import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { HttpException } from "@nestjs/common";
import { assertCafe24SellerOptionsEvidence, assertCafe24OptionProjectionDayEvidence,
  assertCafe24AppVersionEvidence, assertCafe24RawAllItemsV1Evidence } from "../../../apps/api/src/daily-sync/sync-contract";
import { Cafe24OrdersClient } from "../../../apps/api/src/daily-sync/cafe24-orders.client";
import { normalizeCafe24Order } from "../../../apps/api/src/daily-sync/cafe24-order-adapter";
import { ProviderFailure } from "../../../apps/api/src/daily-sync/bounded-request";

const now = new Date("2027-11-01T02:00:00+09:00");
const confirmed = (): NodeJS.ProcessEnv => ({
  DAILY_SYNC_CAFE24_SELLER_DROPDOWN: "true",
  DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT: "2026-10-01"
});
const unsupported = (error: unknown) => error instanceof HttpException &&
  (error.getResponse() as {code: string}).code === "FIELD_UNSUPPORTED";

test("an unchanged confirmed dropdown remains valid beyond 30 days and one year", () => {
  for (const date of ["2026-10-31", "2026-11-01", "2027-11-01"])
    assert.doesNotThrow(() => assertCafe24SellerOptionsEvidence(confirmed(), new Date(`${date}T00:00:00+09:00`)));
  assert.doesNotThrow(() => assertCafe24OptionProjectionDayEvidence("2027-10-31", confirmed(), now));
});

test("an explicit option-setting change blocks reads until reconfirmed", () => {
  const env = {...confirmed(), DAILY_SYNC_CAFE24_SELLER_DROPDOWN_REVIEW_REQUIRED: "true"};
  assert.throws(() => assertCafe24SellerOptionsEvidence(env, now), unsupported);
  env.DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT = "2027-11-01";
  assert.throws(() => assertCafe24SellerOptionsEvidence(env, now), unsupported);
  env.DAILY_SYNC_CAFE24_SELLER_DROPDOWN_REVIEW_REQUIRED = "false";
  assert.doesNotThrow(() => assertCafe24SellerOptionsEvidence(env, now));
});

test("missing, revoked, invalid or future confirmations never become approved", () => {
  for (const patch of [
    {DAILY_SYNC_CAFE24_SELLER_DROPDOWN: undefined},
    {DAILY_SYNC_CAFE24_SELLER_DROPDOWN: "false"},
    {DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT: undefined},
    {DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT: "2026-02-30"},
    {DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT: "2027-11-02"},
    {DAILY_SYNC_CAFE24_SELLER_DROPDOWN_REVIEW_REQUIRED: "invalid"}
  ]) assert.throws(() => assertCafe24SellerOptionsEvidence({...confirmed(), ...patch}, now), unsupported);
  assert.throws(() => assertCafe24OptionProjectionDayEvidence("2027-11-01", confirmed(), now), unsupported);
});

test("other provider-version and all-items review lifetimes keep their existing rules", () => {
  assert.throws(() => assertCafe24AppVersionEvidence({
    DAILY_SYNC_CAFE24_APP_API_VERSION: "2026-09-01",
    DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT: "2026-10-01"
  }, now));
  assert.throws(() => assertCafe24RawAllItemsV1Evidence("2027-10-31", {
    DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED: "true",
    DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT: "2026-10-01"
  }, now), unsupported);
});

test("manual and scheduled paths stop on changed options before DB or credentials", async () => {
  const keys = ["DAILY_SYNC_FEATURE_ENABLED", "DAILY_SYNC_CAFE24_APP_API_VERSION",
    "DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT", ...Object.keys(confirmed()),
    "DAILY_SYNC_CAFE24_SELLER_DROPDOWN_REVIEW_REQUIRED"];
  const saved = keys.map(key => [key, process.env[key]] as const);
  try {
    Object.assign(process.env, confirmed(), {DAILY_SYNC_FEATURE_ENABLED: "true",
      DAILY_SYNC_CAFE24_APP_API_VERSION: "2026-09-01",
      DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date()), DAILY_SYNC_CAFE24_SELLER_DROPDOWN_REVIEW_REQUIRED: "true"});
    let reads = 0;
    const unexpected = async () => { reads++; throw Error("UNEXPECTED_PROVIDER_ACCESS"); };
    const client = new Cafe24OrdersClient({sourceConnection: {findUnique: unexpected}} as any,
      {accessToken: unexpected} as any);
    const rejected = (error: unknown) => unsupported(error) &&
      (error as {diagnosticCode?: string}).diagnosticCode === "CAFE24_EVIDENCE_SELLER_OPTIONS";
    await assert.rejects(client.fetchDaySnapshot("synthetic", "2026-10-31"), rejected);
    await assert.rejects(client.fetchScheduledChunk("synthetic", "2026-10-31", Date.now()+55_000, null), rejected);
    assert.equal(reads, 0);
  } finally {
    for (const [key,value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("real option-value validation still rejects malformed provider data", () => {
  const order = {order_id: "SYNTHETIC_ORDER", shop_no: 1, order_date: "2026-10-31T10:00:00+09:00",
    payment_amount: "100", currency: "KRW", payment_method: ["card"]};
  const item = {order_item_code: "SYNTHETIC_LINE", product_no: "1", product_name: "Synthetic",
    option_value: "S", quantity: 1, product_price: "100", order_status: "N00"};
  const options = {verifiedSellerDropdown: true, csvOptionEvidence: {mallId: "didadi0729", shopKey: "shop1"}};
  assert.equal(normalizeCafe24Order(order, [item], options)[0].optionName, "Synthetic(S)");
  for (const value of [null, undefined, " ", " S", "S\u0000", "S".repeat(1025)])
    assert.throws(() => normalizeCafe24Order(order, [{...item, option_value: value}], options),
      (error: unknown) => error instanceof ProviderFailure && error.safeCode === "FIELD_UNSUPPORTED" &&
        error.diagnosticCode === "CAFE24_FIELD_OPTION_VALUE");
});
