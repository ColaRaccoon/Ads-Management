import type { NativeStoredResult } from "../native-result-contract";
import type { Platform } from "../types";
import { decimal } from "./decimal";
import { resolveProductName, type CatalogProduct, type NameRule } from "./product-name-resolver";

export const NATIVE_NAME_FIELDS = {
  STOREFRONT: "native:STOREFRONT", GOOGLE: "native:GOOGLE", NAVER: "native:NAVER", COUPANG: "native:COUPANG",
  META_ADS: "native:META_ADS", GOOGLE_ADS: "native:GOOGLE_ADS", NAVER_OPTION: "native:NAVER_OPTION"
} as const;
export type MappingGroup = keyof typeof NATIVE_NAME_FIELDS;
export const mappingPlatform = (group: MappingGroup): Platform => group === "STOREFRONT" || group === "GOOGLE" ? "CAFE24" :
  group === "META_ADS" ? "META" : group === "GOOGLE_ADS" ? "GOOGLE" : group === "NAVER_OPTION" ? "NAVER" : group;
export const isNativeNameField = (field: unknown): boolean => Object.values(NATIVE_NAME_FIELDS).includes(field as never);

/** An explicit final-result link may group existing catalog products. Ordinary
 * aliases still retain the canonical-name collision checks in the name resolver. */
export function resolveNativeProduct(originalName: string | null, group: MappingGroup, scopeKey: string, businessDate: string,
  products: readonly CatalogProduct[], rules: readonly NameRule[], version: string) {
  const input = { originalName, nameField: NATIVE_NAME_FIELDS[group], platform: mappingPlatform(group), scopeKey, businessDate };
  const links = rules.filter(rule => rule.nameField === input.nameField);
  const explicit = resolveProductName(input, products.map(product => ({ ...product, active: false })), links, version);
  if (explicit.matchStatus !== "UNMATCHED") return explicit;
  if (group === "NAVER_OPTION") return explicit;
  return resolveProductName(input, products, rules.filter(rule => !isNativeNameField(rule.nameField)), version);
}

/** Extract only explicitly linked source-completed options. Parent residual plus
 * linked options conserve each metric. Shared parent advertising stays on parent.
 * Retain the original basis so replay, disabling and changing links are reversible. */
function splitOptions(rows: NativeStoredResult[], scopeKey: string, businessDate: string,
  products: readonly CatalogProduct[], rules: readonly NameRule[], version: string): NativeStoredResult[] {
  const parents = new Set(rows.filter(row => row.sourceOptions).map(row => row.productKey));
  return rows.filter(row => !row.audit?.optionParentProductKey || !parents.has(row.audit.optionParentProductKey)).flatMap(row => {
    if (row.kind !== "PRODUCT" || row.group !== "NAVER" || !row.sourceOptions?.length || row.audit?.isStoreLevel === "true") return [row];
    const basis = row.optionBasis ?? { quantity: row.quantity, revenue: row.revenue, adSpend: row.adSpend, netProfit: row.netProfit, profitBeforeAds: row.profitBeforeAds };
    const selected = row.sourceOptions.flatMap(option => {
      const match = resolveNativeProduct(option.name, "NAVER_OPTION", scopeKey, businessDate, products, rules, version);
      return match.matchStatus === "MATCHED" ? [{ option, match }] : [];
    });
    if (new Set(row.sourceOptions.map(option => option.key)).size !== row.sourceOptions.length) throw new Error("NATIVE_OPTION_DUPLICATE");
    if (selected.some(({ option }) => (basis.quantity !== null && option.quantity === null) ||
      (["revenue", "adSpend", "netProfit", "profitBeforeAds"] as const).some(key =>
        (["known", "complete"] as const).some(level => basis[key][level] !== null && option[key][level] === null)))) {
      return [{ ...row, ...basis, optionBasis: basis, issues: [...new Set([...row.issues, "NATIVE_OPTION_INCOMPLETE"])] }];
    }
    const subtract = (total: string | null, parts: Array<string | null>) => total === null || parts.some(part => part === null)
      ? null : parts.reduce<string>((value, part) => decimal(value).minus(decimal(part)).toFixed(), total);
    const parent = { ...row, ...basis, optionBasis: basis, issues: row.issues.filter(issue => issue !== "PARENT_COMMON_AD_SPEND_RETAINED") };
    if (!selected.length) return [parent];
    parent.quantity = subtract(basis.quantity, selected.map(({ option }) => option.quantity));
    for (const key of ["revenue", "adSpend", "netProfit", "profitBeforeAds"] as const) {
      parent[key] = { known: subtract(basis[key].known, selected.map(({ option }) => option[key].known)),
        complete: subtract(basis[key].complete, selected.map(({ option }) => option[key].complete)) };
    }
    parent.issues = [...new Set([...parent.issues, "PARENT_COMMON_AD_SPEND_RETAINED"])];
    return [parent, ...selected.map(({ option, match }): NativeStoredResult => ({
      kind: "PRODUCT", group: "NAVER", productKey: `${row.productKey}:option:${option.key}`, productName: match.canonicalProductName,
      quantity: option.quantity, revenue: option.revenue, adSpend: option.adSpend, netProfit: option.netProfit, profitBeforeAds: option.profitBeforeAds,
      sourceUpdatedAt: row.sourceUpdatedAt, issues: [...parent.issues],
      audit: { ...row.audit, sourceProductName: option.name, optionParentProductKey: row.productKey,
        mappingStatus: match.matchStatus, mappingRuleIds: match.ruleIds.join(","), mappingVersion: version }
    }))];
  });
}

/** Identity-only links preserve amounts; explicitly linked options conserve parent totals. */
export function mapNativeProducts(rows: NativeStoredResult[], scopeKey: string, businessDate: string,
  products: readonly CatalogProduct[], rules: readonly NameRule[], version: string): NativeStoredResult[] {
  return splitOptions(rows, scopeKey, businessDate, products, rules, version).map(row => {
    if (row.kind !== "PRODUCT" || row.audit?.isStoreLevel === "true") return row;
    const originalName = row.audit?.sourceProductName ?? row.productName;
    const name = resolveNativeProduct(originalName, row.audit?.optionParentProductKey ? "NAVER_OPTION" : row.group, scopeKey, businessDate, products, rules, version);
    const mapped = name.matchStatus === "MATCHED" ? name.canonicalProductName :
      name.matchStatus === "UNMATCHED" ? originalName : null;
    return { ...row, productName: mapped,
      issues: [...new Set([...row.issues.filter(issue => issue !== "NATIVE_PRODUCT_MAPPING_AMBIGUOUS"), ...(name.matchStatus === "AMBIGUOUS" ? ["NATIVE_PRODUCT_MAPPING_AMBIGUOUS"] : [])])],
      audit: { ...row.audit, sourceProductName: originalName, mappingStatus: name.matchStatus,
        mappingRuleIds: name.ruleIds.join(","), mappingVersion: version } };
  });
}
