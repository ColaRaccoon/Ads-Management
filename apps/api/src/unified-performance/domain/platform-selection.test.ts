import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlatforms, platformSelection, selectedAmount, selectedCoverage } from "./platform-selection";
import { allocateMoney, decimal, money, microsToAmount, quantizeMoney } from "./decimal";
import type { AmountQuality } from "../types";

test("omitted/all-off and normalized selection retain distinct cache identity", () => {
  assert.equal(normalizePlatforms().length, 5);
  assert.deepEqual(normalizePlatforms('["CAFE24","META","META"]'), ["META", "CAFE24"]);
  assert.deepEqual(normalizePlatforms("[]"), []);
  assert.throws(() => normalizePlatforms("NAVER"));
  assert.throws(() => normalizePlatforms(["UNKNOWN"]));
  assert.throws(() => normalizePlatforms(null));
  assert.notEqual(platformSelection().platformSelectionHash, platformSelection([]).platformSelectionHash);
  assert.equal(platformSelection(["META"]).metricAvailability.revenue, false);
  assert.equal(platformSelection(["META"]).metricAvailability.estimatedProfit, false);
  assert.equal(platformSelection(["CAFE24"]).metricAvailability.state, "SALE_ONLY");
  assert.equal(platformSelection([]).metricAvailability.adSpend, false);
});
test("excluded gaps disappear; Naver estimated confidence permits complete numbers and confirmed zero survives", () => {
  const amount = (value: string | null, estimated = false): AmountQuality => ({ knownAmount: value, completeAmount: value,
    knownComponentCount: value === null ? 0 : 1, expectedComponentCount: 1, isEstimate: estimated,
    confidence: estimated ? "ESTIMATED" : "SOURCE_REPORTED", issues: value === null ? ["NOT_COLLECTED"] : [] });
  const rows = [{ platform: "CAFE24" as const, amount: amount("0") }, { platform: "NAVER" as const, amount: amount(null) }];
  assert.equal(selectedAmount(rows, ["CAFE24"]).completeAmount, "0.000000");
  assert.deepEqual(selectedAmount(rows, ["CAFE24"]).issues, []);
  assert.equal(selectedAmount(rows, ["CAFE24", "NAVER"]).completeAmount, null);
  rows[1].amount = amount("123", true);
  assert.equal(selectedAmount(rows, ["CAFE24", "NAVER"]).completeAmount, "123.000000");
  assert.equal(selectedAmount(rows, []).knownAmount, null);
  assert.equal(selectedAmount(rows, ["NAVER"]).confidence, "ESTIMATED");
  assert.equal(selectedAmount(rows.slice(0, 1), ["CAFE24", "NAVER"]).completeAmount, null);
  assert.equal(selectedCoverage([], ["CAFE24"]).excludedByUser.find(s => s.platform === "NAVER")?.participation, "EXCLUDED_BY_USER");
});
test("decimal boundaries, micros and precision avoid JS Number round trips", () => {
  assert.equal(microsToAmount("9007199254740993"), "9007199254.740993");
  assert.equal(quantizeMoney(decimal("-0.0000005")), "-0.000001");
  assert.throws(() => money("1000000000000000000000000"));
  assert.throws(() => money("0.0000001"));
  assert.throws(() => decimal(1));
  assert.throws(() => decimal("1e3"));
});
test("deterministic allocation conserves negative corrections, zero-denominator and source-rounding residuals", () => {
  const targets = [{ key: "B", weight: "0.5" }, { key: "A", weight: "0.5" }];
  assert.deepEqual(allocateMoney("-1", targets, 0), { assigned: [{ key: "A", amount: "-1" }, { key: "B", amount: "0" }], unallocated: "0.000000" });
  assert.equal(allocateMoney("1.25", targets, 0).unallocated, "0.250000");
  assert.deepEqual(allocateMoney("20", [{ key: "A", weight: "0" }]).assigned, []);
  assert.throws(() => allocateMoney("10", [{ key: "A", weight: "0.9" }]));
  assert.throws(() => allocateMoney("10", [{ key: "A", weight: "1" }, { key: "A", weight: "0" }]));
});
