import type { Envelope } from "./types";

export type NativeSourcePublication = Envelope["asOfBySource"][number];
export const NATIVE_RESULT_HELP = "저장된 플랫폼 원본 계산 결과입니다. 이 보고서는 합계와 전일 증감만 계산하며 원가·광고비·순이익을 다시 계산하지 않습니다.";
export const NATIVE_OVERLAP_HELP = "자사몰 원본 보고서에는 유튜브 판매가 포함될 수 있어 구글 원본 매출과 겹칠 수 있습니다. 원본 보고서의 금액과 순이익을 그대로 표시합니다.";
export function nativeTimestamp(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "미확인";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

/** Printed metadata summarizes bounds without claiming every source is equally recent.
 * Full per-source timestamps remain visible on screen and in the workbook. */
export function compactNativePublicationText(date: string, sources: readonly NativeSourcePublication[]) {
  const current = sources.filter(source => source.date === date);
  const known = (key: "sourceAsOf" | "publishedAt") => current.flatMap(source => {
    const stamp = source[key]; return stamp && Number.isFinite(Date.parse(stamp)) ? [stamp] : [];
  }).sort((a, b) => Date.parse(a) - Date.parse(b));
  const sourceTimes = known("sourceAsOf"), publishedTimes = known("publishedAt");
  const unknownSources = current.length - sourceTimes.length, unknownPublications = current.length - publishedTimes.length;
  return `자료 시각(KST): 원본 가장 이른 기준 ${nativeTimestamp(sourceTimes[0] ?? null)} · 가장 늦은 통합 발행 ${nativeTimestamp(publishedTimes.at(-1) ?? null)}` +
    `${unknownSources ? ` · 원본 시각 미확인 ${unknownSources}개` : ""}${unknownPublications ? ` · 발행 시각 미확인 ${unknownPublications}개` : ""}` +
    `${current.some(source => source.stale) ? ` · 이전 성공 자료 ${current.filter(source => source.stale).length}개` : ""}. 발행은 최신·수집 완료를 보장하지 않습니다.`;
}
