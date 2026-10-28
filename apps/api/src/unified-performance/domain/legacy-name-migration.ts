import { CatalogProduct, NameInput, NameRule, normalizeProductName, resolveProductName, validateNameRule } from "./product-name-resolver";
import type { Platform } from "../types";

/** A projection of existing rules, containing no order data or product-ID requirement. */
export type LegacyNameRuleSnapshot = {
  legacyRuleId: string;
  canonicalProductName: string;
  platform: Platform;
  scopeKey: string | null;
  validFrom: string;
  validTo?: string | null;
  matchType: "EXACT" | "CONTAINS" | "REGEX" | "MANUAL";
  terms: string[];
  excludeTerms?: string[];
  optionInclude?: string[];
  optionExclude?: string[];
  saleUnitName?: string | null;
  active?: boolean;
  /** Count only: the new rules never retain or consult an external ID list. */
  legacyExternalIdConditionCount?: number;
  legacyPriority?: number;
  legacyWhitespaceInsensitive?: boolean;
};
export type LegacyMigrationIssue = { legacyRuleId: string | null; code: string; detail: string };

/**
 * This is a draft/preview, never an import writer. Callers supply the reviewed canonical
 * catalogue separately; a legacy alias may not silently create or rename a product.
 * Old whitespace-free/priority/ID semantics need explicit review before API saves.
 */
export function previewLegacyNameMigration(
  products: readonly CatalogProduct[],
  snapshots: readonly LegacyNameRuleSnapshot[],
  samples: readonly NameInput[],
  nameRuleVersion: string
) {
  const issues: LegacyMigrationIssue[] = [];
  const proposedRules: NameRule[] = [];
  const catalogNames = new Set(products.map(p => p.canonicalName));
  const namesByKey = new Map<string, Set<string>>();
  for (const product of products) {
    const key = normalizeProductName(product.canonicalName);
    const names = namesByKey.get(key) ?? new Set<string>();
    names.add(product.canonicalName);
    namesByKey.set(key, names);
  }
  for (const names of namesByKey.values()) if (names.size > 1)
    issues.push({ legacyRuleId: null, code: "CANONICAL_NORMALIZATION_COLLISION", detail: [...names].sort().join(" | ") });
  for (const old of snapshots) {
    const issue = (code: string, detail: string) => issues.push({ legacyRuleId: old.legacyRuleId, code, detail });
    if (!catalogNames.has(old.canonicalProductName)) {
      issue("UNKNOWN_CANONICAL_PRODUCT", "Keep the source name separate until a canonical product is explicitly established.");
      continue;
    }
    if (old.matchType === "REGEX" || old.matchType === "MANUAL") {
      issue("UNSUPPORTED_LEGACY_MATCH", "Replace regex/ID/manual matching with reviewed exact aliases or name conditions.");
      continue;
    }
    if (old.terms.length === 0) {
      issue("NAME_TERMS_MISSING", "An ID-only or option-only rule cannot become an automatic name rule.");
      continue;
    }
    if (!old.scopeKey) issue("GLOBAL_SCOPE_REVIEW", "No account/store scope was supplied; confirm that a cross-scope rule is intended.");
    if (old.legacyExternalIdConditionCount) issue("EXTERNAL_ID_CONDITION_REMOVED", "The draft uses names; compare old ID-restricted scope before saving.");
    if (old.legacyPriority !== undefined) issue("PRIORITY_NOT_PORTED", "Every matching product is evaluated; legacy priority cannot resolve ambiguity.");
    if (old.legacyWhitespaceInsensitive) issue("NORMALIZATION_CHANGED", "Old whitespace-free matching is not copied; preview observed spellings and add explicit aliases where needed.");
    const next: NameRule = {
      id: `legacy:${old.platform}:${old.legacyRuleId}`, canonicalProductName: old.canonicalProductName,
      platform: old.platform, scopeKey: old.scopeKey, validFrom: old.validFrom, validTo: old.validTo ?? null,
      matchType: old.matchType, terms: [...old.terms], excludeTerms: [...(old.excludeTerms ?? [])],
      optionInclude: [...(old.optionInclude ?? [])], optionExclude: [...(old.optionExclude ?? [])],
      saleUnitName: old.saleUnitName ?? null, active: old.active !== false
    };
    try {
      validateNameRule(next);
      proposedRules.push(next);
    } catch {
      issue("INVALID_LEGACY_RULE", "Dates or text conditions are invalid under the new name contract.");
    }
  }
  const preview = samples.map(input => ({ input: { ...input }, result: resolveProductName(input, products, proposedRules, nameRuleVersion) }));
  for (const row of preview) if (["AMBIGUOUS", "UNIT_REQUIRED"].includes(row.result.matchStatus))
    issues.push({ legacyRuleId: null, code: `PREVIEW_${row.result.matchStatus}`, detail: row.result.nameInputHash });
  return { nameRuleVersion, writePerformed: false as const, requiresReview: issues.length > 0, proposedRules, issues, preview };
}

/** The actual v1 canonical names established in 01; this is not the application's old seed list. */
export const BASELINE_CANONICAL_PRODUCTS: readonly CatalogProduct[] = [
  "노필수면안대", "다이어트양말", "두줄무릎보호대", "러닝양말", "러닝조끼", "바라클라바", "버닝 슬라이드", "버닝웨이브바",
  "베놈무릎보호대", "뷰티레그보드", "스카이스텝", "아이언볼", "에어스텝퍼", "유쉴드마스크", "자이로볼", "퍼펙트스케이트",
  "퍼펙트슬라이드", "풀업바", "풀업밴드", "플로우라이트", "한줄보호대"
].map(canonicalName => ({ canonicalName }));

/** Explicit spelling aliases supported by 01. Real store scope is supplied by the importer. */
export function baselineAliasDrafts(naverScopeKey: string, validFrom: string): LegacyNameRuleSnapshot[] {
  if (!naverScopeKey.trim()) throw new Error("An observed Naver store scope is required.");
  return [{ legacyRuleId: "baseline-two-line-alias", canonicalProductName: "두줄무릎보호대", platform: "NAVER",
    scopeKey: naverScopeKey, validFrom, matchType: "EXACT", terms: ["두줄보호대"] }];
}

type LegacyProjectionScope = {
  id: string; canonicalProductName: string; scopeKey: string | null; validFrom: string; validTo?: string | null;
  isActive?: boolean; priority?: number;
};

/** Existing Cafe24 aliases are OR branches, while each branch's option conditions are AND. */
export function projectCafe24NameRules(rows: readonly (LegacyProjectionScope & {
  productNameAliases: readonly string[]; productNumbers?: readonly string[];
  optionIncludeKeywords?: readonly string[]; optionExcludeKeywords?: readonly string[];
})[]): LegacyNameRuleSnapshot[] {
  return rows.flatMap(row => (row.productNameAliases.length ? row.productNameAliases : [""]).map((alias, index) => ({
    legacyRuleId: `${row.id}:alias:${index}`, canonicalProductName: row.canonicalProductName,
    platform: "CAFE24" as const, scopeKey: row.scopeKey, validFrom: row.validFrom, validTo: row.validTo,
    active: row.isActive !== false, matchType: "CONTAINS" as const, terms: alias ? [alias] : [],
    optionInclude: [...(row.optionIncludeKeywords ?? [])], optionExclude: [...(row.optionExcludeKeywords ?? [])],
    legacyExternalIdConditionCount: row.productNumbers?.length ?? 0, legacyPriority: row.priority,
    legacyWhitespaceInsensitive: true
  })));
}

export function projectCoupangNameRules(rows: readonly (LegacyProjectionScope & {
  includeKeywords: readonly string[]; excludeKeywords?: readonly string[];
})[]): LegacyNameRuleSnapshot[] {
  return rows.map(row => ({
    legacyRuleId: row.id, canonicalProductName: row.canonicalProductName, platform: "COUPANG",
    scopeKey: row.scopeKey, validFrom: row.validFrom, validTo: row.validTo, active: row.isActive !== false,
    matchType: "CONTAINS", terms: [...row.includeKeywords], excludeTerms: [...(row.excludeKeywords ?? [])],
    legacyPriority: row.priority, legacyWhitespaceInsensitive: true
  }));
}

export function projectMetaNameRules(rows: readonly (LegacyProjectionScope & {
  matchType: "EXACT" | "CONTAINS" | "REGEX" | "MANUAL"; pattern: string;
})[]): LegacyNameRuleSnapshot[] {
  return rows.map(row => ({
    legacyRuleId: row.id, canonicalProductName: row.canonicalProductName, platform: "META", scopeKey: row.scopeKey,
    validFrom: row.validFrom, validTo: row.validTo, active: row.isActive !== false,
    matchType: row.matchType, terms: [row.pattern], legacyPriority: row.priority
  }));
}

/** Naver canonical sales-unit names and matchAliases stay tied to a reviewed product, not to a product ID. */
export function projectNaverNameRules(rows: readonly (LegacyProjectionScope & {
  displayName: string; matchAliases: readonly string[]; saleUnitName?: string | null;
})[]): LegacyNameRuleSnapshot[] {
  return rows.map(row => ({
    legacyRuleId: row.id, canonicalProductName: row.canonicalProductName, platform: "NAVER", scopeKey: row.scopeKey,
    validFrom: row.validFrom, validTo: row.validTo, active: row.isActive !== false,
    matchType: "EXACT", terms: [...new Set([row.displayName, ...row.matchAliases])], saleUnitName: row.saleUnitName
  }));
}

export function projectGoogleNameRules(rows: readonly (LegacyProjectionScope & {
  name: string; displayName: string;
})[]): LegacyNameRuleSnapshot[] {
  return rows.flatMap(row => [...new Set([row.name, row.displayName])].map((name, index) => ({
    legacyRuleId: `${row.id}:name:${index}`, canonicalProductName: row.canonicalProductName,
    platform: "GOOGLE" as const, scopeKey: row.scopeKey, validFrom: row.validFrom, validTo: row.validTo,
    active: row.isActive !== false, matchType: "CONTAINS" as const, terms: [name], legacyWhitespaceInsensitive: true
  })));
}
