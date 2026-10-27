"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCan } from "@/features/auth/use-auth";
import { apiGet, apiErrorMessage } from "@/lib/api";
import { storefrontTime } from "@/lib/storefront-display";
import type { GoogleMappings, GoogleOptions } from "@/types/google";

export function GoogleMappingDiagnostics({ options, query }: { options: GoogleOptions; query: string }) {
  const canRead = useCan("data.read");
  const [page, setPage] = useState(1);
  const saved = useQuery({ queryKey: ["google", "mappings", query, page],
    queryFn: () => apiGet<GoogleMappings>(`/google/mappings?${query}&page=${page}&pageSize=50`),
    enabled: canRead && options.enabled, retry: false, refetchOnWindowFocus: false });
  const productName = (id: string | null) => options.products.find(item => item.id === id)?.displayName ?? (id || "미배분 / 미연결");
  const connectionName = (id: string) => options.connections.find(item => item.id === id)?.displayName ?? id;
  if (!canRead) return <p className="panel" role="alert">데이터 조회 권한이 없습니다.</p>;
  if (!options.enabled) return <p className="panel" role="status">Google 성과 기능이 비활성화되어 있습니다.</p>;
  return <>
    <section className="panel">
      <h2>캠페인 자동 연결 기준</h2>
      <p>날짜별로 수집된 캠페인명에서 현재 활성 상품의 이름을 찾습니다. 띄어쓰기·대소문자·호환 문자를 정규화하며, 같은 상품의 이름과 표시명이 함께 일치해도 한 상품으로 처리합니다.</p>
      <p>서로 다른 상품이 둘 이상 일치하거나 상품명을 찾지 못하면 미배분으로 남깁니다. 기존 캠페인 ID 연결은 이력으로만 보존하며 자동 연결에 사용하지 않습니다.</p>
      <p>상품 이름을 수정하거나 비활성화하면 과거 기간의 자동 연결 결과도 달라질 수 있습니다. 판매 연결의 기간이나 구성을 바꾸면 해당 기간의 Google 결과가 재계산됩니다.</p>
    </section>
    {saved.isLoading ? <p className="panel" role="status">연결 점검 자료를 읽고 있습니다.</p> : null}
    {saved.isError ? <p className="warning-strip" role="alert">{apiErrorMessage(saved.error, "연결 점검 자료를 읽지 못했습니다.")}</p> : null}
    {saved.data ? <>
      <section className="panel">
        <h2>상품명 인식 기준</h2>
        {saved.data.campaignMappingMode === "CAMPAIGN_NAME" ? <div className="table-wrap"><table aria-label="상품명 인식 기준"><thead><tr><th>연결 상품</th><th>캠페인명에서 찾는 이름</th><th>상품 ID</th></tr></thead><tbody>
          {saved.data.nameAutomaticProducts?.map(item => <tr key={item.id}><td>{item.displayName}</td><td>{[...new Set([item.displayName, item.name].filter(Boolean))].join(" / ")}</td><td>{item.id}</td></tr>)}
          {!saved.data.nameAutomaticProducts?.length ? <tr><td colSpan={3}>활성 상품명 기준이 없습니다.</td></tr> : null}
        </tbody></table></div> : <p role="status">캠페인명 자동 연결 기능의 서버 반영을 확인하고 있습니다.</p>}
      </section>
      <section className="panel">
        <h2>기존 캠페인 ID 연결 이력</h2>
        <p>자동 연결에 사용하지 않는 과거 기록입니다. 이 화면에서는 수정하지 않습니다.</p>
        <div className="table-wrap"><table aria-label="기존 캠페인 ID 연결 이력"><thead><tr><th>계정</th><th>캠페인 ID</th><th>기록된 상품</th><th>적용 기간</th><th>변경 시각 (한국)</th></tr></thead><tbody>
          {saved.data.campaignMappings.map(item => <tr key={item.id}><td>{connectionName(item.connectionId)}</td><td>{item.campaignId}</td><td>{productName(item.productId)}</td><td>{item.startDate.slice(0, 10)} ~ {item.endDate?.slice(0, 10) ?? "계속"}</td><td>{storefrontTime(item.updatedAt)}</td></tr>)}
          {!saved.data.campaignMappings.length ? <tr><td colSpan={5}>이 페이지에 기존 캠페인 ID 연결 이력이 없습니다.</td></tr> : null}
        </tbody></table></div>
      </section>
      <section className="panel">
        <h2>현재 페이지 연결의 최근 변경 이력</h2>
        <p>판매 연결과 기존 캠페인 ID 이력 중 현재 페이지에 포함된 연결의 최근 변경을 최대 100건 표시합니다.</p>
        {saved.data.audit.map(item => <div key={item.id}>
          <p>{storefrontTime(item.createdAt)} · 변경자 {item.actorUserId} · {item.before ? "수정" : "생성"}</p>
          <details><summary>이전 / 변경 값</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({ before: item.before, after: item.after }, null, 2)}</pre></details>
        </div>)}
        {!saved.data.audit.length ? <p>이 페이지의 변경 이력이 없습니다.</p> : null}
      </section>
      <div className="toolbar"><button type="button" className="button" disabled={page <= 1 || saved.isFetching} onClick={() => setPage(page - 1)}>이전</button><span>{page} / {Math.max(1, Math.ceil(saved.data.pagination.total / saved.data.pagination.pageSize))} 페이지 · 판매 연결과 기존 ID 이력 합계 {saved.data.pagination.total}건</span><button type="button" className="button" disabled={page * saved.data.pagination.pageSize >= saved.data.pagination.total || saved.isFetching} onClick={() => setPage(page + 1)}>다음</button></div>
    </> : null}
  </>;
}
