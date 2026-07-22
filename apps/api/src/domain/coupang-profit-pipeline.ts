import {
  calculateCoupangProfit,
  type CoupangAdInput,
  type CoupangCostInput,
  type CoupangFeeMode,
  type CoupangProfitResult
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
  warnings: string[];
  isValid: boolean;
  isManualOnly: boolean;
};

export type NormalCoupangProfitResult = {
  status: CoupangCalculationPartStatus;
  calculated: CoupangProfitResult | null;
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
    current.salesKrw += finiteOrZero(row.salesKrw);
    current.cancelAmountKrw += finiteOrZero(row.cancelAmountKrw);
    current.netSalesKrw += finiteOrZero(row.netSalesKrw);
    current.salesQuantity += finiteOrZero(row.salesQuantity);
    current.orderCount += finiteOrZero(row.orderCount);
    current.lineCount += Math.max(0, Math.trunc(finiteOrZero(row.lineCount ?? 1)));
    current.hasReportedRows = true;
    if (row.saleMethod && !current.saleMethods.includes(row.saleMethod)) {
      current.saleMethods.push(row.saleMethod);
    }
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
  if (!manual || manual.quantity === 0) {
    return {
      salesKrw: reported.salesKrw,
      netSalesKrw: reported.netSalesKrw,
      salesQuantity: reported.salesQuantity,
      orderCount: reported.orderCount,
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
      warnings: unique(warnings),
      isValid: !hasBlockingManualSalesWarning(warnings),
      isManualOnly: true
    };
  }

  if (manual.quantity > reported.salesQuantity) {
    warnings.push("MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED");
  }
  if (manual.salesAmountKrw !== null && manual.salesAmountKrw > reported.salesKrw) {
    warnings.push("MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED");
  }
  const actualSalesKrw = manual.salesAmountKrw === null ? null : reported.salesKrw - manual.salesAmountKrw;
  const actualNetSalesKrw = manual.salesAmountKrw === null ? null : reported.netSalesKrw - manual.salesAmountKrw;
  const actualSalesQuantity = reported.salesQuantity - manual.quantity;
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

  const hasNormalActivity = input.actual.netSalesKrw !== 0 || input.actual.salesQuantity !== 0;
  if (!hasNormalActivity) {
    const calculated = calculateCoupangProfit(
      { saleMethod: null, netSalesKrw: input.actual.netSalesKrw, salesQuantity: input.actual.salesQuantity },
      emptyCostInput(),
      input.ads,
      { includeReturnCost: false, useGrowthCost: true }
    );
    return { status: "NOT_APPLICABLE", calculated, warnings: calculated.warnings };
  }
  if (!input.cost) {
    return { status: "INCOMPLETE", calculated: null, warnings: ["NORMAL_COST_RULE_MISSING"] };
  }
  if (input.reported.saleMethods.length > 1) {
    return { status: "INCOMPLETE", calculated: null, warnings: ["NORMAL_SALE_METHOD_CONFLICT"] };
  }

  const calculated = calculateCoupangProfit(
    {
      saleMethod: input.reported.saleMethods[0] ?? null,
      netSalesKrw: input.actual.netSalesKrw,
      salesQuantity: input.actual.salesQuantity
    },
    input.cost,
    input.ads,
    { feeMode: input.feeMode, includeReturnCost: true, useGrowthCost: true }
  );
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
    "MANUAL_PURCHASE_ADJUSTED_NET_SALES_NEGATIVE"
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
