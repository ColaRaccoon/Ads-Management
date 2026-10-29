import test from "node:test";
import assert from "node:assert/strict";
import { ExactDecimal as D } from "./decimal";
import { calculateRelationships, type RelationshipDay } from "./relationship-calculation";

const at = (index: number) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
const data = (count = 100): RelationshipDay[] => Array.from({ length: count }, (_, index) => ({
  date: at(index), adSpend: String(index * index % 97 + 1), otherAdSpend: String(index + 10),
  revenue: String((index * index % 97 + 1) * 3 + 15), profitBeforeAds: String((index * index % 97 + 1) * 2 - 180),
  isEstimate: false, issues: []
}));
const options = { from: at(14), to: at(99) };

test("known raw daily relationship is exact for revenue and signed pre-ad profit", () => {
  const result = calculateRelationships(data(), options);
  assert.equal(result.lags.length, 10);
  for (const entry of result.lags.filter(entry => entry.lagDays === 0)) {
    assert.equal(entry.coefficient, "1.0000000000");
    assert.equal(entry.usedDays, 86);
    assert.equal(entry.excludedDays, 0);
    assert.deepEqual(entry.reasons, []);
    assert.ok(new D(entry.volatility.adSpendStdDev!).gt(0));
  }
  assert.equal(result.daily.length, 86);
  assert.equal(result.policy.minimumPairs, 60);
  assert.equal(result.policy.movingAverageUse, "VISUAL_ONLY");
});

test("lag aligns earlier ad spend to later outcome using exact calendar dates, even for shuffled inputs", () => {
  const days = data();
  for (let index = 3; index < days.length; index++) days[index].revenue = new D(days[index - 3].adSpend!).mul(4).plus(17).toFixed(6);
  const result = calculateRelationships([...days].reverse(), options);
  const lag3 = result.lags.find(entry => entry.lagDays === 3 && entry.metric === "revenue")!;
  assert.equal(lag3.coefficient, "1.0000000000");
  assert.equal(lag3.pairs[0].adDate, at(11));
  assert.equal(lag3.pairs[0].outcomeDate, at(14));
  assert.equal(lag3.pairs[0].adSpend, days[11].adSpend);
  assert.equal(lag3.pairs.at(-1)!.outcomeDate, options.to);
  assert.notEqual(result.lags.find(entry => entry.lagDays === 0 && entry.metric === "revenue")!.coefficient, "1.0000000000");
});

test("missing ad day is not replaced with zero nor adjacent row when pairing a lag", () => {
  const days = data().filter(day => day.date !== at(11));
  const result = calculateRelationships(days, options);
  const lag3 = result.lags.find(entry => entry.lagDays === 3 && entry.metric === "revenue")!;
  assert.equal(lag3.usedDays, 85);
  assert.deepEqual(lag3.excludedDates, [{ outcomeDate: at(14), adDate: at(11), reasons: ["MISSING_AD_SPEND"] }]);
  assert.equal(lag3.pairs[0].adDate, at(12));
  assert.equal(result.daily[0].movingAverage7.adSpend, null);
});

test("revenue remains usable when pre-ad profit is unknown; partial outcomes never count as zero", () => {
  const days = data();
  days[30].profitBeforeAds = null;
  const result = calculateRelationships(days, options);
  assert.equal(result.lags[0].usedDays, 86);
  assert.equal(result.lags[1].usedDays, 85);
  assert.deepEqual(result.lags[1].excludedDates[0].reasons, ["MISSING_OUTCOME"]);
});

test("display threshold uses 60 actual daily pairs and does not suppress scatter", () => {
  const days = data();
  const short = calculateRelationships(days, { from: at(14), to: at(72) });
  assert.equal(short.lags[0].usedDays, 59);
  assert.equal(short.lags[0].coefficient, null);
  assert.deepEqual(short.lags[0].reasons, ["INSUFFICIENT_PAIRS"]);
  assert.equal(short.lags[0].pairs.length, 59);
  const enough = calculateRelationships(days, { from: at(14), to: at(73) });
  assert.equal(enough.lags[0].coefficient, "1.0000000000");
});

test("constant inputs hide coefficients and explain each zero-variance series", () => {
  const days = data().map(day => ({ ...day, adSpend: "0", revenue: "10" }));
  const result = calculateRelationships(days, options);
  assert.equal(result.lags[0].coefficient, null);
  assert.deepEqual(result.lags[0].reasons, ["CONSTANT_AD_SPEND", "CONSTANT_OUTCOME"]);
  assert.equal(result.lags[0].volatility.adSpendStdDev, "0.0000000000");
});

test("more than 20 percent missing hides coefficient even with at least 60 usable pairs", () => {
  const days = data(114);
  for (let index = 14; index < 35; index++) days[index].adSpend = null;
  const result = calculateRelationships(days, { from: at(14), to: at(113) });
  assert.equal(result.lags[0].usedDays, 79);
  assert.equal(result.lags[0].coefficient, null);
  assert.deepEqual(result.lags[0].reasons, ["EXCESSIVE_MISSING"]);
  days[34].adSpend = "17";
  const boundary = calculateRelationships(days, { from: at(14), to: at(113) });
  assert.equal(boundary.lags[0].usedDays, 80);
  assert.ok(boundary.lags[0].coefficient !== null);
});

test("estimates contribute pairs and retain estimate markers on both endpoints", () => {
  const days = data();
  days[11].isEstimate = true; days[11].issues = ["ESTIMATED"];
  days[15].isEstimate = true;
  const result = calculateRelationships(days, options);
  const lag3 = result.lags.find(entry => entry.lagDays === 3 && entry.metric === "revenue")!;
  assert.equal(lag3.usedDays, 86);
  assert.equal(lag3.isEstimate, true);
  assert.equal(lag3.pairs[0].isEstimate, true);
  assert.deepEqual(lag3.pairs[0].issues, ["ESTIMATED"]);
  assert.equal(lag3.pairs[1].isEstimate, true);
});

test("missing other-media context never removes a valid pair; joint media changes remain contextual", () => {
  const days = data().map(day => ({ ...day, otherAdSpend: day.adSpend }));
  days[14].otherAdSpend = null;
  const result = calculateRelationships(days, options);
  assert.equal(result.lags[0].coefficient, "1.0000000000");
  assert.equal(result.lags[0].pairs[0].otherAdSpend, null);
  assert.equal(result.lags[0].usedDays, 86);
  assert.ok(result.warnings.includes("OTHER_MEDIA_AND_UNRECORDED_EVENTS_MAY_COCHANGE"));
});

test("Decimal centering preserves tiny variation on values beyond Number exact integer range", () => {
  const days = data().map((day, index) => ({ ...day,
    adSpend: new D("900719925474099300000000").plus(new D(index).div(1000000)).toFixed(6),
    revenue: new D("900719925474099300000000").plus(new D(index).mul(3).div(1000000)).toFixed(6) }));
  const result = calculateRelationships(days, options);
  assert.equal(result.lags[0].coefficient, "1.0000000000");
  assert.equal(result.lags[0].pairs[0].adSpend, days[14].adSpend);
  assert.ok(new D(result.lags[0].volatility.adSpendStdDev!).gt(0));
});

test("seven-day moving average requires seven actual consecutive values and does not increase sample count", () => {
  const days = data();
  const result = calculateRelationships(days, { from: at(3), to: at(65) });
  assert.equal(result.daily[0].movingAverage7.adSpend, null);
  const expected = days.slice(0, 7).reduce((sum, day) => sum.plus(day.adSpend!), new D(0)).div(7).toFixed(6);
  assert.equal(result.daily[3].movingAverage7.adSpend, expected);
  assert.equal(result.lags[0].usedDays, 63);
});

test("before/after windows use change date only in after window and preserve available counts", () => {
  const days = data(100).map((day, index) => ({ ...day, adSpend: index < 50 ? "10" : "20", revenue: index < 50 ? "100" : "130" }));
  const result = calculateRelationships(days, { ...options, changeDate: at(50) });
  for (const row of result.beforeAfter) {
    assert.equal(row.before.to, at(49));
    assert.equal(row.after.from, at(50));
    assert.equal(row.before.metrics.adSpend.usedDays, row.windowDays);
    assert.equal(row.before.metrics.adSpend.mean, "10.0000000000");
    assert.equal(row.after.metrics.adSpend.mean, "20.0000000000");
    assert.equal(row.changes.adSpend.changePct, "100.0000000000");
    assert.equal(row.changes.revenue.changePct, "30.0000000000");
  }
});

test("lookback and post-period data cannot leak into before/after outcomes", () => {
  const days = data();
  const result = calculateRelationships(days, { from: at(14), to: at(40), changeDate: at(16) });
  assert.equal(result.beforeAfter[0].before.metrics.adSpend.usedDays, 2);
  assert.equal(result.beforeAfter[0].before.metrics.adSpend.excludedDays, 5);
  assert.equal(result.beforeAfter[0].before.metrics.adSpend.complete, false);
  assert.equal(result.beforeAfter[0].changes.adSpend.change, null);
  assert.equal(result.beforeAfter[0].changes.adSpend.reason, "INCOMPLETE_WINDOW");
  const nearEnd = calculateRelationships(days, { from: at(14), to: at(40), changeDate: at(39) });
  assert.equal(nearEnd.beforeAfter[0].after.metrics.adSpend.usedDays, 2);
  assert.equal(nearEnd.beforeAfter[0].changes.adSpend.changePct, null);
});

test("missing windows expose partial daily means but no full-window change; nonpositive baseline has no percent", () => {
  const days = data().map(day => ({ ...day, adSpend: "0", profitBeforeAds: "-10" }));
  days[49].revenue = null;
  const result = calculateRelationships(days, { ...options, changeDate: at(50) });
  const row = result.beforeAfter[0];
  assert.equal(row.before.metrics.revenue.usedDays, 6);
  assert.ok(row.before.metrics.revenue.mean !== null);
  assert.equal(row.changes.revenue.reason, "INCOMPLETE_WINDOW");
  assert.equal(row.changes.adSpend.change, "0.0000000000");
  assert.equal(row.changes.adSpend.changePct, null);
  assert.equal(row.changes.adSpend.reason, "ZERO_BASE");
  assert.equal(row.changes.profitBeforeAds.reason, "NON_POSITIVE_BASE");
});

test("tiny before-after means preserve a positive denominator and compute ratios before rounding", () => {
  const days = data().map(day => ({ ...day, adSpend: "0" }));
  days[49].adSpend = "0.000001";
  days[50].adSpend = "0.000002";
  const result = calculateRelationships(days, { ...options, changeDate: at(50) });
  const row = result.beforeAfter[0];
  assert.equal(row.before.metrics.adSpend.mean, "0.0000001429");
  assert.equal(row.after.metrics.adSpend.mean, "0.0000002857");
  assert.equal(row.changes.adSpend.change, "0.0000001429");
  assert.equal(row.changes.adSpend.changePct, "100.0000000000");
  assert.equal(row.changes.adSpend.reason, null);
  assert.notEqual(new D(row.after.metrics.adSpend.mean!).minus(row.before.metrics.adSpend.mean!).div(row.before.metrics.adSpend.mean!).mul(100).toFixed(10), row.changes.adSpend.changePct);
});

test("empty inputs have fully excluded days, no coefficients, no invented zero values", () => {
  const result = calculateRelationships([], { from: at(14), to: at(99) });
  assert.equal(result.lags[0].usedDays, 0);
  assert.equal(result.lags[0].excludedDays, 86);
  assert.equal(result.lags[0].coefficient, null);
  assert.equal(result.daily[0].adSpend, null);
  assert.deepEqual(result.lags[0].excludedDates[0].reasons, ["MISSING_AD_SPEND", "MISSING_OUTCOME"]);
  assert.equal(result.lags[0].volatility.outcomeStdDev, null);
});

test("duplicate dates, bad decimals and out-of-range changes fail instead of silently accepting ambiguous input", () => {
  assert.throws(() => calculateRelationships([...data(), data()[0]], options), /Duplicate/);
  assert.throws(() => calculateRelationships([{ ...data()[0], adSpend: "NaN" }], options), /decimal/);
  assert.throws(() => calculateRelationships(data(), { ...options, changeDate: at(1) }), /inside/);
});
