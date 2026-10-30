import { Cafe24ProductRule, ProductCostRule } from "@prisma/client";
import { Cafe24SalesCalculator } from "../domain/cafe24-sales-calculator";

/** Same base prices, option overrides, VAT and bundle quantities as Cafe24/Meta. */
export function resolveGoogleSaleConfiguration(quantity: number,
  rule: Pick<ProductCostRule, "salePriceKrw" | "vatKrw" | "productCostKrw" | "shippingKrw" | "extraCostKrw"> | null,
  match: Pick<Cafe24ProductRule, "displayName" | "optionIncludeKeywords" | "productNameAliases" | "salePriceKrwOverride" | "productCostKrwOverride" | "shippingKrwOverride" | "extraCostKrwOverride"> | null) {
  const calculator = new Cafe24SalesCalculator();
  const strings = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : [];
  const bundle = !!match && ([match.displayName, ...strings(match.optionIncludeKeywords), ...strings(match.productNameAliases)]
    .some(v => v.replace(/\s+/g, "").toLowerCase().includes("1+1")) || strings(match.optionIncludeKeywords).includes("+"));
  const cost = rule ? calculator.resolveCost({ salePriceKrw: rule.salePriceKrw.toNumber(), vatKrw: rule.vatKrw.toNumber(),
    productCostKrw: rule.productCostKrw.toNumber(), shippingKrw: rule.shippingKrw.toNumber(), extraCostKrw: rule.extraCostKrw.toNumber() },
    match ? { salePriceKrwOverride: match.salePriceKrwOverride?.toNumber() ?? null, productCostKrwOverride: match.productCostKrwOverride?.toNumber() ?? null,
      shippingKrwOverride: match.shippingKrwOverride?.toNumber() ?? null, extraCostKrwOverride: match.extraCostKrwOverride?.toNumber() ?? null } : null) : null;
  return { quantity: quantity * (bundle ? 2 : 1), calculationQuantity: quantity, collectedQuantity: quantity,
    saleUnitLabel: null, cost };
}
