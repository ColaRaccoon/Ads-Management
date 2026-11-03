import type { NativeStoredResult } from "../native-result-contract";
import type { Platform } from "../types";
import { resolveProductName, type CatalogProduct, type NameRule } from "./product-name-resolver";

export const NATIVE_NAME_FIELDS = {
  STOREFRONT: "native:STOREFRONT", GOOGLE: "native:GOOGLE", NAVER: "native:NAVER", COUPANG: "native:COUPANG",
  META_ADS: "native:META_ADS", GOOGLE_ADS: "native:GOOGLE_ADS"
} as const;
export type MappingGroup = keyof typeof NATIVE_NAME_FIELDS;
export const mappingPlatform = (group: MappingGroup): Platform => group === "STOREFRONT" || group === "GOOGLE" ? "CAFE24" :
  group === "META_ADS" ? "META" : group === "GOOGLE_ADS" ? "GOOGLE" : group;
export const isNativeNameField = (field: unknown): boolean => Object.values(NATIVE_NAME_FIELDS).includes(field as never);

/** An explicit final-result link may group existing catalog products. Ordinary
 * aliases still retain the canonical-name collision checks in the name resolver. */
export function resolveNativeProduct(originalName: string | null, group: MappingGroup, scopeKey: string, businessDate: string,
  products: readonly CatalogProduct[], rules: readonly NameRule[], version: string) {
  const input = { originalName, nameField: NATIVE_NAME_FIELDS[group], platform: mappingPlatform(group), scopeKey, businessDate };
  const links = rules.filter(rule => rule.nameField === input.nameField);
  const explicit = resolveProductName(input, products.map(product => ({ ...product, active: false })), links, version);
  if (explicit.matchStatus !== "UNMATCHED") return explicit;
  return resolveProductName(input, products, rules.filter(rule => !isNativeNameField(rule.nameField)), version);
}

/** Only identity changes. Source keys, units, amounts, summary rows and nulls survive. */
export function mapNativeProducts(rows: NativeStoredResult[], scopeKey: string, businessDate: string,
  products: readonly CatalogProduct[], rules: readonly NameRule[], version: string): NativeStoredResult[] {
  return rows.map(row => {
    if (row.kind !== "PRODUCT" || row.audit?.isStoreLevel === "true") return row;
    const originalName = row.audit?.sourceProductName ?? row.productName;
    const name = resolveNativeProduct(originalName, row.group, scopeKey, businessDate, products, rules, version);
    const mapped = name.matchStatus === "MATCHED" ? name.canonicalProductName :
      name.matchStatus === "UNMATCHED" ? originalName : null;
    return { ...row, productName: mapped,
      issues: [...new Set([...row.issues.filter(issue => issue !== "NATIVE_PRODUCT_MAPPING_AMBIGUOUS"), ...(name.matchStatus === "AMBIGUOUS" ? ["NATIVE_PRODUCT_MAPPING_AMBIGUOUS"] : [])])],
      audit: { ...row.audit, sourceProductName: originalName, mappingStatus: name.matchStatus,
        mappingRuleIds: name.ruleIds.join(","), mappingVersion: version } };
  });
}

