"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch, apiPost, apiErrorMessage } from "@/lib/api";
import { useCan } from "@/features/auth/use-auth";
import { storefrontTime } from "@/lib/storefront-display";
import { googleMoney, googleReasons } from "@/lib/google-display";
import { blankGoogleMapping, editGoogleMapping, googleMappingInputError, googleSaleAmountFields, googleSaleConfigurationText } from "@/lib/google-mapping-form";
import type { GoogleMapping, GoogleMappingDraft, GoogleMappingPreview, GoogleMappings, GoogleOptions, GoogleReportResponse } from "@/types/google";

export function GoogleMappingEditor({ options, query }: { options: GoogleOptions; query: string }) {
  const canRead = useCan("data.read");
  const canManage = useCan("mappings.manage");
  const cache = useQueryClient();
  const [draft, setDraft] = useState<GoogleMappingDraft>(() => blankGoogleMapping("SALE"));
  const [preview, setPreview] = useState<GoogleMappingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [campaignPage, setCampaignPage] = useState(1);
  const [message, setMessage] = useState("");
  const saved = useQuery({ queryKey: ["google", "mappings", query, page], queryFn: () => apiGet<GoogleMappings>(`/google/mappings?${query}&page=${page}&pageSize=50`), enabled: canRead && options.enabled, retry: false });
  const automatic = saved.data?.campaignMappingMode === "CAMPAIGN_NAME";
  const campaigns = useQuery({ queryKey: ["google", "campaigns", query, campaignPage], queryFn: () => apiGet<GoogleReportResponse>(`/google/campaigns?${query}&page=${campaignPage}&pageSize=50`), enabled: canRead && options.enabled && automatic, retry: false, refetchOnWindowFocus: false });
  const productName = (id: string | null | undefined) => options.products.find((item) => item.id === id)?.displayName ?? (id || "미배분 / 미연결");
  const connectionName = (id: string) => options.connections.find((item) => item.id === id)?.displayName ?? id;
  const update = (change: Partial<GoogleMappingDraft>) => { setDraft((value) => ({ ...value, ...change })); setPreview(null); setMessage(""); };
  const edit = (mapping: GoogleMapping) => {
    setDraft(editGoogleMapping(mapping));
    setPreview(null); setMessage("");
  };
  const run = async (save: boolean) => {
    if (!canManage || busy) return;
    const inputError = googleMappingInputError(draft);
    if (inputError) { setMessage(inputError); setPreview(null); return; }
    setBusy(true); setMessage("");
    try {
      if (!save) setPreview(await apiPost<GoogleMappingPreview>("/google/mappings/preview", draft));
      else {
        if (!preview?.canSave || preview.overlaps.length) return;
        if (draft.id) await apiPatch(`/google/mappings/${draft.id}`, draft);
        else await apiPost("/google/mappings", draft);
        await cache.invalidateQueries({ queryKey: ["google"] });
        setDraft(blankGoogleMapping("SALE")); setPreview(null); setMessage("Google 연결을 저장했습니다.");
      }
    } catch (error) { setMessage(apiErrorMessage(error, "연결을 처리하지 못했습니다. 현재 자료를 새로고침하고 다시 확인하세요.")); }
    finally { setBusy(false); }
  };
  if (!canRead) return <p className="panel" role="alert">데이터 조회 권한이 없습니다.</p>;
  if (!options.enabled) return <p className="panel" role="status">Google 성과 기능이 비활성화되어 있습니다.</p>;
  return <>
    <section className="panel">
      <h2>캠페인명 자동 연결</h2>
      <p>캠페인명에 상품명이 하나만 일치하면 자동 연결합니다. 같은 상품의 여러 캠페인은 함께 합산합니다.</p>
      {!automatic && !saved.isLoading && !saved.isError ? <p role="status">캠페인명 자동 연결 기능의 서버 반영을 확인하고 있습니다.</p> : null}
      {campaigns.isLoading ? <p role="status">캠페인명 연결 결과를 읽고 있습니다.</p> : null}
      {campaigns.isError ? <p className="warning-strip" role="alert">{apiErrorMessage(campaigns.error, "캠페인 연결 결과를 읽지 못했습니다.")}</p> : null}
      {campaigns.data ? <>
        <p className="field-help">{campaigns.data.range.from} ~ {campaigns.data.range.to} 수집 기준</p>
        {campaigns.data.completeness.warningCodes.length ? <p className="warning-strip">확인이 필요한 데이터가 있습니다. <Link href={`/google/diagnostics${query ? `?${query}` : ""}`}>데이터 점검에서 확인</Link></p> : null}
        <div className="table-wrap"><table aria-label="캠페인명 자동 연결 결과"><thead><tr><th>광고 계정</th><th>캠페인명</th><th>자동 연결 상품</th><th>광고비</th><th>연결 상태</th></tr></thead><tbody>{campaigns.data.campaigns.map(item => <tr key={`${item.connectionId}:${item.campaignId}:${item.currencyCode}`}><td>{connectionName(item.connectionId)}</td><td>{item.campaignName}</td><td>{item.productIds.map(productName).join(" / ") || "미배분"}</td><td>{googleMoney(item.adSpendKrwExact)}</td><td>{item.hasUnmapped ? "미배분 포함" : "상품명 자동 연결"}{item.warningCodes.length ? ` · ${googleReasons(item.warningCodes)}` : ""}{item.productIds.length > 1 ? " · 조회 기간 중 이름별 연결 상품 변경" : ""}</td></tr>)}{!campaigns.data.campaigns.length ? <tr><td colSpan={5}>선택한 기간의 수집된 캠페인이 없습니다. 수집 상태를 확인하세요.</td></tr> : null}</tbody></table></div>
        <div className="toolbar"><button type="button" className="button" disabled={campaignPage <= 1 || campaigns.isFetching} onClick={() => setCampaignPage(campaignPage - 1)}>이전 캠페인</button><span>{campaignPage} / {Math.max(1, Math.ceil(campaigns.data.pagination.total / campaigns.data.pagination.pageSize))} 페이지 · {campaigns.data.pagination.total}개 캠페인</span><button type="button" className="button" disabled={campaignPage * campaigns.data.pagination.pageSize >= campaigns.data.pagination.total || campaigns.isFetching} onClick={() => setCampaignPage(campaignPage + 1)}>다음 캠페인</button></div>
      </> : null}
    </section>
    <div className="panel">
      <h2>유튜브 판매 연결</h2>
      <p>카페24 상품번호·옵션을 상품에 연결하고 판매 구성을 지정합니다.</p>
      {!canManage ? <p>연결을 수정할 권한이 없습니다. 저장된 연결은 조회할 수 있습니다.</p> : <form onSubmit={(event) => { event.preventDefault(); void run(false); }}>
        <div className="toolbar">

          <label className="field">연결 계정<select className="select" required disabled={Boolean(draft.id) || busy} value={draft.connectionId} onChange={(event) => update({ connectionId: event.target.value })}><option value="">계정 선택</option>{options.connections.filter((item) => item.provider === "CAFE24").map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.externalAccountId}</option>)}</select></label>
          <>
            <label className="field">카페24 상품번호<input className="input" required disabled={Boolean(draft.id) || busy} value={draft.productNo ?? ""} onChange={(event) => update({ productNo: event.target.value })} /></label>
            <label className="field">옵션 적용 범위<select className="select" disabled={Boolean(draft.id) || busy} value={draft.optionScope ?? "EXACT"} onChange={(event) => update({ optionScope: event.target.value as "EXACT" | "PRODUCT", optionName: "" })}><option value="EXACT">특정 옵션 (완전 일치)</option><option value="PRODUCT">상품번호 전체</option></select></label>
            {draft.optionScope !== "PRODUCT" ? <label className="field">옵션 식별자 (완전 일치)<input className="input" disabled={Boolean(draft.id) || busy} value={draft.optionName ?? ""} onChange={(event) => update({ optionName: event.target.value })} /></label> : null}
          </>
          <label className="field">연결 상품<select className="select" disabled={busy} value={draft.productId ?? ""} onChange={(event) => update({ productId: event.target.value || null })}><option value="">미배분 / 미연결</option>{options.products.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
          <label className="field">적용 시작일<input className="input" required type="date" disabled={busy} value={draft.startDate} onChange={(event) => update({ startDate: event.target.value })} /></label>
          <label className="field">적용 종료일 (포함)<input className="input" type="date" min={draft.startDate} disabled={busy} value={draft.endDate ?? ""} onChange={(event) => update({ endDate: event.target.value || null })} /></label>
        </div>
        {draft.kind === "SALE" ? <GoogleSaleConfigurationFields draft={draft} update={update} busy={busy} /> : null}
        <div className="toolbar">
          <button className="button" disabled={busy} type="submit">변경 영향 미리보기</button>
          <button className="button" disabled={busy} type="button" onClick={() => { setDraft(blankGoogleMapping("SALE")); setPreview(null); }}>새 연결 / 취소</button>
        </div>
        {preview ? <div className="warning-strip" role="status">
          <p>기존 상품: {preview.before ? productName(preview.before.productId) : "Google 전용 연결 없음"} → 변경 상품: {productName(preview.after.productId)}</p>
          {!preview.before && draft.kind === "SALE" ? <p>저장하면 이 기간의 Google 판매에 새 연결이 우선 적용됩니다.</p> : null}
          {draft.kind === "SALE" ? <>
            <p>옵션 범위: {preview.after.optionScope === "PRODUCT" ? "상품번호 전체" : `특정 옵션 · ${preview.after.optionName || "옵션 없음"}`}</p>
            <p>기존 판매 구성: {preview.before ? googleSaleConfigurationText(preview.before) : "Google 전용 구성 없음"}</p>
            <p>변경 판매 구성: {googleSaleConfigurationText(preview.after)}</p>
          </> : null}
          <p>영향 기간: {preview.affectedRange.from?.slice(0, 10)} ~ {preview.affectedRange.to?.slice(0, 10) ?? "종료일 없음"}. 과거 기간을 포함하면 해당 Google 결과가 재계산됩니다.</p>
          {preview.overlaps.length ? <p>적용 기간이 겹치는 연결 {preview.overlaps.length}건이 있습니다. 기간을 수정하세요.</p> : <button type="button" className="button primary" disabled={busy || !preview.canSave} onClick={() => void run(true)}>이 변경 저장</button>}
        </div> : null}
      </form>}
      {message ? <p role="status">{message}</p> : null}
    </div>
    {saved.isError ? <p className="warning-strip" role="alert">{apiErrorMessage(saved.error, "저장된 연결을 읽지 못했습니다.")}</p> : null}
    {saved.isLoading ? <p role="status">연결을 읽고 있습니다.</p> : null}
    {saved.data ? <>
      <section className="panel">
        <h2>저장된 유튜브 판매 연결</h2>
        <div className="table-wrap"><table aria-label="저장된 유튜브 판매 연결"><thead><tr><th>계정</th><th>상품번호 / 옵션 범위</th><th>상품</th><th>판매 구성 (수량 1 기준)</th><th>적용 기간</th><th>변경 시각 (한국)</th>{canManage ? <th>변경</th> : null}</tr></thead><tbody>
          {saved.data.salesMappings.map((item) => <tr key={item.id}><td>{connectionName(item.connectionId)}</td><td>{item.productNo} / {item.optionScope === "PRODUCT" ? "상품번호 전체" : `특정 옵션 · ${item.optionName || "옵션 없음"}`}</td><td>{productName(item.productId)}</td><td>{googleSaleConfigurationText(item)}</td><td>{item.startDate.slice(0, 10)} ~ {item.endDate?.slice(0, 10) ?? "계속"}</td><td>{storefrontTime(item.updatedAt)}</td>{canManage ? <td><button type="button" className="button" disabled={busy} onClick={() => edit(item)}>수정 / 연결 해제</button></td> : null}</tr>)}
          {!saved.data.salesMappings.length ? <tr><td colSpan={canManage ? 7 : 6}>이 페이지에 판매 연결이 없습니다.</td></tr> : null}
        </tbody></table></div>
        <div className="toolbar"><button type="button" className="button" disabled={page <= 1 || saved.isFetching} onClick={() => setPage(page - 1)}>이전</button><span>전체 연결 목록 {page} / {Math.max(1, Math.ceil(saved.data.pagination.total / saved.data.pagination.pageSize))} 페이지 · 이 페이지 판매 연결 {saved.data.salesMappings.length}건</span><button type="button" className="button" disabled={page * saved.data.pagination.pageSize >= saved.data.pagination.total || saved.isFetching} onClick={() => setPage(page + 1)}>다음</button></div>
      </section>
    </> : null}
  </>;
}

export function GoogleSaleConfigurationFields({ draft, update, busy }: { draft: GoogleMappingDraft; update: (value: Partial<GoogleMappingDraft>) => void; busy: boolean }) {
  const requiresAmounts = googleSaleAmountFields.some(({ key }) => draft[key] != null) || Boolean(draft.saleUnitLabel?.trim());
  return <fieldset disabled={busy} style={{ margin: "16px 0", border: "1px solid var(--line)", borderRadius: 6, padding: 12 }}>
    <legend>Google 전용 판매 구성 (선택)</legend>
    <p>판매수량 1은 한 구성입니다. 1+1은 한 세트 전체 금액을 입력하며 다시 2배 하지 않습니다.</p>
    <p>입력할 때는 4개 금액을 모두 채우고, 없는 비용은 0으로 입력하세요. 모두 비우면 기존 비용 규칙을 사용합니다. 판매단위 이름도 4개 금액과 함께 지정합니다. 기존 공용 상품 설정은 변경하지 않습니다.</p>
    <div className="toolbar">
      <label className="field">판매단위 이름<input className="input" maxLength={64} placeholder="예: 1+1 세트" value={draft.saleUnitLabel ?? ""} onChange={(event) => update({ saleUnitLabel: event.target.value || null })} /></label>
      {googleSaleAmountFields.map(({ key, label }) => <label className="field" key={key}>{label}<input className="input" type="number" min="0" max="999999999999.99" step="0.01" required={requiresAmounts} value={draft[key] ?? ""} onChange={(event) => update({ [key]: event.target.value === "" ? null : event.target.valueAsNumber })} /></label>)}
      <button type="button" className="button" onClick={() => update({ saleUnitLabel: null, salePriceKrwOverride: null, productCostKrwOverride: null, shippingKrwOverride: null, extraCostKrwOverride: null })}>전용 구성 비우기</button>
    </div>
  </fieldset>;
}
