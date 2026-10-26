"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch, apiPost, apiErrorMessage } from "@/lib/api";
import { useCan } from "@/features/auth/use-auth";
import { storefrontTime, storefrontToday } from "@/lib/storefront-display";
import { editGoogleMapping, googleMappingInputError, googleSaleAmountFields, googleSaleConfigurationText } from "@/lib/google-mapping-form";
import type { GoogleMapping, GoogleMappingDraft, GoogleMappingPreview, GoogleMappings, GoogleOptions } from "@/types/google";

const blank = (): GoogleMappingDraft => ({ kind: "CAMPAIGN", connectionId: "", campaignId: "", productId: null, startDate: storefrontToday("Asia/Seoul")!, endDate: null });

export function GoogleMappingEditor({ options, query }: { options: GoogleOptions; query: string }) {
  const canManage = useCan("mappings.manage");
  const cache = useQueryClient();
  const [draft, setDraft] = useState<GoogleMappingDraft>(blank);
  const [preview, setPreview] = useState<GoogleMappingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState("");
  const saved = useQuery({ queryKey: ["google", "mappings", query, page], queryFn: () => apiGet<GoogleMappings>(`/google/mappings?${query}&page=${page}&pageSize=50`), retry: false });
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
        setDraft(blank()); setPreview(null); setMessage("Google 연결을 저장했습니다.");
      }
    } catch (error) { setMessage(apiErrorMessage(error, "연결을 처리하지 못했습니다. 현재 자료를 새로고침하고 다시 확인하세요.")); }
    finally { setBusy(false); }
  };
  return <>
    <div className="panel">
      <h2>Google 전용 연결</h2>
      <p>캠페인 ID와 계정, 판매 상품번호와 옵션을 정확히 지정합니다. 여러 상품 캠페인은 미배분으로 저장하세요. 적용일 이전 판매·광고 원본은 바뀌지 않습니다.</p>
      {!canManage ? <p>연결 변경에는 mappings.manage 권한이 필요합니다. 저장된 연결을 조회할 수 있습니다.</p> : <form onSubmit={(event) => { event.preventDefault(); void run(false); }}>
        <div className="toolbar">
          <label className="field">연결 종류<select className="select" disabled={Boolean(draft.id) || busy} value={draft.kind} onChange={(event) => { setDraft({ ...blank(), kind: event.target.value as GoogleMappingDraft["kind"] }); setPreview(null); }}><option value="CAMPAIGN">Google 캠페인</option><option value="SALE">유튜브 판매</option></select></label>
          <label className="field">연결 계정<select className="select" required disabled={Boolean(draft.id) || busy} value={draft.connectionId} onChange={(event) => update({ connectionId: event.target.value })}><option value="">계정 선택</option>{options.connections.filter((item) => item.provider === (draft.kind === "CAMPAIGN" ? "GOOGLE" : "CAFE24")).map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.externalAccountId}</option>)}</select></label>
          {draft.kind === "CAMPAIGN" ? <label className="field">캠페인 ID<input className="input" required disabled={Boolean(draft.id) || busy} value={draft.campaignId ?? ""} onChange={(event) => update({ campaignId: event.target.value })} /></label> : <>
            <label className="field">카페24 상품번호<input className="input" required disabled={Boolean(draft.id) || busy} value={draft.productNo ?? ""} onChange={(event) => update({ productNo: event.target.value })} /></label>
            <label className="field">옵션 적용 범위<select className="select" disabled={Boolean(draft.id) || busy} value={draft.optionScope ?? "EXACT"} onChange={(event) => update({ optionScope: event.target.value as "EXACT" | "PRODUCT", optionName: "" })}><option value="EXACT">특정 옵션 (완전 일치)</option><option value="PRODUCT">상품번호 전체</option></select></label>
            {draft.optionScope !== "PRODUCT" ? <label className="field">옵션 식별자 (완전 일치)<input className="input" disabled={Boolean(draft.id) || busy} value={draft.optionName ?? ""} onChange={(event) => update({ optionName: event.target.value })} /></label> : null}
          </>}
          <label className="field">연결 상품<select className="select" disabled={busy} value={draft.productId ?? ""} onChange={(event) => update({ productId: event.target.value || null })}><option value="">미배분 / 미연결</option>{options.products.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
          <label className="field">적용 시작일<input className="input" required type="date" disabled={busy} value={draft.startDate} onChange={(event) => update({ startDate: event.target.value })} /></label>
          <label className="field">적용 종료일 (포함)<input className="input" type="date" min={draft.startDate} disabled={busy} value={draft.endDate ?? ""} onChange={(event) => update({ endDate: event.target.value || null })} /></label>
        </div>
        {draft.kind === "SALE" ? <GoogleSaleConfigurationFields draft={draft} update={update} busy={busy} /> : null}
        <div className="toolbar">
          <button className="button" disabled={busy} type="submit">변경 영향 미리보기</button>
          <button className="button" disabled={busy} type="button" onClick={() => { setDraft(blank()); setPreview(null); }}>새 연결 / 취소</button>
        </div>
        {preview ? <div className="warning-strip" role="status">
          <p>기존 상품: {preview.before ? productName(preview.before.productId) : "Google 전용 연결 없음"} → 변경 상품: {productName(preview.after.productId)}</p>
          {!preview.before && draft.kind === "SALE" ? <p>전용 연결이 없던 판매는 기존 카페24 상품 연결을 재사용했을 수 있습니다. 새 Google 연결은 그 상품 선택보다 우선 적용됩니다.</p> : null}
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
    {saved.data ? <>{(["CAMPAIGN", "SALE"] as const).map((kind) => <div className="panel" key={kind}>
      <h2>{kind === "CAMPAIGN" ? "캠페인 연결" : "유튜브 판매 연결"}</h2>
      <div className="table-wrap"><table><thead><tr><th>계정</th><th>{kind === "CAMPAIGN" ? "캠페인 ID" : "상품번호 / 옵션 범위"}</th><th>상품</th>{kind === "SALE" ? <th>Google 판매 구성 (수량 1 기준)</th> : null}<th>적용 기간</th><th>변경 시각 (한국)</th>{canManage ? <th>변경</th> : null}</tr></thead><tbody>
        {(kind === "CAMPAIGN" ? saved.data.campaignMappings : saved.data.salesMappings).map((item) => <tr key={item.id}><td>{connectionName(item.connectionId)}</td><td>{kind === "CAMPAIGN" ? item.campaignId : `${item.productNo} / ${item.optionScope === "PRODUCT" ? "상품번호 전체" : `특정 옵션 · ${item.optionName || "옵션 없음"}`}`}</td><td>{productName(item.productId)}</td>{kind === "SALE" ? <td>{googleSaleConfigurationText(item)}</td> : null}<td>{item.startDate.slice(0, 10)} ~ {item.endDate?.slice(0, 10) ?? "계속"}</td><td>{storefrontTime(item.updatedAt)}</td>{canManage ? <td><button type="button" className="button" disabled={busy} onClick={() => edit(item)}>수정 / 연결 해제</button></td> : null}</tr>)}
      </tbody></table></div>
    </div>)}
      <div className="toolbar"><button className="button" disabled={page <= 1 || saved.isFetching} onClick={() => setPage(page - 1)}>이전</button><span>{page} / {Math.max(1, Math.ceil(saved.data.pagination.total / saved.data.pagination.pageSize))} 페이지 · 두 종류 합계 {saved.data.pagination.total}건</span><button className="button" disabled={page * saved.data.pagination.pageSize >= saved.data.pagination.total || saved.isFetching} onClick={() => setPage(page + 1)}>다음</button></div>
      <details className="panel"><summary>현재 페이지 연결의 최근 변경 이력 (최대 100건)</summary>{saved.data.audit.map((item) => <div key={item.id}><p>{storefrontTime(item.createdAt)} · 변경자 {item.actorUserId} · {item.before ? "수정" : "생성"}</p><details><summary>이전 / 변경 값</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({ before: item.before, after: item.after }, null, 2)}</pre></details></div>)}</details>
    </> : null}
  </>;
}

export function GoogleSaleConfigurationFields({ draft, update, busy }: { draft: GoogleMappingDraft; update: (value: Partial<GoogleMappingDraft>) => void; busy: boolean }) {
  const requiresAmounts = googleSaleAmountFields.some(({ key }) => draft[key] != null) || Boolean(draft.saleUnitLabel?.trim());
  return <fieldset disabled={busy} style={{ margin: "16px 0", border: "1px solid var(--line)", borderRadius: 6, padding: 12 }}>
    <legend>Google 전용 판매 구성 (선택)</legend>
    <p>판매수량 1에 해당하는 완성 구성의 금액을 입력합니다. 기본 판매가 1+1 세트라면 세트 전체 금액을 입력하며, 세트라는 이유로 금액이나 수량을 다시 2배 하지 않습니다.</p>
    <p>4개 금액을 모두 비우면 기존 비용 규칙을 사용합니다. 지정할 때는 4개를 모두 입력하고 비용이 없으면 0을 입력하세요. 판매단위 이름도 4개 금액과 함께 지정합니다. 기존 공용 상품 설정은 변경하지 않습니다.</p>
    <div className="toolbar">
      <label className="field">판매단위 이름<input className="input" maxLength={64} placeholder="예: 1+1 세트" value={draft.saleUnitLabel ?? ""} onChange={(event) => update({ saleUnitLabel: event.target.value || null })} /></label>
      {googleSaleAmountFields.map(({ key, label }) => <label className="field" key={key}>{label}<input className="input" type="number" min="0" max="999999999999.99" step="0.01" required={requiresAmounts} value={draft[key] ?? ""} onChange={(event) => update({ [key]: event.target.value === "" ? null : event.target.valueAsNumber })} /></label>)}
      <button type="button" className="button" onClick={() => update({ saleUnitLabel: null, salePriceKrwOverride: null, productCostKrwOverride: null, shippingKrwOverride: null, extraCostKrwOverride: null })}>전용 구성 비우기</button>
    </div>
  </fieldset>;
}
