import { safeDivide } from "./date-number";

export type CoupangFeeMode = "PER_UNIT" | "RATE";

export type CoupangProfitOptions = {
  feeMode?: CoupangFeeMode;
  includeReturnCost?: boolean;
  useGrowthCost?: boolean;
};

export type CoupangCostInput = {
  salePriceKrw: number;
  supplyPriceKrw?: number;
  productCostKrw: number;
  salesFeeRate?: number;
  salesFeeKrw?: number;
  sellerShippingFeeKrw?: number;
  growthInboundFeeKrw?: number;
  growthShippingFeeKrw?: number;
  returnRate?: number;
  returnCostPerUnitKrw?: number;
  extraCostKrw?: number;
};

export type CoupangSalesInput = {
  saleMethod?: string | null;
  netSalesKrw: number;
  salesQuantity: number;
};

export type CoupangAdInput = {
  adSpendKrw: number;
  adConversionSalesKrw: number;
  adConversionQuantity?: number;
};

export type CoupangProfitResult = {
  netSalesKrw: number;
  productCostKrw: number;
  salesFeeKrw: number;
  shippingCostKrw: number;
  returnCostKrw: number;
  extraCostKrw: number;
  adSpendKrw: number;
  totalCostKrw: number;
  marginKrw: number;
  marginRate: number | null;
  roas: number | null;
  organicSalesKrw: number;
  warnings: string[];
};

export function calculateCoupangProfit(
  sales: CoupangSalesInput,
  cost: CoupangCostInput,
  ads: CoupangAdInput,
  options: CoupangProfitOptions = {}
): CoupangProfitResult {
  const quantity = finiteNumber(sales.salesQuantity);
  const netSalesKrw = finiteNumber(sales.netSalesKrw);
  const productCostKrw = finiteNumber(cost.productCostKrw) * quantity;
  const salesFeeKrw =
    options.feeMode === "RATE"
      ? netSalesKrw * finiteNumber(cost.salesFeeRate)
      : finiteNumber(cost.salesFeeKrw) * quantity;
  const shippingCostKrw = shippingCost(sales.saleMethod, cost, quantity, options);
  const returnCostKrw =
    options.includeReturnCost === false
      ? 0
      : quantity * finiteNumber(cost.returnRate) * finiteNumber(cost.returnCostPerUnitKrw);
  const extraCostKrw = finiteNumber(cost.extraCostKrw) * quantity;
  const adSpendKrw = finiteNumber(ads.adSpendKrw);
  const totalCostKrw = productCostKrw + salesFeeKrw + shippingCostKrw + returnCostKrw + extraCostKrw + adSpendKrw;
  const marginKrw = netSalesKrw - totalCostKrw;
  const organicSalesKrw = netSalesKrw - finiteNumber(ads.adConversionSalesKrw);
  const warnings = organicSalesKrw < 0 ? ["AD_CONVERSION_EXCEEDS_NET_SALES"] : [];

  return {
    netSalesKrw,
    productCostKrw,
    salesFeeKrw,
    shippingCostKrw,
    returnCostKrw,
    extraCostKrw,
    adSpendKrw,
    totalCostKrw,
    marginKrw,
    marginRate: safeDivide(marginKrw, netSalesKrw),
    roas: safeDivide(finiteNumber(ads.adConversionSalesKrw), adSpendKrw),
    organicSalesKrw,
    warnings
  };
}

function shippingCost(
  saleMethod: string | null | undefined,
  cost: CoupangCostInput,
  quantity: number,
  options: CoupangProfitOptions
) {
  if (options.useGrowthCost === false) {
    return finiteNumber(cost.sellerShippingFeeKrw) * quantity;
  }
  if (isGrowthSaleMethod(saleMethod)) {
    return (finiteNumber(cost.growthInboundFeeKrw) + finiteNumber(cost.growthShippingFeeKrw)) * quantity;
  }
  return finiteNumber(cost.sellerShippingFeeKrw) * quantity;
}

function isGrowthSaleMethod(value: string | null | undefined) {
  const normalized = String(value ?? "").toLowerCase().replace(/\s+/g, "");
  return normalized.includes("growth") || normalized.includes("rocket") || normalized.includes("\ub85c\ucf13") || normalized.includes("\uadf8\ub85c\uc2a4");
}

function finiteNumber(value: number | null | undefined) {
  return Number.isFinite(value) ? Number(value) : 0;
}
