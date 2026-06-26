import { formatDateOnly } from "./date-number";

export type CoupangPriceSource = "PROMOTION" | "BASE" | "MISSING" | "CONFLICT";

export type CoupangPromotionPriceCandidate = {
  promotionPriceKrw: number | null | undefined;
  promotionStartDate: Date;
  promotionEndDate: Date;
  promotionStatus?: string | null;
  validationErrors?: unknown;
};

export type CoupangResolvedPrice = {
  salePriceKrw: number | null;
  baseSalePriceKrw: number | null;
  promotionPriceKrw: number | null;
  priceSource: CoupangPriceSource;
  priceWarnings: string[];
};

export function resolveCoupangSalePrice(input: {
  baseSalePriceKrw: number | null | undefined;
  promotions: CoupangPromotionPriceCandidate[];
  date: Date;
}): CoupangResolvedPrice {
  const baseSalePriceKrw = positiveNumberOrNull(input.baseSalePriceKrw);
  const activePromotionPrices = Array.from(
    new Set(
      input.promotions
        .filter((promotion) => isPromotionActiveOn(promotion, input.date))
        .filter(isPromotionPriceCandidateEligible)
        .map((promotion) => positiveNumberOrNull(promotion.promotionPriceKrw))
        .filter((value): value is number => value !== null)
    )
  );

  if (activePromotionPrices.length === 1) {
    return {
      salePriceKrw: activePromotionPrices[0],
      baseSalePriceKrw,
      promotionPriceKrw: activePromotionPrices[0],
      priceSource: "PROMOTION",
      priceWarnings: []
    };
  }

  if (activePromotionPrices.length > 1) {
    return {
      salePriceKrw: baseSalePriceKrw,
      baseSalePriceKrw,
      promotionPriceKrw: null,
      priceSource: "CONFLICT",
      priceWarnings: ["PROMOTION_PRICE_CONFLICT"]
    };
  }

  if (baseSalePriceKrw !== null) {
    return {
      salePriceKrw: baseSalePriceKrw,
      baseSalePriceKrw,
      promotionPriceKrw: null,
      priceSource: "BASE",
      priceWarnings: []
    };
  }

  return {
    salePriceKrw: null,
    baseSalePriceKrw: null,
    promotionPriceKrw: null,
    priceSource: "MISSING",
    priceWarnings: ["BASE_SALE_PRICE_MISSING"]
  };
}

function isPromotionActiveOn(promotion: CoupangPromotionPriceCandidate, date: Date) {
  const target = formatDateOnly(date);
  return formatDateOnly(promotion.promotionStartDate) <= target && formatDateOnly(promotion.promotionEndDate) >= target;
}

export function isPromotionPriceCandidateEligible(promotion: Pick<CoupangPromotionPriceCandidate, "promotionStatus" | "validationErrors">) {
  return !isInactivePromotionStatus(promotion.promotionStatus) && !hasValidationErrorCode(promotion.validationErrors, "INVALID_PROMOTION_STATUS");
}

export function isInactivePromotionStatus(status: string | null | undefined) {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  return ["취소", "반려", "거절", "중지", "cancel", "canceled", "cancelled", "reject", "rejected", "stop", "stopped"].some((value) =>
    normalized.includes(value)
  );
}

function hasValidationErrorCode(value: unknown, errorCode: string) {
  return Array.isArray(value) && value.some((item) => Boolean(item && typeof item === "object" && "errorCode" in item && item.errorCode === errorCode));
}

function positiveNumberOrNull(value: number | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
