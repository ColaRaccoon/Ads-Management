import { BadRequestException } from "@nestjs/common";
import { assertBusinessDate } from "./domain/product-name-resolver";
import { stringArray, type ReportQuery } from "./report-query";
import type { Platform } from "./types";

export const RELATIONSHIP_MEDIA = ["META", "GOOGLE", "NAVER_DA", "COUPANG_ADS"] as const;
export type RelationshipMedium = typeof RELATIONSHIP_MEDIA[number];
export const MEDIUM_PLATFORM: Record<RelationshipMedium, Platform> = { META: "META", GOOGLE: "GOOGLE", NAVER_DA: "NAVER", COUPANG_ADS: "COUPANG" };
export function parseRelationshipQuery(input: Record<string, unknown>, query: ReportQuery) {
  try {
    const availableMedia = RELATIONSHIP_MEDIA.filter(medium => query.platforms.includes(MEDIUM_PLATFORM[medium]));
    const requested = stringArray(input.analysisMedia, "analysisMedia", 4);
    if (requested?.some(medium => !availableMedia.includes(medium as RelationshipMedium)))
      throw new Error("포함한 플랫폼의 광고 매체만 분석 대상으로 선택해 주세요.");
    if (input.cursor !== undefined) throw new Error("관계 분석은 페이지 cursor를 사용하지 않습니다.");
    const analysisMedia = availableMedia.filter(medium => requested === undefined || requested.includes(medium));
    let changeDate: string | undefined;
    if (input.changeDate !== undefined) {
      if (typeof input.changeDate !== "string") throw new Error("변경일을 확인해 주세요.");
      assertBusinessDate(input.changeDate);
      if (input.changeDate < query.from || input.changeDate > query.to) throw new Error("변경일은 조회 기간 안에서 선택해 주세요.");
      changeDate = input.changeDate;
    }
    return { analysisMedia, availableMedia, changeDate };
  } catch (error) {
    throw new BadRequestException({ code: "UNIFIED_RELATIONSHIP_QUERY_INVALID", message: error instanceof Error ? error.message : "분석 조건을 확인해 주세요." });
  }
}
