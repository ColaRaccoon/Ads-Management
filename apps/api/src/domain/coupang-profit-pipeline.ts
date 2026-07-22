import {
  calculateCoupangProfitBySegments,
  normalizeCoupangFulfillmentMethod,
  parseExplicitCoupangFulfillmentMethod,
  type CoupangAdInput,
  type CoupangCostInput,
  type CoupangFeeMode,
  type CoupangFulfillmentMethod,
  type CoupangSegmentProfitResult
} from "./coupang-profit-calculator";

export type CoupangCalculationPartStatus = "COMPLETE" | "INCOMPLETE" | "NOT_APPLICABLE";

export type ReportedSalesFactInput = {
  productId: string;
  date: string;
  salesKrw: number;
  cancelAmountKrw: number;
  netSalesKrw: number;
  salesQuantity: number;
  orderCount: number;
  saleMethod?: string | null;
  lineCount?: number;
  productName?: string;
};

export type CoupangSalesSegment = {
  fulfillmentMethod: CoupangFulfillmentMethod;
  sourceSaleMethods: string[];
  salesKrw: number;
  cancelAmountKrw: number;
  netSalesKrw: number;
  salesQuantity: number;
  orderCount: number;
  lineCount: number;
};

export type ReportedSalesFacts = {
  productId: string;
  date: string;
  productName: string;
  salesKrw: number;
  cancelAmountKrw: number;
  netSalesKrw: number;
  salesQuantity: number;
  orderCount: number;
  lineCount: number;
  saleMethods: string[];
  segments: CoupangSalesSegment[];
  hasReportedRows: boolean;
};

export type ManualPurchaseFactInput = {
  productId: string;
  date: string;
  quantity: number;
  salesAmountKrw?: number | null;
  salePriceKrw?: number | null;
  promotionPriceKrw?: number | null;
  baseSalePriceKrw?: number | null;
  productCostKrw?: number | null;
  vendorFeeKrw?: number | null;
  coupangSalesFeeKrw?: number | null;
  shippingCostKrw?: number | null;
  vatKrw?: number | null;
  otherCostKrw?: number | null;
  totalCostKrw?: number | null;
  saleMethod?: string | null;
};

export type ManualPurchaseFacts = {
  productId: string;
  date: string;
  quantity: number;
  salesAmountKrw: number | null;
  productCostKrw: number | null;
  vendorFeeKrw: number | null;
  coupangSalesFeeKrw: number | null;
  shippingCostKrw: number | null;
  vatKrw: number | null;
  otherCostKrw: number | null;
  totalCostKrw: number | null;
  saleMethods: string[];
  rowCount: number;
  warnings: string[];
  isCostSnapshotComplete: boolean;
};

export type ActualSalesFacts = {
  salesKrw: number | null;
  netSalesKrw: number | null;
  salesQuantity: number | null;
  orderCount: number;
  segments: CoupangSalesSegment[];
  warnings: string[];
  isValid: boolean;
  isManualOnly: boolean;
};

export type NormalCoupangProfitResult = {
  status: CoupangCalculationPartStatus;
  calculated: CoupangSegmentProfitResult | null;
  warnings: string[];
};

export function productDateKey(productId: string, date: string) {
  return `${productId}\u0000${date}`;
}

export function aggregateReportedSalesByProductDate(rows: ReportedSalesFactInput[]) {
  const result = new Map<string, ReportedSalesFacts>();
  for (const row of rows) {
    const key = productDateKey(row.productId, row.date);
    const current = result.get(key) ?? emptyReportedSalesFacts(row.productId, row.date, row.productName ?? "Coupang Product");
    current.hasReportedRows = true;
    if (row.saleMethod && !current.saleMethods.includes(row.saleMethod)) {
      current.saleMethods.push(row.saleMethod);
    }
    const fulfillmentMethod = normalizeCoupangFulfillmentMethod(row.saleMethod);
    let segment = current.segments.find((candidate) => candidate.fulfillmentMethod === fulfillmentMethod);
    if (!segment) {
      segment = emptySalesSegment(fulfillmentMethod);
      current.segments.push(segment);
    }
    if (row.saleMethod && !segment.sourceSaleMethods.includes(row.saleMethod)) {
      segment.sourceSaleMethods.push(row.saleMethod);
    }
    segment.salesKrw += finiteOrZero(row.salesKrw);
    segment.cancelAmountKrw += finiteOrZero(row.cancelAmountKrw);
    segment.netSalesKrw += finiteOrZero(row.netSalesKrw);
    segment.salesQuantity += finiteOrZero(row.salesQuantity);
    segment.orderCount += finiteOrZero(row.orderCount);
    segment.lineCount += Math.max(0, Math.trunc(finiteOrZero(row.lineCount ?? 1)));
    syncReportedTotalsFromSegments(current);
    result.set(key, current);
  }
  return result;
}

export function aggregateManualPurchasesByProductDate(rows: ManualPurchaseFactInput[]) {
  const grouped = new Map<string, ManualPurchaseFactInput[]>();
  for (const row of rows) {
    const key = productDateKey(row.productId, row.date);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const result = new Map<string, ManualPurchaseFacts>();
  for (const [key, group] of grouped) {
    const warnings: string[] = [];
    const resolvedSales = group.map(resolveManualPurchaseSalesAmount);
    warnings.push(...resolvedSales.flatMap((resolved) => resolved.warnings));
    if (group.length > 1) warnings.push("DUPLICATE_MANUAL_PURCHASE_ROWS");
    if (group.some((row) => !Number.isInteger(row.quantity) || row.quantity <= 0)) {
      warnings.push("MANUAL_PURCHASE_INVALID_QUANTITY");
    }

    const productCostKrw = sumNullable(group.map((row) => nonNegativeOrNull(row.productCostKrw)));
    const vendorFeeKrw = sumNullable(group.map((row) => nonNegativeOrNull(row.vendorFeeKrw)));
    const coupangSalesFeeKrw = sumNullable(group.map((row) => nonNegativeOrNull(row.coupangSalesFeeKrw)));
    const shippingCostKrw = sumNullable(group.map((row) => nonNegativeOrNull(row.shippingCostKrw)));
    const vatKrw = sumNullable(group.map((row) => nonNegativeOrNull(row.vatKrw)));
    const otherCostKrw = sumNullable(group.map((row) => nonNegativeOrNull(row.otherCostKrw)));
    const totalCostKrw = sumNullable(group.map((row) => nonNegativeOrNull(row.totalCostKrw)));
    const componentTotal = sumNullable([productCostKrw, vendorFeeKrw, coupangSalesFeeKrw, shippingCostKrw, vatKrw, otherCostKrw]);
    const isCostSnapshotComplete = totalCostKrw !== null && componentTotal !== null;
    if (!isCostSnapshotComplete) {
      warnings.push("MANUAL_PURCHASE_COST_SNAPSHOT_INCOMPLETE");
    } else if (Math.abs(totalCostKrw - componentTotal) > 0.05) {
      warnings.push("MANUAL_PURCHASE_TOTAL_COST_MISMATCH");
    }

    const first = group[0];
    result.set(key, {
      productId: first.productId,
      date: first.date,
      quantity: group.reduce((sum, row) => sum + finiteOrZero(row.quantity), 0),
      salesAmountKrw: sumNullable(resolvedSales.map((resolved) => resolved.salesAmountKrw)),
      productCostKrw,
      vendorFeeKrw,
      coupangSalesFeeKrw,
      shippingCostKrw,
      vatKrw,
      otherCostKrw,
      totalCostKrw,
      saleMethods: unique(group.map((row) => row.saleMethod)),
      rowCount: group.length,
      warnings: unique(warnings),
      isCostSnapshotComplete: isCostSnapshotComplete && !warnings.includes("MANUAL_PURCHASE_TOTAL_COST_MISMATCH")
    });
  }
  return result;
}

export function resolveManualPurchaseSalesAmount(input: Pick<
  ManualPurchaseFactInput,
  "quantity" | "salesAmountKrw" | "salePriceKrw" | "promotionPriceKrw" | "baseSalePriceKrw"
>) {
  const storedAmount = positiveOrNull(input.salesAmountKrw);
  if (storedAmount !== null) {
    return { salesAmountKrw: storedAmount, source: "STORED" as const, warnings: [] as string[] };
  }

  const prices = [
    ["SALE_PRICE", input.salePriceKrw],
    ["PROMOTION_PRICE", input.promotionPriceKrw],
    ["BASE_PRICE", input.baseSalePriceKrw]
  ] as const;
  for (const [source, value] of prices) {
    const price = positiveOrNull(value);
    if (price !== null && Number.isInteger(input.quantity) && input.quantity > 0) {
      return {
        salesAmountKrw: price * input.quantity,
        source,
        warnings: ["MANUAL_PURCHASE_SALES_AMOUNT_LEGACY_FALLBACK"]
      };
    }
  }
  return {
    salesAmountKrw: null,
    source: "MISSING" as const,
    warnings: ["MANUAL_PURCHASE_SALES_AMOUNT_MISSING"]
  };
}

export function adjustReportedSalesForManualPurchase(
  reported: ReportedSalesFacts,
  manual: ManualPurchaseFacts | null
): ActualSalesFacts {
  const reportedSegments = resolvedReportedSegments(reported);
  if (!manual || manual.quantity === 0) {
    return {
      salesKrw: reported.salesKrw,
      netSalesKrw: reported.netSalesKrw,
      salesQuantity: reported.salesQuantity,
      orderCount: reported.orderCount,
      segments: cloneSalesSegments(reportedSegments),
      warnings: [],
      isValid: true,
      isManualOnly: false
    };
  }

  const warnings = [...manual.warnings];
  if (!reported.hasReportedRows) {
    warnings.push("MANUAL_PURCHASE_WITHOUT_REPORTED_SALES");
    return {
      salesKrw: 0,
      netSalesKrw: 0,
      salesQuantity: 0,
      orderCount: 0,
      segments: [],
      warnings: unique(warnings),
      isValid: !hasBlockingManualSalesWarning(warnings),
      isManualOnly: true
    };
  }

  const manualSaleMethod = manual.saleMethods.length === 1 ? manual.saleMethods[0] : null;
  const exactTargetSegment = manualSaleMethod === null
    ? null
    : reportedSegments.find((segment) => segment.sourceSaleMethods.some(
        (sourceSaleMethod) => canonicalSaleMethod(sourceSaleMethod) === canonicalSaleMethod(manualSaleMethod)
      )) ?? null;
  const manualFulfillmentMethod = manualSaleMethod === null
    ? null
    : parseExplicitCoupangFulfillmentMethod(manualSaleMethod);
  const targetSegment = reportedSegments.length === 1
    ? reportedSegments[0]
    : exactTargetSegment ?? (manualFulfillmentMethod
        ? reportedSegments.find((segment) => segment.fulfillmentMethod === manualFulfillmentMethod) ?? null
        : null);
  if (reportedSegments.length > 1 && !targetSegment) {
    warnings.push("MANUAL_PURCHASE_SALE_METHOD_REQUIRED_FOR_MIXED_SALES");
    return {
      salesKrw: reported.salesKrw,
      netSalesKrw: reported.netSalesKrw,
      salesQuantity: reported.salesQuantity,
      orderCount: reported.orderCount,
      segments: cloneSalesSegments(reportedSegments),
      warnings: unique(warnings),
      isValid: false,
      isManualOnly: false
    };
  }

  const deductionBase = targetSegment ?? emptySalesSegment(manualFulfillmentMethod ?? "SELLER");
  if (manual.quantity > deductionBase.salesQuantity) {
    warnings.push("MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED");
  }
  if (manual.salesAmountKrw !== null && manual.salesAmountKrw > deductionBase.salesKrw) {
    warnings.push("MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED");
  }
  const adjustedSegments = cloneSalesSegments(reportedSegments);
  const adjustedTarget = adjustedSegments.find((segment) => segment.fulfillmentMethod === deductionBase.fulfillmentMethod);
  if (adjustedTarget) {
    adjustedTarget.salesQuantity -= manual.quantity;
    if (manual.salesAmountKrw !== null) {
      adjustedTarget.salesKrw -= manual.salesAmountKrw;
      adjustedTarget.netSalesKrw -= manual.salesAmountKrw;
    }
  }
  const segmentTotals = sumCoupangSalesSegments(adjustedSegments);
  const actualSalesKrw = manual.salesAmountKrw === null ? null : segmentTotals.salesKrw;
  const actualNetSalesKrw = manual.salesAmountKrw === null ? null : segmentTotals.netSalesKrw;
  const actualSalesQuantity = segmentTotals.salesQuantity;
  if (actualSalesQuantity < 0 && !warnings.includes("MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED")) {
    warnings.push("MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED");
  }
  if (actualSalesKrw !== null && actualSalesKrw < 0 && !warnings.includes("MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED")) {
    warnings.push("MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED");
  }
  if (actualNetSalesKrw !== null && actualNetSalesKrw < 0) {
    warnings.push("MANUAL_PURCHASE_ADJUSTED_NET_SALES_NEGATIVE");
  }
  return {
    salesKrw: actualSalesKrw,
    netSalesKrw: actualNetSalesKrw,
    salesQuantity: actualSalesQuantity,
    orderCount: reported.orderCount,
    segments: adjustedSegments,
    warnings: unique(warnings),
    isValid: !hasBlockingManualSalesWarning(warnings),
    isManualOnly: false
  };
}

export function calculateNormalCoupangProfit(input: {
  reported: ReportedSalesFacts;
  actual: ActualSalesFacts;
  cost: CoupangCostInput | null;
  ads: CoupangAdInput;
  feeMode?: CoupangFeeMode;
}): NormalCoupangProfitResult {
  const warnings: string[] = [];
  if (!input.actual.isValid || input.actual.netSalesKrw === null || input.actual.salesQuantity === null) {
    return { status: "INCOMPLETE", calculated: null, warnings };
  }

  const hasNormalActivity = hasCoupangSalesSegmentActivity(input.actual.segments);
  if (!hasNormalActivity) {
    const calculated = calculateCoupangProfitBySegments({
      segments: input.actual.segments,
      cost: emptyCostInput(),
      ads: input.ads,
      feeMode: input.feeMode,
      includeReturnCost: false
    });
    return { status: "NOT_APPLICABLE", calculated, warnings: calculated.warnings };
  }
  if (!input.cost) {
    return { status: "INCOMPLETE", calculated: null, warnings: ["NORMAL_COST_RULE_MISSING"] };
  }
  const missingLogisticsWarnings = missingCoupangLogisticsCostWarnings(input.actual.segments, input.cost);
  if (missingLogisticsWarnings.length > 0) {
    return { status: "INCOMPLETE", calculated: null, warnings: missingLogisticsWarnings };
  }
  const calculated = calculateCoupangProfitBySegments({
    segments: input.actual.segments,
    cost: input.cost,
    ads: input.ads,
    feeMode: input.feeMode,
    includeReturnCost: true
  });
  return { status: "COMPLETE", calculated, warnings: calculated.warnings };
}

export function calculateManualPurchaseProfitAdjustment(manual: ManualPurchaseFacts | null) {
  if (!manual || manual.quantity === 0) {
    return { status: "NOT_APPLICABLE" as const, totalCostKrw: 0, marginAdjustmentKrw: 0, warnings: [] as string[] };
  }
  const blocking = hasBlockingManualWarning(manual.warnings) || !manual.isCostSnapshotComplete || manual.totalCostKrw === null;
  if (blocking) {
    return {
      status: "INCOMPLETE" as const,
      totalCostKrw: manual.totalCostKrw,
      marginAdjustmentKrw: null,
      warnings: manual.warnings
    };
  }
  const totalCostKrw = manual.totalCostKrw as number;
  return {
    status: "COMPLETE" as const,
    totalCostKrw,
    marginAdjustmentKrw: -totalCostKrw,
    warnings: manual.warnings
  };
}

export function combineCoupangProfitParts(input: {
  normal: NormalCoupangProfitResult;
  manual: ReturnType<typeof calculateManualPurchaseProfitAdjustment>;
}) {
  const calculationStatus = input.normal.status === "INCOMPLETE" || input.manual.status === "INCOMPLETE"
    ? "INCOMPLETE" as const
    : "COMPLETE" as const;
  if (calculationStatus === "INCOMPLETE" || !input.normal.calculated || input.manual.totalCostKrw === null) {
    return { calculationStatus, totalCostKrw: null, marginKrw: null };
  }
  return {
    calculationStatus,
    totalCostKrw: input.normal.calculated.totalCostKrw + input.manual.totalCostKrw,
    marginKrw: input.normal.calculated.marginKrw - input.manual.totalCostKrw
  };
}

export function emptyReportedSalesFacts(productId: string, date: string, productName = "Coupang Product"): ReportedSalesFacts {
  return {
    productId,
    date,
    productName,
    salesKrw: 0,
    cancelAmountKrw: 0,
    netSalesKrw: 0,
    salesQuantity: 0,
    orderCount: 0,
    lineCount: 0,
    saleMethods: [],
    segments: [],
    hasReportedRows: false
  };
}

function hasBlockingManualSalesWarning(warnings: string[]) {
  return warnings.some((warning) => [
    "DUPLICATE_MANUAL_PURCHASE_ROWS",
    "MANUAL_PURCHASE_INVALID_QUANTITY",
    "MANUAL_PURCHASE_SALES_AMOUNT_MISSING",
    "MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED",
    "MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED",
    "MANUAL_PURCHASE_ADJUSTED_NET_SALES_NEGATIVE",
    "MANUAL_PURCHASE_SALE_METHOD_REQUIRED_FOR_MIXED_SALES"
  ].includes(warning));
}

function hasBlockingManualWarning(warnings: string[]) {
  return hasBlockingManualSalesWarning(warnings) || warnings.some((warning) => [
    "MANUAL_PURCHASE_COST_SNAPSHOT_INCOMPLETE",
    "MANUAL_PURCHASE_TOTAL_COST_MISMATCH"
  ].includes(warning));
}

function emptyCostInput(): CoupangCostInput {
  return { productCostKrw: 0 };
}

export function sumCoupangSalesSegments(segments: CoupangSalesSegment[]) {
  return segments.reduce((totals, segment) => ({
    salesKrw: totals.salesKrw + finiteOrZero(segment.salesKrw),
    cancelAmountKrw: totals.cancelAmountKrw + finiteOrZero(segment.cancelAmountKrw),
    netSalesKrw: totals.netSalesKrw + finiteOrZero(segment.netSalesKrw),
    salesQuantity: totals.salesQuantity + finiteOrZero(segment.salesQuantity),
    orderCount: totals.orderCount + finiteOrZero(segment.orderCount),
    lineCount: totals.lineCount + finiteOrZero(segment.lineCount)
  }), {
    salesKrw: 0,
    cancelAmountKrw: 0,
    netSalesKrw: 0,
    salesQuantity: 0,
    orderCount: 0,
    lineCount: 0
  });
}

export function hasCoupangSalesSegmentActivity(segments: CoupangSalesSegment[]) {
  return segments.some((segment) => segment.netSalesKrw !== 0 || segment.salesQuantity !== 0);
}

export function missingCoupangLogisticsCostWarnings(
  segments: CoupangSalesSegment[],
  cost: CoupangCostInput
) {
  const warnings: string[] = [];
  const hasSellerSales = segments.some(
    (segment) => segment.fulfillmentMethod === "SELLER" && segment.salesQuantity > 0
  );
  const hasGrowthSales = segments.some(
    (segment) => segment.fulfillmentMethod === "GROWTH" && segment.salesQuantity > 0
  );
  if (hasSellerSales && cost.sellerShippingFeeKrw === null) {
    warnings.push("SELLER_SHIPPING_FEE_MISSING");
  }
  if (hasGrowthSales && cost.hanaroShippingFeeKrw === null) {
    warnings.push("HANARO_SHIPPING_FEE_MISSING");
  }
  return warnings;
}

function emptySalesSegment(fulfillmentMethod: CoupangFulfillmentMethod): CoupangSalesSegment {
  return {
    fulfillmentMethod,
    sourceSaleMethods: [],
    salesKrw: 0,
    cancelAmountKrw: 0,
    netSalesKrw: 0,
    salesQuantity: 0,
    orderCount: 0,
    lineCount: 0
  };
}

function cloneSalesSegments(segments: CoupangSalesSegment[]) {
  return segments.map((segment) => ({
    ...segment,
    sourceSaleMethods: [...segment.sourceSaleMethods]
  }));
}

function canonicalSaleMethod(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function resolvedReportedSegments(reported: ReportedSalesFacts) {
  if (reported.segments?.length) {
    return reported.segments;
  }
  if (!reported.hasReportedRows && reported.salesKrw === 0 && reported.netSalesKrw === 0 && reported.salesQuantity === 0) {
    return [];
  }
  return [{
    fulfillmentMethod: normalizeCoupangFulfillmentMethod(reported.saleMethods[0]),
    sourceSaleMethods: [...reported.saleMethods],
    salesKrw: reported.salesKrw,
    cancelAmountKrw: reported.cancelAmountKrw,
    netSalesKrw: reported.netSalesKrw,
    salesQuantity: reported.salesQuantity,
    orderCount: reported.orderCount,
    lineCount: reported.lineCount
  }];
}

function syncReportedTotalsFromSegments(reported: ReportedSalesFacts) {
  const totals = sumCoupangSalesSegments(reported.segments);
  reported.salesKrw = totals.salesKrw;
  reported.cancelAmountKrw = totals.cancelAmountKrw;
  reported.netSalesKrw = totals.netSalesKrw;
  reported.salesQuantity = totals.salesQuantity;
  reported.orderCount = totals.orderCount;
  reported.lineCount = totals.lineCount;
}

function finiteOrZero(value: number | null | undefined) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function positiveOrNull(value: number | null | undefined) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}

function nonNegativeOrNull(value: number | null | undefined) {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

function sumNullable(values: Array<number | null>) {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + Number(value), 0);
}

function unique(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}
