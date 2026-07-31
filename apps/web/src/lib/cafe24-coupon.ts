export type Cafe24CouponScope = "GLOBAL" | "PRODUCT";
export type CouponMatchStatus = "NO_COUPON" | "APPLIED" | "UNMATCHED";
export type CouponMatchConfidence = "NONE" | "EXACT" | "ESTIMATED";
export type CouponAggregateStatus = "NO_COUPON" | "EXACT" | "ESTIMATED" | "UNMATCHED" | "MIXED";
export type CouponAuditCategory = "EXACT" | "ESTIMATED" | "UNMATCHED";

export const CAFE24_COUPON_DEPENDENT_QUERY_KEYS = [
  ["cafe24-coupon-rules"],
  ["products"],
  ["sales-product-performance"],
  ["daily-report-sales-product-performance"]
] as const;

export const CAFE24_COUPON_PRODUCTS_QUERY_PATH = "/products?includeInactive=true";
export const CAFE24_COUPON_PRODUCTS_QUERY_KEY = ["products", "includeInactive"] as const;

export type Cafe24CouponProduct = {
  id?: string | null;
  productId?: string | null;
  displayName?: string | null;
  name?: string | null;
  code?: string | null;
  productName?: string | null;
};

export type Cafe24CouponRule = {
  id: string;
  name: string;
  scope: Cafe24CouponScope;
  productId: string | null;
  discountKrw: number | string;
  priority: number;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
  note?: string | null;
  createdAt?: string;
  updatedAt?: string;
  product?: Cafe24CouponProduct | null;
};

export type Cafe24CouponAuditRow = {
  orderNo: string;
  orderDate: string | null;
  productIds?: string[];
  productNames?: string[];
  products?: Cafe24CouponProduct[];
  paymentMethod: string | null;
  totalOrderKrw: number | null;
  totalPaidKrw: number | null;
  observedGapKrw: number | null;
  selectedRuleId?: string | null;
  selectedRuleName: string | null;
  selectedScope: Cafe24CouponScope | null;
  couponDeductionKrw: number;
  ignoredResidualKrw: number;
  status: CouponMatchStatus;
  confidence: CouponMatchConfidence;
  warningCodes: string[];
};

export type Cafe24CouponAuditResponse = {
  period: { from: string; to: string };
  rows: Cafe24CouponAuditRow[];
};

export function couponAuditCategory(row: Pick<Cafe24CouponAuditRow, "confidence" | "status">): CouponAuditCategory {
  if (row.status === "UNMATCHED") {
    return "UNMATCHED";
  }
  return row.confidence === "ESTIMATED" ? "ESTIMATED" : "EXACT";
}

export function couponAuditLabel(row: Pick<Cafe24CouponAuditRow, "confidence" | "status">) {
  switch (couponAuditCategory(row)) {
    case "EXACT":
      return "정확";
    case "ESTIMATED":
      return "추정";
    case "UNMATCHED":
      return "미적용";
  }
}

export function couponAggregateLabel(status: CouponAggregateStatus | null | undefined) {
  switch (status) {
    case "EXACT":
      return "정확";
    case "ESTIMATED":
      return "추정";
    case "UNMATCHED":
      return "미적용";
    case "MIXED":
      return "혼합";
    case "NO_COUPON":
    case null:
    case undefined:
      return "쿠폰 없음";
  }
}

export function couponScopeLabel(scope: Cafe24CouponScope | null | undefined) {
  return scope === "PRODUCT" ? "상품별" : scope === "GLOBAL" ? "전체 상품" : "-";
}

export function couponProductLabel(row: Pick<Cafe24CouponAuditRow, "productIds" | "productNames" | "products">) {
  const productNames = (row.productNames ?? []).filter(Boolean);
  if (productNames.length > 0) {
    return productNames.join(", ");
  }
  const embeddedNames = (row.products ?? [])
    .map((product) => product.displayName ?? product.productName ?? product.name ?? product.code ?? product.productId ?? product.id)
    .filter((value): value is string => Boolean(value));
  if (embeddedNames.length > 0) {
    return embeddedNames.join(", ");
  }
  return (row.productIds ?? []).join(", ") || "-";
}

export function dateInputText(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

export function salesExcelDataLastRow(totalRowCount: number) {
  return Math.max(1, totalRowCount - 1);
}
