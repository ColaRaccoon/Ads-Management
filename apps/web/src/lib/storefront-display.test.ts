import test from "node:test";
import assert from "node:assert/strict";
import { storefrontDecimal, storefrontError, storefrontLabel, storefrontMoney, storefrontToday, STOREFRONT_QUERY_OPTIONS } from "./storefront-display";

test("decimal display preserves micros and integers above the JavaScript safe range", () => {
  assert.equal(storefrontDecimal("900719925474099312345.000001"), "900,719,925,474,099,312,345.000001");
  assert.equal(storefrontMoney("0.000001", "KRW"), "0.000001 원");
  assert.equal(storefrontMoney("10673.070000", "USD"), "10,673.07 USD");
  assert.equal(storefrontMoney("-15.20"), "-15.2 원");
});

test("a collected zero is visibly different from missing, partial, stale, and disconnected", () => {
  assert.equal(storefrontMoney("0"), "0 원");
  assert.equal(storefrontMoney(null), "—");
  assert.equal(storefrontDecimal("NaN"), "—");
  assert.equal(new Set(["COMPLETE_ZERO", "MISSING", "PARTIAL", "STALE", "NOT_CONNECTED"].map(storefrontLabel)).size, 5);
});

test("source conflict explains the failed action rather than implying upload success", () => {
  assert.match(storefrontError({ code: "SOURCE_SELECTION_REQUIRED" }), /CSV.*원천 선택/);
  assert.equal(storefrontError({ code: "UNKNOWN_CODE", message: "sensitive provider payload" }), "처리하지 못했습니다. 상태를 다시 확인하세요.");
});

test("the storefront never starts recurring, background, focus, or reconnect reads", () => {
  assert.equal(STOREFRONT_QUERY_OPTIONS.refetchInterval, false);
  assert.equal(STOREFRONT_QUERY_OPTIONS.refetchIntervalInBackground, false);
  assert.equal(STOREFRONT_QUERY_OPTIONS.refetchOnWindowFocus, false);
  assert.equal(STOREFRONT_QUERY_OPTIONS.refetchOnReconnect, false);
  assert.equal(STOREFRONT_QUERY_OPTIONS.retry, false);
  assert.equal(STOREFRONT_QUERY_OPTIONS.refetchOnMount, "always");
});

test("manual-day boundary uses account-local date and invalid time zones fail closed", () => {
  const instant = new Date("2026-10-18T18:00:00Z");
  assert.equal(storefrontToday("Asia/Seoul", instant), "2026-10-19");
  assert.equal(storefrontToday("America/Los_Angeles", instant), "2026-10-18");
  assert.equal(storefrontToday("invalid-zone", instant), null);
});
