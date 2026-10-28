import { createHash } from "node:crypto";
import { assertAdapterBatch, assertAdapterRequest, assertOffsetTimestamp } from "../adapter-contract";
import { ExactDecimal as D, money, quantizeMoney } from "../domain/decimal";
import { assertBusinessDate, CatalogProduct, NameRule, ProductNameResolution, resolveProductName } from "../domain/product-name-resolver";
import type { AdapterBatch, AdapterRequest, AdSpendFact, ControlTotal, SourceCoverage } from "../types";

export const COUPANG_UPLOAD_SCOPE = "LEGACY_COUPANG_SINGLE_UPLOAD";
export type CoupangAdsRow = {
  id: string;
  adMetricKey: string;
  adExecutionProductName: string;
  /** Collected text only; never synthesize this from the external option ID. */
  adExecutionOptionName?: string | null;
  adExecutionOptionId?: string | null;
  campaignName?: string | null;
  adGroupName?: string | null;
  adName?: string | null;
  adSpendKrw: string;
  totalConversionSales1dKrw: string | null;
  conversionProductName?: string | null;
  conversionProductId?: string | null;
  uploadBatchId: string | null;
  sourceVersion: string;
  observedAt: string;
  updatedAt: string | null;
};
/** The reader supplies selected current, non-error rows from completed uploads. */
export type CoupangAdsDayInput = {
  date: string;
  scopeKey: string;
  rows: readonly CoupangAdsRow[];
  complete: boolean;
  selectedSource?: string | null;
  collectedAt?: string | null;
  sourceIssues?: readonly string[];
  excludedRows?: number;
  unverifiedRows?: number;
  selectionEvidence?: unknown;
  configuration: { products: readonly CatalogProduct[]; nameRules: readonly NameRule[] };
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sum = (values: readonly string[]) => values.reduce((total, value) => total.plus(value), new D(0));
const placeholder = (value: string | null | undefined) => !value?.trim() || value.trim() === "-";

function spendName(request: AdapterRequest, input: CoupangAdsDayInput, row: CoupangAdsRow): ProductNameResolution {
  const resolve = (originalName: string, nameField: string, fallback: boolean) => resolveProductName({ originalName,
    originalOption: row.adExecutionOptionName, nameField, restorationPath: fallback ? `PLACEHOLDER_EXECUTION_NAME:${nameField}` : null,
    platform: "COUPANG", scopeKey: input.scopeKey, businessDate: input.date },
  fallback ? input.configuration.products.map(product => ({ ...product, active: false })) : input.configuration.products,
  fallback ? input.configuration.nameRules.filter(rule => rule.nameField === nameField) : input.configuration.nameRules,
  request.nameRuleVersion);
  if (!placeholder(row.adExecutionProductName)) return resolve(row.adExecutionProductName, "ad_execution_product_name", false);
  // A missing execution name permits only explicit field-scoped rules, never the conversion product.
  const alternatives = ([ [row.adName, "ad_name"], [row.adGroupName, "ad_group_name"], [row.campaignName, "campaign_name"] ] as const)
    .filter(([name, field]) => !placeholder(name) && input.configuration.nameRules.some(rule => rule.nameField === field))
    .map(([name, field]) => resolve(name!, field, true));
  const candidates = [...new Set(alternatives.flatMap(value => value.candidateNames))].sort();
  const successful = alternatives.filter(value => value.matchStatus === "MATCHED");
  const base = successful[0] ?? alternatives.find(value => value.candidateNames.length) ?? alternatives[0] ?? resolve("", "ad_execution_product_name", false);
  if (!alternatives.length) return base;
  const evidence = { ...base, nameInputHash: hash(alternatives.map(value => value.nameInputHash)),
    candidateNames: candidates, ruleIds: [...new Set(alternatives.flatMap(value => value.ruleIds))].sort() };
  if (candidates.length > 1 || alternatives.some(value => value.matchStatus === "AMBIGUOUS"))
    return { ...evidence, canonicalProductName: null, saleUnitName: null, matchStatus: "AMBIGUOUS", reasons: ["CONFLICTING_SPEND_NAME_FIELDS"] };
  return evidence;
}

/** No sales fact is created from an advertising conversion metric. */
export function normalizeCoupangAdsDay(request: AdapterRequest, input: CoupangAdsDayInput): AdapterBatch {
  assertAdapterRequest(request, "COUPANG"); assertBusinessDate(input.date);
  if (input.scopeKey !== COUPANG_UPLOAD_SCOPE || request.scopeKeys[0] !== input.scopeKey || input.date < request.from || input.date > request.to)
    throw new Error("Coupang ads day escaped the confirmed single-upload scope/date.");
  if (input.rows.length > request.limit) throw new Error("COUPANG_AD_DAY_EXCEEDS_PAGE_LIMIT");
  if (input.collectedAt != null) assertOffsetTimestamp(input.collectedAt);
  for (const count of [input.excludedRows ?? 0, input.unverifiedRows ?? 0])
    if (!Number.isInteger(count) || count < 0) throw new Error("Invalid Coupang ads evidence row count.");
  const rows = [...input.rows].sort((a, b) => a.adMetricKey < b.adMetricKey ? -1 : a.adMetricKey > b.adMetricKey ? 1 : 0);
  if (new Set(rows.map(row => row.adMetricKey)).size !== rows.length || rows.some(row => !row.adMetricKey))
    throw new Error("Duplicate or missing selected Coupang ad key.");
  const sourceIssues = [...new Set(input.sourceIssues ?? [])].sort();
  const complete = input.complete && !(input.unverifiedRows ?? 0);
  const fingerprint = hash(["COUPANG_ADS", input.scopeKey, input.date, input.selectedSource ?? null, complete,
    input.collectedAt ?? null, sourceIssues, input.excludedRows ?? 0, input.unverifiedRows ?? 0, input.selectionEvidence ?? null,
    request.nameRuleVersion, request.saleUnitRuleVersion, request.allocationRuleVersion, request.calculationVersion,
    [...input.configuration.products].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)),
    [...input.configuration.nameRules].sort((a, b) => a.id.localeCompare(b.id)), rows]);
  const facts: AdSpendFact[] = rows.map(row => {
    const name = spendName(request, input, row);
    const amount = quantizeMoney(money(row.adSpendKrw));
    const issues = [...sourceIssues];
    if (name.matchStatus !== "MATCHED") issues.push(`NAME_${name.matchStatus}`);
    return { ref: { sourceSystem: "COUPANG_ADS", platform: "COUPANG", schema: "meta_ads", table: "coupang_ad_metrics",
      scopeKey: input.scopeKey, recordKind: "AD_SPEND", sourceRecordKey: `${input.date}:${row.adMetricKey}`,
      selectedSource: input.selectedSource ?? "CSV", sourceVersion: row.sourceVersion, uploadOrRunId: row.uploadBatchId,
      payloadHash: hash(row), providerUpdatedAt: row.updatedAt, observedAt: row.observedAt,
      businessDate: input.date, dateBasis: "metric_date", sourceTimeZone: "Asia/Seoul" },
      name, productName: name.matchStatus === "MATCHED" ? name.canonicalProductName : null, medium: "COUPANG_ADS",
      originalAmount: amount, currency: "KRW", fx: { baseCurrency: "KRW", quoteCurrency: "KRW", requestedDate: input.date,
        sourceDate: input.date, rate: "1", provider: "IDENTITY", fallbackType: "IDENTITY", fxVersion: request.fxVersion },
      amountKrw: amount, roundingAdjustment: "0.000000", preQuantizationFingerprint: hash([row.adSpendKrw, "KRW", "1"]),
      attribution: name.matchStatus === "MATCHED" ? "DIRECT" : "UNALLOCATED", allocationRuleVersion: request.allocationRuleVersion,
      referenceConversionRevenue: row.totalConversionSales1dKrw === null ? null : quantizeMoney(money(row.totalConversionSales1dKrw)),
      quality: { isEstimate: false, confidence: "SOURCE_REPORTED", issues: [...new Set(issues)].sort() } };
  });
  const present = facts.length > 0 || complete;
  const selected = present ? quantizeMoney(sum(facts.map(fact => fact.amountKrw!))) : null;
  const assigned = present ? quantizeMoney(sum(facts.filter(fact => fact.productName !== null).map(fact => fact.amountKrw!))) : null;
  const unmatched = present ? quantizeMoney(sum(facts.filter(fact => fact.productName === null).map(fact => fact.amountKrw!))) : null;
  const control: ControlTotal = { measure: "AD_SPEND", sourceSystem: "COUPANG_ADS", platform: "COUPANG", scopeKey: input.scopeKey,
    date: input.date, currency: "KRW", selectedRows: facts.length, selectedAmount: selected, assignedAmount: assigned, unmatchedAmount: unmatched,
    unallocatedAmount: present ? "0.000000" : null, excludedNonSaleAmount: "0.000000", excludedByPolicyRows: input.excludedRows ?? 0,
    roundingAdjustment: "0.000000", difference: selected === null ? null : quantizeMoney(money(selected).minus(assigned!).minus(unmatched!)) };
  const issues = [...new Set([...sourceIssues, ...facts.flatMap(fact => fact.quality.issues),
    ...(input.unverifiedRows ? ["UNVERIFIED_AD_SOURCE_ROWS"] : [])])].sort();
  const stale = issues.includes("STALE_DATA");
  const coverage: SourceCoverage = { sourceSystem: "COUPANG_ADS", platform: "COUPANG", component: "AD_SPEND", scopeKey: input.scopeKey,
    date: input.date, participation: "INCLUDED", collectionState: complete ? stale ? "STALE" : "COMPLETE" : facts.length || input.unverifiedRows ? "PARTIAL" : "NOT_COLLECTED",
    rowsPresent: facts.length + (input.unverifiedRows ?? 0), zeroConfirmed: complete && !stale && facts.length === 0,
    selectedSource: input.selectedSource ?? (present ? "CSV" : null),
    selectedUploadId: facts.length && new Set(facts.map(fact => fact.ref.uploadOrRunId)).size === 1 ? facts[0].ref.uploadOrRunId : null,
    sourceVersion: fingerprint, collectedAt: input.collectedAt ?? null,
    sourceAsOf: input.collectedAt ?? rows.map(row => row.observedAt).sort().at(-1) ?? null,
    calculatedAt: null, lastSuccessAt: input.collectedAt ?? null, sourceFingerprint: fingerprint,
    nameRuleVersion: request.nameRuleVersion, costRuleVersion: request.saleUnitRuleVersion,
    mappedRows: facts.filter(fact => fact.productName !== null).length, unmappedRows: facts.filter(fact => fact.productName === null).length,
    unmatchedAmount: unmatched, missingCostRows: 0, missingFxAmount: present ? "0.000000" : null,
    unallocatedAmount: unmatched, quality: { isEstimate: false, confidence: "SOURCE_REPORTED", issues } };
  const nextDate = new Date(Date.parse(`${input.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const batch: AdapterBatch = { sales: [], adSpends: facts, commonExpenses: [], coverage: [coverage], sourceControlTotals: [control],
    nextCursor: nextDate <= request.to ? nextDate : null, sourceFingerprint: fingerprint };
  assertAdapterBatch(request, "COUPANG", batch);
  return batch;
}
