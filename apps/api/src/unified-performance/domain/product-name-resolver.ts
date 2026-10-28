import { createHash } from "node:crypto";
import type { NameEvidence, Platform } from "../types";

export const NAME_NORMALIZATION_VERSION = "name-nfc-v1";

export type CatalogProduct = { canonicalName: string; active?: boolean; requiresSaleUnit?: boolean };
export type NameInput = {
  originalName: string | null;
  originalOption?: string | null;
  nameField: string;
  restorationPath?: string | null;
  platform: Platform;
  scopeKey: string;
  businessDate: string;
  saleUnitName?: string | null;
  requiresSaleUnit?: boolean;
};
export type NameRule = {
  id: string;
  canonicalProductName: string;
  matchType: "EXACT" | "CONTAINS";
  /** EXACT accepts any listed alias; CONTAINS requires all listed terms. */
  terms: string[];
  excludeTerms?: string[];
  optionExact?: string | null;
  optionInclude?: string[];
  optionExclude?: string[];
  nameField?: string | null;
  platform?: Platform | null;
  scopeKey?: string | null;
  validFrom: string;
  validTo?: string | null;
  active?: boolean;
  saleUnitName?: string | null;
};
export type ProductNameResolution = NameEvidence & { reasons: string[] };

/** Only business-equivalent spelling changes: digits, punctuation and set sizes survive. */
export function normalizeProductName(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ").replace(/[A-Z]/g, c => c.toLowerCase());
}

export function assertBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000") ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    throw new Error("Business date must be an existing YYYY-MM-DD date.");
}

export function validateNameRule(rule: NameRule): void {
  if (!normalizeProductName(rule.canonicalProductName) || !rule.id || !["EXACT", "CONTAINS"].includes(rule.matchType))
    throw new Error("Name rule needs an ID, canonical product name and supported match type.");
  if (!Array.isArray(rule.terms) || !rule.terms.length || rule.terms.some(t => typeof t !== "string" || !normalizeProductName(t)))
    throw new Error("Name terms must be nonempty strings.");
  for (const values of [rule.excludeTerms, rule.optionInclude, rule.optionExclude]) {
    if (values !== undefined && (!Array.isArray(values) || values.some(t => typeof t !== "string" || !normalizeProductName(t))))
      throw new Error("Name and option conditions must contain nonempty strings.");
  }
  if (rule.platform != null && !["META", "GOOGLE", "NAVER", "COUPANG", "CAFE24"].includes(rule.platform))
    throw new Error("Unknown name rule platform.");
  assertBusinessDate(rule.validFrom);
  if (rule.validTo) {
    assertBusinessDate(rule.validTo);
    if (rule.validTo < rule.validFrom) throw new Error("Name rule date range is reversed.");
  }
}

/** Source IDs are deliberately absent; a rename or rule/scope/day change invalidates the evidence key. */
export function nameInputHash(input: NameInput, nameRuleVersion: string): string {
  return createHash("sha256").update(JSON.stringify([
    NAME_NORMALIZATION_VERSION, input.originalName, input.originalOption ?? null,
    input.nameField, input.restorationPath ?? null, input.platform, input.scopeKey, input.businessDate,
    input.saleUnitName ?? null, input.requiresSaleUnit ?? false, nameRuleVersion
  ])).digest("hex");
}

function conditionsMatch(input: NameInput, rule: NameRule, name: string, option: string): boolean {
  if (rule.active === false || rule.platform && rule.platform !== input.platform ||
      rule.scopeKey && rule.scopeKey !== input.scopeKey || rule.nameField && rule.nameField !== input.nameField ||
      input.businessDate < rule.validFrom || rule.validTo && input.businessDate > rule.validTo) return false;
  if (rule.excludeTerms?.some(t => name.includes(normalizeProductName(t)))) return false;
  if (rule.optionExact != null && normalizeProductName(rule.optionExact) !== option) return false;
  if (rule.optionInclude?.some(t => !option.includes(normalizeProductName(t)))) return false;
  if (rule.optionExclude?.some(t => option.includes(normalizeProductName(t)))) return false;
  const terms = rule.terms.map(normalizeProductName);
  return rule.matchType === "EXACT" ? terms.includes(name) : terms.every(t => name.includes(t));
}

export function resolveProductName(
  input: NameInput,
  products: readonly CatalogProduct[],
  rules: readonly NameRule[],
  nameRuleVersion: string
): ProductNameResolution {
  assertBusinessDate(input.businessDate);
  rules.forEach(validateNameRule);
  const normalizedName = normalizeProductName(input.originalName);
  const normalizedOption = normalizeProductName(input.originalOption);
  const base = {
    originalName: input.originalName ?? "", originalOption: input.originalOption ?? "", nameField: input.nameField,
    restorationPath: input.restorationPath ?? null, normalizedName, normalizedOption,
    canonicalProductName: null, saleUnitName: null, candidateNames: [] as string[], ruleIds: [] as string[],
    nameRuleVersion, nameInputHash: nameInputHash(input, nameRuleVersion)
  };
  if (!normalizedName) return { ...base, matchStatus: "NAME_MISSING", reasons: ["SOURCE_NAME_EMPTY"] };

  // Deactivation removes the unconditional exact-name shortcut. It does not
  // delete an explicitly dated historical rule or rewrite its earlier facts.
  const catalog = products.filter(p => p.active !== false);
  const allowedNames = new Set(products.map(p => p.canonicalName));
  const matchedRules = rules.filter(r => allowedNames.has(r.canonicalProductName) && conditionsMatch(input, r, normalizedName, normalizedOption));
  const exactProducts = catalog.filter(p => normalizeProductName(p.canonicalName) === normalizedName).map(p => p.canonicalName);
  const exactRules = matchedRules.filter(r => r.matchType === "EXACT");
  const exactNames = [...exactProducts, ...exactRules.map(r => r.canonicalProductName)];
  const selectedRules = exactNames.length ? exactRules : matchedRules;
  const candidateNames = [...new Set(exactNames.length ? exactNames : selectedRules.map(r => r.canonicalProductName))].sort();
  const ruleIds = [...new Set(selectedRules.map(r => r.id))].sort();
  const evidence = { ...base, candidateNames, ruleIds };
  if (!candidateNames.length) return { ...evidence, matchStatus: "UNMATCHED", reasons: ["NO_EFFECTIVE_NAME_RULE"] };
  if (candidateNames.length > 1) return { ...evidence, matchStatus: "AMBIGUOUS", reasons: [
    exactProducts.length > 1 ? "CANONICAL_NORMALIZATION_COLLISION" : "MULTIPLE_PRODUCT_CANDIDATES"
  ] };

  const canonicalProductName = candidateNames[0];
  const productRules = matchedRules.filter(r => r.canonicalProductName === canonicalProductName);
  const unitEvidence = { ...evidence, ruleIds: [...new Set([...ruleIds, ...productRules.filter(r => r.saleUnitName).map(r => r.id)])].sort() };
  const saleUnits = [...new Set(productRules.map(r => r.saleUnitName).filter((v): v is string => !!v))].sort();
  const requestedUnit = normalizeProductName(input.saleUnitName);
  const usableUnits = requestedUnit ? saleUnits.filter(u => normalizeProductName(u) === requestedUnit) : saleUnits;
  const saleUnitName = requestedUnit && !saleUnits.length ? input.saleUnitName! : usableUnits.length === 1 ? usableUnits[0] : null;
  const requiresSaleUnit = input.requiresSaleUnit || products.some(p => p.canonicalName === canonicalProductName && p.requiresSaleUnit);
  if (usableUnits.length > 1 || requestedUnit && saleUnits.length > 0 && usableUnits.length === 0 || requiresSaleUnit && !saleUnitName)
    return { ...unitEvidence, canonicalProductName, matchStatus: "UNIT_REQUIRED", reasons: [
      usableUnits.length > 1 ? "MULTIPLE_SALE_UNIT_CANDIDATES" : "SALE_UNIT_UNRESOLVED"
    ] };
  return { ...unitEvidence, canonicalProductName, saleUnitName, matchStatus: "MATCHED", reasons: [
    exactNames.length ? "EXACT_NAME_OR_ALIAS" : "ALL_NAME_CONDITIONS_MATCHED"
  ] };
}
