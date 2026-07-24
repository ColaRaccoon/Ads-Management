import { parseKrwIntegerInput } from "./krw-input";
import { percentInputToRate } from "./percent-input";

export type CoupangCostField =
  | "salePriceKrw" | "supplyPriceKrw" | "productCostKrw"
  | "sellerShippingFeeKrw" | "hanaroShippingFeeKrw"
  | "growthInboundFeeKrw" | "growthShippingFeeKrw"
  | "returnRate" | "returnCostPerUnitKrw" | "extraCostKrw"
  | "legacySalesFeePercent" | "effectiveFrom";

export type CoupangCostForm = Record<CoupangCostField, string>;
export type CoupangCostPayload = {
  salePriceKrw?: number;
  supplyPriceKrw?: number;
  productCostKrw?: number;
  sellerShippingFeeKrw: number | null;
  hanaroShippingFeeKrw: number | null;
  growthInboundFeeKrw?: number;
  growthShippingFeeKrw?: number;
  returnRate?: number;
  returnCostPerUnitKrw?: number;
  extraCostKrw?: number;
  salesFeeRate?: number;
  effectiveFrom: string;
};

const KRW_FIELDS = [
  "salePriceKrw", "supplyPriceKrw", "productCostKrw",
  "sellerShippingFeeKrw", "hanaroShippingFeeKrw",
  "growthInboundFeeKrw", "growthShippingFeeKrw",
  "returnCostPerUnitKrw", "extraCostKrw"
] as const;

export function validateCoupangCostForm(form: CoupangCostForm, includeLegacySalesFee = false) {
  const errors: Partial<Record<CoupangCostField, string>> = {};
  for (const field of KRW_FIELDS) {
    const result = parseKrwIntegerInput(form[field]);
    if (result.kind === "invalid") errors[field] = result.message;
  }
  validatePercent(form.returnRate, "returnRate", "반품률", errors);
  if (includeLegacySalesFee) validatePercent(form.legacySalesFeePercent, "legacySalesFeePercent", "판매 수수료율", errors);
  if (!isDateOnly(form.effectiveFrom)) errors.effectiveFrom = "적용 시작일을 YYYY-MM-DD 형식으로 입력하세요.";
  return { isValid: Object.keys(errors).length === 0, errors };
}

export function buildCoupangCostPayload(
  form: CoupangCostForm,
  options: { includeLegacySalesFee?: boolean } = {}
): CoupangCostPayload {
  const validation = validateCoupangCostForm(form, options.includeLegacySalesFee);
  if (!validation.isValid) {
    const error = new Error("금액 입력을 확인하세요.");
    Object.assign(error, { fieldErrors: validation.errors });
    throw error;
  }
  const payload: CoupangCostPayload = {
    sellerShippingFeeKrw: nullableKrw(form.sellerShippingFeeKrw),
    hanaroShippingFeeKrw: nullableKrw(form.hanaroShippingFeeKrw),
    effectiveFrom: form.effectiveFrom
  };
  for (const field of [
    "salePriceKrw", "supplyPriceKrw", "productCostKrw", "growthInboundFeeKrw",
    "growthShippingFeeKrw", "returnCostPerUnitKrw", "extraCostKrw"
  ] as const) {
    const parsed = parseKrwIntegerInput(form[field]);
    if (parsed.kind === "valid") payload[field] = parsed.value;
  }
  const returnRate = percentInputToRate(form.returnRate);
  if (returnRate !== undefined) payload.returnRate = returnRate;
  if (options.includeLegacySalesFee) {
    const salesFeeRate = percentInputToRate(form.legacySalesFeePercent);
    if (salesFeeRate !== undefined) payload.salesFeeRate = salesFeeRate;
  }
  return payload;
}

function nullableKrw(raw: string) {
  const parsed = parseKrwIntegerInput(raw);
  return parsed.kind === "valid" ? parsed.value : null;
}

function validatePercent(raw: string, field: "returnRate" | "legacySalesFeePercent", label: string, errors: Partial<Record<CoupangCostField, string>>) {
  try {
    percentInputToRate(raw);
  } catch {
    errors[field] = `${label}은 0 이상 100 이하의 숫자여야 합니다.`;
  }
}

function isDateOnly(raw: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}
