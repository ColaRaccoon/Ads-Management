import { createHash } from "node:crypto";
import { assertAdapterBatch, assertAdapterRequest, assertOffsetTimestamp } from "../adapter-contract";
import { ExactDecimal as D, money, quantizeMoney } from "../domain/decimal";
import { assertBusinessDate, normalizeProductName, resolveProductName } from "../domain/product-name-resolver";
import type { CatalogProduct, NameRule, ProductNameResolution } from "../domain/product-name-resolver";
import type { AdapterBatch, AdapterRequest, AdSpendFact, CommonExpenseFact, SourceCoverage, SourceRef } from "../types";

export interface NaverAdUpload {
  id: string; storeId: string; reportDate: string; sourceType: string;
  isActive: boolean; state: string; weekdayValidationStatus: string;
  replacedUploadId?: string | null; updatedAt: string;
}
export interface NaverAdCost {
  id: string; storeId: string; reportDate: string; sourceUploadId: string;
  campaignId: string; campaignName: string; totalCost: string; totalConversionSales?: string | null; updatedAt: string;
  /** Names inferred from source text, never an external-ID product mapping. */
  groupName?: string | null; groupChildNames?: readonly string[];
}
export interface NaverFakePurchase { id: string; storeId: string; date: string; amount: string; updatedAt: string }
export interface NaverDeliveryEvidence {
  sourceId: string; basis: "STORED_SUMMARY" | "ORDER_RULE";
  customerPaidDeliveryFee: string | null; estimatedDeliveryBaseCost: string | null;
  deliveryUnitCost: string | null; uniquePackageCount: number | null;
  complete: boolean; fallbackUnitCost: boolean; calculatedAt: string | null;
}
export interface NaverStoredSummary {
  id: string; storeId: string; date: string; calculationVersion: string; calculatedAt: string; updatedAt: string;
  costSnapshotId?: string | null; mappingBasisHash?: string | null;
}
export interface NaverOrderSyncState {
  storeId: string; initialCoverageFrom: string; lastSuccessfulChangedTo: string | null;
  lastSuccessfulSyncAt: string | null; changedCoverageBaselineAt?: string;
  historicalCoverageGap?: { from: string; to: string };
}
export interface NaverAdsCommonDayInput {
  date: string; scopeKey: string; observedAt: string; sourceVersion: string;
  configuration: { products: readonly CatalogProduct[]; nameRules: readonly NameRule[] };
  uploads: readonly NaverAdUpload[]; ads: readonly NaverAdCost[]; fakePurchases: readonly NaverFakePurchase[];
  delivery: NaverDeliveryEvidence | null; storedSummaries?: readonly NaverStoredSummary[];
  syncState?: NaverOrderSyncState | null; adSourceIssues?: readonly string[]; commonSourceIssues?: readonly string[];
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sum = (values: readonly string[]) => quantizeMoney(values.reduce((s, value) => s.plus(money(value)), new D(0)));
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const estimate = (issues: readonly string[]) => ({ isEstimate: true, confidence: "ESTIMATED" as const, issues: unique(issues) });
const latestTimestamp = (values: readonly string[]) => {
  values.forEach(assertOffsetTimestamp);
  return [...values].sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
};

/** These are confidence/freshness diagnostics, not proof that numeric inputs are missing. */
export function naverSyncDiagnostics(date: string, state: NaverOrderSyncState | null | undefined): string[] {
  assertBusinessDate(date);
  const issues = ["NAVER_ESTIMATED_SOURCE", "NAVER_HISTORICAL_RETURNS_NOT_GUARANTEED"];
  if (!state) return [...issues, "NAVER_ORDER_SYNC_STATE_MISSING"];
  assertBusinessDate(state.initialCoverageFrom);
  if (state.lastSuccessfulSyncAt !== null) assertOffsetTimestamp(state.lastSuccessfulSyncAt);
  if (state.lastSuccessfulChangedTo !== null) assertOffsetTimestamp(state.lastSuccessfulChangedTo);
  if (date < state.initialCoverageFrom) issues.push("NAVER_BEFORE_INITIAL_COVERAGE");
  if (!state.lastSuccessfulSyncAt) issues.push("NAVER_ORDER_SYNC_SUCCESS_UNKNOWN");
  if (!state.lastSuccessfulChangedTo) issues.push("NAVER_CHANGED_ORDER_COVERAGE_UNKNOWN");
  if (state.historicalCoverageGap) issues.push("NAVER_CHANGED_ORDER_COVERAGE_GAP");
  return unique(issues);
}

export function naverStoredDiagnostics(rows: readonly NaverStoredSummary[], sourceAsOf: string | null = null) {
  if (sourceAsOf !== null) assertOffsetTimestamp(sourceAsOf);
  const issues: string[] = [];
  for (const row of rows) {
    assertOffsetTimestamp(row.calculatedAt); assertOffsetTimestamp(row.updatedAt);
    if (!row.costSnapshotId || !row.mappingBasisHash) issues.push("NAVER_STORED_FINGERPRINT_MISSING");
    if (row.calculationVersion !== "profit-v2") issues.push("NAVER_STORED_CALCULATION_VERSION_OLD");
    if (sourceAsOf && Date.parse(row.calculatedAt) < Date.parse(sourceAsOf)) issues.push("NAVER_STORED_RESULT_PREDATES_SOURCE");
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(row.calculationVersion)) throw new Error("Invalid stored calculation version.");
    issues.push(`NAVER_STORED_CALCULATION_VERSION:${row.calculationVersion}`);
  }
  return { issues: unique(issues), calculatedAt: latestTimestamp(rows.map(row => row.calculatedAt)),
    calculationVersions: unique(rows.map(row => row.calculationVersion)) };
}

function adName(request: AdapterRequest, input: NaverAdsCommonDayInput, row: NaverAdCost): ProductNameResolution {
  const resolve = (name: string, field: string) => resolveProductName({ originalName: name, nameField: field,
    platform: "NAVER", scopeKey: input.scopeKey, businessDate: input.date },
  input.configuration.products, input.configuration.nameRules, request.nameRuleVersion);
  const campaign = resolve(row.campaignName, "campaign_name");
  if (!row.groupName || !row.groupChildNames?.length ||
      !normalizeProductName(row.campaignName).includes(normalizeProductName(row.groupName))) return campaign;
  const children = row.groupChildNames.map(name => resolve(name, "sales_unit_name"));
  const names = unique(children.flatMap(child => child.candidateNames));
  const allResolved = children.every(child => child.matchStatus === "MATCHED");
  const product = allResolved && names.length === 1 ? names[0] : null;
  const conflict = campaign.canonicalProductName && product && campaign.canonicalProductName !== product;
  const candidates = unique([...names, ...campaign.candidateNames]);
  return { ...campaign, canonicalProductName: conflict ? null : product,
    saleUnitName: null, matchStatus: conflict || candidates.length > 1 ? "AMBIGUOUS" : product ? "MATCHED" : "UNMATCHED",
    candidateNames: candidates, ruleIds: unique([...campaign.ruleIds, ...children.flatMap(child => child.ruleIds)]),
    restorationPath: "canonical_sales_units.group_names", nameInputHash: hash([campaign.nameInputHash, row.groupName, children.map(child => child.nameInputHash)]),
    reasons: [product && !conflict ? "GROUP_CHILD_NAMES_SINGLE_PRODUCT" : "GROUP_AD_REQUIRES_ALLOCATION"] };
}

export function normalizeNaverAdsCommonDay(request: AdapterRequest, input: NaverAdsCommonDayInput): AdapterBatch {
  assertAdapterRequest(request, "NAVER"); assertBusinessDate(input.date); assertOffsetTimestamp(input.observedAt);
  if (request.scopeKeys[0] !== input.scopeKey || input.date < request.from || input.date > request.to)
    throw new Error("NAVER_AD_COMMON_SCOPE_DATE_MISMATCH");
  for (const rows of [input.ads, input.uploads, input.fakePurchases]) {
    if (rows.length > request.limit) throw new Error("NAVER_AD_COMMON_DAY_TOO_LARGE");
    if (rows.some(row => !row.id) || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("NAVER_DUPLICATE_SOURCE_KEY");
    if (rows.some(row => row.storeId !== input.scopeKey)) throw new Error("NAVER_CROSS_STORE_REFERENCE");
  }
  if (input.uploads.some(row => row.reportDate !== input.date) || input.ads.some(row => row.reportDate !== input.date) ||
      input.fakePurchases.some(row => row.date !== input.date) || input.storedSummaries?.some(row => row.storeId !== input.scopeKey || row.date !== input.date) ||
      input.syncState && input.syncState.storeId !== input.scopeKey) throw new Error("NAVER_CROSS_DAY_REFERENCE");
  const activeCandidates = input.uploads.filter(row => row.isActive === true && row.state === "CONFIRMED" &&
    row.weekdayValidationStatus === "PASSED" && row.sourceType === "NAVER_DA_XLSX");
  // An explicit replacement wins even if damaged legacy state left its predecessor active.
  const uploadById = new Map(input.uploads.map(row => [row.id, row]));
  const replacedIds = new Set<string>();
  let replacementCycle = false;
  for (const candidate of activeCandidates) {
    const seen = new Set([candidate.id]);
    let predecessor = candidate.replacedUploadId;
    while (predecessor) {
      replacedIds.add(predecessor);
      if (seen.has(predecessor)) { replacementCycle = true; break; }
      seen.add(predecessor); predecessor = uploadById.get(predecessor)?.replacedUploadId;
    }
  }
  const active = activeCandidates.filter(row => !replacedIds.has(row.id));
  const activeIds = new Set(active.map(row => row.id));
  const selected = input.ads.filter(row => activeIds.has(row.sourceUploadId)).sort((a, b) => a.id.localeCompare(b.id));
  const adSourceIssues = [...input.adSourceIssues ?? []];
  const adConfidenceIssues = active.length > 1 ? ["NAVER_MULTIPLE_ACTIVE_UPLOADS_ACCEPTED"] : [];
  if (active.length !== activeCandidates.length) adSourceIssues.push("NAVER_REPLACED_UPLOAD_STILL_ACTIVE");
  if (replacementCycle) adSourceIssues.push("NAVER_UPLOAD_REPLACEMENT_CYCLE");
  if (!active.length) adSourceIssues.push("NAVER_AD_UPLOAD_MISSING");
  const ref = (table: string, recordKind: string, key: string, updatedAt: string | null, uploadId: string | null = null): SourceRef => ({
    sourceSystem: recordKind === "AD_SPEND" ? "NAVER_DA" : "NAVER_SMARTSTORE", platform: "NAVER", schema: "public", table,
    scopeKey: input.scopeKey, recordKind, sourceRecordKey: `${input.date}:${key}`, selectedSource: recordKind === "AD_SPEND" ? "NAVER_DA_XLSX" : "NAVER_BUSINESS_RULES",
    sourceVersion: input.sourceVersion, uploadOrRunId: uploadId, payloadHash: null, providerUpdatedAt: updatedAt,
    observedAt: input.observedAt, businessDate: input.date, dateBasis: recordKind === "AD_SPEND" ? "reportDate" : "paymentDate", sourceTimeZone: "Asia/Seoul" });
  let invalidAdRows = 0, invalidFakeRows = 0;
  const ads: AdSpendFact[] = selected.flatMap(row => {
    assertOffsetTimestamp(row.updatedAt);
    let amount: string;
    try { amount = quantizeMoney(money(row.totalCost)); }
    catch { invalidAdRows++; adSourceIssues.push("NAVER_AD_AMOUNT_INVALID"); return []; }
    let conversion: string | null = null;
    const rowIssues: string[] = [];
    if (row.totalConversionSales != null) {
      try { conversion = quantizeMoney(money(row.totalConversionSales)); }
      catch { rowIssues.push("NAVER_AD_REFERENCE_CONVERSION_INVALID"); }
    }
    const name = adName(request, input, row);
    return [{ ref: ref("ad_campaign_daily_costs", "AD_SPEND", row.id, row.updatedAt, row.sourceUploadId), name,
      productName: name.matchStatus === "MATCHED" ? name.canonicalProductName : null, medium: "NAVER_DA", originalAmount: amount,
      currency: "KRW", amountKrw: amount, fx: { baseCurrency: "KRW", quoteCurrency: "KRW", requestedDate: input.date,
        sourceDate: input.date, rate: "1", provider: "IDENTITY", fallbackType: "IDENTITY", fxVersion: request.fxVersion },
      roundingAdjustment: "0.000000", preQuantizationFingerprint: hash([row.totalCost, "KRW", "1"]),
      attribution: name.matchStatus === "MATCHED" ? "DIRECT" : "UNALLOCATED", allocationRuleVersion: request.allocationRuleVersion,
      referenceConversionRevenue: conversion,
      quality: estimate(["NAVER_ESTIMATED_SOURCE", ...adSourceIssues, ...adConfidenceIssues, ...rowIssues, ...(name.matchStatus !== "MATCHED" ? [`NAME_${name.matchStatus}`] : []), ...name.reasons.filter(reason => reason === "GROUP_AD_REQUIRES_ALLOCATION")]) } satisfies AdSpendFact];
  });
  const expenses: CommonExpenseFact[] = [];
  const commonReadIssues = [...input.commonSourceIssues ?? []];
  const commonIssues = [...commonReadIssues, ...naverSyncDiagnostics(input.date, input.syncState)];
  const addExpense = (table: string, id: string, kind: CommonExpenseFact["kind"], amount: string, updatedAt: string | null) => {
    const normalized = quantizeMoney(money(amount)), expenseKey = `NAVER:${input.scopeKey}:${input.date}:${kind}:${id}`;
    expenses.push({ ref: ref(table, kind, id, updatedAt), expenseKey, kind, amountKrw: normalized, scopeKey: input.scopeKey,
      productName: null, allocationStatus: "UNALLOCATED", allocationRuleVersion: request.allocationRuleVersion,
      originalAmount: normalized, unallocatedAmount: normalized, quality: estimate(commonIssues) });
  };
  if (!input.delivery) commonIssues.push("NAVER_DELIVERY_COMPONENTS_MISSING");
  else {
    const delivery = input.delivery;
    if (delivery.calculatedAt !== null) assertOffsetTimestamp(delivery.calculatedAt);
    if (delivery.fallbackUnitCost) commonIssues.push("NAVER_DELIVERY_UNIT_COST_DEFAULT_3500");
    if (delivery.customerPaidDeliveryFee === null) commonIssues.push("NAVER_DELIVERY_INCOME_MISSING");
    if (delivery.estimatedDeliveryBaseCost === null) commonIssues.push("NAVER_DELIVERY_COST_MISSING");
    for (const [kind, value] of [["SHIPPING_INCOME", delivery.customerPaidDeliveryFee], ["SHIPPING_COST", delivery.estimatedDeliveryBaseCost]] as const) {
      if (value === null) continue;
      try { money(value); }
      catch { commonReadIssues.push("NAVER_DELIVERY_AMOUNT_INVALID"); commonIssues.push("NAVER_DELIVERY_AMOUNT_INVALID"); continue; }
      addExpense(delivery.basis === "STORED_SUMMARY" ? "daily_store_summaries" : "order_items", delivery.sourceId, kind, value, delivery.calculatedAt);
    }
  }
  for (const fake of [...input.fakePurchases].sort((a, b) => a.id.localeCompare(b.id))) {
    assertOffsetTimestamp(fake.updatedAt);
    try { money(fake.amount); }
    catch { invalidFakeRows++; commonReadIssues.push("NAVER_FAKE_PURCHASE_AMOUNT_INVALID"); commonIssues.push("NAVER_FAKE_PURCHASE_AMOUNT_INVALID"); continue; }
    addExpense("daily_fake_purchases", fake.id, "FAKE_PURCHASE", fake.amount, fake.updatedAt);
  }
  const adAsOf = latestTimestamp(active.map(row => row.updatedAt));
  const stored = naverStoredDiagnostics(input.storedSummaries ?? [], adAsOf);
  commonIssues.push(...stored.issues);
  const completeAds = active.length > 0 && adSourceIssues.length === 0;
  const completeCommon = !!input.delivery?.complete && input.delivery.customerPaidDeliveryFee !== null &&
    input.delivery.estimatedDeliveryBaseCost !== null && !commonReadIssues.length;
  const fingerprint = hash(["naver-ad-common-v1", input, request.nameRuleVersion, request.allocationRuleVersion, request.calculationVersion]);
  const adPresent = ads.length > 0 || completeAds;
  const adTotal = adPresent && !invalidAdRows ? sum(ads.map(row => row.amountKrw!)) : null;
  const assigned = adPresent ? sum(ads.filter(row => row.productName !== null).map(row => row.amountKrw!)) : null;
  const unallocated = adPresent ? sum(ads.filter(row => row.productName === null).map(row => row.amountKrw!)) : null;
  const coverage = (component: "AD_SPEND" | "COMMON_EXPENSE", count: number, complete: boolean, issues: string[]): SourceCoverage => ({
    sourceSystem: component === "AD_SPEND" ? "NAVER_DA" : "NAVER_SMARTSTORE", platform: "NAVER", component,
    scopeKey: input.scopeKey, date: input.date, participation: "INCLUDED",
    collectionState: complete ? "COMPLETE" : count || issues.some(issue => issue.endsWith("READ_FAILED")) ? "PARTIAL" : "NOT_COLLECTED",
    rowsPresent: count, zeroConfirmed: complete && count === 0, selectedSource: component === "AD_SPEND" ? active.length ? "NAVER_DA_XLSX" : null : input.delivery?.basis ?? null,
    selectedUploadId: component === "AD_SPEND" && active.length === 1 ? active[0].id : null, sourceVersion: input.sourceVersion,
    collectedAt: component === "AD_SPEND" ? adAsOf : input.syncState?.lastSuccessfulSyncAt ?? null,
    sourceAsOf: component === "AD_SPEND" ? adAsOf : input.delivery?.calculatedAt ?? input.syncState?.lastSuccessfulSyncAt ?? null,
    calculatedAt: component === "AD_SPEND" ? null : input.delivery?.calculatedAt ?? stored.calculatedAt,
    lastSuccessAt: component === "AD_SPEND" ? adAsOf : input.syncState?.lastSuccessfulSyncAt ?? null,
    sourceFingerprint: fingerprint, nameRuleVersion: request.nameRuleVersion, costRuleVersion: request.saleUnitRuleVersion,
    mappedRows: component === "AD_SPEND" ? ads.filter(row => row.productName !== null).length : 0,
    unmappedRows: component === "AD_SPEND" ? ads.filter(row => row.productName === null).length : 0,
    unmatchedAmount: component === "AD_SPEND" ? unallocated : null, missingCostRows: 0, missingFxAmount: "0.000000",
    unallocatedAmount: component === "AD_SPEND" ? unallocated : expenses.length || complete ? sum(expenses.map(row => row.amountKrw!)) : null,
    quality: estimate(["NAVER_ESTIMATED_SOURCE", ...issues]) });
  const next = new Date(Date.parse(`${input.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const batch: AdapterBatch = { sales: [], adSpends: ads, commonExpenses: expenses,
    coverage: [coverage("AD_SPEND", ads.length + invalidAdRows, completeAds, [...adSourceIssues, ...adConfidenceIssues, ...ads.flatMap(row => row.quality.issues)]),
      coverage("COMMON_EXPENSE", expenses.length + invalidFakeRows, completeCommon, commonIssues)],
    sourceControlTotals: [{ measure: "AD_SPEND", sourceSystem: "NAVER_DA", platform: "NAVER", scopeKey: input.scopeKey, date: input.date,
      currency: "KRW", selectedRows: selected.length, selectedAmount: adTotal, assignedAmount: assigned, unmatchedAmount: "0.000000",
      unallocatedAmount: unallocated, excludedNonSaleAmount: "0.000000", excludedByPolicyRows: input.ads.length - selected.length,
      roundingAdjustment: "0.000000", difference: adTotal === null ? null : quantizeMoney(money(adTotal).minus(assigned!).minus(unallocated!)) }],
    nextCursor: next <= request.to ? next : null, sourceFingerprint: fingerprint };
  assertAdapterBatch(request, "NAVER", batch); return batch;
}
