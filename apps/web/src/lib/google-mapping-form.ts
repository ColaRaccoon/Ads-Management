import type { GoogleMapping, GoogleMappingDraft, GoogleSaleConfiguration } from "../types/google";
import { googleMoney } from "./google-display";
import { storefrontToday } from "./storefront-display";

export function blankGoogleMapping(kind: GoogleMappingDraft["kind"] = "CAMPAIGN", startDate = storefrontToday("Asia/Seoul")!): GoogleMappingDraft {
  return {
    kind, connectionId: "", productId: null, startDate, endDate: null,
    ...(kind === "CAMPAIGN" ? { campaignId: "" } : { productNo: "", optionName: "", optionScope: "EXACT" as const })
  };
}

export const googleSaleAmountFields = [
  { key: "salePriceKrwOverride", label: "구성 판매가 (원)" },
  { key: "productCostKrwOverride", label: "구성 상품원가 (원)" },
  { key: "shippingKrwOverride", label: "구성 배송비 (원)" },
  { key: "extraCostKrwOverride", label: "구성 추가비용 (원)" }
] as const;

export function editGoogleMapping(mapping: GoogleMapping): GoogleMappingDraft {
  return {
    kind: mapping.kind, id: mapping.id, connectionId: mapping.connectionId,
    campaignId: mapping.campaignId ?? undefined, productNo: mapping.productNo ?? undefined,
    optionName: mapping.optionName ?? "", productId: mapping.productId,
    startDate: mapping.startDate.slice(0, 10), endDate: mapping.endDate?.slice(0, 10) ?? null,
    expectedUpdatedAt: mapping.updatedAt,
    ...(mapping.kind === "SALE" ? {
      optionScope: mapping.optionScope ?? "EXACT", saleUnitLabel: mapping.saleUnitLabel ?? null,
      salePriceKrwOverride: mapping.salePriceKrwOverride ?? null,
      productCostKrwOverride: mapping.productCostKrwOverride ?? null,
      shippingKrwOverride: mapping.shippingKrwOverride ?? null,
      extraCostKrwOverride: mapping.extraCostKrwOverride ?? null
    } : {})
  };
}

export function googleMappingInputError(draft: GoogleMappingDraft): string | null {
  if (draft.kind !== "SALE") return null;
  const amounts = googleSaleAmountFields.map(({ key }) => draft[key]);
  const filled = amounts.filter((value) => value != null);
  if (filled.length !== 0 && filled.length !== 4) return "Google 전용 구성 금액은 4개를 모두 입력하거나 모두 비워 주세요. 비용이 없으면 0을 입력하세요.";
  if (draft.saleUnitLabel?.trim() && filled.length !== 4) return "판매단위 이름을 지정하려면 구성 금액 4개를 모두 입력해 주세요.";
  if (filled.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 999999999999.99 || !/^\d+(?:\.\d{1,2})?$/.test(String(value)))) return "구성 금액은 0 이상, 소수점 둘째 자리까지 입력해 주세요.";
  if (draft.optionScope === "PRODUCT" && draft.optionName) return "상품번호 전체 연결에는 특정 옵션을 지정할 수 없습니다.";
  return null;
}

export function googleSaleConfigurationText(value: GoogleSaleConfiguration) {
  const unit = value.saleUnitLabel || "기존 판매단위";
  if (googleSaleAmountFields.every(({ key }) => value[key] == null)) return `${unit} · 기존 비용 규칙 사용`;
  return `${unit} · 판매가 ${googleMoney(value.salePriceKrwOverride)} / 원가 ${googleMoney(value.productCostKrwOverride)} / 배송비 ${googleMoney(value.shippingKrwOverride)} / 추가비용 ${googleMoney(value.extraCostKrwOverride)}`;
}
