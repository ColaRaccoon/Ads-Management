export type CoupangShippingFeeForm = {
  sellerShippingFeeKrw: string;
  hanaroShippingFeeKrw: string;
};

export function coupangShippingFeePayload(form: CoupangShippingFeeForm) {
  return {
    sellerShippingFeeKrw: nullableShippingFeeValue(form.sellerShippingFeeKrw),
    hanaroShippingFeeKrw: nullableShippingFeeValue(form.hanaroShippingFeeKrw)
  };
}

function nullableShippingFeeValue(value: string): number | string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
}
