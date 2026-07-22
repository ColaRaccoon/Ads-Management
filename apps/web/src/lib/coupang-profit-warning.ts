type CoupangProfitWarningRow = {
  productName: string;
  calculationStatus: "COMPLETE" | "INCOMPLETE";
  warnings: string[];
  ruleStatus: "OK" | "MISSING_COST_RULE" | "UNMATCHED";
};

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
    return `${reason} (${displayedNames}${remainingNameCount > 0 ? ` 외 ${remainingNameCount}개` : ""})`;
  });
  const remainingReasonCount = Math.max(0, reasons.length - maxReasonCount);
  return `주요 원인: ${displayed.join(" · ")}${remainingReasonCount > 0 ? ` · 외 ${remainingReasonCount}개` : ""}`;
}
