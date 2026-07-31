const AMOUNT_TOLERANCE_KRW = 1;

export type Cafe24CouponScopeValue = "GLOBAL" | "PRODUCT";

export type Cafe24CouponOrderLineInput = {
  orderDate: Date | null;
  paymentMethod: string | null;
  totalOrderKrw: number | null;
  totalPaidKrw: number | null;
  productId: string | null;
  salePriceKrw: number;
  quantity: number;
  isValid?: boolean;
};

export type Cafe24CouponRuleInput = {
  id: string;
  name: string;
  scope: Cafe24CouponScopeValue;
  productId: string | null;
  discountKrw: number;
  priority: number;
  validFrom: Date;
  validTo: Date | null;
  isActive: boolean;
  createdAt: Date;
};

export type CouponMatchStatus = "NO_COUPON" | "APPLIED" | "UNMATCHED";

export type CouponMatchConfidence = "NONE" | "EXACT" | "ESTIMATED";

export type CouponWarningCode =
  | "MISSING_TOTAL_ORDER"
  | "INCOMPLETE_ORDER_DATA"
  | "INCONSISTENT_ORDER_DATE"
  | "INCONSISTENT_TOTAL_ORDER"
  | "INCONSISTENT_TOTAL_PAID"
  | "NON_POSITIVE_GAP"
  | "NO_ACTIVE_COUPON_RULE"
  | "NO_PLAUSIBLE_COUPON_AMOUNT"
  | "UNMATCHED_PRODUCT"
  | "PARTIAL_PRODUCT_MAPPING"
  | "NON_POSITIVE_ALLOCATION_BASE"
  | "RULE_TIE_RESOLVED_BY_PRIORITY"
  | "IGNORED_RESIDUAL_EXISTS";

export type Cafe24CouponResolution = {
  orderNo: string;
  orderDate: Date | null;
  couponDetected: boolean;
  status: CouponMatchStatus;
  confidence: CouponMatchConfidence;
  totalOrderKrw: number | null;
  totalPaidKrw: number | null;
  observedGapKrw: number | null;
  selectedRuleId: string | null;
  selectedRuleName: string | null;
  selectedScope: Cafe24CouponScopeValue | null;
  couponDeductionKrw: number;
  ignoredResidualKrw: number;
  allocationsByProductId: Map<string, number>;
  warningCodes: CouponWarningCode[];
  candidateRuleIds: string[];
};

export function resolveCafe24CouponOrder(input: {
  orderNo: string;
  lines: readonly Cafe24CouponOrderLineInput[];
  rules: readonly Cafe24CouponRuleInput[];
}): Cafe24CouponResolution {
  const orderDate = firstDate(input.lines);
  const totalOrderKrw = firstFiniteAmount(input.lines.map((line) => line.totalOrderKrw));
  const totalPaidKrw = firstFiniteAmount(input.lines.map((line) => line.totalPaidKrw));
  const couponDetected = input.lines.some((line) => paymentTokens(line.paymentMethod).includes("쿠폰"));
  const base = baseResolution({
    orderNo: input.orderNo,
    orderDate,
    couponDetected,
    totalOrderKrw,
    totalPaidKrw
  });

  if (!couponDetected) {
    return {
      ...base,
      observedGapKrw:
        totalOrderKrw === null || totalPaidKrw === null ? null : totalOrderKrw - totalPaidKrw
    };
  }

  if (input.lines.some((line) => line.isValid === false)) {
    return unmatched(base, "INCOMPLETE_ORDER_DATA");
  }

  if (input.lines.length === 0 || input.lines.some((line) => !isFiniteAmount(line.totalOrderKrw))) {
    return unmatched(base, "MISSING_TOTAL_ORDER");
  }

  if (!datesAreConsistent(input.lines.map((line) => line.orderDate))) {
    return unmatched(base, "INCONSISTENT_ORDER_DATE");
  }

  if (!amountsAreConsistent(input.lines.map((line) => line.totalOrderKrw))) {
    return unmatched(base, "INCONSISTENT_TOTAL_ORDER");
  }

  if (!amountsAreConsistent(input.lines.map((line) => line.totalPaidKrw))) {
    return unmatched(base, "INCONSISTENT_TOTAL_PAID");
  }

  if (totalOrderKrw === null || totalPaidKrw === null) {
    return unmatched(base, "INCONSISTENT_TOTAL_PAID");
  }

  const observedGapKrw = totalOrderKrw - totalPaidKrw;
  const withGap = { ...base, observedGapKrw };
  if (observedGapKrw <= 0) {
    return unmatched(withGap, "NON_POSITIVE_GAP");
  }

  const matchedLineCount = input.lines.filter((line) => Boolean(line.productId)).length;
  if (matchedLineCount === 0) {
    return unmatched(withGap, "UNMATCHED_PRODUCT");
  }
  if (matchedLineCount !== input.lines.length) {
    return unmatched(withGap, "PARTIAL_PRODUCT_MAPPING");
  }

  if (!orderDate) {
    return unmatched(withGap, "NO_ACTIVE_COUPON_RULE");
  }

  const productIds = new Set(input.lines.map((line) => line.productId).filter((id): id is string => Boolean(id)));
  const candidates = input.rules
    .filter((rule) => isRuleEligible(rule, orderDate, productIds))
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const candidateRuleIds = candidates.map((rule) => rule.id);
  if (candidates.length === 0) {
    return unmatched(withGap, "NO_ACTIVE_COUPON_RULE", candidateRuleIds);
  }

  const selection = selectCouponRule(candidates, observedGapKrw);
  if (!selection) {
    return unmatched(withGap, "NO_PLAUSIBLE_COUPON_AMOUNT", candidateRuleIds);
  }

  const warningCodes: CouponWarningCode[] = [];
  if (selection.sameAmountRules.length > 1) {
    warningCodes.push("RULE_TIE_RESOLVED_BY_PRIORITY");
  }

  const allocationsByProductId = allocateCoupon(input.lines, selection.rule);
  if (!allocationsByProductId) {
    warningCodes.push("NON_POSITIVE_ALLOCATION_BASE");
    return {
      ...unmatched(withGap, warningCodes[warningCodes.length - 1], candidateRuleIds),
      warningCodes
    };
  }

  const couponDeductionKrw = selection.rule.discountKrw;
  const ignoredResidualKrw = Math.max(0, observedGapKrw - couponDeductionKrw);
  const confidence: CouponMatchConfidence =
    Math.abs(observedGapKrw - couponDeductionKrw) <= AMOUNT_TOLERANCE_KRW ? "EXACT" : "ESTIMATED";
  if (ignoredResidualKrw > AMOUNT_TOLERANCE_KRW) {
    warningCodes.push("IGNORED_RESIDUAL_EXISTS");
  }

  return {
    ...withGap,
    status: "APPLIED",
    confidence,
    selectedRuleId: selection.rule.id,
    selectedRuleName: selection.rule.name,
    selectedScope: selection.rule.scope,
    couponDeductionKrw,
    ignoredResidualKrw,
    allocationsByProductId,
    warningCodes,
    candidateRuleIds
  };
}

function baseResolution(input: {
  orderNo: string;
  orderDate: Date | null;
  couponDetected: boolean;
  totalOrderKrw: number | null;
  totalPaidKrw: number | null;
}): Cafe24CouponResolution {
  return {
    orderNo: input.orderNo,
    orderDate: input.orderDate,
    couponDetected: input.couponDetected,
    status: input.couponDetected ? "UNMATCHED" : "NO_COUPON",
    confidence: "NONE",
    totalOrderKrw: input.totalOrderKrw,
    totalPaidKrw: input.totalPaidKrw,
    observedGapKrw: null,
    selectedRuleId: null,
    selectedRuleName: null,
    selectedScope: null,
    couponDeductionKrw: 0,
    ignoredResidualKrw: 0,
    allocationsByProductId: new Map(),
    warningCodes: [],
    candidateRuleIds: []
  };
}

function unmatched(
  base: Cafe24CouponResolution,
  warningCode: CouponWarningCode,
  candidateRuleIds: string[] = []
): Cafe24CouponResolution {
  return {
    ...base,
    status: "UNMATCHED",
    confidence: "NONE",
    selectedRuleId: null,
    selectedRuleName: null,
    selectedScope: null,
    couponDeductionKrw: 0,
    ignoredResidualKrw: 0,
    allocationsByProductId: new Map(),
    warningCodes: [warningCode],
    candidateRuleIds
  };
}

function paymentTokens(paymentMethod: string | null): string[] {
  return String(paymentMethod ?? "")
    .normalize("NFKC")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isRuleEligible(rule: Cafe24CouponRuleInput, orderDate: Date, productIds: Set<string>): boolean {
  if (
    !rule.isActive ||
    !Number.isFinite(rule.discountKrw) ||
    rule.discountKrw <= 0 ||
    dateValue(rule.validFrom) > dateValue(orderDate) ||
    (rule.validTo !== null && dateValue(rule.validTo) < dateValue(orderDate))
  ) {
    return false;
  }
  if (rule.scope === "GLOBAL") {
    return rule.productId === null;
  }
  return rule.scope === "PRODUCT" && rule.productId !== null && productIds.has(rule.productId);
}

function selectCouponRule(
  candidates: Cafe24CouponRuleInput[],
  observedGapKrw: number
): { rule: Cafe24CouponRuleInput; sameAmountRules: Cafe24CouponRuleInput[] } | null {
  const exact = candidates.filter(
    (rule) => Math.abs(observedGapKrw - rule.discountKrw) <= AMOUNT_TOLERANCE_KRW
  );

  let selectedAmount: number;
  if (exact.length > 0) {
    const closestDifference = Math.min(...exact.map((rule) => Math.abs(observedGapKrw - rule.discountKrw)));
    selectedAmount = Math.max(
      ...exact
        .filter((rule) => Math.abs(Math.abs(observedGapKrw - rule.discountKrw) - closestDifference) < Number.EPSILON)
        .map((rule) => rule.discountKrw)
    );
  } else {
    const plausible = candidates.filter((rule) => rule.discountKrw <= observedGapKrw + AMOUNT_TOLERANCE_KRW);
    if (plausible.length === 0) {
      return null;
    }
    selectedAmount = Math.max(...plausible.map((rule) => rule.discountKrw));
  }

  const sameAmountRules = candidates
    .filter((rule) => rule.discountKrw === selectedAmount)
    .slice()
    .sort(compareRulesAtSameAmount);
  return { rule: sameAmountRules[0], sameAmountRules };
}

function compareRulesAtSameAmount(left: Cafe24CouponRuleInput, right: Cafe24CouponRuleInput): number {
  if (left.scope !== right.scope) {
    return left.scope === "PRODUCT" ? -1 : 1;
  }
  const priority = left.priority - right.priority;
  if (priority !== 0) {
    return priority;
  }
  const validFrom = dateValue(right.validFrom) - dateValue(left.validFrom);
  if (validFrom !== 0) {
    return validFrom;
  }
  const createdAt = right.createdAt.getTime() - left.createdAt.getTime();
  if (createdAt !== 0) {
    return createdAt;
  }
  return left.id.localeCompare(right.id);
}

function allocateCoupon(
  lines: readonly Cafe24CouponOrderLineInput[],
  rule: Cafe24CouponRuleInput
): Map<string, number> | null {
  if (rule.scope === "PRODUCT") {
    return rule.productId ? new Map([[rule.productId, rule.discountKrw]]) : null;
  }

  const basesByProductId = new Map<string, number>();
  for (const line of lines) {
    if (!line.productId) {
      return null;
    }
    const rawLineBase =
      Number.isFinite(line.salePriceKrw) && Number.isFinite(line.quantity)
        ? line.salePriceKrw * line.quantity
        : 0;
    const lineBase = Math.max(0, rawLineBase);
    basesByProductId.set(line.productId, (basesByProductId.get(line.productId) ?? 0) + lineBase);
  }

  return allocateNonNegativeByWeight(rule.discountKrw, basesByProductId);
}

export function allocateNonNegativeByWeight(
  totalAmount: number,
  weights: ReadonlyMap<string, number>
): Map<string, number> | null {
  if (!Number.isFinite(totalAmount) || totalAmount < 0 || weights.size === 0) {
    return null;
  }

  const entries = [...weights.entries()]
    .map(([key, weight]) => [key, Number.isFinite(weight) ? Math.max(0, weight) : 0] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const totalWeight = entries.reduce((total, [, weight]) => total + weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return null;
  }

  const moneyScale = Number.isInteger(totalAmount) ? 1 : 100;
  const totalUnits = Math.round(totalAmount * moneyScale);
  if (!Number.isSafeInteger(totalUnits) || totalUnits < 0) {
    return null;
  }

  const shares = entries.map(([key, weight]) => {
    const exactUnits = (totalUnits * weight) / totalWeight;
    const floorUnits = Math.floor(exactUnits);
    return {
      key,
      floorUnits,
      remainder: exactUnits - floorUnits
    };
  });
  let remainingUnits = totalUnits - shares.reduce((total, share) => total + share.floorUnits, 0);
  const largestRemainders = shares
    .slice()
    .sort((left, right) => right.remainder - left.remainder || left.key.localeCompare(right.key));
  for (let index = 0; index < remainingUnits; index += 1) {
    largestRemainders[index % largestRemainders.length].floorUnits += 1;
  }

  return new Map(
    shares
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((share) => [share.key, share.floorUnits / moneyScale])
  );
}

function amountsAreConsistent(values: readonly (number | null)[]): boolean {
  if (values.length === 0 || values.some((value) => !isFiniteAmount(value))) {
    return false;
  }
  const numericValues = values as number[];
  return Math.max(...numericValues) - Math.min(...numericValues) <= AMOUNT_TOLERANCE_KRW;
}

function datesAreConsistent(values: readonly (Date | null)[]): boolean {
  if (values.length === 0 || values.some((value) => value === null || !Number.isFinite(value.getTime()))) {
    return false;
  }
  const first = dateValue(values[0] as Date);
  return values.every((value) => dateValue(value as Date) === first);
}

function firstFiniteAmount(values: readonly (number | null)[]): number | null {
  return values.find(isFiniteAmount) ?? null;
}

function isFiniteAmount(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function firstDate(lines: readonly Cafe24CouponOrderLineInput[]): Date | null {
  return lines.find((line) => line.orderDate !== null)?.orderDate ?? null;
}

function dateValue(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}
