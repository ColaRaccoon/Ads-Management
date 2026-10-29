import { ApiError, apiGet } from "@/lib/api";
import { chartNumber } from "./chart-model";
import { filterParams, responseMatches, type Reader } from "./model";
import type { Envelope, Filters, Platform } from "./types";

export const ANALYSIS_MEDIA = ["META", "GOOGLE", "NAVER_DA", "COUPANG_ADS"] as const;
export type AnalysisMedium = typeof ANALYSIS_MEDIA[number];
export type RelationshipMetric = "revenue" | "profitBeforeAds";
export type RelationshipValue = RelationshipMetric | "adSpend" | "otherAdSpend";
export type RelationshipDay = { date: string; adSpend: string | null; otherAdSpend: string | null; revenue: string | null;
  profitBeforeAds: string | null; isEstimate: boolean; issues: string[]; weekday: number;
  movingAverage7: Record<RelationshipValue, string | null> };
export type RelationshipPair = { outcomeDate: string; adDate: string; adSpend: string; outcome: string; otherAdSpend: string | null; isEstimate: boolean; issues: string[] };
export type RelationshipLag = { lagDays: number; metric: RelationshipMetric; from: string; to: string; expectedDays: number; usedDays: number; excludedDays: number;
  excludedDates: { outcomeDate: string; adDate: string; reasons: string[] }[]; pairs: RelationshipPair[]; coefficient: string | null; reasons: string[];
  volatility: { adSpendStdDev: string | null; outcomeStdDev: string | null }; isEstimate: boolean; issues: string[] };
export type RelationshipWindow = { from: string; to: string; expectedDays: number;
  metrics: Record<RelationshipValue, { usedDays: number; excludedDays: number; mean: string | null; complete: boolean }> };
export type RelationshipComparison = { windowDays: number; changeDate: string; before: RelationshipWindow; after: RelationshipWindow;
  changes: Record<RelationshipValue, { change: string | null; changePct: string | null; reason: string | null }> };
export type Relationships = Envelope & { baseSnapshotHash: string; analysis: {
  analysisMedia: AnalysisMedium[]; availableMedia: AnalysisMedium[]; changeDate?: string; outcomeLabel: string; lookbackFrom: string;
  events: { status: "UNAVAILABLE"; message: string }; policy: { minimumPairs: number; maximumMissingFraction: string; lagDirection: string; movingAverageUse: string };
  lags: RelationshipLag[]; daily: RelationshipDay[]; beforeAfter: RelationshipComparison[]; warnings: string[];
} };
const MEDIA_PLATFORM: Record<AnalysisMedium, Platform> = { META: "META", GOOGLE: "GOOGLE", NAVER_DA: "NAVER", COUPANG_ADS: "COUPANG" };
export const availableAnalysisMedia = (platforms: Platform[]) => ANALYSIS_MEDIA.filter(medium => platforms.includes(MEDIA_PLATFORM[medium]));
export const selectedAnalysisMedia = (platforms: Platform[], selected?: readonly AnalysisMedium[] | null) => availableAnalysisMedia(platforms).filter(medium => selected == null || selected.includes(medium));
export function relationshipParams(filters: Filters, media: readonly AnalysisMedium[], changeDate = "") {
  const params = filterParams(filters);
  params.set("analysisMedia", JSON.stringify(selectedAnalysisMedia(filters.platforms, media)));
  if (changeDate) params.set("changeDate", changeDate);
  return params;
}
export const relationshipKey = (identity: string, filters: Filters, media: readonly AnalysisMedium[], changeDate: string, anchor: Envelope) =>
  ["product-performance-relationships", identity, relationshipParams(filters, media, changeDate).toString(), anchor.snapshotHash] as const;
export function assertRelationshipResponse(data: Relationships, filters: Filters, media: readonly AnalysisMedium[], changeDate: string, anchor: Envelope) {
  const expected = selectedAnalysisMedia(filters.platforms, media);
  if (!responseMatches(data, filters) || data.baseSnapshotHash !== anchor.snapshotHash || data.selection.selectionHash !== anchor.selection.selectionHash ||
    JSON.stringify(data.analysis.analysisMedia) !== JSON.stringify(expected) || (data.analysis.changeDate ?? "") !== changeDate ||
    data.analysis.beforeAfter.some(row => row.changeDate !== changeDate) || (!changeDate && data.analysis.beforeAfter.length > 0)) {
    throw new ApiError(409, "관계 분석의 조회 조건 또는 발행 버전이 바뀌었습니다. 다시 조회해 주세요.", "UNIFIED_RELATIONSHIPS_CHANGED");
  }
}
export async function loadRelationships(filters: Filters, media: readonly AnalysisMedium[], changeDate: string, anchor: Envelope, read: Reader = apiGet, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const result = await read<Relationships>(`/unified-performance/relationships?${relationshipParams(filters, media, changeDate)}`);
  signal?.throwIfAborted();
  assertRelationshipResponse(result, filters, media, changeDate, anchor);
  return result;
}
export const relationshipCoordinates = (pairs: RelationshipPair[]) => pairs.flatMap(pair => {
  const x = chartNumber(pair.adSpend), y = chartNumber(pair.outcome);
  return x === null || y === null ? [] : [{ ...pair, x, y }];
});
export function validChangeDate(value: string, filters: Filters) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value && value >= filters.from && value <= filters.to;
}
const REASONS: Record<string, string> = {
  INSUFFICIENT_PAIRS: "유효 일별 쌍 60개 미만", CONSTANT_AD_SPEND: "분석 광고비 변동 없음", CONSTANT_OUTCOME: "결과값 변동 없음",
  EXCESSIVE_MISSING: "누락 과다", MISSING_AD_SPEND: "분석 광고비 미확인", MISSING_OUTCOME: "결과값 미확인",
  MISSING_AD_DATE: "선행 광고일 미확인", MISSING_OUTCOME_DATE: "결과일 미확인", MISSING_INPUT: "입력 미확인",
  INCOMPLETE_WINDOW: "기간 내 누락 또는 창 일부만 확보", ZERO_BASE: "변경 전 평균 0", NON_POSITIVE_BASE: "변경 전 평균이 0 이하",
  NON_POSITIVE_PROFIT_BASE: "광고 전 이익의 변경 전 평균이 0 이하", NO_ANALYSIS_MEDIA: "분석할 광고 매체를 선택하세요.",
  OBSERVATIONAL_RELATIONSHIP_ONLY: "관측 관계이며 인과효과가 아닙니다.",
  MINIMUM_PAIRS_IS_DISPLAY_POLICY: "최소 표본수는 계수 표시 정책이며 통계적 보장이 아닙니다.",
  OTHER_MEDIA_AND_UNRECORDED_EVENTS_MAY_COCHANGE: "다른 매체 비용·미기록 행사·가격·품절 등이 함께 변했을 수 있습니다.",
  NET_PROFIT_DIRECTLY_SUBTRACTS_AD_SPEND: "순이익은 광고비를 직접 차감하므로 매출 효과와 구분합니다.",
};
export const relationshipReason = (reason: string) => REASONS[reason] ?? reason;
