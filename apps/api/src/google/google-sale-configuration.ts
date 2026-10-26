import { Cafe24ProductRule, GooglePerformanceMapping, ProductCostRule } from "@prisma/client";
import { Cafe24SalesCalculator } from "../domain/cafe24-sales-calculator";

/** A Google sale configuration describes one collected sale unit (for example,
 * a complete 1+1 set). Its quantity and costs must never inherit bundle doubling. */
export function resolveGoogleSaleConfiguration(quantity: number,
  mapping: Pick<GooglePerformanceMapping, "salePriceKrwOverride" | "productCostKrwOverride" | "shippingKrwOverride" | "extraCostKrwOverride" | "saleUnitLabel"> | undefined,
  rule: Pick<ProductCostRule, "salePriceKrw" | "vatKrw" | "productCostKrw" | "shippingKrw" | "extraCostKrw"> | null,
  match: Pick<Cafe24ProductRule, "displayName" | "optionIncludeKeywords" | "productNameAliases" | "salePriceKrwOverride" | "productCostKrwOverride" | "shippingKrwOverride" | "extraCostKrwOverride"> | null) {
  const calculator = new Cafe24SalesCalculator();
  const values = [mapping?.salePriceKrwOverride, mapping?.productCostKrwOverride,
    mapping?.shippingKrwOverride, mapping?.extraCostKrwOverride];
  const count = values.filter(value => value != null).length;
  if (count !== 0 && count !== 4) throw new Error("Incomplete Google sale configuration");
  if (count === 4) {
    return { quantity, calculationQuantity: quantity, collectedQuantity: quantity,
      saleUnitLabel: mapping?.saleUnitLabel ?? null,
      cost: calculator.resolveCost({ salePriceKrw: values[0]!.toNumber(), vatKrw: 0,
        productCostKrw: values[1]!.toNumber(), shippingKrw: values[2]!.toNumber(), extraCostKrw: values[3]!.toNumber() }) };
  }
  // Preserve the legacy exact mapping path when no Google configuration exists.
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
