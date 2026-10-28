import { createHash } from "node:crypto";
import { Prisma, SourceCoverage as StoredCoverage } from "@prisma/client";
import { assertAdapterBatch, assertAdapterRequest } from "../adapter-contract";
import { ExactDecimal as D, decimal, microsToAmount, money, quantizeMoney, ratio } from "../domain/decimal";
import { assertBusinessDate, CatalogProduct, NameRule, resolveProductName } from "../domain/product-name-resolver";
import { UnifiedManagementRepository } from "../management.repository";
import type { AdapterBatch, AdapterRequest, AdSpendFact, ControlTotal, FxEvidence, SourceCoverage } from "../types";

export const adHash = (input: unknown): string => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export const day = (value: Date): string => value.toISOString().slice(0, 10);
export const iso = (value: Date | null | undefined): string | null => value?.toISOString() ?? null;
export const sum = (values: readonly string[]): Prisma.Decimal => values.reduce((total, value) => total.plus(value), new D(0));
export type AdPlatform = "META" | "GOOGLE";
export type AdConfiguration = { products: readonly CatalogProduct[]; nameRules: readonly NameRule[] };
export type AdRow = {
  id: string; entityKey: string; originalName: string; source: "API" | "CSV";
  sourceVersion: string; runOrUploadId: string | null; observedAt: string; updatedAt: string;
  amount: string; conversionRevenue: string | null;
};
export type AdDayInput = {
  platform: AdPlatform; date: string; scopeKey: string; currency: string; timeZone: string;
  rows: readonly AdRow[]; selectedSource: "API" | "CSV" | null; complete: boolean;
  sourceIssues: readonly string[]; storedCoverage: StoredCoverage | null;
  fx: { rate: string; sourceDate: string; provider: string; fallbackType: string } | null;
  legacyFx?: ReadonlyMap<string, { rate: string; sourceDate: string; ruleId: string }>;
  sourceSelectionEvidence?: unknown;
  /** Current rows observed but withheld because their atomic API publication could not be proven. */
  unverifiedRows?: number;
  excludedRows: number; configuration: AdConfiguration;
};

/** One day is indivisible: conversion residuals and source controls cannot cross pages. */
export function adPageDate(request: AdapterRequest, platform: AdPlatform): string {
  assertAdapterRequest(request, platform);
  const date = request.cursor ?? request.from;
  assertBusinessDate(date);
  if (date < request.from || date > request.to) throw new Error("Ad cursor escaped the requested range.");
  return date;
}

export function adConfiguration(snapshot: Awaited<ReturnType<UnifiedManagementRepository["snapshot"]>>, request: AdapterRequest): AdConfiguration {
  for (const key of ["scopePolicyVersion", "nameRuleVersion", "saleUnitRuleVersion", "allocationRuleVersion"] as const)
    if (request[key] !== snapshot.versions[key]) throw new Error(`STALE_CONFIGURATION:${key}`);
  return { products: snapshot.products.map(product => ({ canonicalName: product.canonicalName, active: product.active })),
    nameRules: snapshot.rules.filter(rule => rule.kind === "NAME").flatMap(rule => {
      const product = snapshot.products.find(product => product.id === rule.productId);
      return product ? [{ ...(rule.payload as unknown as Omit<NameRule, "id" | "canonicalProductName" | "validFrom">),
        id: rule.id, canonicalProductName: product.canonicalName, platform: rule.platform as NameRule["platform"],
        scopeKey: rule.scopeKey, validFrom: day(rule.validFrom), validTo: rule.validTo ? day(rule.validTo) : null, active: rule.active }] : [];
    }) };
}

export function assertAdScope(scope: string, platform: AdPlatform): void {
  if (platform === "META" && scope === "LEGACY_UNBOUND") return;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scope))
    throw new Error("Ad scope must be an authorized source connection key.");
}

/** Pure normalization keeps the exact source amount independent of classification and FX. */
export function normalizeAdDay(request: AdapterRequest, input: AdDayInput): AdapterBatch {
  assertAdapterRequest(request, input.platform);
  if (request.scopeKeys[0] !== input.scopeKey || input.date < request.from || input.date > request.to)
    throw new Error("Ad day escaped the requested scope.");
  if (input.rows.length > request.limit) throw new Error("AD_DAY_EXCEEDS_PAGE_LIMIT: request a larger day limit.");
  if (new Set(input.rows.map(row => row.entityKey)).size !== input.rows.length) throw new Error("Duplicate selected ad entity/day.");
  const system = input.platform === "META" ? "META_ADSET" : "GOOGLE_CAMPAIGN";
  const table = input.platform === "META" ? "meta_adset_daily_metrics" : "google_campaign_daily_costs";
  const rows = [...input.rows].sort((a, b) => a.entityKey.localeCompare(b.entityKey, "en"));
  const fingerprint = adHash([system, input.scopeKey, input.date, input.currency, input.timeZone, input.selectedSource,
    input.complete, input.unverifiedRows ?? 0, input.storedCoverage?.lastSuccessRunId, input.sourceIssues, input.fx,
    [...input.legacyFx?.entries() ?? []].sort(([a], [b]) => a.localeCompare(b)), input.sourceSelectionEvidence ?? null, rows]);
  const exact = new Map<string, Prisma.Decimal>();
  const facts: AdSpendFact[] = rows.map(row => {
    const name = resolveProductName({ originalName: row.originalName, nameField: input.platform === "META" ? "adset_name" : "campaign_name",
      platform: input.platform, scopeKey: input.scopeKey, businessDate: input.date }, input.configuration.products, input.configuration.nameRules, request.nameRuleVersion);
    const originalAmount = input.platform === "GOOGLE" ? microsToAmount(row.amount) : quantizeMoney(money(row.amount));
    const issues = [...input.sourceIssues];
    if (name.matchStatus !== "MATCHED") issues.push(`NAME_${name.matchStatus}`);
    if (input.timeZone !== "Asia/Seoul") issues.push("TIME_ZONE_MISMATCH");
    let fx: FxEvidence = { baseCurrency: input.currency, quoteCurrency: "KRW", requestedDate: input.date,
      sourceDate: null, rate: null, provider: null, fallbackType: "MISSING", fxVersion: request.fxVersion };
    const legacy = name.matchStatus === "MATCHED" && name.canonicalProductName ? input.legacyFx?.get(name.canonicalProductName) : null;
    const supportedCurrency = input.platform !== "META" || input.currency === "USD";
    if (!supportedCurrency) issues.push("META_CURRENCY_MISMATCH");
    else if (input.currency === "KRW") fx = { ...fx, sourceDate: input.date, rate: "1", provider: "IDENTITY", fallbackType: "IDENTITY" };
    else if (input.fx && ratio(input.fx.rate).gt(0)) fx = { ...fx, ...input.fx };
    else if (input.platform === "META" && legacy && ratio(legacy.rate).gt(0)) {
      fx = { ...fx, rate: legacy.rate, sourceDate: legacy.sourceDate, provider: "PRODUCT_COST_RULE", fallbackType: `LEGACY_PRODUCT_RULE:${legacy.ruleId}` };
      issues.push("LEGACY_PRODUCT_FX_FALLBACK");
    }
    let amountKrw: string | null = null;
    if (fx.rate !== null) {
      const value = decimal(originalAmount).mul(fx.rate);
      exact.set(row.entityKey, value);
      amountKrw = quantizeMoney(value);
    } else issues.push("MISSING_EXCHANGE_RATE");
    return { ref: { sourceSystem: system, platform: input.platform, schema: "meta_ads", table, scopeKey: input.scopeKey,
      recordKind: "AD_SPEND", sourceRecordKey: `${input.date}:${row.entityKey}`, selectedSource: input.scopeKey === "LEGACY_UNBOUND" ? "LEGACY_UNBOUND" : row.source,
      sourceVersion: row.sourceVersion, uploadOrRunId: row.runOrUploadId, payloadHash: adHash(row), providerUpdatedAt: row.updatedAt,
      observedAt: row.observedAt, businessDate: input.date, dateBasis: "metric_date", sourceTimeZone: input.timeZone },
      name, productName: name.matchStatus === "MATCHED" ? name.canonicalProductName : null, medium: input.platform,
      originalAmount, currency: input.currency, fx, amountKrw, roundingAdjustment: "0.000000",
      preQuantizationFingerprint: adHash([originalAmount, fx, exact.get(row.entityKey)?.toFixed() ?? null]),
      attribution: name.matchStatus === "MATCHED" ? "DIRECT" : "UNALLOCATED", allocationRuleVersion: request.allocationRuleVersion,
      referenceConversionRevenue: row.conversionRevenue === null ? null : quantizeMoney(money(row.conversionRevenue)),
      quality: { isEstimate: false, confidence: "SOURCE_REPORTED", issues: [...new Set(issues)] } };
  });
  // Target is the sum of exact converted values rounded once, with deterministic micro-won residuals.
  const converted = facts.flatMap((fact, index) => fact.amountKrw === null ? [] : [{ fact, key: rows[index].entityKey,
    residual: exact.get(rows[index].entityKey)!.minus(fact.amountKrw) }]);
  const target = sum([...exact.values()].map(value => value.toFixed())).toDecimalPlaces(6);
  let residual = target.minus(sum(converted.map(row => row.fact.amountKrw!)));
  converted.sort((a, b) => (residual.isNegative() ? a.residual.cmp(b.residual) : b.residual.cmp(a.residual)) || (a.key < b.key ? -1 : 1));
  for (const row of converted) {
    if (residual.isZero()) break;
    const change = residual.isNegative() ? "-0.000001" : "0.000001";
    row.fact.amountKrw = quantizeMoney(decimal(row.fact.amountKrw!).plus(change));
    row.fact.roundingAdjustment = change;
    residual = residual.minus(change);
  }
  if (!residual.isZero()) throw new Error("Ad conversion residual was not conserved.");
  const present = facts.length > 0 || input.complete;
  const controls: ControlTotal[] = [];
  const control = (currency: string, value: (fact: AdSpendFact) => string | null) => {
    const values = facts.map(value), known = (subset: AdSpendFact[]) => quantizeMoney(sum(subset.flatMap(fact => value(fact) === null ? [] : [value(fact)!])));
    const selected = present && values.every(value => value !== null) ? quantizeMoney(sum(values as string[])) : null;
    const assigned = present ? known(facts.filter(fact => fact.productName !== null)) : null;
    const unmatched = present ? known(facts.filter(fact => fact.productName === null)) : null;
    controls.push({ measure: "AD_SPEND", sourceSystem: system, platform: input.platform, scopeKey: input.scopeKey, date: input.date, currency,
      selectedRows: facts.length, selectedAmount: selected, assignedAmount: assigned, unmatchedAmount: unmatched, unallocatedAmount: present ? "0.000000" : null,
      excludedNonSaleAmount: "0.000000", excludedByPolicyRows: input.excludedRows,
      roundingAdjustment: currency === "KRW" ? quantizeMoney(sum(facts.map(fact => fact.roundingAdjustment))) : "0.000000",
      difference: selected === null ? null : quantizeMoney(decimal(selected).minus(assigned!).minus(unmatched!)) });
  };
  control(input.currency, fact => fact.originalAmount);
  if (input.currency !== "KRW") control("KRW", fact => fact.amountKrw);
  const issues = [...new Set([...input.sourceIssues, ...facts.flatMap(fact => fact.quality.issues)])];
  const stored = input.storedCoverage;
  const coverage: SourceCoverage = { sourceSystem: system, platform: input.platform, component: "AD_SPEND", scopeKey: input.scopeKey, date: input.date,
    participation: "INCLUDED", collectionState: input.complete ? issues.includes("STALE_DATA") ? "STALE" : "COMPLETE" : facts.length || input.unverifiedRows ? "PARTIAL" : "NOT_COLLECTED",
    rowsPresent: facts.length + (input.unverifiedRows ?? 0), zeroConfirmed: facts.length === 0 && input.complete && !issues.includes("STALE_DATA"),
    selectedSource: input.selectedSource, selectedUploadId: facts.length && new Set(facts.map(fact => fact.ref.uploadOrRunId)).size === 1 ? facts[0].ref.uploadOrRunId : null,
    sourceVersion: fingerprint, collectedAt: iso(stored?.lastSuccessAt), sourceAsOf: iso(stored?.lastSuccessAt) ?? rows.map(row => row.observedAt).sort().at(-1) ?? null,
    calculatedAt: null, lastSuccessAt: iso(stored?.lastSuccessAt), sourceFingerprint: fingerprint,
    nameRuleVersion: request.nameRuleVersion, costRuleVersion: request.saleUnitRuleVersion, mappedRows: facts.filter(fact => fact.productName !== null).length,
    unmappedRows: facts.filter(fact => fact.productName === null).length,
    unmatchedAmount: present ? quantizeMoney(sum(facts.filter(fact => fact.productName === null).map(fact => fact.originalAmount))) : null,
    missingCostRows: 0, missingFxAmount: present ? quantizeMoney(sum(facts.filter(fact => fact.amountKrw === null).map(fact => fact.originalAmount))) : null,
    unallocatedAmount: present ? quantizeMoney(sum(facts.filter(fact => fact.productName === null && fact.amountKrw !== null).map(fact => fact.amountKrw!))) : null,
    quality: { isEstimate: false, confidence: "SOURCE_REPORTED", issues } };
  const nextDate = day(new Date(Date.parse(input.date) + 86400000));
  const batch: AdapterBatch = { sales: [], commonExpenses: [], adSpends: facts, coverage: [coverage], sourceControlTotals: controls,
    nextCursor: nextDate <= request.to ? nextDate : null, sourceFingerprint: fingerprint };
  assertAdapterBatch(request, input.platform, batch);
  return batch;
}
