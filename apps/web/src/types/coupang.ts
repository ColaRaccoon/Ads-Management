export type CoupangGroupBy = "product" | "group";

export type CoupangProductProfitRow = {
  rowType?: "PRODUCT" | "GROUP";
  productId: string;
  productName: string;
  groupId?: string | null;
  groupName?: string | null;
  childProductCount?: number;
  children?: CoupangProductProfitRow[];
  saleMethod: string | null;
  matchedSalesLineCount: number;
  reportedSalesKrw: number;
  reportedNetSalesKrw: number;
  reportedSalesQuantity: number;
  reportedOrderCount: number;
  salesKrw: number | null;
  netSalesKrw: number | null;
  salesQuantity: number | null;
  orderCount: number;
  cancelAmountKrw: number;
  salePriceKrw: number | null;
  baseSalePriceKrw: number | null;
  promotionPriceKrw: number | null;
  priceSource: string;
  priceWarnings: string[];
  productCostKrw: number | null;
  salesFeeKrw: number | null;
  shippingCostKrw: number | null;
  sellerSalesQuantity: number;
  growthSalesQuantity: number;
  sellerShippingCostKrw: number | null;
  hanaroShippingCostKrw: number | null;
  growthInboundCostKrw: number | null;
  growthShippingCostKrw: number | null;
  totalLogisticsCostKrw: number | null;
  returnCostKrw: number | null;
  extraCostKrw: number | null;
  vatKrw: number | null;
  manualPurchaseSalesKrw: number | null;
  manualPurchaseQuantity: number;
  manualPurchaseProductCostKrw: number | null;
  manualPurchaseVendorFeeKrw: number | null;
  manualPurchaseCoupangSalesFeeKrw: number | null;
  manualPurchaseShippingCostKrw: number | null;
  manualPurchaseOtherCostKrw: number | null;
  manualPurchaseTotalCostKrw: number | null;
  actualSalesKrw: number | null;
  actualNetSalesKrw: number | null;
  actualSalesQuantity: number | null;
  normalCalculationStatus: "COMPLETE" | "INCOMPLETE" | "NOT_APPLICABLE";
  manualCalculationStatus: "COMPLETE" | "INCOMPLETE" | "NOT_APPLICABLE";
  calculationStatus: "COMPLETE" | "INCOMPLETE";
  adSpendKrw: number;
  adConversionSalesKrw: number;
  adConversionQuantity: number;
  organicSalesKrw: number | null;
  reportedOrganicSalesKrw: number;
  actualOrganicSalesKrw: number | null;
  normalMarginKrw: number | null;
  totalCostKrw: number | null;
  marginKrw: number | null;
  knownTotalCostKrw: number;
  knownMarginKrw: number;
  completeProductCount: number;
  incompleteProductCount: number;
  excludedNetSalesKrw: number;
  excludedSalesQuantity: number;
  incompleteNormalCount: number;
  incompleteManualCount: number;
  marginRate: number | null;
  roas: number | null;
  warnings: string[];
  ruleStatus: "OK" | "MISSING_COST_RULE" | "UNMATCHED";
};

export type CoupangProfitSummary = {
  isComplete: boolean;
  reportedSalesKrw: number;
  reportedNetSalesKrw: number;
  reportedSalesQuantity: number;
  reportedOrderCount: number;
  cancelAmountKrw: number;
  manualPurchaseSalesKrw: number | null;
  manualPurchaseQuantity: number;
  manualPurchaseProductCostKrw: number | null;
  manualPurchaseVendorFeeKrw: number | null;
  manualPurchaseCoupangSalesFeeKrw: number | null;
  manualPurchaseShippingCostKrw: number | null;
  manualPurchaseOtherCostKrw: number | null;
  manualPurchaseTotalCostKrw: number | null;
  actualSalesKrw: number | null;
  actualNetSalesKrw: number | null;
  actualSalesQuantity: number | null;
  salesKrw: number | null;
  netSalesKrw: number | null;
  salesQuantity: number | null;
  productCostKrw: number | null;
  salesFeeKrw: number | null;
  shippingCostKrw: number | null;
  sellerSalesQuantity: number;
  growthSalesQuantity: number;
  sellerShippingCostKrw: number | null;
  hanaroShippingCostKrw: number | null;
  growthInboundCostKrw: number | null;
  growthShippingCostKrw: number | null;
  totalLogisticsCostKrw: number | null;
  returnCostKrw: number | null;
  extraCostKrw: number | null;
  vatKrw: number | null;
  adSpendKrw: number;
  adConversionSalesKrw: number;
  organicSalesKrw: number | null;
  reportedOrganicSalesKrw: number;
  actualOrganicSalesKrw: number | null;
  normalMarginKrw: number | null;
  totalCostKrw: number | null;
  marginKrw: number | null;
  knownMarginKrw: number;
  knownTotalCostKrw: number;
  completeProductCount: number;
  incompleteProductCount: number;
  excludedNetSalesKrw: number;
  excludedSalesQuantity: number;
  incompleteNormalCount: number;
  incompleteManualCount: number;
  marginRate: number | null;
  roas: number | null;
  adSpendRatio: number | null;
  incompleteCalculationCount: number;
  missingCostRuleCount: number;
  warningCount: number;
};

export type CoupangProductProfitResponse = {
  period: { from: string; to: string };
  groupBy: CoupangGroupBy;
  summary: CoupangProfitSummary;
  rows: CoupangProductProfitRow[];
};

export type CoupangDashboardResponse = CoupangProductProfitResponse;

export type CoupangDailyPreviousMetrics = {
  reportedSalesQuantity: number;
  adSpendKrw: number;
  roas: number | null;
  marginKrw: number | null;
};

export type CoupangDailyVisibleMetrics = {
  reportedSalesKrw: number;
  reportedSalesQuantity: number;
  manualPurchaseQuantity: number;
  adSpendKrw: number;
  roas: number | null;
  organicSalesKrw: number | null;
  marginKrw: number | null;
};

export type CoupangDailyProductRow = CoupangDailyVisibleMetrics & {
  rowType: "PRODUCT";
  productId: string;
  productName: string;
  groupId: string | null;
  groupName: string | null;
  memo: string | null;
  previous: CoupangDailyPreviousMetrics;
  calculationStatus: "COMPLETE" | "INCOMPLETE";
  warnings: string[];
};

export type CoupangDailyGroupRow = CoupangDailyVisibleMetrics & {
  rowType: "GROUP";
  groupId: string;
  groupName: string;
  productName: string;
  childProductCount: number;
  children: CoupangDailyProductRow[];
  previous: CoupangDailyPreviousMetrics;
  calculationStatus: "COMPLETE" | "INCOMPLETE";
  warnings: string[];
};

export type CoupangDailyReportRow =
  | CoupangDailyGroupRow
  | CoupangDailyProductRow;

export type CoupangDailySummary = CoupangDailyVisibleMetrics & {
  isComplete: boolean;
  knownMarginKrw: number;
  incompleteProductCount: number;
  excludedNetSalesKrw: number;
  excludedSalesQuantity: number;
};

export type CoupangDailyReportResponse = {
  date: string;
  previousDate: string;
  summary: {
    current: CoupangDailySummary;
    previous: CoupangDailySummary;
  };
  rows: CoupangDailyReportRow[];
};

export type CoupangManualPurchaseOption = {
  coupangProductId: string;
  coupangProductRuleId: string | null;
  productName: string;
  ruleDisplayName: string | null;
  groupId: string | null;
  groupName: string | null;
  saleMethod: string | null;
  searchText: string;
  salePriceKrw: number | null;
  baseSalePriceKrw: number | null;
  promotionPriceKrw: number | null;
  priceSource: string;
  priceWarnings: string[];
  unitSalesAmountKrw: number | null;
  unitProductCostKrw: number | null;
  unitVendorFeeKrw: number;
  unitCoupangSalesFeeKrw: number | null;
  unitShippingCostKrw: number | null;
  unitOtherCostKrw: number | null;
  unitTotalCostKrw: number | null;
  existingQuantity: number;
  existingMemo: string;
  isCalculable: boolean;
  warnings: string[];
};

export type CoupangManualPurchaseOptionsResponse = {
  date: string;
  vendorFeePerUnitKrw: number;
  groups: { id: string; displayName: string }[];
  options: CoupangManualPurchaseOption[];
};

export type CoupangManualPurchaseSavedRow = {
  coupangProductId: string;
  quantity: number;
  salesAmountKrw: number | null;
  salesAmountSource: "STORED" | "SALE_PRICE" | "PROMOTION_PRICE" | "BASE_PRICE" | "MISSING";
  productCostKrw: number;
  vendorFeeTotalKrw: number;
  coupangSalesFeeKrw: number;
  salesFeeRateApplied: number;
  shippingCostKrw: number;
  otherCostKrw: number;
  totalCostKrw: number;
  memo: string;
  warnings: string[];
};

export type CoupangManualPurchaseSaveResponse = {
  date: string;
  selectedOptionCount: number;
  totalQuantity: number;
  totalSalesAmountKrw: number;
  totalCostKrw: number;
  rows: CoupangManualPurchaseSavedRow[];
};
