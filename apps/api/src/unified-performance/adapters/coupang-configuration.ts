import { createHash } from "node:crypto";
import { normalizeCoupangText } from "../../domain/coupang-product-matcher";
import { assertBusinessDate, normalizeProductName, type CatalogProduct, type NameRule } from "../domain/product-name-resolver";
import type { CoupangSaleCostRule } from "./coupang-sales";

type DateValue = Date | string;
type DecimalValue = string | { toString(): string };
export type CoupangLegacyProduct = { id: string; standardName: string; displayName: string; isActive?: boolean };
export type CoupangLegacyNameRule = {
  id: string; coupangProductId?: string; productId?: string; displayName?: string;
  includeKeywords: unknown; excludeKeywords: unknown; adEnabled?: boolean; isActive?: boolean;
  validFrom: DateValue; validTo?: DateValue | null;
};
export type CoupangLegacyCostRule = {
  id: string; coupangProductId?: string; productId?: string;
  effectiveFrom?: DateValue; effectiveTo?: DateValue | null; from?: DateValue; to?: DateValue | null;
  productCostKrw: DecimalValue | null; sellerShippingFeeKrw: DecimalValue | null; hanaroShippingFeeKrw: DecimalValue | null;
  growthInboundFeeKrw: DecimalValue | null; growthShippingFeeKrw: DecimalValue | null;
  returnRate: DecimalValue | null; returnCostPerUnitKrw: DecimalValue | null; extraCostKrw: DecimalValue | null;
  salePriceKrw?: DecimalValue | null;
};
type UnifiedProjection = {
  products: readonly { id: string; canonicalName: string; active: boolean }[];
  rules: readonly { id: string; kind: string; productId: string | null; platform: string | null; scopeKey: string | null;
    payload: unknown; validFrom: DateValue; validTo: DateValue | null; active: boolean }[];
};
export type CoupangConfigurationInput = {
  date: string; scopeKey: string; products: readonly CoupangLegacyProduct[]; rules: readonly CoupangLegacyNameRule[];
  costs: readonly CoupangLegacyCostRule[];
  observedSales: readonly { productName: string; optionName: string }[];
  observedAds: readonly { adExecutionProductName: string }[];
  unified?: UnifiedProjection;
};
const day = (value: DateValue) => { const date = value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10); assertBusinessDate(date); return date; };
const scalar = (value: DecimalValue | null | undefined) => value == null ? null : value.toString();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terms = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === "string") ? value : [];

/** Only the aliases explicitly established in 01 are merged. Unknown variants retain their own names. */
export function coupangProductIdentity(standardName: string): { productName: string; saleUnitName: string; unitsPerSaleUnit: string | null } {
  const key = normalizeCoupangText(standardName);
  const explicit = key.match(/^(버닝웨이브바|플로우라이트)_?([12])개입$/) ?? key.match(/^(한줄보호대)_?([24])개입$/);
  if (explicit) return { productName: explicit[1], saleUnitName: `${explicit[2]}개입`, unitsPerSaleUnit: explicit[2] };
  if (key === "두줄보호대") return { productName: "두줄무릎보호대", saleUnitName: "기본", unitsPerSaleUnit: null };
  return { productName: standardName.normalize("NFC").trim().replace(/\s+/gu, " "), saleUnitName: "기본", unitsPerSaleUnit: null };
}

/** External keys are used only to restore the names of legacy settings, never as source classification conditions. */
export function coupangConfiguration(input: CoupangConfigurationInput): {
  products: CatalogProduct[]; nameRules: NameRule[]; costRules: CoupangSaleCostRule[];
} {
  assertBusinessDate(input.date);
  if (input.scopeKey !== "LEGACY_COUPANG_SINGLE_UPLOAD") throw new Error("Unknown Coupang legacy configuration scope.");
  const identities = new Map(input.products.map(product => [product.id, coupangProductIdentity(product.standardName)]));
  const products = new Map<string, CatalogProduct>();
  for (const product of input.unified?.products ?? []) products.set(product.canonicalName, { canonicalName: product.canonicalName, active: product.active });
  for (const product of input.products) {
    const canonicalName = identities.get(product.id)!.productName;
    const existing = products.get(canonicalName);
    products.set(canonicalName, { canonicalName, active: existing?.active === true || product.isActive !== false });
  }
  const nameRules: NameRule[] = [];
  for (const rule of input.unified?.rules ?? []) {
    if (rule.kind !== "NAME") continue;
    const product = input.unified?.products.find(product => product.id === rule.productId);
    if (product) nameRules.push({ ...(rule.payload as Omit<NameRule, "id" | "canonicalProductName" | "validFrom">), id: rule.id,
      canonicalProductName: product.canonicalName, platform: rule.platform as NameRule["platform"], scopeKey: rule.scopeKey,
      validFrom: day(rule.validFrom), validTo: rule.validTo == null ? null : day(rule.validTo), active: rule.active });
  }
  const observed = [
    ...input.observedSales.map(row => ({ text: row.productName, option: row.optionName, field: "product_name", ad: false })),
    ...input.observedAds.map(row => ({ text: row.adExecutionProductName, option: "", field: "ad_execution_product_name", ad: true }))
  ];
  const groupedRules = new Map<string, CoupangLegacyNameRule[]>();
  for (const rule of input.rules) {
    const productKey = rule.coupangProductId ?? rule.productId ?? "";
    groupedRules.set(productKey, [...groupedRules.get(productKey) ?? [], rule]);
  }
  const prepared = input.products.map(product => {
    const productRules = groupedRules.get(product.id) ?? [];
    const effective = productRules.filter(rule => rule.isActive !== false && day(rule.validFrom) <= input.date &&
      (rule.validTo == null || input.date <= day(rule.validTo))).map(rule => ({ rule,
        include: terms(rule.includeKeywords).map(normalizeCoupangText).filter(Boolean),
        exclude: terms(rule.excludeKeywords).map(normalizeCoupangText).filter(Boolean) }));
    return { product, identity: identities.get(product.id)!, productRules, effective,
      aliases: [product.standardName, product.displayName].map(normalizeProductName) };
  });
  const seen = new Set<string>();
  const uniqueObservations = [...new Map(observed.map(observation => [JSON.stringify(observation), observation])).values()];
  for (const observation of uniqueObservations) {
    if (!observation.text.trim() || observation.text.trim() === "-") continue;
    const combined = normalizeCoupangText(observation.ad ? observation.text : `${observation.text} ${observation.option}`);
    for (const { product, identity, productRules, effective: effectiveRules, aliases } of prepared) {
      const effective = observation.ad ? effectiveRules.filter(item => item.rule.adEnabled !== false) : effectiveRules;
      const directAlias = product.isActive !== false && aliases.includes(normalizeProductName(observation.text));
      const matching = effective.filter(({ include, exclude }) => include.length > 0 && include.every(term => combined.includes(term)) &&
        !exclude.some(term => combined.includes(term))).map(item => item.rule);
      // A configured period must be effective even for a collected standard/display-name alias.
      if (!matching.length && !(directAlias && (!productRules.length || effective.length))) continue;
      const generated: NameRule = { id: `coupang-observed:${hash([observation, identity.productName, identity.saleUnitName, matching.map(rule => rule.id).sort()])}`,
        canonicalProductName: identity.productName, matchType: "EXACT", terms: [observation.text],
        optionExact: observation.ad ? null : observation.option, nameField: observation.field, platform: "COUPANG", scopeKey: input.scopeKey,
        validFrom: input.date, validTo: input.date, saleUnitName: identity.saleUnitName, active: true };
      if (!seen.has(generated.id)) { seen.add(generated.id); nameRules.push(generated); }
    }
  }
  const costRules: CoupangSaleCostRule[] = input.costs.flatMap(cost => {
    const identity = identities.get(cost.coupangProductId ?? cost.productId ?? "");
    if (!identity) return [];
    const from = cost.effectiveFrom ?? cost.from;
    if (from == null) throw new Error("Missing Coupang legacy cost effective date.");
    return [{ id: cost.id, historyKey: cost.coupangProductId ?? cost.productId, productName: identity.productName, saleUnitName: identity.saleUnitName,
      from: day(from), to: cost.effectiveTo == null && cost.to == null ? null : day((cost.effectiveTo ?? cost.to)!), unitsPerSaleUnit: identity.unitsPerSaleUnit,
      productCostKrw: scalar(cost.productCostKrw), sellerShippingFeeKrw: scalar(cost.sellerShippingFeeKrw),
      hanaroShippingFeeKrw: scalar(cost.hanaroShippingFeeKrw), growthInboundFeeKrw: scalar(cost.growthInboundFeeKrw),
      growthShippingFeeKrw: scalar(cost.growthShippingFeeKrw), returnRate: scalar(cost.returnRate),
      returnCostPerUnitKrw: scalar(cost.returnCostPerUnitKrw), extraCostKrw: scalar(cost.extraCostKrw), salePriceKrw: scalar(cost.salePriceKrw) }];
  });
  return { products: [...products.values()].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)),
    nameRules: nameRules.sort((a, b) => a.id.localeCompare(b.id)), costRules: costRules.sort((a, b) => a.id.localeCompare(b.id)) };
}
