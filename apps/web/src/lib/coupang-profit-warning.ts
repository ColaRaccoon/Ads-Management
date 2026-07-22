type CoupangProfitWarningRow = {
  productName: string;
  calculationStatus: "COMPLETE" | "INCOMPLETE";
  warnings: string[];
  ruleStatus: "OK" | "MISSING_COST_RULE" | "UNMATCHED";
};

const COUPANG_LOGISTICS_MISSING_WARNINGS = new Set([
  "SELLER_SHIPPING_FEE_MISSING",
  "HANARO_SHIPPING_FEE_MISSING",
  "GROWTH_INBOUND_FEE_MISSING",
  "GROWTH_SHIPPING_FEE_MISSING"
]);

export function hasCoupangLogisticsMissingWarning(warnings: string[]) {
  return warnings.some((warning) => COUPANG_LOGISTICS_MISSING_WARNINGS.has(warning));
}

export function formatCoupangIncompleteReasons(rows: CoupangProfitWarningRow[], maxReasonCount = 3) {
  const productNamesByReason = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.calculationStatus !== "INCOMPLETE") continue;
    const reasons = Array.from(new Set([
      ...row.warnings,
      ...(row.ruleStatus !== "OK" ? [row.ruleStatus] : [])
    ]));
    for (const reason of reasons.length > 0 ? reasons : ["INCOMPLETE_REASON_UNKNOWN"]) {
      const productNames = productNamesByReason.get(reason) ?? new Set<string>();
      productNames.add(row.productName);
      productNamesByReason.set(reason, productNames);
    }
  }

  const reasons = Array.from(productNamesByReason.entries());
  if (reasons.length === 0) return "";
  const displayed = reasons.slice(0, maxReasonCount).map(([reason, productNames]) => {
    const names = Array.from(productNames);
    const displayedNames = names.slice(0, 2).join(", ");
    const remainingNameCount = Math.max(0, names.length - 2);
    return `${coupangProfitWarningLabel(reason)} (${displayedNames}${remainingNameCount > 0 ? ` 외 ${remainingNameCount}개` : ""})`;
  });
  const remainingReasonCount = Math.max(0, reasons.length - maxReasonCount);
  return `주요 원인: ${displayed.join(" · ")}${remainingReasonCount > 0 ? ` · 외 ${remainingReasonCount}개` : ""}`;
}

export function coupangProfitWarningLabel(reason: string) {
  return ({
    SELLER_SHIPPING_FEE_MISSING: "판매자 배송비가 설정되지 않았습니다",
    HANARO_SHIPPING_FEE_MISSING: "하나로 배송비가 설정되지 않았습니다",
    GROWTH_INBOUND_FEE_MISSING: "그로스 입출고비가 설정되지 않았습니다",
    GROWTH_SHIPPING_FEE_MISSING: "그로스 배송비가 설정되지 않았습니다"
  } as Record<string, string>)[reason] ?? reason;
}
