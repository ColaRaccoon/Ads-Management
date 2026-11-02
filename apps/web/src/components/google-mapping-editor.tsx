"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPatch, apiErrorMessage } from "@/lib/api";
import { useCan } from "@/features/auth/use-auth";
import { googleMoney, googleReasons } from "@/lib/google-display";
import type { GoogleMappings, GoogleOptions, GoogleReportResponse, GoogleCampaignKeyword, GoogleCampaignKeywordDraft } from "@/types/google";

export function GoogleMappingEditor({ options, query }: { options: GoogleOptions; query: string }) {
  const canRead = useCan("data.read");
  const [campaignPage, setCampaignPage] = useState(1);
  const saved = useQuery({ queryKey: ["google", "mappings", query, 1], queryFn: () => apiGet<GoogleMappings>(`/google/mappings?${query}&page=1&pageSize=50`), enabled: canRead && options.enabled, retry: false });
  const automatic = saved.data?.campaignMappingMode === "CAMPAIGN_NAME";
  const campaigns = useQuery({ queryKey: ["google", "campaigns", query, campaignPage], queryFn: () => apiGet<GoogleReportResponse>(`/google/campaigns?${query}&page=${campaignPage}&pageSize=50`), enabled: canRead && options.enabled && automatic, retry: false, refetchOnWindowFocus: false });
  const productName = (id: string | null | undefined) => options.products.find((item) => item.id === id)?.displayName ?? (id || "미배분 / 미연결");
  const connectionName = (id: string) => options.connections.find((item) => item.id === id)?.displayName ?? id;
  if (!canRead) return <p className="panel" role="alert">데이터 조회 권한이 없습니다.</p>;
  if (!options.enabled) return <p className="panel" role="status">Google 성과 기능이 비활성화되어 있습니다.</p>;
  return <>
    <section className="panel">
      <h2>캠페인명 자동 연결</h2>
      <p>캠페인명에 포함된 제품명과 등록한 키워드로 자동 연결합니다. 같은 제품의 여러 캠페인은 함께 합산하며, 서로 다른 상품이 동시에 일치하면 미배분으로 표시합니다.</p>
      <p className="field-help">예: 버닝 웨이브바 - 2026-10-19와 버닝 웨이브바 - 2026-10-28은 모두 버닝웨이브바로 연결합니다. 원본 캠페인명은 확인용이며 날짜를 연결 기준으로 저장하지 않습니다.</p>
      {!automatic && !saved.isLoading && !saved.isError ? <p role="status">캠페인명 자동 연결 기능의 서버 반영을 확인하고 있습니다.</p> : null}
      {campaigns.isLoading ? <p role="status">캠페인명 연결 결과를 읽고 있습니다.</p> : null}
      {campaigns.isError ? <p className="warning-strip" role="alert">{apiErrorMessage(campaigns.error, "캠페인 연결 결과를 읽지 못했습니다.")}</p> : null}
      {campaigns.data ? <>
        <p className="field-help">{campaigns.data.range.from} ~ {campaigns.data.range.to} 수집 기준</p>
        {campaigns.data.completeness.warningCodes.length ? <p className="warning-strip">확인이 필요한 데이터가 있습니다. <Link href={`/google/diagnostics${query ? `?${query}` : ""}`}>데이터 점검에서 확인</Link></p> : null}
        <div className="table-wrap"><table aria-label="캠페인명 자동 연결 결과"><thead><tr><th>광고 계정</th><th>원본 캠페인명</th><th>매칭 제품명</th><th>광고비</th><th>연결 상태</th></tr></thead><tbody>{campaigns.data.campaigns.map(item => <tr key={`${item.connectionId}:${item.campaignId}:${item.currencyCode}`}><td>{connectionName(item.connectionId)}</td><td>{item.campaignName}</td><td>{item.productIds.map(productName).join(" / ") || "미배분"}</td><td>{googleMoney(item.adSpendKrwExact)}</td><td>{item.hasUnmapped ? "미배분 포함" : "상품명 자동 연결"}{item.warningCodes.length ? ` · ${googleReasons(item.warningCodes)}` : ""}{item.productIds.length > 1 ? " · 조회 기간 중 이름별 연결 상품 변경" : ""}</td></tr>)}{!campaigns.data.campaigns.length ? <tr><td colSpan={5}>선택한 기간의 수집된 캠페인이 없습니다. 수집 상태를 확인하세요.</td></tr> : null}</tbody></table></div>
        <div className="toolbar"><button type="button" className="button" disabled={campaignPage <= 1 || campaigns.isFetching} onClick={() => setCampaignPage(campaignPage - 1)}>이전 캠페인</button><span>{campaignPage} / {Math.max(1, Math.ceil(campaigns.data.pagination.total / campaigns.data.pagination.pageSize))} 페이지 · {campaigns.data.pagination.total}개 캠페인</span><button type="button" className="button" disabled={campaignPage * campaigns.data.pagination.pageSize >= campaigns.data.pagination.total || campaigns.isFetching} onClick={() => setCampaignPage(campaignPage + 1)}>다음 캠페인</button></div>
      </> : null}
    </section>
    <GoogleCampaignKeywordSettings options={options} query={query} />
    <section className="panel">
      <h2>유튜브 판매 공통 설정</h2>
      <p>메타와 동일한 카페24 상품·옵션 매핑 및 판매가·원가 설정을 사용합니다.</p>
      <p>상품명에 [유튜브]가 있는 판매만 Google에 포함합니다. 상품번호가 달라도 공통 상품명·옵션 조건과 적용기간이 일치하면 연결합니다.</p>
      <p>단품·1+1 구성별 판매가·원가와 수량 계산도 공통 설정을 따릅니다. 기존 Google 전용 판매 설정은 계산에 사용하지 않습니다.</p>
      <Link className="button" href="/mappings">공통 상품·옵션 설정</Link>
    </section>
  </>;
}

export function GoogleCampaignKeywordSettings({ options, query }: { options: GoogleOptions; query: string }) {
  const canManage = useCan("mappings.manage");
  const cache = useQueryClient();
  const initial = (): GoogleCampaignKeywordDraft => ({
    connectionId: new URLSearchParams(query).get("connectionId") ?? options.connections.find(item => item.provider === "GOOGLE")?.id ?? "",
    keyword: "", productId: "", startDate: new URLSearchParams(query).get("from") ?? new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), endDate: null
  });
  const [draft, setDraft] = useState(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const saved = useQuery({ queryKey: ["google", "campaign-keywords", query],
    queryFn: () => apiGet<{ keywords: GoogleCampaignKeyword[] }>(`/google/campaign-keywords?${query}`), retry: false, refetchOnWindowFocus: false });
  const reset = () => { setDraft(initial()); setEditingId(null); };
  const save = async () => {
    if (!canManage || busy) return;
    if (!draft.keyword.trim() || !draft.connectionId || !draft.productId || !draft.startDate || (draft.endDate && draft.endDate < draft.startDate)) {
      setMessage("계정·키워드·상품과 올바른 적용기간을 입력해 주세요."); return;
    }
    setBusy(true); setMessage("");
    try {
      if (editingId) await apiPatch(`/google/campaign-keywords/${editingId}`, draft);
      else await apiPost("/google/campaign-keywords", draft);
      await cache.invalidateQueries({ queryKey: ["google"] });
      reset(); setMessage("키워드를 저장했습니다. 적용기간의 기존 광고비도 다시 계산됩니다.");
    } catch (error) { setMessage(apiErrorMessage(error, "키워드를 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  };
  return <section className="panel" aria-label="구글 캠페인 키워드 설정">
    <h2>캠페인 키워드 연결</h2>
    <p>캠페인명에 키워드가 포함되면 선택한 상품에 광고비를 연결합니다. 적용 시작일을 과거 날짜로 지정하면 해당 날짜부터 다시 계산합니다.</p>
    {canManage ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0 }}><div className="toolbar">
        <label className="field">광고 계정<select className="select" required disabled={Boolean(editingId)} value={draft.connectionId} onChange={event => setDraft({ ...draft, connectionId: event.target.value })}>
          <option value="">계정 선택</option>{options.connections.filter(item => item.provider === "GOOGLE").map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
        <label className="field">캠페인 키워드<input className="input" required maxLength={256} placeholder="예: 퍼슬" value={draft.keyword} onChange={event => setDraft({ ...draft, keyword: event.target.value })} /></label>
        <label className="field">연결 상품<select className="select" required value={draft.productId} onChange={event => setDraft({ ...draft, productId: event.target.value })}>
          <option value="">상품 선택</option>{options.products.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
        <label className="field">적용 시작일<input className="input" type="date" required value={draft.startDate} onChange={event => setDraft({ ...draft, startDate: event.target.value })} /></label>
        <label className="field">적용 종료일<input className="input" type="date" min={draft.startDate} value={draft.endDate ?? ""} onChange={event => setDraft({ ...draft, endDate: event.target.value || null })} /></label>
        <button className="button primary" type="submit">{busy ? "저장 중…" : editingId ? "키워드 수정 저장" : "키워드 추가"}</button>
        {editingId ? <button className="button" type="button" onClick={reset}>수정 취소</button> : null}
      </div></fieldset>
    </form> : <p>키워드는 조회할 수 있으며, 수정에는 매핑 관리 권한이 필요합니다.</p>}
    {message ? <p role="status">{message}</p> : null}
    {saved.isLoading ? <p role="status">키워드를 읽고 있습니다.</p> : null}
    {saved.isError ? <p role="alert">{apiErrorMessage(saved.error, "키워드를 읽지 못했습니다.")}</p> : null}
    <div className="table-wrap"><table aria-label="등록된 캠페인 키워드"><thead><tr><th>광고 계정</th><th>키워드</th><th>연결 상품</th><th>적용기간</th>{canManage ? <th>관리</th> : null}</tr></thead><tbody>
      {saved.data?.keywords.map(item => <tr key={item.id}>
        <td>{options.connections.find(connection => connection.id === item.connectionId)?.displayName ?? item.connectionId}</td><td>{item.keyword}</td><td>{item.productName ?? item.productId}</td><td>{item.startDate} ~ {item.endDate ?? "계속"}</td>
        {canManage ? <td><button className="button" type="button" disabled={busy} aria-label={`키워드 수정: ${item.keyword}`} onClick={() => {
          setEditingId(item.id); setDraft({ connectionId: item.connectionId, keyword: item.keyword, productId: item.productId, startDate: item.startDate, endDate: item.endDate, expectedUpdatedAt: item.updatedAt }); setMessage("");
        }}>수정</button></td> : null}
      </tr>)}
      {saved.data && !saved.data.keywords.length ? <tr><td colSpan={canManage ? 5 : 4}>등록된 캠페인 키워드가 없습니다.</td></tr> : null}
    </tbody></table></div>
  </section>;
}
