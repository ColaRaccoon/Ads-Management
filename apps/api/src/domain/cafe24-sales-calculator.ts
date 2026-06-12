import { safeDivide } from "./date-number";
import { CostRuleInput } from "./margin-calculator";

export type Cafe24CostOverrideInput = {
  salePriceKrwOverride?: number | null;
  productCostKrwOverride?: number | null;
  shippingKrwOverride?: number | null;
  extraCostKrwOverride?: number | null;
};

export type Cafe24ResolvedCostInput = CostRuleInput & {
  source: "PRODUCT_COST_RULE" | "CAFE24_RULE_OVERRIDE";
};

export type Cafe24SalesCalculationInput = {
  quantity: number;
  adSpendUsd: number;
  exchangeRateKrwPerUsd: number;
  cost: CostRuleInput;
};

export type Cafe24SalesCalculationResult = {
  quantity: number;
  revenueKrw: number;
  grossCostKrw: number;
  adSpendUsd: number;
  adSpendKrw: number;
  totalCostKrw: number;
  marginKrw: number;
  roas: number | null;
  cpaKrw: number | null;
  marginRate: number | null;
};

export class Cafe24SalesCalculator {
  resolveCost(costRule: CostRuleInput, override: Cafe24CostOverrideInput | null = null): Cafe24ResolvedCostInput {
    const salePriceKrw = numberOrFallback(override?.salePriceKrwOverride, costRule.salePriceKrw);
    const productCostKrw = numberOrFallback(override?.productCostKrwOverride, costRule.productCostKrw);
    const shippingKrw = numberOrFallback(override?.shippingKrwOverride, costRule.shippingKrw);
    const extraCostKrw = numberOrFallback(override?.extraCostKrwOverride, costRule.extraCostKrw);
    const hasOverride =
      override?.salePriceKrwOverride !== undefined ||
      override?.productCostKrwOverride !== undefined ||
      override?.shippingKrwOverride !== undefined ||
      override?.extraCostKrwOverride !== undefined;

    return {
      salePriceKrw,
      vatKrw: salePriceKrw * 0.1,
      productCostKrw,
      shippingKrw,
      extraCostKrw,
      source: hasOverride ? "CAFE24_RULE_OVERRIDE" : "PRODUCT_COST_RULE"
    };
  }

  calculate(input: Cafe24SalesCalculationInput): Cafe24SalesCalculationResult {
    const revenueKrw = input.cost.salePriceKrw * input.quantity;
    const grossCostKrw =
      (input.cost.vatKrw + input.cost.productCostKrw + input.cost.shippingKrw + input.cost.extraCostKrw) * input.quantity;
    const adSpendKrw = input.adSpendUsd * input.exchangeRateKrwPerUsd;
    const totalCostKrw = grossCostKrw + adSpendKrw;
    const marginKrw = revenueKrw - totalCostKrw;

    return {
      quantity: input.quantity,
      revenueKrw,
      grossCostKrw,
      adSpendUsd: input.adSpendUsd,
      adSpendKrw,
      totalCostKrw,
      marginKrw,
      roas: safeDivide(revenueKrw, adSpendKrw),
      cpaKrw: safeDivide(adSpendKrw, input.quantity),
      marginRate: safeDivide(marginKrw, revenueKrw)
    };
  }
}

function numberOrFallback(value: number | null | undefined, fallback: number) {
  return value === null || value === undefined || !Number.isFinite(value) ? fallback : value;
}
