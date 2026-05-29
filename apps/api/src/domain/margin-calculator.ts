import { safeDivide } from "./date-number";

export type CostRuleInput = {
  salePriceKrw: number;
  vatKrw: number;
  productCostKrw: number;
  shippingKrw: number;
  extraCostKrw: number;
};

export type CpaRuleInput = {
  targetRatio: number;
  watchRatio: number;
  stopRatio: number;
};

export type ProductCpaThresholds = {
  contributionBeforeAdsKrw: number;
  breakEvenCpaKrw: number | null;
  targetCpaKrw: number | null;
  watchCpaKrw: number | null;
  stopCpaKrw: number | null;
};

export type MarginMetricInput = {
  spendUsd: number;
  purchaseCount: number;
  exchangeRateKrwPerUsd: number;
};

export type MarginMetricResult = {
  spendKrw: number;
  revenueKrw: number;
  grossCostKrw: number;
  marginKrw: number;
  cpaKrw: number | null;
  cpaUsd: number | null;
  roas: number | null;
};

export class MarginCalculator {
  thresholds(costRule: CostRuleInput, cpaRule: CpaRuleInput): ProductCpaThresholds {
    const contributionBeforeAdsKrw =
      costRule.salePriceKrw -
      costRule.vatKrw -
      costRule.productCostKrw -
      costRule.shippingKrw -
      costRule.extraCostKrw;
    const breakEvenCpaKrw = contributionBeforeAdsKrw;
    return {
      contributionBeforeAdsKrw,
      breakEvenCpaKrw,
      targetCpaKrw: breakEvenCpaKrw === null ? null : breakEvenCpaKrw * cpaRule.targetRatio,
      watchCpaKrw: breakEvenCpaKrw === null ? null : breakEvenCpaKrw * cpaRule.watchRatio,
      stopCpaKrw: breakEvenCpaKrw === null ? null : breakEvenCpaKrw * cpaRule.stopRatio
    };
  }

  margin(input: MarginMetricInput, costRule: CostRuleInput): MarginMetricResult {
    const spendKrw = input.spendUsd * input.exchangeRateKrwPerUsd;
    const revenueKrw = input.purchaseCount * costRule.salePriceKrw;
    const grossCostKrw =
      input.purchaseCount *
      (costRule.vatKrw + costRule.productCostKrw + costRule.shippingKrw + costRule.extraCostKrw);
    const marginKrw = revenueKrw - grossCostKrw - spendKrw;
    return {
      spendKrw,
      revenueKrw,
      grossCostKrw,
      marginKrw,
      cpaKrw: safeDivide(spendKrw, input.purchaseCount),
      cpaUsd: safeDivide(input.spendUsd, input.purchaseCount),
      roas: safeDivide(revenueKrw, spendKrw)
    };
  }
}
