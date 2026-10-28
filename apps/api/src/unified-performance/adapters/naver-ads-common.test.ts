import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeNaverAdsCommonDay, naverStoredDiagnostics, naverSyncDiagnostics } from "./naver-ads-common";
import type { NaverAdsCommonDayInput, NaverAdCost, NaverAdUpload } from "./naver-ads-common";
import { CONTRACT_VERSION } from "../types";
import type { AdapterRequest } from "../types";

const at = "2026-10-27T12:00:00+09:00";
const request = (): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: "run", readSnapshotId: "snapshot",
  from: "2026-10-27", to: "2026-10-27", scopeKeys: ["store"], platforms: ["NAVER"], sourcePolicySnapshot: {},
  sourceWatermarks: {}, cursor: null, limit: 100, scopePolicyVersion: "scope", nameRuleVersion: "name",
  saleUnitRuleVersion: "unit", allocationRuleVersion: "allocation", calculationVersion: "calc", fxVersion: "fx" });
const upload = (id = "current", values: Partial<NaverAdUpload> = {}): NaverAdUpload => ({ id, storeId: "store", reportDate: "2026-10-27",
  sourceType: "NAVER_DA_XLSX", isActive: true, state: "CONFIRMED", weekdayValidationStatus: "PASSED", updatedAt: at, ...values });
const ad = (id = "a", values: Partial<NaverAdCost> = {}): NaverAdCost => ({ id, storeId: "store", reportDate: "2026-10-27",
  sourceUploadId: "current", campaignId: "external-ad", campaignName: "제품 A", totalCost: "1500", totalConversionSales: "9000", updatedAt: at, ...values });
const input = (values: Partial<NaverAdsCommonDayInput> = {}): NaverAdsCommonDayInput => ({ date: "2026-10-27", scopeKey: "store", observedAt: at,
  sourceVersion: "source", configuration: { products: [{ canonicalName: "제품 A" }, { canonicalName: "제품 B" }], nameRules: [] },
  uploads: [upload()], ads: [ad()], fakePurchases: [], delivery: { sourceId: "summary", basis: "STORED_SUMMARY",
    customerPaidDeliveryFee: "5000", estimatedDeliveryBaseCost: "7000", deliveryUnitCost: "3500", uniquePackageCount: 2,
    complete: true, fallbackUnitCost: false, calculatedAt: at }, ...values });

test("Naver advertising uses current confirmed passed DA uploads and preserves unclassified spend", () => {
  const uploads = [upload(), upload("old", { isActive: false }), upload("preview", { state: "PREVIEW" }),
    upload("deleted", { state: "DELETED" }), upload("bad-weekday", { weekdayValidationStatus: "FAILED" }), upload("foreign-source", { sourceType: "OTHER" })];
  const ads = [...uploads.map((u, i) => ad(String(i), { sourceUploadId: u.id })), ad("unmatched", { campaignName: "모르는 상품", totalCost: "123" })];
  const batch = normalizeNaverAdsCommonDay(request(), input({ uploads, ads }));
  assert.equal(batch.adSpends.length, 2);
  assert.equal(batch.sourceControlTotals[0].selectedAmount, "1623.000000");
  assert.equal(batch.sourceControlTotals[0].assignedAmount, "1500.000000");
  assert.equal(batch.sourceControlTotals[0].unallocatedAmount, "123.000000");
  assert.equal(batch.sourceControlTotals[0].difference, "0.000000");
  assert.equal(batch.sourceControlTotals[0].excludedByPolicyRows, 5);
  assert.equal(batch.sales.length, 0);
  assert.equal(batch.adSpends[0].referenceConversionRevenue, "9000.000000");
  assert.equal(batch.coverage[0].collectionState, "COMPLETE");
  assert.equal(batch.coverage[0].quality.confidence, "ESTIMATED");
});

test("Replacement, deletion and explicit zero correction cannot retain the previous upload's costs", () => {
  const old = upload("old", { isActive: false });
  const corrected = upload("new", { replacedUploadId: "old" });
  const original = ad("old-cost", { sourceUploadId: "old", totalCost: "89000" });
  const batch = normalizeNaverAdsCommonDay(request(), input({ uploads: [old, corrected], ads: [original] }));
  assert.equal(batch.adSpends.length, 0);
  assert.equal(batch.sourceControlTotals[0].selectedAmount, "0.000000");
  assert.equal(batch.coverage[0].zeroConfirmed, true);
  assert.equal(batch.coverage[0].selectedUploadId, "new");
  const deleted = normalizeNaverAdsCommonDay(request(), input({ uploads: [upload("old", { isActive: false, state: "DELETED" })], ads: [original] }));
  assert.equal(deleted.adSpends.length, 0);
  assert.equal(deleted.sourceControlTotals[0].selectedAmount, null);
  assert.equal(deleted.coverage[0].zeroConfirmed, false);
  assert.equal(deleted.coverage[0].collectionState, "NOT_COLLECTED");
});

test("Same name after campaign ID changes classifies automatically and distinct campaign rows remain", () => {
  const batch = normalizeNaverAdsCommonDay(request(), input({ ads: [ad("one"), ad("two", { campaignId: "new-external-id" })] }));
  assert.deepEqual(batch.adSpends.map(row => row.productName), ["제품 A", "제품 A"]);
  assert.equal(batch.sourceControlTotals[0].selectedAmount, "3000.000000");
});

test("Direct group spend remains a single source amount and cross-product group stays unallocated", () => {
  const cross = ad("cross", { campaignName: "종합그룹 캠페인", groupName: "종합그룹", groupChildNames: ["제품 A", "제품 B"], totalCost: "1001" });
  const single = ad("single", { campaignName: "A그룹", groupName: "A그룹", groupChildNames: ["제품 A", "제품 A"], totalCost: "2000" });
  const batch = normalizeNaverAdsCommonDay(request(), input({ ads: [cross, single] }));
  assert.equal(batch.adSpends.length, 2);
  assert.equal(batch.adSpends[0].productName, null);
  assert.equal(batch.adSpends[0].name.matchStatus, "AMBIGUOUS");
  assert.equal(batch.adSpends[1].productName, "제품 A");
  assert.equal(batch.sourceControlTotals[0].selectedAmount, "3001.000000");
  assert.equal(batch.sourceControlTotals[0].assignedAmount, "2000.000000");
  assert.equal(batch.sourceControlTotals[0].unallocatedAmount, "1001.000000");
});

test("Unresolved group child and contradictory group names cannot guess attribution", () => {
  const unresolved = normalizeNaverAdsCommonDay(request(), input({ ads: [ad("a", { campaignName: "그룹", groupName: "그룹", groupChildNames: ["제품 A", "모름"] })] }));
  assert.equal(unresolved.adSpends[0].productName, null);
  const ignoredIdLikeHint = normalizeNaverAdsCommonDay(request(), input({ ads: [ad("a", { campaignName: "모름", groupName: "unrelated-group", groupChildNames: ["제품 A"] })] }));
  assert.equal(ignoredIdLikeHint.adSpends[0].productName, null);
  const contradict = normalizeNaverAdsCommonDay(request(), input({ ads: [ad("a", { campaignName: "제품 A", groupName: "제품 A", groupChildNames: ["제품 B"] })] }));
  assert.equal(contradict.adSpends[0].productName, null);
  assert.equal(contradict.adSpends[0].name.matchStatus, "AMBIGUOUS");
});

test("Shipping income, cost and fake purchases remain separate scope expenses once including signed corrections", () => {
  const batch = normalizeNaverAdsCommonDay(request(), input({ fakePurchases: [
    { id: "fake", storeId: "store", date: "2026-10-27", amount: "10000", updatedAt: at },
    { id: "correction", storeId: "store", date: "2026-10-27", amount: "-2000", updatedAt: at }] }));
  assert.deepEqual(batch.commonExpenses.map(row => row.kind), ["SHIPPING_INCOME", "SHIPPING_COST", "FAKE_PURCHASE", "FAKE_PURCHASE"]);
  assert.equal(batch.commonExpenses.every(row => row.productName === null && row.allocationStatus === "UNALLOCATED"), true);
  const byKind = Object.fromEntries(batch.commonExpenses.map(row => [row.expenseKey, row.amountKrw]));
  assert.equal(Object.keys(byKind).length, 4);
  assert.equal(batch.commonExpenses.filter(row => row.kind === "FAKE_PURCHASE").reduce((s, row) => s + Number(row.amountKrw), 0), 8000);
  assert.equal(batch.coverage[1].collectionState, "COMPLETE");
  assert.equal(batch.sales.length, 0);
});

test("Missing delivery input retains available fake amount and does not manufacture zero or complete coverage", () => {
  const batch = normalizeNaverAdsCommonDay(request(), input({ delivery: null, fakePurchases: [
    { id: "fake", storeId: "store", date: "2026-10-27", amount: "0", updatedAt: at }] }));
  assert.equal(batch.commonExpenses.length, 1);
  assert.equal(batch.commonExpenses[0].amountKrw, "0.000000");
  assert.equal(batch.coverage[1].collectionState, "PARTIAL");
  assert.equal(batch.coverage[1].quality.issues.includes("NAVER_DELIVERY_COMPONENTS_MISSING"), true);
  const noInput = normalizeNaverAdsCommonDay(request(), input({ delivery: null }));
  assert.equal(noInput.coverage[1].collectionState, "NOT_COLLECTED");
  assert.equal(noInput.coverage[1].unallocatedAmount, null);
});

test("Stored old version, missing fingerprints and sync gaps explain confidence without discarding estimates", () => {
  const batch = normalizeNaverAdsCommonDay(request(), input({ storedSummaries: [{ id: "stored", storeId: "store", date: "2026-10-27",
    calculationVersion: "profit-v1", calculatedAt: "2026-10-27T01:00:00+09:00", updatedAt: at }],
  syncState: { storeId: "store", initialCoverageFrom: "2026-10-01", lastSuccessfulSyncAt: at, lastSuccessfulChangedTo: at,
    historicalCoverageGap: { from: "2026-10-25T00:00:00+09:00", to: "2026-10-26T00:00:00+09:00" } } }));
  assert.equal(batch.coverage[1].collectionState, "COMPLETE");
  for (const issue of ["NAVER_STORED_FINGERPRINT_MISSING", "NAVER_STORED_CALCULATION_VERSION_OLD", "NAVER_STORED_RESULT_PREDATES_SOURCE", "NAVER_CHANGED_ORDER_COVERAGE_GAP"])
    assert.equal(batch.coverage[1].quality.issues.includes(issue), true, issue);
  assert.equal(batch.adSpends[0].amountKrw, "1500.000000");
  assert.equal(naverSyncDiagnostics("2026-10-27", null).includes("NAVER_ORDER_SYNC_STATE_MISSING"), true);
  assert.equal(naverStoredDiagnostics([]).calculatedAt, null);
});

test("Failed ad read cannot mark empty upload complete while common numeric evidence remains usable", () => {
  const batch = normalizeNaverAdsCommonDay(request(), input({ ads: [], adSourceIssues: ["NAVER_ADS_READ_FAILED"] }));
  assert.equal(batch.coverage[0].collectionState, "PARTIAL");
  assert.equal(batch.coverage[0].zeroConfirmed, false);
  assert.equal(batch.sourceControlTotals[0].selectedAmount, null);
  assert.equal(batch.coverage[1].collectionState, "COMPLETE");
});

test("Multiple valid active uploads follow source additive rules without making complete input partial", () => {
  const batch = normalizeNaverAdsCommonDay(request(), input({ uploads: [upload(), upload("second")], ads: [ad(), ad("b", { sourceUploadId: "second" })] }));
  assert.equal(batch.coverage[0].collectionState, "COMPLETE");
  assert.equal(batch.coverage[0].selectedUploadId, null);
  assert.equal(batch.coverage[0].quality.issues.includes("NAVER_MULTIPLE_ACTIVE_UPLOADS_ACCEPTED"), true);
  assert.equal(batch.sourceControlTotals[0].selectedAmount, "3000.000000");
});

test("Explicit replacement lineage excludes a damaged still-active predecessor and reports its state", () => {
  const batch = normalizeNaverAdsCommonDay(request(), input({ uploads: [upload("old"), upload("new", { replacedUploadId: "old" })],
    ads: [ad("old-cost", { sourceUploadId: "old", totalCost: "99999" }), ad("new-cost", { sourceUploadId: "new", totalCost: "1000" })] }));
  assert.equal(batch.adSpends.length, 1);
  assert.equal(batch.adSpends[0].ref.uploadOrRunId, "new");
  assert.equal(batch.sourceControlTotals[0].selectedAmount, "1000.000000");
  assert.equal(batch.sourceControlTotals[0].excludedByPolicyRows, 1);
  assert.equal(batch.coverage[0].collectionState, "PARTIAL");
  assert.equal(batch.coverage[0].quality.issues.includes("NAVER_REPLACED_UPLOAD_STILL_ACTIVE"), true);
});

test("Replacement ancestry crosses inactive intermediate uploads and cycles cannot confirm a zero", () => {
  const batch = normalizeNaverAdsCommonDay(request(), input({ uploads: [upload("old"), upload("middle", { isActive: false, replacedUploadId: "old" }),
    upload("new", { replacedUploadId: "middle" })], ads: [ad("old", { sourceUploadId: "old" }), ad("new", { sourceUploadId: "new", totalCost: "100" })] }));
  assert.equal(batch.adSpends.length, 1);
  assert.equal(batch.adSpends[0].amountKrw, "100.000000");
  const cycle = normalizeNaverAdsCommonDay(request(), input({ uploads: [upload("one", { replacedUploadId: "two" }), upload("two", { replacedUploadId: "one" })], ads: [] }));
  assert.equal(cycle.coverage[0].quality.issues.includes("NAVER_UPLOAD_REPLACEMENT_CYCLE"), true);
  assert.equal(cycle.coverage[0].zeroConfirmed, false);
  assert.equal(cycle.sourceControlTotals[0].selectedAmount, null);
});

test("Stored freshness compares actual instants across timestamp offsets", () => {
  const diagnostics = naverStoredDiagnostics([{ id: "stored", storeId: "store", date: "2026-10-27", calculationVersion: "profit-v2",
    calculatedAt: "2026-10-27T08:00:00+09:00", updatedAt: at }], "2026-10-27T00:00:00Z");
  assert.equal(diagnostics.issues.includes("NAVER_STORED_RESULT_PREDATES_SOURCE"), true);
});

test("Source duplicates, cross-store/date rows and excluded platform are rejected at the pure boundary", () => {
  assert.throws(() => normalizeNaverAdsCommonDay(request(), input({ ads: [ad(), ad()] })), /DUPLICATE/);
  assert.throws(() => normalizeNaverAdsCommonDay(request(), input({ ads: [ad("a", { storeId: "other" })] })), /CROSS_STORE/);
  assert.throws(() => normalizeNaverAdsCommonDay(request(), input({ ads: [ad("a", { reportDate: "2026-10-26" })] })), /CROSS_DAY/);
  assert.throws(() => normalizeNaverAdsCommonDay({ ...request(), platforms: ["META"] }, input()), /Excluded/);
});

test("One malformed monetary row retains usable advertising, shipping and fake purchase siblings with partial diagnostics", () => {
  const batch = normalizeNaverAdsCommonDay(request(), input({ ads: [ad("good"), ad("bad", { totalCost: "NaN" })], fakePurchases: [
    { id: "good", storeId: "store", date: "2026-10-27", amount: "123", updatedAt: at },
    { id: "bad", storeId: "store", date: "2026-10-27", amount: "NaN", updatedAt: at }] }));
  assert.equal(batch.adSpends.length, 1);
  assert.equal(batch.adSpends[0].amountKrw, "1500.000000");
  assert.equal(batch.sourceControlTotals[0].selectedAmount, null);
  assert.equal(batch.sourceControlTotals[0].assignedAmount, "1500.000000");
  assert.equal(batch.sourceControlTotals[0].difference, null);
  assert.equal(batch.coverage[0].rowsPresent, 2);
  assert.equal(batch.coverage[0].collectionState, "PARTIAL");
  assert.equal(batch.coverage[0].quality.issues.includes("NAVER_AD_AMOUNT_INVALID"), true);
  assert.equal(batch.commonExpenses.length, 3);
  assert.equal(batch.coverage[1].collectionState, "PARTIAL");
  assert.equal(batch.coverage[1].quality.issues.includes("NAVER_FAKE_PURCHASE_AMOUNT_INVALID"), true);
});

test("Invalid optional conversion reference does not erase a valid ad cost", () => {
  const batch = normalizeNaverAdsCommonDay(request(), input({ ads: [ad("good", { totalConversionSales: "NaN" })] }));
  assert.equal(batch.adSpends[0].amountKrw, "1500.000000");
  assert.equal(batch.adSpends[0].referenceConversionRevenue, null);
  assert.equal(batch.adSpends[0].quality.issues.includes("NAVER_AD_REFERENCE_CONVERSION_INVALID"), true);
  assert.equal(batch.coverage[0].collectionState, "COMPLETE");
});
