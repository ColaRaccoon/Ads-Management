const fields: Record<string, string> = {
  purchaseCount: "구매", resultCount: "결과", landingPageViews: "랜딩 페이지 조회", shopClicks: "샵 클릭",
  addToCartCount: "장바구니", videoPlay3sCount: "영상 3초", videoPlay25Count: "영상 25%",
  videoPlay50Count: "영상 50%", videoPlay75Count: "영상 75%", videoPlay100Count: "영상 100%"
};
const reasons: Record<string, string> = {
  UNSUPPORTED_FIELD: "제공되지 않음", RESULT_MAPPING_UNVERIFIED: "결과 의미 미확정",
  ATTRIBUTION_UNVERIFIED: "기여 설정 미확정", ATTRIBUTION_MISMATCH: "기여 설정 불일치",
  MIXED_ATTRIBUTION: "기여 설정 혼합", MIXED_RESULT: "결과 유형 혼합",
  AMBIGUOUS_ACTION: "액션 의미 미확정", NOT_APPLICABLE: "해당 결과 없음", PARTIAL_METRIC: "일부 값 미확정"
};

export function formatMetaMetricReasons(values?: Record<string, string> | null): string {
  return Object.entries(values ?? {}).filter(([field, reason]) => fields[field] && reasons[reason])
    .map(([field, reason]) => `${fields[field]}: ${reasons[reason]}`).join(" · ");
}
