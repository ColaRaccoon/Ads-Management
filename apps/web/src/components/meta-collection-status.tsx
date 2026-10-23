"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, rangeQuery } from "@/lib/api";

type CollectionSummary = {
  mode: "DISABLED" | "NO_API_POLICY" | "API";
  items: Array<{ connectionId: string; accountId: string; dataKind: string;
    expectedDays: number; collectedDays: number; missingDays: number;
    failedDays: number; runningDays: number; lastSuccessAt: string | null;
    lastAttemptAt: string | null }>;
};

export function MetaCollectionStatus({ range }: { range: { from: string; to: string } }) {
  const query = useQuery({ queryKey: ["meta-collection", range.from, range.to],
    queryFn: () => apiGet<CollectionSummary>(`/dashboard/meta-collection?${rangeQuery(range)}`) });
  if (query.isError) return <div className="warning-strip" role="status">Meta API 수집 상태를 확인할 수 없습니다.</div>;
  if (!query.data || query.data.mode === "DISABLED") return null;
  if (query.data.mode === "NO_API_POLICY") return <div className="warning-strip" role="status">Meta API 수집 미연결</div>;
  return <div className="warning-strip" role="status">{query.data.items.map(item =>
    <span key={`${item.connectionId}:${item.dataKind}`}>
      Meta {item.accountId} {item.dataKind === "META_AD" ? "광고" : "광고세트"} · {item.collectedDays}/{item.expectedDays}일 수집 · 미수집 {item.missingDays}일 · 실패 {item.failedDays}일 · 진행 {item.runningDays}일 · 마지막 성공 {time(item.lastSuccessAt)} · 마지막 시도 {time(item.lastAttemptAt)}
      {item.failedDays > 0 && item.collectedDays > 0 ? " · 마지막 성공 데이터를 표시합니다." : ""}
    </span>)}</div>;
}

function time(value: string | null) {
  return value ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "없음";
}
