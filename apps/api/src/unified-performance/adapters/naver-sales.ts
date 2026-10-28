import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { assertAdapterBatch, assertAdapterRequest } from "../adapter-contract";
import { ExactDecimal as D, money, quantity, quantizeMoney, ratio } from "../domain/decimal";
import { assertBusinessDate, normalizeProductName, resolveProductName, type CatalogProduct, type NameRule } from "../domain/product-name-resolver";
import type { AdapterBatch, AdapterRequest, ControlTotal, SaleFact, SourceCoverage } from "../types";

/** Selected fields only: deliberately excludes external product IDs and order/customer payloads. */
export interface NaverOrderRow {
  id: string; externalProductOrderId: string; orderSourceSignatureId: string | null;
  canonicalSalesUnitId: string | null; rawProductName: string | null; rawOptionInfo: string | null;
  /** Same-store products name projection; reference IDs restore text only. */
  productNameFallback?: string | null;
  paymentDate: string | null; saleStatus: string; quantity: string | null; productPaymentAmount: string | null;
  paymentCommission: string | null; knowledgeShoppingSellingInterlockCommission: string | null;
  saleCommission: string | null; channelCommission: string | null; updatedAt: string | null;
}
export interface NaverOrderSignature {
  id: string; rawProductNameSnapshot: string | null; rawOptionInfoSnapshot: string | null;
}
export interface NaverSalesUnit {
  id: string; displayName: string; matchAliases: readonly string[]; parentSalesUnitId: string | null;
  isGroup: boolean; isActive?: boolean; isStoreLevel?: boolean;
}
export interface NaverCostValues { unitCost: string | null; otherCost: string | null; feeRate: string | null }
export interface NaverCostSetting extends NaverCostValues {
  id: string; canonicalSalesUnitId: string; isActive: boolean; effectiveFrom: string; effectiveTo: string | null;
  updatedAt: string; costValuesUpdatedAt?: string | null;
}
export interface NaverCostSnapshot { id: string; effectiveFrom: string; updatedAt: string }
export interface NaverCostEntry extends NaverCostValues { id: string; snapshotId: string; canonicalSalesUnitId: string }
export interface NaverSalesDayInput {
  date: string; scopeKey: string; observedAt: string; collectedAt: string | null; sourceVersion: string;
  complete: boolean; sourceIssues: readonly string[];
  rows: readonly NaverOrderRow[]; signatures: readonly NaverOrderSignature[]; salesUnits: readonly NaverSalesUnit[];
  costSettings: readonly NaverCostSetting[]; costSnapshots: readonly NaverCostSnapshot[]; costEntries: readonly NaverCostEntry[];
  configuration: { products: readonly CatalogProduct[]; nameRules: readonly NameRule[] };
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const zero = () => new D(0);
const sum = (values: readonly string[]) => values.reduce((total, value) => total.plus(value), zero());
const nonblank = (value: string | null | undefined) => value?.trim() ? value : null;
function parsed(value: string | null, kind: "money" | "quantity" | "ratio" = "money", nonnegative = true) {
  try {
    if (value === null) return null;
    const result = kind === "quantity" ? quantity(value) : kind === "ratio" ? ratio(value) : money(value);
    return nonnegative && result.isNegative() || kind === "ratio" && result.gt(1) ? null : result;
  } catch { return null; }
}
type SelectedCost = { values: NaverCostValues | null; ref: string | null; from: string | null; to: string | null; issues: string[] };
/** Mirrors the reference helper: an omitted snapshot cell or expired winning manual source never revives older cost. */
export function selectNaverCost(date: string, unitId: string, input: Pick<NaverSalesDayInput, "costSnapshots" | "costEntries" | "costSettings">): SelectedCost {
  const snapshots = input.costSnapshots.filter(s => s.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const snapshot = snapshots[0];
  const manuals = input.costSettings.filter(s => s.canonicalSalesUnitId === unitId && s.isActive && s.effectiveFrom <= date)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const manual = manuals[0];
  if (snapshot && snapshots.filter(s => s.effectiveFrom === snapshot.effectiveFrom).length > 1)
    return { values: null, ref: null, from: snapshot.effectiveFrom, to: null, issues: ["COST_SNAPSHOT_AMBIGUOUS"] };
  if (manual && !Number.isFinite(Date.parse(manual.costValuesUpdatedAt ?? manual.updatedAt)) ||
      snapshot && !Number.isFinite(Date.parse(snapshot.updatedAt)))
    return { values: null, ref: null, from: null, to: null, issues: ["COST_VALUE_TIMESTAMP_INVALID"] };
  const useManual = manual && (!snapshot || manual.effectiveFrom > snapshot.effectiveFrom ||
    manual.effectiveFrom === snapshot.effectiveFrom && Date.parse(manual.costValuesUpdatedAt ?? manual.updatedAt) >= Date.parse(snapshot.updatedAt));
  if (useManual) {
    if (manuals.filter(s => s.effectiveFrom === manual.effectiveFrom && Date.parse(s.updatedAt) === Date.parse(manual.updatedAt)).length > 1)
      return { values: null, ref: null, from: manual.effectiveFrom, to: manual.effectiveTo, issues: ["COST_SETTING_AMBIGUOUS"] };
    return { values: manual.effectiveTo && date > manual.effectiveTo ? null : manual, ref: `sales_unit_cost_settings:${manual.id}`,
      from: manual.effectiveFrom, to: manual.effectiveTo, issues: manual.effectiveTo && date > manual.effectiveTo ? ["COST_SETTING_EXPIRED"] : [] };
  }
  const entries = input.costEntries.filter(e => e.snapshotId === snapshot?.id && e.canonicalSalesUnitId === unitId);
  return { values: entries.length === 1 ? entries[0] : null, ref: snapshot ? `sales_unit_cost_snapshots:${snapshot.id}` : null,
    from: snapshot?.effectiveFrom ?? null, to: null,
    issues: !snapshot ? ["COST_SOURCE_MISSING"] : entries.length !== 1 ? [entries.length ? "COST_ENTRY_AMBIGUOUS" : "COST_SNAPSHOT_UNIT_OMITTED"] : [] };
}

/** Name-only unit lookup. IDs are never compared to an external product/option key. */
function findUnit(name: string, option: string | null, units: readonly NaverSalesUnit[], resolvedUnit: string | null | undefined,
  compatible: (unit: NaverSalesUnit) => boolean, baseProductName: string | null) {
  const candidates = units.filter(u => !u.isGroup && !u.isStoreLevel);
  const exact = (text: string) => candidates.filter(u => [u.displayName, ...u.matchAliases].some(alias =>
    normalizeProductName(alias) === normalizeProductName(text)) && compatible(u));
  for (const text of [option ? `${name} ${option}` : null, option]) {
    if (!nonblank(text)) continue;
    const matches = exact(text!);
    if (matches.length) return matches;
  }
  const optionMatches = nonblank(option) ? candidates.filter(unit => [unit.displayName, ...unit.matchAliases].some(alias => {
    const normalized = normalizeProductName(alias);
    return normalized && normalized !== normalizeProductName(baseProductName) && normalizeProductName(option).includes(normalized);
  }) && compatible(unit)) : [];
  if (optionMatches.length) return optionMatches;
  for (const text of [resolvedUnit, name]) {
    if (!nonblank(text)) continue;
    const matches = exact(text!);
    if (matches.length) return matches;
  }
  const lookups = [name, option ?? "", `${name} ${option ?? ""}`].map(normalizeProductName);
  return candidates.filter(u => u.matchAliases.some(alias => normalizeProductName(alias) &&
    lookups.some(text => text.includes(normalizeProductName(alias)))) && compatible(u));
}

type Working = { row: NaverOrderRow; fact: SaleFact; revenue: Prisma.Decimal | null; group: string; quantityInvalid: boolean };
/** Deterministic whole-won allocation preserves Math.round(group/day revenue * .1), including signed adjustments. */
function applyGroupVat(rows: Working[]) {
  const groups = new Map<string, Working[]>();
  rows.forEach(row => groups.set(row.group, [...groups.get(row.group) ?? [], row]));
  for (const group of groups.values()) {
    if (group.some(row => row.revenue === null)) {
      group.forEach(row => { row.fact.vatExpense = null; row.fact.quality.issues.push("VAT_GROUP_REVENUE_INCOMPLETE"); });
      continue;
    }
    const total = group.reduce((acc, row) => acc.plus(row.revenue!), zero());
    const vat = total.mul("0.1").plus("0.5").floor();
    const parts = group.map(row => {
      const exact = total.isZero() ? zero() : vat.mul(row.revenue!).div(total);
      const base = exact.floor();
      return { row, base, remainder: exact.minus(base) };
    });
    let remaining = vat.minus(parts.reduce((acc, p) => acc.plus(p.base), zero()));
    const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    parts.sort((a, b) => b.remainder.cmp(a.remainder) || order(a.row.fact.productName ?? "", b.row.fact.productName ?? "") ||
      order(a.row.fact.ref.sourceRecordKey, b.row.fact.ref.sourceRecordKey));
    for (const part of parts) {
      if (remaining.gt(0)) { part.base = part.base.plus(1); remaining = remaining.minus(1); }
      part.row.fact.vatExpense = quantizeMoney(part.base);
    }
    if (!remaining.isZero()) throw new Error("NAVER_VAT_ALLOCATION_RESIDUAL");
  }
}

/** SALE/paymentDate are the source's operating basis; canceled/returned amounts are never deducted again. */
export function normalizeNaverSalesDay(request: AdapterRequest, input: NaverSalesDayInput): AdapterBatch {
  assertAdapterRequest(request, "NAVER"); assertBusinessDate(input.date);
  if (input.scopeKey !== request.scopeKeys[0] || input.date < request.from || input.date > request.to) throw new Error("NAVER_SALES_SCOPE_DATE_MISMATCH");
  if (input.rows.length > request.limit) throw new Error("NAVER_SALES_DAY_TOO_LARGE");
  const identities = input.rows.map(row => row.externalProductOrderId || row.id);
  if (new Set(identities).size !== identities.length) throw new Error("NAVER_DUPLICATE_PRODUCT_ORDER");
  for (const source of [...input.costSettings, ...input.costSnapshots]) {
    assertBusinessDate(source.effectiveFrom);
    if ("effectiveTo" in source && typeof source.effectiveTo === "string") assertBusinessDate(source.effectiveTo);
  }
  const unitById = new Map(input.salesUnits.map(unit => [unit.id, unit]));
  const signatureById = new Map(input.signatures.map(signature => [signature.id, signature]));
  const selected = input.rows.filter(row => row.paymentDate === input.date && row.saleStatus === "SALE");
  const working: Working[] = selected.map(row => {
    const issues = [...input.sourceIssues], signature = signatureById.get(row.orderSourceSignatureId ?? "");
    const referenced = unitById.get(row.canonicalSalesUnitId ?? "");
    const raw = nonblank(row.rawProductName), restored = nonblank(signature?.rawProductNameSnapshot);
    const option = nonblank(row.rawOptionInfo) ?? nonblank(signature?.rawOptionInfoSnapshot);
    // Bundled add-ons may share the main product's ID/name; the tagged option explicitly names the actual sold item.
    const bundledName = option?.includes("[함께배송") ? nonblank(option.match(/\]\s*([^:]+?)\s*:/)?.[1]) : null;
    const extracted = !raw && !restored && option ? nonblank((option.match(/\]\s*([^:]+?)\s*:/) ?? option.match(/^([^:]+?)\s*:/))?.[1]) : null;
    const optionResolved = extracted ? resolveProductName({ originalName: extracted, originalOption: option, nameField: "rawOptionInfo",
      platform: "NAVER", scopeKey: input.scopeKey, businessDate: input.date }, input.configuration.products, input.configuration.nameRules, request.nameRuleVersion) : null;
    const optionName = optionResolved?.matchStatus === "MATCHED" ? extracted : null;
    const fallbackProduct = nonblank(row.productNameFallback);
    const originalName = bundledName ?? raw ?? restored ?? optionName ?? fallbackProduct ?? referenced?.displayName ?? null;
    const restorationPath = bundledName ? "rawOptionInfo.BUNDLED_PRODUCT_NAME" : raw ? null : restored ? "public.order_source_signatures.rawProductNameSnapshot" :
      optionName ? "rawOptionInfo.RECOVERED_PRODUCT_NAME" : fallbackProduct ? "public.products.productName" : referenced ? "public.canonical_sales_units.displayName" : null;
    const baseInput = { originalName, originalOption: option, nameField: bundledName || optionName ? "rawOptionInfo" : "rawProductName", restorationPath,
      platform: "NAVER" as const, scopeKey: input.scopeKey, businessDate: input.date };
    const first = resolveProductName(baseInput, input.configuration.products, input.configuration.nameRules, request.nameRuleVersion);
    const compatible = (unit: NaverSalesUnit) => {
      if (!first.canonicalProductName) return true;
      const unitName = resolveProductName({ ...baseInput, originalName: unit.displayName, nameField: "sales_unit_name" },
        input.configuration.products, input.configuration.nameRules, request.nameRuleVersion);
      // Unknown unit names remain candidates; a confirmed different product cannot win on a generic option alias.
      return unitName.canonicalProductName === null || unitName.canonicalProductName === first.canonicalProductName;
    };
    // Check product compatibility only for text-matching units, not every store unit for every order.
    let unitCandidates = findUnit(originalName ?? "", option, input.salesUnits, first.saleUnitName, compatible, first.canonicalProductName);
    let referenceName: ReturnType<typeof resolveProductName> | null = null;
    let referenceCanClassify = false;
    const baseName = normalizeProductName(first.canonicalProductName);
    const baseOnlyUnit = unitCandidates.length === 1 && normalizeProductName(unitCandidates[0].displayName) === baseName &&
      // A title containing the base product is not evidence that a single-unit cost applies.
      ![unitCandidates[0].displayName, ...unitCandidates[0].matchAliases].some(alias => {
        const normalized = normalizeProductName(alias);
        return normalized && normalized !== baseName && [originalName, option].some(text => normalizeProductName(text).includes(normalized));
      }) && !input.configuration.nameRules.some(rule => first.ruleIds.includes(rule.id) && rule.saleUnitName &&
        (rule.optionExact != null || !!rule.optionInclude?.length || !!rule.optionExclude?.length));
    const specificReference = baseOnlyUnit && referenced && normalizeProductName(referenced.displayName) !== normalizeProductName(unitCandidates[0].displayName);
    if ((unitCandidates.length === 0 || specificReference || !raw && first.matchStatus === "UNMATCHED") && referenced && !referenced.isGroup && !referenced.isStoreLevel && first.matchStatus !== "AMBIGUOUS") {
      const restoredUnitName = resolveProductName({ ...baseInput, originalName: referenced.displayName, nameField: "sales_unit_name",
        saleUnitName: referenced.displayName, restorationPath: "public.canonical_sales_units.displayName" },
      input.configuration.products, input.configuration.nameRules, request.nameRuleVersion);
      // The reference restores a name, never an external product mapping. A contradictory classified source name wins.
      const sameProduct = ["MATCHED", "UNIT_REQUIRED"].includes(first.matchStatus) && first.canonicalProductName !== null &&
        first.canonicalProductName === restoredUnitName.canonicalProductName;
      const agreesWithSource = sameProduct || !raw && first.canonicalProductName === null;
      if (restoredUnitName.matchStatus === "MATCHED" && agreesWithSource) {
        const byName = input.salesUnits.filter(unit => !unit.isGroup && !unit.isStoreLevel &&
          normalizeProductName(unit.displayName) === normalizeProductName(referenced.displayName));
        if (byName.length === 1) {
          unitCandidates = byName; referenceName = restoredUnitName;
          referenceCanClassify = sameProduct || !(raw || restored || bundledName || optionName || fallbackProduct);
        }
      }
    }
    let unit = unitCandidates.length === 1 ? unitCandidates[0] : null;
    let name = resolveProductName({ ...baseInput, saleUnitName: unit?.displayName ?? first.saleUnitName },
      input.configuration.products, input.configuration.nameRules, request.nameRuleVersion);
    if (referenceName && unit && referenceCanClassify) name = { ...name, canonicalProductName: referenceName.canonicalProductName,
      saleUnitName: unit.displayName, matchStatus: "MATCHED", candidateNames: unique([...name.candidateNames, ...referenceName.candidateNames]),
      ruleIds: unique([...name.ruleIds, ...referenceName.ruleIds]),
      restorationPath: [name.restorationPath, "public.canonical_sales_units.displayName:SALE_UNIT_NAME_REFERENCE"].filter(Boolean).join(";"),
      nameInputHash: hash(["NAVER_REFERENCE_NAME_RESTORATION_V1", name.nameInputHash, referenceName.nameInputHash, unit.displayName]),
      reasons: ["NAVER_REFERENCE_DISPLAY_NAME_RESOLVED"] };
    if (referenceName) issues.push("NAVER_SALE_UNIT_NAME_RESTORED");
    if (referenceName && !referenceCanClassify) {
      issues.push("NAVER_SOURCE_COST_UNIT_RESTORED_PRODUCT_UNCLASSIFIED");
      name = { ...name, nameInputHash: hash([name.nameInputHash, referenceName.nameInputHash]),
        restorationPath: [name.restorationPath, "public.canonical_sales_units.displayName:COST_UNIT_ONLY"].filter(Boolean).join(";") };
    }
    // An exact source alias may identify a unit whose own display name has the effective unified-name rule.
    const productAliasInName = unit && [unit.displayName, ...unit.matchAliases].some(alias => {
      const key = normalizeProductName(alias);
      return key && !/^(?:단품|세트|기본|(?:\d+\+)*\d+(?:개입|개|세트)?)$/.test(key) && normalizeProductName(originalName).includes(key);
    });
    if (unit && name.matchStatus === "UNMATCHED" && !referenceName && productAliasInName) {
      const canonical = resolveProductName({ ...baseInput, originalName: unit.displayName, saleUnitName: unit.displayName },
        input.configuration.products, input.configuration.nameRules, request.nameRuleVersion);
      if (canonical.matchStatus === "MATCHED") name = { ...name, canonicalProductName: canonical.canonicalProductName,
        saleUnitName: unit.displayName, matchStatus: "MATCHED", candidateNames: canonical.candidateNames,
        ruleIds: canonical.ruleIds, reasons: ["NAVER_NAME_ALIAS_TO_SALE_UNIT"] };
    }
    if (unit && name.matchStatus === "UNMATCHED" && !referenceName && !productAliasInName) {
      unit = null; unitCandidates = []; name = { ...name, saleUnitName: null };
    }
    if (name.matchStatus !== "MATCHED") issues.push(`NAME_${name.matchStatus}`);
    if (!unit) issues.push(unitCandidates.length ? "SALE_UNIT_AMBIGUOUS" : "SALE_UNIT_NAME_UNRESOLVED");
    const q = parsed(row.quantity, "quantity");
    const quantityInvalid = q === null || !q.isInteger();
    if (quantityInvalid) issues.push("ORDER_QUANTITY_INVALID");
    const revenue = parsed(row.productPaymentAmount, "money", false);
    if (revenue === null) issues.push("PRODUCT_PAYMENT_AMOUNT_INVALID");
    const cost = unit ? selectNaverCost(input.date, unit.id, input) : { values: null, ref: null, from: null, to: null, issues: [] };
    issues.push(...cost.issues);
    const unitCost = parsed(cost.values?.unitCost ?? null), other = parsed(cost.values?.otherCost ?? null);
    const feeRate = parsed(cost.values?.feeRate ?? null, "ratio");
    const costValid = unitCost !== null && other !== null && (cost.values?.feeRate == null || feeRate !== null);
    if (!costValid) issues.push("COST_VALUES_INCOMPLETE");
    const feeFields = [row.paymentCommission, row.knowledgeShoppingSellingInterlockCommission, row.saleCommission, row.channelCommission];
    const feeMask = feeFields.map(value => value === null ? "0" : "1").join("");
    const fees = feeFields.filter((value): value is string => value !== null).map(value => parsed(value, "money", false));
    let fee: Prisma.Decimal | null = null;
    let feeBasis: string;
    if (fees.length) {
      feeBasis = "API_PRESENT_FIELDS_SUM";
      if (fees.some(value => value === null)) issues.push("API_FEE_INVALID");
      else fee = fees.reduce<Prisma.Decimal>((acc, value) => acc.plus(value!), zero());
      if (fees.length < 4) issues.push("API_FEE_PARTIAL_PRESENCE");
    } else {
      feeBasis = "EFFECTIVE_FEE_RATE_FALLBACK";
      if (costValid && feeRate !== null && revenue !== null) fee = revenue.mul(feeRate).mul(100).plus("0.5").floor().div(100);
      else issues.push("FEE_FALLBACK_MISSING");
    }
    const productCost = costValid && !quantityInvalid ? quantizeMoney(unitCost!.mul(q!)) : null;
    const otherCost = costValid && !quantityInvalid ? quantizeMoney(other!.mul(q!)) : null;
    const sourceRecordKey = row.externalProductOrderId || row.id;
    const fact: SaleFact = {
      ref: { sourceSystem: "NAVER_SMARTSTORE", platform: "NAVER", schema: "public", table: "order_items", scopeKey: input.scopeKey,
        recordKind: "PRODUCT_ORDER_SALE", sourceRecordKey, selectedSource: "SALE_PAYMENT_DATE", sourceVersion: input.sourceVersion,
        uploadOrRunId: null, payloadHash: hash(row), providerUpdatedAt: row.updatedAt, observedAt: input.observedAt,
        businessDate: input.date, dateBasis: "paymentDate", sourceTimeZone: "Asia/Seoul" },
      name, productName: name.matchStatus === "MATCHED" ? name.canonicalProductName : null,
      marketplace: "NAVER_SMARTSTORE", saleUnitName: unit?.displayName ?? name.saleUnitName, optionName: option,
      orderedQuantity: quantityInvalid ? "0" : q!.toFixed(), calculationQuantity: quantityInvalid ? "0" : q!.toFixed(),
      unitsPerSaleUnit: null, physicalQuantity: null, quantityBasis: quantityInvalid ? "SOURCE_QUANTITY_INVALID_NOT_ZERO_CONFIRMED" : "ORDERED_SALE_UNITS_COST_PER_SALE_UNIT",
      operatingRevenue: revenue === null ? null : quantizeMoney(revenue), revenueBasis: "PRODUCT_PAYMENT_AMOUNT",
      collectedPaymentAmount: revenue === null ? null : quantizeMoney(revenue), paymentGrain: "PRODUCT_ORDER",
      paymentAllocationStatus: "SOURCE_PRODUCT_ORDER_AMOUNT", discountTreatment: "ALREADY_INCLUDED_IN_PRODUCT_PAYMENT",
      refundTreatment: "CURRENT_SALE_STATUS_NO_SECOND_CANCELLATION_DEDUCTION", productCost,
      platformFee: fee === null ? null : quantizeMoney(fee), directShippingCost: "0.000000", returnCost: "0.000000",
      otherDirectCost: otherCost, vatExpense: null, discountNotYetIncluded: "0.000000", manualVendorFee: "0.000000",
      costRuleRef: cost.ref, costEffectiveFrom: cost.from, costEffectiveTo: cost.to, costBasisVersion: "naver-profit-v2-preserved",
      taxPolicyVersion: "NAVER_GROUP_DAY_REVENUE_10_PERCENT_MATH_ROUND_V1", feeBasis, feePresenceMask: feeMask,
      shippingBasis: "STORE_COMMON_EXPENSE_ONLY", dateBasis: "paymentDate", costComponents: [], profitBeforeAds: null,
      quality: { isEstimate: true, confidence: "ESTIMATED", issues: unique(issues) }
    };
    const groupingUnit = unit ?? referenced;
    return { row, fact, revenue, quantityInvalid, group: groupingUnit?.parentSalesUnitId ?? groupingUnit?.id ?? `unmapped:${sourceRecordKey}` };
  });
  applyGroupVat(working);
  for (const { fact } of working) {
    fact.costComponents = ([ ["PRODUCT_COST", fact.productCost], ["PLATFORM_FEE", fact.platformFee],
      ["OTHER_DIRECT_COST", fact.otherDirectCost], ["VAT_EXPENSE", fact.vatExpense] ] as const).map(([kind, amount]) => ({
      kind, sourceExpenseKey: `${input.scopeKey}:${fact.ref.sourceRecordKey}:${kind}`, amount, includedInRevenue: false, applied: amount !== null
    }));
    if ([fact.operatingRevenue, fact.productCost, fact.platformFee, fact.otherDirectCost, fact.vatExpense].every(v => v !== null))
      fact.profitBeforeAds = quantizeMoney(money(fact.operatingRevenue).minus(fact.productCost!).minus(fact.platformFee!).minus(fact.otherDirectCost!).minus(fact.vatExpense!));
    fact.quality.issues = unique(fact.quality.issues);
  }
  const sales = working.map(row => row.fact), mapped = sales.filter(s => s.productName !== null);
  const missingCostRows = sales.filter(s => s.profitBeforeAds === null).length;
  const sourceFingerprint = hash([input, request.nameRuleVersion, request.saleUnitRuleVersion, request.calculationVersion]);
  const present = sales.length > 0 || input.complete;
  const unmatchedAmount = present ? quantizeMoney(sum(sales.filter(s => s.productName === null && s.operatingRevenue !== null).map(s => s.operatingRevenue!))) : null;
  const coverage: SourceCoverage = { sourceSystem: "NAVER_SMARTSTORE", platform: "NAVER", component: "SALE", scopeKey: input.scopeKey,
    date: input.date, participation: "INCLUDED", collectionState: !input.complete ? input.rows.length ? "PARTIAL" : "NOT_COLLECTED" : "COMPLETE",
    rowsPresent: input.rows.length, zeroConfirmed: input.complete && input.rows.length === 0, selectedSource: "SALE_PAYMENT_DATE",
    selectedUploadId: null, sourceVersion: input.sourceVersion, collectedAt: input.collectedAt, sourceAsOf: input.collectedAt,
    calculatedAt: input.observedAt, lastSuccessAt: input.collectedAt, sourceFingerprint,
    nameRuleVersion: request.nameRuleVersion, costRuleVersion: request.saleUnitRuleVersion, mappedRows: mapped.length,
    unmappedRows: sales.length - mapped.length, unmatchedAmount, missingCostRows, missingFxAmount: "0.000000", unallocatedAmount: present ? "0.000000" : null,
    quality: { isEstimate: true, confidence: "ESTIMATED", issues: unique([...input.sourceIssues,
      "NAVER_SOURCE_ESTIMATE", ...sales.flatMap(s => s.quality.issues)]) } };
  const control = (measure: ControlTotal["measure"], field: "operatingRevenue" | "productCost" | "platformFee" | "otherDirectCost" | "vatExpense"): ControlTotal => {
    const known = sales.filter(s => s[field] !== null);
    const assignedAmount = quantizeMoney(sum(known.filter(s => s.productName !== null).map(s => s[field]!)));
    const unassigned = quantizeMoney(sum(known.filter(s => s.productName === null).map(s => s[field]!)));
    const excluded = field === "operatingRevenue" ? quantizeMoney(sum(input.rows.filter(row => row.paymentDate === input.date && row.saleStatus !== "SALE")
      .map(row => parsed(row.productPaymentAmount, "money", false)?.toFixed() ?? "0"))) : "0.000000";
    return { measure, sourceSystem: "NAVER_SMARTSTORE", platform: "NAVER", scopeKey: input.scopeKey, date: input.date, currency: "KRW",
      selectedRows: selected.length, selectedAmount: present && known.length === sales.length ? quantizeMoney(sum(known.map(s => s[field]!))) : null,
      assignedAmount: present ? assignedAmount : null, unmatchedAmount: present ? unassigned : null, unallocatedAmount: present ? "0.000000" : null, excludedNonSaleAmount: excluded,
      excludedByPolicyRows: input.rows.length - selected.length, roundingAdjustment: "0.000000", difference: present && known.length === sales.length ? "0.000000" : null };
  };
  const batch: AdapterBatch = { sales, adSpends: [], commonExpenses: [], coverage: [coverage],
    sourceControlTotals: [control("OPERATING_REVENUE", "operatingRevenue"), control("PRODUCT_COST", "productCost"),
      control("PLATFORM_FEE", "platformFee"), control("OTHER_DIRECT_COST", "otherDirectCost"), control("VAT_EXPENSE", "vatExpense")],
    nextCursor: null, sourceFingerprint };
  assertAdapterBatch(request, "NAVER", batch); return batch;
}
