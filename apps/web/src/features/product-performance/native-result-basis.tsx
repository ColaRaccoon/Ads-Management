import React from "react";
import { PLATFORM_LABELS } from "./types";
import { compactNativePublicationText, nativeTimestamp, type NativeSourcePublication } from "./native-result-metadata";
export function NativeResultPublicationTimes({ date, sources }: { date: string; sources: readonly NativeSourcePublication[] }) {
  const current = sources.filter(source => source.date === date);
  const labels = new Map<string, number>();
  return <section className="native-result-publication-times" aria-label="보고일 원본 자료와 발행 시각">
    <div className="native-result-screen-only">
    <p><strong>보고일 {date} 자료 시각 · 한국시간(KST)</strong></p>
    {!current.length ? <p>원본자료 기준 미확인 · 통합 발행 미확인</p> : current.map(source => {
      const index = (labels.get(source.platform) ?? 0) + 1; labels.set(source.platform, index);
      const multiple = current.filter(row => row.platform === source.platform).length > 1;
      return <p key={`${source.platform}:${source.scopeKey}:${source.date}`}>{PLATFORM_LABELS[source.platform]}{multiple ? ` · 계정/스토어 ${index}` : ""}
        {` · 원본자료 기준 ${nativeTimestamp(source.sourceAsOf)} · 통합 발행 ${nativeTimestamp(source.publishedAt)}`}{source.stale ? " · 이전 성공 자료" : ""}</p>;
    })}
    <p>발행 시각은 원본 수집 완료나 최신 자료를 보장하지 않습니다.</p>
    </div>
    <p className="native-result-print-only">{compactNativePublicationText(date, current)}</p>
  </section>;
}
