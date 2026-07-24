export function parseSelectedManualPurchaseQuantity(value: string, productLabel: string, memo = "") {
  const text = value.trim();
  const quantity = text === "" ? 0 : Number(text);
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`${productLabel}: 수량은 0 이상의 정수여야 합니다.`);
  }
  if (quantity === 0 && memo.trim() === "") return null;
  return quantity;
}

type ManualPurchaseDraft = { quantity: string };
type ManualPurchaseSummaryOption = {
  coupangProductId: string;
  unitSalesAmountKrw: number | null;
  unitVendorFeeKrw: number | null;
  isCalculable: boolean;
  warnings: string[];
};

export function summarizeManualPurchaseDrafts(
  drafts: Record<string, ManualPurchaseDraft>,
  options: ManualPurchaseSummaryOption[]
) {
  const optionById = new Map(options.map((option) => [option.coupangProductId, option]));
  let selectedOptionCount = 0;
  let totalQuantity = 0;
  let expectedSalesAmountKrw: number | null = 0;
  let expectedVendorFeeKrw: number | null = 0;
  let expectedCostKrw: number | null = 0;
  let uncalculableCount = 0;
  const uncalculableReasons: string[] = [];

  for (const [productId, draft] of Object.entries(drafts)) {
    const quantity = Number(draft.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const option = optionById.get(productId);
    const hasSalesAmount = Number.isFinite(option?.unitSalesAmountKrw);
    const hasVendorFee = Number.isFinite(option?.unitVendorFeeKrw);
    const hasCost = hasVendorFee;
    selectedOptionCount += 1;
    totalQuantity += quantity;
    expectedSalesAmountKrw = expectedSalesAmountKrw === null || !hasSalesAmount
      ? null
      : expectedSalesAmountKrw + quantity * Number(option?.unitSalesAmountKrw);
    expectedVendorFeeKrw = expectedVendorFeeKrw === null || !hasVendorFee
      ? null
      : expectedVendorFeeKrw + roundMoney(quantity * Number(option?.unitVendorFeeKrw));
    expectedCostKrw = expectedVendorFeeKrw;

    if (!option?.isCalculable || !hasSalesAmount || !hasCost) {
      uncalculableCount += 1;
      uncalculableReasons.push(...(option?.warnings.length ? option.warnings : ["가구매 예상 금액 계산 불가"]));
    }
  }

  return {
    selectedOptionCount,
    totalQuantity,
    expectedSalesAmountKrw,
    expectedVendorFeeKrw,
    expectedCostKrw,
    uncalculableCount,
    uncalculableReasons: Array.from(new Set(uncalculableReasons))
  };
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
