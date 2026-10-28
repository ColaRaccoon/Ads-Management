import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION } from "../types";
import type { AdapterRequest } from "../types";
import type { NameRule } from "../domain/product-name-resolver";
import { COUPANG_UPLOAD_SCOPE, normalizeCoupangAdsDay } from "./coupang-ads";
import type { CoupangAdsDayInput, CoupangAdsRow } from "./coupang-ads";

const request = (): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: "ads-run", readSnapshotId: "snapshot",
  from: "2026-10-26", to: "2026-10-26", scopeKeys: [COUPANG_UPLOAD_SCOPE], platforms: ["COUPANG"], sourcePolicySnapshot: {},
  sourceWatermarks: {}, cursor: null, limit: 100, scopePolicyVersion: "scope-v1", nameRuleVersion: "name-v1",
  saleUnitRuleVersion: "unit-v1", allocationRuleVersion: "allocation-v1", calculationVersion: "coupang-normal-v1", fxVersion: "fx-v1" });
const row = (adMetricKey = "ad-a", adSpendKrw = "100.01"): CoupangAdsRow => ({ id: adMetricKey, adMetricKey,
  adExecutionProductName: "버닝웨이브바", adExecutionOptionId: "external-123", adSpendKrw,
  totalConversionSales1dKrw: "99999", conversionProductName: "플로우라이트", conversionProductId: "conversion-id",
  uploadBatchId: "upload-a", sourceVersion: "1", observedAt: "2026-10-27T01:00:00Z", updatedAt: null });
const input = (rows: readonly CoupangAdsRow[] = [row()]): CoupangAdsDayInput => ({ date: "2026-10-26", scopeKey: COUPANG_UPLOAD_SCOPE,
  rows, complete: true, collectedAt: "2026-10-27T01:00:00Z", configuration: {
    products: [{ canonicalName: "버닝웨이브바" }, { canonicalName: "플로우라이트" }], nameRules: [] } });
const rule = (canonicalProductName: string, nameField?: string): NameRule => ({ id: `${canonicalProductName}-${nameField ?? "base"}`,
  canonicalProductName, matchType: "CONTAINS", terms: [canonicalProductName], validFrom: "2026-10-01", platform: "COUPANG", nameField });

test("Coupang spend follows the execution product and conversion revenue never becomes sales", () => {
  const batch = normalizeCoupangAdsDay(request(), input());
  assert.equal(batch.adSpends[0].productName, "버닝웨이브바");
  assert.equal(batch.adSpends[0].referenceConversionRevenue, "99999.000000");
  assert.equal(batch.adSpends[0].originalAmount, "100.010000");
  assert.equal(batch.adSpends[0].amountKrw, "100.010000");
  assert.equal(batch.adSpends[0].fx.rate, "1");
  assert.deepEqual(batch.sales, []); assert.deepEqual(batch.commonExpenses, []);
});

test("Coupang multiple options and no-sale advertising preserve assigned, unmatched and signed costs", () => {
  const rows = [{ ...row("a", "100.010001"), adExecutionOptionId: "one" }, { ...row("b", "200.02"), adExecutionOptionId: "two" },
    { ...row("c", "39.97"), adExecutionProductName: "등록되지 않은 제품", totalConversionSales1dKrw: "0" },
    { ...row("correction", "-0.000001"), adExecutionProductName: "등록되지 않은 제품" }];
  const batch = normalizeCoupangAdsDay(request(), input(rows));
  assert.equal(batch.adSpends.length, 4);
  assert.equal(batch.sourceControlTotals[0].selectedAmount, "340.000000");
  assert.equal(batch.sourceControlTotals[0].assignedAmount, "300.030001");
  assert.equal(batch.sourceControlTotals[0].unmatchedAmount, "39.969999");
  assert.equal(batch.sourceControlTotals[0].difference, "0.000000");
  assert.equal(batch.coverage[0].unallocatedAmount, "39.969999");
  assert.equal(batch.coverage[0].unmappedRows, 2);
});

test("external product or option changes do not change name classification, while renames do", () => {
  const initial = normalizeCoupangAdsDay(request(), input()).adSpends[0];
  const changedId = normalizeCoupangAdsDay(request(), input([{ ...row(), id: "new-id", adExecutionOptionId: "new-option" }])).adSpends[0];
  assert.equal(initial.productName, changedId.productName);
  assert.equal(initial.name.nameInputHash, changedId.name.nameInputHash);
  const renamed = normalizeCoupangAdsDay(request(), input([{ ...row(), adExecutionProductName: "플로우라이트" }])).adSpends[0];
  assert.equal(renamed.productName, "플로우라이트");
  assert.notEqual(initial.name.nameInputHash, renamed.name.nameInputHash);
});

test("explicit fallback field rules recover placeholder execution names and diagnose conflicts", () => {
  const data = input([{ ...row(), adExecutionProductName: "-", adName: "버닝웨이브바 광고", campaignName: "플로우라이트 광고" }]);
  assert.equal(normalizeCoupangAdsDay(request(), data).adSpends[0].productName, null);
  data.configuration.nameRules = [rule("버닝웨이브바", "ad_name")];
  const recovered = normalizeCoupangAdsDay(request(), data).adSpends[0];
  assert.equal(recovered.productName, "버닝웨이브바");
  assert.equal(recovered.name.restorationPath, "PLACEHOLDER_EXECUTION_NAME:ad_name");
  data.configuration.nameRules = [...data.configuration.nameRules, rule("플로우라이트", "campaign_name")];
  const conflict = normalizeCoupangAdsDay(request(), data).adSpends[0];
  assert.equal(conflict.productName, null); assert.equal(conflict.name.matchStatus, "AMBIGUOUS");
  assert.deepEqual(conflict.name.candidateNames, ["버닝웨이브바", "플로우라이트"]);
});

test("a real unknown execution name is not replaced by a matching ad or conversion product", () => {
  const data = input([{ ...row(), adExecutionProductName: "새로운 제품", adName: "버닝웨이브바", conversionProductName: "플로우라이트" }]);
  data.configuration.nameRules = [rule("버닝웨이브바", "ad_name")];
  const fact = normalizeCoupangAdsDay(request(), data).adSpends[0];
  assert.equal(fact.productName, null); assert.equal(fact.name.originalName, "새로운 제품");
});

test("an expired field fallback rule cannot use the unconditional canonical-name shortcut", () => {
  const data = input([{ ...row(), adExecutionProductName: "-", adName: "버닝웨이브바" }]);
  data.configuration.nameRules = [{ ...rule("버닝웨이브바", "ad_name"), validTo: "2026-10-25" }];
  assert.equal(normalizeCoupangAdsDay(request(), data).adSpends[0].productName, null);
  data.configuration.nameRules = [{ ...rule("버닝웨이브바", "ad_name"), validFrom: "2026-10-27" }];
  assert.equal(normalizeCoupangAdsDay(request(), data).adSpends[0].productName, null);
});

test("option names and inclusive rule dates apply while expired rules do not classify", () => {
  const data = input([{ ...row(), adExecutionProductName: "쿠팡 버닝", adExecutionOptionName: "2개입" }]);
  data.configuration.nameRules = [{ ...rule("버닝웨이브바"), terms: ["쿠팡 버닝"], optionExact: "2개입", saleUnitName: "2개입",
    validFrom: "2026-10-26", validTo: "2026-10-26" }];
  const fact = normalizeCoupangAdsDay(request(), data).adSpends[0];
  assert.equal(fact.productName, "버닝웨이브바"); assert.equal(fact.name.saleUnitName, "2개입");
  data.configuration.nameRules = [{ ...data.configuration.nameRules[0], validTo: "2026-10-25", validFrom: "2026-10-01" }];
  assert.equal(normalizeCoupangAdsDay(request(), data).adSpends[0].productName, null);
});

test("collected zero, missing day, partial rows and unverified zero are distinct", () => {
  const zero = normalizeCoupangAdsDay(request(), input([]));
  assert.equal(zero.coverage[0].zeroConfirmed, true); assert.equal(zero.sourceControlTotals[0].selectedAmount, "0.000000");
  const missing = normalizeCoupangAdsDay(request(), { ...input([]), complete: false, collectedAt: null });
  assert.equal(missing.coverage[0].collectionState, "NOT_COLLECTED"); assert.equal(missing.sourceControlTotals[0].selectedAmount, null);
  const partial = normalizeCoupangAdsDay(request(), { ...input(), complete: false });
  assert.equal(partial.coverage[0].collectionState, "PARTIAL"); assert.equal(partial.sourceControlTotals[0].selectedAmount, "100.010000");
  const withheld = normalizeCoupangAdsDay(request(), { ...input([]), unverifiedRows: 2 });
  assert.equal(withheld.coverage[0].zeroConfirmed, false); assert.equal(withheld.coverage[0].collectionState, "PARTIAL");
  assert.equal(withheld.coverage[0].rowsPresent, 2); assert.equal(withheld.sourceControlTotals[0].selectedAmount, null);
});

test("source fingerprints are row-order independent and invalidate replacement and historical name rules", () => {
  const data = input([row("a"), row("b")]);
  const initial = normalizeCoupangAdsDay(request(), data);
  assert.equal(initial.sourceFingerprint, normalizeCoupangAdsDay(request(), { ...data, rows: [...data.rows].reverse() }).sourceFingerprint);
  assert.notEqual(initial.sourceFingerprint, normalizeCoupangAdsDay(request(), { ...data, rows: [row("a"), { ...row("b"), sourceVersion: "2", adSpendKrw: "0" }] }).sourceFingerprint);
  assert.notEqual(initial.sourceFingerprint, normalizeCoupangAdsDay({ ...request(), nameRuleVersion: "name-v2" }, data).sourceFingerprint);
  assert.equal(normalizeCoupangAdsDay(request(), input([])).adSpends.length, 0);
});

test("duplicate selected rows, excluded source, unknown multi-account scope and invalid precise money are rejected", () => {
  assert.throws(() => normalizeCoupangAdsDay(request(), input([row(), row()])), /Duplicate/);
  assert.throws(() => normalizeCoupangAdsDay({ ...request(), platforms: ["CAFE24"] }, input()), /Excluded/);
  assert.throws(() => normalizeCoupangAdsDay({ ...request(), scopeKeys: ["unverified-account"] }, { ...input(), scopeKey: "unverified-account" }), /single-upload/);
  assert.throws(() => normalizeCoupangAdsDay(request(), input([row("bad", "1e5")])), /decimal string/);
  assert.throws(() => normalizeCoupangAdsDay(request(), input([row("bad", "0.0000001")])), /numeric/);
  assert.throws(() => normalizeCoupangAdsDay({ ...request(), limit: 1 }, input([row("a"), row("b")])), /PAGE_LIMIT/);
});
