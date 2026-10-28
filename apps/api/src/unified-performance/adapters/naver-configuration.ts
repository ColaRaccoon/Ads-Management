import { createHash } from "node:crypto";
import { normalizeProductName, resolveProductName, type CatalogProduct, type NameRule } from "../domain/product-name-resolver";
import type { NaverSalesUnit } from "./naver-sales";
import type { AdapterRequest } from "../types";

/** Only equivalences established by the 01 contract; no punctuation/size stripping or fuzzy identity. */
const establishedNames: Record<string, string> = {
  "버닝웨이브": "버닝웨이브바", "두줄보호대": "두줄무릎보호대", "버닝슬라이드": "버닝 슬라이드"
};
type Configuration = { products: readonly CatalogProduct[]; nameRules: readonly NameRule[] };
export function naverConfiguration(request: AdapterRequest, date: string, units: readonly NaverSalesUnit[], unified: Configuration): Configuration {
  const products = new Map(unified.products.map(p => [p.canonicalName, p]));
  const nameRules: NameRule[] = [...unified.nameRules];
  const byId = new Map(units.map(u => [u.id, u]));
  for (const unit of units) {
    if (unit.isStoreLevel || !unit.displayName?.trim()) continue;
    const parent = unit.parentSalesUnitId ? byId.get(unit.parentSalesUnitId) : null;
    const parentResolution = parent?.isGroup ? resolveProductName({ originalName: establishedNames[parent.displayName] ?? parent.displayName,
      nameField: "sales_unit_name", platform: "NAVER", scopeKey: request.scopeKeys[0], businessDate: date }, unified.products, unified.nameRules, request.nameRuleVersion) : null;
    const parentRepresentsProduct = parent?.isGroup && (parentResolution?.matchStatus === "MATCHED" || [parent.displayName, ...parent.matchAliases]
      .some(name => normalizeProductName(name) && normalizeProductName(unit.displayName).includes(normalizeProductName(name))));
    const base = parentRepresentsProduct ? parent : unit;
    const baseText = establishedNames[base.displayName] ?? base.displayName;
    const ownName = resolveProductName({ originalName: unit.displayName, nameField: "sales_unit_name", platform: "NAVER",
      scopeKey: request.scopeKeys[0], businessDate: date }, unified.products, unified.nameRules, request.nameRuleVersion);
    const resolved = ownName.matchStatus !== "UNMATCHED" ? ownName : resolveProductName({ originalName: baseText, nameField: "sales_unit_name", platform: "NAVER",
      scopeKey: request.scopeKeys[0], businessDate: date }, unified.products, unified.nameRules, request.nameRuleVersion);
    if (resolved.matchStatus === "AMBIGUOUS" || resolved.matchStatus === "UNIT_REQUIRED") continue;
    const canonicalName = resolved.canonicalProductName ?? baseText;
    // A source-only name is a separate product, never silently collapsed into another platform's similar name.
    if (!products.has(canonicalName)) products.set(canonicalName, { canonicalName, active: unit.isActive !== false });
    const aliases = [...new Set([unit.displayName, ...unit.matchAliases].filter(name => normalizeProductName(name)))];
    for (const alias of aliases) for (const nameField of ["rawProductName", "rawOptionInfo", "campaign_name", "sales_unit_name"]) {
      const rule: NameRule = { id: `naver-source-name:${createHash("sha256").update(JSON.stringify([canonicalName, alias, unit.isGroup ? null : unit.displayName, date, nameField])).digest("hex")}`,
        canonicalProductName: canonicalName, matchType: "CONTAINS", terms: [alias], platform: "NAVER", scopeKey: request.scopeKeys[0],
        validFrom: date, validTo: date, active: true, nameField, saleUnitName: ["rawProductName", "rawOptionInfo"].includes(nameField) && !unit.isGroup ? unit.displayName : null };
      nameRules.push(rule);
    }
  }
  return { products: [...products.values()], nameRules };
}
