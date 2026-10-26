import type { GoogleCampaignRow, GoogleProfitRow } from "../types/google";
import type { CsvColumn } from "./csv";

const WARNINGS: Record<string, string> = {
  GOOGLE_COLLECTION_INCOMPLETE: "Google 광고비 미수집 / 수집 미완료",
  CAFE24_COLLECTION_INCOMPLETE: "카페24 판매 수집 미완료",
  MISSING_COST_RULE: "설정 판매가 / 원가 규칙 누락",
  COUPON_UNRESOLVED: "쿠폰 판정 또는 주문행 배분 미확정",
  COUPON_ESTIMATED: "추정 쿠폰 적용",
  UNALLOCATED_AD_SPEND: "미배분 Google 광고비 존재",
  AMBIGUOUS_CAMPAIGN_PRODUCT: "캠페인명에 여러 상품이 포함되어 자동 연결 보류",
  CAMPAIGN_PRODUCT_NOT_FOUND: "캠페인명에서 활성 상품명을 찾지 못함",
  UNMAPPED_SALES: "미연결 유튜브 판매 존재",
  MISSING_EXCHANGE_RATE: "원화 환산 환율 누락",
  TIME_ZONE_MISMATCH: "광고 계정과 카페24 영업일의 시간대 불일치",
  TIME_ZONE_UNKNOWN: "광고 계정 시간대 미확인",
  CAFE24_TIME_ZONE_MISMATCH: "카페24 영업일의 시간대 불일치",
  CAFE24_CURRENCY_MISMATCH: "카페24 계정 통화 불일치",
  PRICE_MISMATCH: "수집 판매가와 설정 판매가 차이",
  SOURCE_SELECTION_REQUIRED: "CSV / API 원천 선택 필요",
  PAGE_NAME_UNVERIFIED: "판매 페이지 이름과 수집 상품명 일치 여부 미검증"
};
export const googleReason = (code: string) => WARNINGS[code] ?? `확인 필요 (${code})`;
export const googleReasons = (codes: string[]) => codes.map(googleReason).join(" · ");
function roundedGoogleInteger(value: number | string | null | undefined): string {
  if (value == null) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    const rounded = Math.round(value);
    return (rounded === 0 ? 0 : rounded).toLocaleString("ko-KR", { maximumFractionDigits: 0 });
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return "—";
  const [, sign, integer, fraction = ""] = match;
  // Match Math.round's ties toward +Infinity without converting exact API decimals to Number.
  const increment = sign
    ? fraction[0] > "5" || (fraction[0] === "5" && /[1-9]/.test(fraction.slice(1)))
    : fraction[0] >= "5";
  const magnitude = BigInt(integer) + (increment ? 1n : 0n);
  return `${sign && magnitude !== 0n ? "-" : ""}${magnitude.toLocaleString("ko-KR")}`;
}
export const googleMoney = (value: number | string | null | undefined) => {
  const rounded = roundedGoogleInteger(value);
  return rounded === "—" ? rounded : `${rounded} 원`;
};
export const googleNumber = (value: number | null | undefined) => roundedGoogleInteger(value);
export const googleRatio = (value: number | null, percent = false) => {
  const rounded = roundedGoogleInteger(value == null ? null : percent ? value * 100 : value);
  return rounded === "—" ? rounded : `${rounded}${percent ? "%" : "배"}`;
};
export const googleSaleUnit = (row: Pick<GoogleProfitRow, "saleUnitLabel" | "saleUnitLabels">) => row.saleUnitLabel || (row.saleUnitLabels?.length ? `혼합 단위 (${row.saleUnitLabels.join(" / ")} · 기존 단위 포함 가능)` : "기존 판매단위");

/** The screen and export both use server values. No channel calculation occurs here. */
export function googleProfitColumns(productName: (id: string | null) => string): CsvColumn<GoogleProfitRow>[] {
  return [
    { header: "일자", value: (row) => row.date },
    { header: "상품 ID", value: (row) => row.productId },
    { header: "상품", value: (row) => productName(row.productId) },
    { header: "판매수량", value: (row) => row.quantity },
    { header: "판매단위", value: (row) => googleSaleUnit(row) },
    { header: "설정 판매가 기준 매출 (KRW)", value: (row) => row.revenueKrw },
    { header: "계산 가능한 매출 부분합 (KRW)", value: (row) => row.knownRevenueKrw },
    { header: "수집 판매가 기준 금액 (결제액 아님, KRW)", value: (row) => row.collectedRevenueKrw },
    { header: "판매비용 (KRW)", value: (row) => row.grossCostKrw },
    { header: "유튜브 판매행 쿠폰 차감 (KRW)", value: (row) => row.couponDeductionKrw },
    { header: "배분 Google 광고비 (KRW)", value: (row) => row.adSpendKrwExact },
    { header: "확정 마진 (KRW)", value: (row) => row.marginKrw },
    { header: "계산 가능한 잠정 마진 (KRW)", value: (row) => row.calculatedMarginKrw },
    { header: "마진율 (비율)", value: (row) => row.marginRate },
    { header: "페이지 기준 ROAS (배)", value: (row) => row.roas },
    { header: "판매가 차이 행 수", value: (row) => row.priceMismatchCount },
    { header: "완전성", value: (row) => row.complete ? "확정" : "미확정" },
    { header: "확인 사유", value: (row) => googleReasons(row.warningCodes) },
    { header: "노출수", value: (row) => row.impressions ?? null },
    { header: "클릭수", value: (row) => row.clicks ?? null },
    { header: "클릭률 (비율)", value: (row) => row.ctr ?? null },
    { header: "클릭당 비용 (KRW)", value: (row) => row.cpcKrw ?? null },
    { header: "판매 1개당 광고비 (카페24 판매수량 기준, KRW)", value: (row) => row.costPerSaleKrw ?? null }
  ];
}

export function googleCampaignColumns(productName: (id: string | null) => string): CsvColumn<GoogleCampaignRow>[] {
  return [
    { header: "연결 ID", value: (row) => row.connectionId },
    { header: "광고 계정", value: (row) => row.customerId },
    { header: "캠페인 ID", value: (row) => row.campaignId },
    { header: "캠페인", value: (row) => row.campaignName },
    { header: "연결 상품", value: (row) => row.productIds.map(productName).join(" / ") },
    { header: "미배분 포함", value: (row) => row.hasUnmapped ? "있음" : "없음" },
    { header: "통화", value: (row) => row.currencyCode },
    { header: "원본 비용 micros", value: (row) => row.costMicros },
    { header: "광고비 (KRW)", value: (row) => row.adSpendKrwExact },
    { header: "노출", value: (row) => row.impressions },
    { header: "클릭", value: (row) => row.clicks },
    { header: "CTR (비율)", value: (row) => row.ctr },
    { header: "CPC (KRW)", value: (row) => row.cpcKrw },
    { header: "확인 사유", value: (row) => googleReasons(row.warningCodes) }
  ];
}
