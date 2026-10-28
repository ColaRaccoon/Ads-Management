import { createHash } from "node:crypto";
import { CONTRACT_VERSION } from "./types";
import type { AdapterBatch, AdapterRequest, Platform, Quality, SourceRef } from "./types";
import { money, quantity, ratio } from "./domain/decimal";
import { assertBusinessDate } from "./domain/product-name-resolver";
import { normalizePlatforms } from "./domain/platform-selection";

/** Logical source identity preserves separate same-name orders and source record kinds. */
export const logicalSourceKey = (ref: Pick<SourceRef, "sourceSystem" | "scopeKey" | "recordKind" | "sourceRecordKey">) =>
  createHash("sha256").update(JSON.stringify([ref.sourceSystem, ref.scopeKey, ref.recordKind, ref.sourceRecordKey])).digest("hex");

export function assertAdapterRequest(request: AdapterRequest, platform: Platform): void {
  if (request.contractVersion !== CONTRACT_VERSION) throw new Error("Unsupported unified contract version.");
  assertBusinessDate(request.from); assertBusinessDate(request.to);
  const days = (Date.parse(request.to) - Date.parse(request.from)) / 86400000 + 1;
  if (days < 1 || days > 92) throw new Error("Adapter range must be 1 through 92 inclusive days.");
  if (!normalizePlatforms(request.platforms).includes(platform)) throw new Error("Excluded source must not be read.");
  if (!Array.isArray(request.scopeKeys) || request.scopeKeys.length !== 1 || !request.scopeKeys[0]?.trim())
    throw new Error("Adapter batches require one explicitly authorized source scope.");
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 10000) throw new Error("Invalid adapter page limit.");
  for (const field of ["runId", "readSnapshotId", "scopePolicyVersion", "nameRuleVersion", "saleUnitRuleVersion", "allocationRuleVersion", "calculationVersion", "fxVersion"] as const)
    if (typeof request[field] !== "string" || !request[field].trim()) throw new Error(`Missing adapter ${field}.`);
}
function quality(value: Quality): void {
  if (!value || typeof value.isEstimate !== "boolean" || !["SOURCE_REPORTED", "ESTIMATED"].includes(value.confidence) ||
      !Array.isArray(value.issues) || value.issues.some(i => typeof i !== "string")) throw new Error("Invalid quality evidence.");
}
const nullableMoney = (value: unknown) => { if (value !== null) money(value); };
export function assertOffsetTimestamp(value: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error("Timestamp requires a valid ISO8601 offset.");
  assertBusinessDate(value.slice(0, 10));
}

/** Stage writers call this before persisting JSON payloads; numeric columns alone cannot validate JSON. */
export function assertAdapterBatch(request: AdapterRequest, platform: Platform, batch: AdapterBatch): void {
  assertAdapterRequest(request, platform);
  const seen = new Set<string>();
  const ref = (source: SourceRef) => {
    assertBusinessDate(source.businessDate);
    if (source.platform !== platform || !request.scopeKeys.includes(source.scopeKey) || source.businessDate < request.from || source.businessDate > request.to)
      throw new Error("Fact escaped requested platform/scope/date.");
    for (const key of ["sourceSystem", "recordKind", "sourceRecordKey", "schema", "table", "selectedSource", "sourceVersion", "observedAt", "dateBasis", "sourceTimeZone"] as const)
      if (typeof source[key] !== "string" || !source[key].trim()) throw new Error(`Missing source ${key}.`);
    assertOffsetTimestamp(source.observedAt);
    if (source.providerUpdatedAt !== null) assertOffsetTimestamp(source.providerUpdatedAt);
    const identity = logicalSourceKey(source);
    if (seen.has(identity)) throw new Error("Duplicate selected logical source fact.");
    seen.add(identity);
  };
  const salesPlatforms = { CAFE24: "CAFE24", COUPANG: "COUPANG", NAVER_SMARTSTORE: "NAVER" };
  for (const sale of batch.sales) {
    ref(sale.ref); quality(sale.quality);
    if (salesPlatforms[sale.marketplace] !== platform) throw new Error("Sale marketplace/platform mismatch.");
    for (const key of ["operatingRevenue", "collectedPaymentAmount", "productCost", "platformFee", "directShippingCost", "returnCost", "otherDirectCost", "vatExpense", "discountNotYetIncluded", "manualVendorFee", "profitBeforeAds"] as const) nullableMoney(sale[key]);
    for (const key of ["orderedQuantity", "calculationQuantity"] as const) quantity(sale[key]);
    for (const key of ["unitsPerSaleUnit", "physicalQuantity"] as const) if (sale[key] !== null) quantity(sale[key]);
    sale.costComponents.forEach(cost => { nullableMoney(cost.amount); if (typeof cost.applied !== "boolean" || typeof cost.includedInRevenue !== "boolean" || !cost.sourceExpenseKey) throw new Error("Cost application evidence missing."); });
  }
  const adPlatforms = { META: "META", GOOGLE: "GOOGLE", NAVER_DA: "NAVER", COUPANG_ADS: "COUPANG" };
  for (const ad of batch.adSpends) {
    ref(ad.ref); quality(ad.quality);
    if (adPlatforms[ad.medium] !== platform) throw new Error("Ad medium/platform mismatch.");
    money(ad.originalAmount); nullableMoney(ad.amountKrw); money(ad.roundingAdjustment);
    nullableMoney(ad.referenceConversionRevenue);
    if (ad.fx.rate !== null && ratio(ad.fx.rate).lte(0)) throw new Error("FX rate must be positive.");
    if (ad.amountKrw !== null && ad.fx.rate === null) throw new Error("Converted amount requires FX evidence.");
  }
  for (const expense of batch.commonExpenses) {
    if (platform === "META" || platform === "GOOGLE") throw new Error("Ad-only platforms cannot emit common expenses.");
    ref(expense.ref); quality(expense.quality);
    money(expense.originalAmount); nullableMoney(expense.amountKrw); nullableMoney(expense.unallocatedAmount);
    if (expense.scopeKey !== expense.ref.scopeKey || !expense.expenseKey) throw new Error("Expense scope/key mismatch.");
  }
  for (const coverage of batch.coverage) {
    quality(coverage.quality); assertBusinessDate(coverage.date);
    for (const timestamp of [coverage.sourceAsOf, coverage.collectedAt, coverage.calculatedAt, coverage.lastSuccessAt])
      if (timestamp !== null) assertOffsetTimestamp(timestamp);
    if (coverage.platform !== platform || !request.scopeKeys.includes(coverage.scopeKey) || coverage.date < request.from || coverage.date > request.to || coverage.participation === "EXCLUDED_BY_USER")
      throw new Error("Selection-excluded coverage is response metadata, never a source fact.");
    if (!Number.isInteger(coverage.rowsPresent) || coverage.rowsPresent < 0 || coverage.zeroConfirmed && (coverage.rowsPresent !== 0 || coverage.collectionState !== "COMPLETE"))
      throw new Error("Zero requires explicit complete collection evidence.");
    for (const key of ["unmatchedAmount", "missingFxAmount", "unallocatedAmount"] as const) nullableMoney(coverage[key]);
  }
  for (const control of batch.sourceControlTotals) {
    if (control.measure !== undefined && !["AD_SPEND", "OPERATING_REVENUE", "REGISTERED_GROSS", "SOURCE_LIST_PRICE_GROSS", "PRODUCT_COST", "DIRECT_SHIPPING_COST", "OTHER_DIRECT_COST", "VAT_EXPENSE", "COUPON"].includes(control.measure))
      throw new Error("Unknown control total measure.");
    assertBusinessDate(control.date);
    if (control.platform !== platform || !request.scopeKeys.includes(control.scopeKey) || control.date < request.from || control.date > request.to) throw new Error("Control total scope mismatch.");
    for (const key of ["selectedAmount", "assignedAmount", "unmatchedAmount", "unallocatedAmount", "excludedNonSaleAmount", "difference"] as const) nullableMoney(control[key]);
    money(control.roundingAdjustment);
  }
}
