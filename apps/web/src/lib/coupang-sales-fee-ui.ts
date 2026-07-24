export const COUPANG_SALES_FEE_DEPENDENT_QUERY_KEYS = [
  "coupang-product-profit",
  "coupang-dashboard",
  "coupang-daily-report"
] as const;

export function canSaveCoupangProductForm(input: {
  displayName: string;
  isEditing: boolean;
  isCorrectingCostRule: boolean;
  includeKeywordCount: number;
}) {
  return Boolean(input.displayName.trim())
    && (!input.isEditing || input.isCorrectingCostRule || input.includeKeywordCount > 0);
}

export function coupangRateLabel(value: string | number | null | undefined) {
  if (value === null || value === undefined || String(value).trim() === "") return "-";
  const number = Number(value);
  return Number.isFinite(number)
    ? `${(number * 100).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`
    : "-";
}

export function currentCoupangSalesFeeLabel(rule: {
  salesFeePercent: number;
  effectiveFrom: string;
} | null) {
  return rule
    ? `${rule.salesFeePercent}% (${rule.effectiveFrom}부터)`
    : "적용 중인 공통값 없음";
}

export function coupangMoneyLabel(value: string | number | null | undefined) {
  if (value === null || value === undefined || String(value).trim() === "") return "-";
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number).toLocaleString("ko-KR")}원` : "-";
}

export function coupangCostRuleTodayImpactLabel(rule: {
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}, koreaToday: string) {
  const from = rule.effectiveFrom?.slice(0, 10);
  const to = rule.effectiveTo?.slice(0, 10);
  if (from && from > koreaToday) return "미래 시작 이력이므로 오늘 현재값은 바뀌지 않습니다.";
  if (to && to < koreaToday) return "과거 기간 이력이므로 오늘 현재값은 바뀌지 않습니다.";
  return "오늘의 현재 비용값으로 적용됩니다.";
}

export function coupangCostCorrectionSuccessLabel(rule: {
  salesFeeRate?: string | number | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  productCostKrw?: string | number | null;
  supplyPriceKrw?: string | number | null;
  sellerShippingFeeKrw?: string | number | null;
  hanaroShippingFeeKrw?: string | number | null;
}, koreaToday: string) {
  const from = rule.effectiveFrom?.slice(0, 10) || "-";
  const to = rule.effectiveTo?.slice(0, 10);
  const values = [
    ["상품원가", rule.productCostKrw],
    ["공급가", rule.supplyPriceKrw],
    ["판매자 배송비", rule.sellerShippingFeeKrw],
    ["하나로 배송비", rule.hanaroShippingFeeKrw]
  ].map(([label, value]) => `${label} ${krwLabel(value)}`).join(", ");
  return `비용 이력 정정 완료: ${from}${to ? `~${to}` : "부터"}, ${values}, 레거시 판매 수수료율 ${coupangRateLabel(rule.salesFeeRate)}. ${coupangCostRuleTodayImpactLabel(rule, koreaToday)}`;
}

export function coupangProductCreationSuccessLabel(product: {
  displayName: string;
  costRules?: Array<{
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
    productCostKrw?: string | number | null;
    supplyPriceKrw?: string | number | null;
    sellerShippingFeeKrw?: string | number | null;
    hanaroShippingFeeKrw?: string | number | null;
  }>;
}, koreaToday: string) {
  const rule = [...(product.costRules ?? [])]
    .filter((candidate) => Boolean(candidate.effectiveFrom))
    .sort((left, right) => String(right.effectiveFrom).localeCompare(String(left.effectiveFrom)))[0];
  if (!rule) return `상품 생성 완료: ${product.displayName}. 저장된 비용 이력은 없습니다.`;
  const from = rule.effectiveFrom?.slice(0, 10) || "-";
  const to = rule.effectiveTo?.slice(0, 10);
  const values = [
    ["상품원가", rule.productCostKrw],
    ["공급가", rule.supplyPriceKrw],
    ["판매자 배송비", rule.sellerShippingFeeKrw],
    ["하나로 배송비", rule.hanaroShippingFeeKrw]
  ].map(([label, value]) => `${label} ${krwLabel(value)}`).join(", ");
  return `상품 생성 및 비용 저장 완료: ${product.displayName}, ${from}${to ? `~${to}` : "부터"}, ${values}. ${coupangCostRuleTodayImpactLabel(rule, koreaToday)}`;
}

function krwLabel(value: string | number | null | undefined) {
  if (value === null || value === undefined || String(value).trim() === "") return "미설정";
  return coupangMoneyLabel(value);
}
