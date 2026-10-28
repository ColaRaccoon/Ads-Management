"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PermissionPage } from "@/components/permission-page";
import { useAuth } from "@/features/auth/use-auth";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { koreaTodayDateInput, koreaYesterdayDateInput } from "@/lib/korea-date";
import { NameRuleFields } from "./name-rule-fields";
import { NamePreview } from "./name-preview";
import { SaleUnitFields } from "./sale-unit-fields";
import { AllocationFields } from "./allocation-fields";
import { LegacyNameRules } from "./legacy-name-rules";
import { configurationError, editRule, newRule, previewKey } from "./model";
import { Audit, Configuration, Job, KIND_LABELS, NameSample, PLATFORMS, Platform, Preview, Product, Rule, RuleDraft, RuleKind } from "./types";

const money = (value: string | null | undefined) => value == null ? "미확인" : `${value} 원`;
type Saved = { ruleId: string; from: string | null; to: string | null; platforms: Platform[]; scopeKeys?: string[]; key: string };
type Pending = { saved: Saved; jobs: Job[]; batch?: { from: string; to: string; key: string } };
function validSaved(value: unknown): value is Saved {
  if (!value || typeof value !== "object") return false;
  const s = value as Saved;
  return typeof s.ruleId === "string" && typeof s.key === "string" && Array.isArray(s.platforms) && s.platforms.every(p => PLATFORMS.includes(p)) &&
    (s.from === null || typeof s.from === "string") && (s.to === null || typeof s.to === "string") &&
    (s.scopeKeys === undefined || Array.isArray(s.scopeKeys) && s.scopeKeys.every(key => typeof key === "string"));
}
function validJobs(value: unknown): value is Job[] {
  return Array.isArray(value) && value.every(j => j && typeof j.jobId === "string" && typeof j.status === "string" &&
    (j.issues === undefined || Array.isArray(j.issues) && j.issues.every((i: unknown) => typeof i === "string")));
}

export function ProductMappingsPage() {
  const { user } = useAuth();
  return <PermissionPage permission="data.read"><Mappings key={user?.id} /></PermissionPage>;
}

function Mappings() {
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const configuration = useQuery({ queryKey: ["unified-configuration", user?.id], queryFn: () => apiGet<Configuration>("/unified-products/configuration"), retry: false });
  const [draft, setDraft] = useState<RuleDraft>(() => newRule("NAME", koreaTodayDateInput()));
  const [editingId, setEditingId] = useState<string>();
  const [filter, setFilter] = useState<RuleKind>("NAME");
  const [samples, setSamples] = useState<NameSample[]>([]);
  const [from, setFrom] = useState(koreaYesterdayDateInput);
  const [to, setTo] = useState(koreaYesterdayDateInput);
  const [platforms, setPlatforms] = useState<Platform[]>([...PLATFORMS]);
  const [preview, setPreview] = useState<{ key: string; result: Preview }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [saved, setSaved] = useState<Saved>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [rebuildBatch, setRebuildBatch] = useState<{ from: string; to: string; key: string }>();
  const [restored, setRestored] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  useEffect(() => {
    if (!user?.id) return;
    try {
      const raw = sessionStorage.getItem(`product-mapping-rebuild:${user.id}`);
      if (raw) {
        const value = JSON.parse(raw);
        if (validSaved(value.saved) && validJobs(value.jobs ?? [])) {
          setSaved(value.saved); setJobs(value.jobs ?? []);
          if (value.batch && [value.batch.from, value.batch.to, value.batch.key].every(v => typeof v === "string")) setRebuildBatch(value.batch);
          if (Array.isArray(value.pending)) setPending(value.pending.filter((p: Pending) => p && validSaved(p.saved) && validJobs(p.jobs)));
        }
      }
    } catch { /* A damaged browser record never triggers a write or rebuild. */ }
    setRestored(true);
  }, [user?.id]);
  useEffect(() => {
    if (!restored || !user?.id) return;
    try { sessionStorage.setItem(`product-mapping-rebuild:${user.id}`, JSON.stringify({ saved, jobs, batch: rebuildBatch, pending })); } catch { /* Storage unavailable; live state remains usable. */ }
  }, [saved, jobs, rebuildBatch, pending, restored, user?.id]);
  const rememberSaved = (next: Saved) => {
    if (saved) setPending(previous => [...previous, { saved, jobs, batch: rebuildBatch }]);
    setSaved(next); setJobs([]); setRebuildBatch(undefined);
  };
  const [auditId, setAuditId] = useState<string>();
  const audit = useQuery({ queryKey: ["unified-audit", user?.id, auditId], enabled: Boolean(auditId), queryFn: () => apiGet<Audit[]>(`/unified-rules/${auditId}/audit`), retry: false });
  const [product, setProduct] = useState<{ id?: string; canonicalName: string; active: boolean; expectedVersion?: number; reason: string }>({ canonicalName: "", active: true, reason: "" });
  const [productPreview, setProductPreview] = useState<{ key: string; canSave: boolean }>();
  const input = { ...draft, ...(editingId ? { id: editingId } : {}), samples, impactFrom: from, impactTo: to, previewPlatforms: platforms };
  const key = previewKey(input);
  const currentPreview = preview?.key === key ? preview.result : undefined;
  const change = (next: Partial<RuleDraft>) => { setDraft(d => ({ ...d, ...next })); setPreview(undefined); };
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) { setError(configurationError(e)); setPreview(undefined); setProductPreview(undefined); }
    finally { lock.current = false; setBusy(false); }
  };
  const start = (rule?: Rule, kind: RuleKind = filter) => {
    setEditingId(rule?.id); setDraft(rule ? editRule(rule) : newRule(kind, koreaTodayDateInput())); setPreview(undefined); setSamples([]);
  };
  const refresh = async () => { await configuration.refetch(); await queryClient.invalidateQueries({ queryKey: ["unified-audit"] }); };
  const previewRule = () => run(async () => {
    const result = await apiPost<Preview>("/unified-rules/preview", input);
    setPreview({ key, result });
  });
  const save = () => run(async () => {
    if (!currentPreview?.canSave || !can("mappings.manage")) return;
    const body = { ...draft, expectedConfigurationVersion: currentPreview.versions.configurationVersion };
    type SaveResult = { rule: Rule; affectedRange: { from: string; to: string | null }; affectedScope: { platforms: Platform[]; scopeKeys?: string[] } };
    const result = editingId ? await apiPatch<SaveResult>(`/unified-rules/${editingId}`, body)
      : await apiPost<SaveResult>("/unified-rules", body);
    setEditingId(result.rule.id); setDraft(editRule(result.rule)); setPreview(undefined);
    rememberSaved({ ruleId: result.rule.id, ...result.affectedRange, ...result.affectedScope, key: crypto.randomUUID() });
    setNotice("설정을 저장했습니다. 발행 결과 반영을 위한 재집계가 필요합니다."); await refresh();
  });
  const rebuild = () => run(async () => {
    if (!saved || !can("operations.run")) return;
    if (saved.from && from < saved.from || saved.to && to > saved.to) { setError("재집계 날짜를 저장된 영향 기간 안으로 지정해 주세요."); return; }
    const batch = rebuildBatch?.from === from && rebuildBatch.to === to ? rebuildBatch : { from, to, key: crypto.randomUUID() };
    setRebuildBatch(batch);
    const result = await apiPost<{ jobs: Job[] }>("/unified-performance/rebuild", {
      from, to, platforms: saved.platforms, ...(saved.scopeKeys ? { scopeKeys: saved.scopeKeys } : {}),
      reason: `제품 설정 변경 ${saved.ruleId}`, expectedContractVersion: "product-performance-v1.1.0", idempotencyKey: batch.key
    });
    setJobs(result.jobs); setNotice("영향 원천·날짜 전체의 재집계를 등록했습니다. 작업 실행 후 발행 상태를 확인하세요.");
  });
  const productAction = (saveProduct: boolean) => run(async () => {
    if (!saveProduct) {
      const result = await apiPost<{ canSave: boolean }>("/unified-products/preview", product);
      setProductPreview({ key: previewKey(product), canSave: result.canSave });
    } else {
      if (!can("products.manage") || productPreview?.key !== previewKey(product) || !productPreview.canSave) return;
      const { id, ...body } = product;
      const result = id ? await apiPatch<{ product: Product }>(`/unified-products/${id}`, body) : await apiPost<{ product: Product }>("/unified-products", body);
      rememberSaved({ ruleId: result.product.id, from: null, to: null, platforms: [...PLATFORMS], key: crypto.randomUUID() });
      setProductPreview(undefined); setProduct({ canonicalName: "", active: true, reason: "" }); await refresh();
      setNotice("기준 제품을 저장했습니다. 관련 이름·참여 규칙을 확인하고 해당 규칙의 영향 범위에서 재집계를 요청하세요.");
    }
  });
  if (configuration.isPending) return <section className="page"><div className="panel" aria-busy="true">제품 설정을 불러오고 있습니다.</div></section>;
  if (configuration.isError) return <section className="page"><h1>제품명과 배분 설정</h1><div className="warning-strip" role="alert">{configurationError(configuration.error)}</div><button className="button" onClick={() => void configuration.refetch()}>다시 조회</button><LegacyLinks /></section>;
  const data = configuration.data!;
  return <section className="page product-mappings">
    <div className="page-header"><div><h1>제품명과 배분 설정</h1><p>고정 제품명과 이름으로 자동 분류합니다. 같은 이름의 신규 상품 ID도 기존 규칙으로 판정합니다.</p></div><button className="button" disabled={busy} onClick={() => void refresh()}>최신 설정 불러오기</button></div>
    <div className="panel"><strong>관리 설정</strong><p>이름·비용·적용기간은 전체 사용자의 설정입니다. 아래 플랫폼 선택은 금액 미리보기의 조회 범위에만 적용됩니다. Meta·Google 광고와 Cafe24 판매는 별도 원천입니다.</p>{!can("mappings.manage") && <p>조회 권한: 설정과 미리보기를 확인할 수 있습니다. 저장에는 매핑 관리 권한이 필요합니다.</p>}</div>
    {error && <div role="alert" className="warning-strip">{error}</div>}{notice && <div role="status" className="warning-strip">{notice}</div>}
    <div className="grid two"><div className="panel"><h2>고정 기준 제품명</h2><div className="table-wrap"><table><thead><tr><th>제품명</th><th>상태·버전</th><th>관리</th></tr></thead><tbody>{data.products.map(p => <tr key={p.id}><td>{p.canonicalName}</td><td>{p.active ? "활성" : "비활성"} · v{p.version}</td><td>{can("products.manage") && <button className="button" disabled={busy} onClick={() => { setProduct({ id: p.id, canonicalName: p.canonicalName, active: p.active, expectedVersion: p.version, reason: "" }); setProductPreview(undefined); }}>수정</button>}</td></tr>)}</tbody></table></div>{!data.products.length && <p>등록된 통합 기준 제품이 없습니다. 기존 원천 설정은 아래 링크에서 확인할 수 있습니다.</p>}</div>
      {can("products.manage") && <form className="panel" onSubmit={e => { e.preventDefault(); void productAction(false); }}><h2>{product.id ? "기준 제품 수정" : "기준 제품 추가"}</h2><fieldset disabled={busy}><label className="field">고정 제품명<input className="input" required maxLength={256} value={product.canonicalName} onChange={e => setProduct({ ...product, canonicalName: e.target.value })} /></label><label><input type="checkbox" checked={product.active} onChange={e => setProduct({ ...product, active: e.target.checked })} /> 활성</label><label className="field">변경 사유<input className="input" required maxLength={1024} value={product.reason} onChange={e => setProduct({ ...product, reason: e.target.value })} /></label><div className="toolbar"><button className="button" type="submit">제품 변경 미리보기</button><button className="button primary" type="button" disabled={productPreview?.key !== previewKey(product) || !productPreview.canSave} onClick={() => void productAction(true)}>제품 저장</button><button className="button" type="button" onClick={() => { setProduct({ canonicalName: "", active: true, reason: "" }); setProductPreview(undefined); }}>새 제품</button></div></fieldset>{productPreview?.key === previewKey(product) && <p role="status">{productPreview.canSave ? "저장 가능한 제품명입니다." : "제품명·기존 별칭·배분 참조·버전 충돌을 확인하세요."}</p>}</form>}
    </div>
    <div className="panel"><div className="toolbar">{Object.entries(KIND_LABELS).map(([kind, label]) => <button key={kind} className={filter === kind ? "button primary" : "button"} onClick={() => setFilter(kind as RuleKind)}>{label}</button>)}<button className="button" disabled={busy} onClick={() => start(undefined, filter)}>새 규칙 미리보기</button></div>
      <div className="table-wrap"><table><thead><tr><th>제품 / 규칙</th><th>플랫폼·범위</th><th>적용기간</th><th>상태</th><th>작업</th></tr></thead><tbody>{data.rules.filter(r => r.kind === filter).map(r => <tr key={r.id}><td>{data.products.find(p => p.id === r.productId)?.canonicalName ?? "공통"}<details><summary>규칙·비용 전체 보기</summary><pre>{JSON.stringify(r.payload, null, 2)}</pre></details></td><td>{r.platform ?? "전체"}<br />{r.scopeKey ?? "전체 범위"}</td><td>{r.validFrom} ~ {r.validTo ?? "종료 없음"}</td><td>{r.active ? "활성" : "비활성"} · v{r.version}</td><td><button className="button" disabled={busy} onClick={() => start(r)}>불러오기</button><button className="button" onClick={() => setAuditId(r.id)}>변경 이력</button></td></tr>)}</tbody></table></div>{!data.rules.some(r => r.kind === filter) && <p>등록된 {KIND_LABELS[filter]}이 없습니다.</p>}
    </div>
    <form className="panel" onSubmit={e => { e.preventDefault(); void previewRule(); }}><h2>{editingId ? "기존" : "새"} {KIND_LABELS[draft.kind]} · 미리보기와 저장</h2><fieldset disabled={busy}>
      <div className="form-grid"><label className="field">제품<select className="select" required={draft.kind !== "ALLOCATION"} disabled={draft.kind === "ALLOCATION"} value={draft.productId ?? ""} onChange={e => change({ productId: e.target.value || null })}><option value="">제품 선택</option>{data.products.map(p => <option key={p.id} value={p.id}>{p.canonicalName}{p.active ? "" : " (비활성)"}</option>)}</select></label>
      <label className="field">설정 적용 플랫폼<select className="select" required={draft.kind !== "NAME"} value={draft.platform ?? ""} onChange={e => change({ platform: e.target.value as Platform || null, scopeKey: null })}><option value="">전체 플랫폼</option>{PLATFORMS.map(p => <option key={p}>{p}</option>)}</select></label><label className="field">원천 범위 (선택)<input className="input" maxLength={256} value={draft.scopeKey ?? ""} onChange={e => change({ scopeKey: e.target.value || null })} placeholder="비우면 해당 플랫폼 전체" /></label><label className="field">적용 시작일<input className="input" type="date" required value={draft.validFrom} onChange={e => change({ validFrom: e.target.value })} /></label><label className="field">적용 종료일 (선택)<input className="input" type="date" min={draft.validFrom} value={draft.validTo ?? ""} onChange={e => change({ validTo: e.target.value || null })} /></label><label><input type="checkbox" checked={draft.active} onChange={e => change({ active: e.target.checked })} /> 활성 (해제 후 저장하면 비활성화)</label></div>
      {draft.kind === "NAME" && <NameRuleFields payload={draft.payload} onChange={payload => change({ payload })} />}
      {draft.kind === "SALE_UNIT" && <SaleUnitFields payload={draft.payload} onChange={payload => change({ payload })} />}
      {draft.kind === "ALLOCATION" && <AllocationFields payload={draft.payload} onChange={payload => change({ payload })} products={data.products} />}
      {draft.kind === "SCOPE_POLICY" && <div><p>이 제품이 참여하는 구성요소입니다. 조회 플랫폼 선택과 별도로 저장됩니다.</p>{["SALE", "AD_SPEND", "DIRECT_COST", "COMMON_EXPENSE"].map(component => <label key={component}><input type="checkbox" checked={(draft.payload.components as string[] ?? []).includes(component)} onChange={e => change({ payload: { ...draft.payload, components: e.target.checked ? [...(draft.payload.components as string[] ?? []), component] : (draft.payload.components as string[] ?? []).filter(c => c !== component) } })} />{component} </label>)}</div>}
      <label className="field">변경 사유<input className="input" required maxLength={1024} value={draft.reason} onChange={e => change({ reason: e.target.value })} /></label>
      <NamePreview samples={samples} onSamplesChange={setSamples} results={currentPreview?.samples} disabled={busy} />
      <h3>금액 범위 미리보기</h3><p>선택 플랫폼의 기존 발행금액을 재검토 대상으로 표시합니다. 변경 후 금액 예측은 재집계 결과에서 확인합니다.</p><div className="toolbar"><label>조회 시작 <input className="input" type="date" required value={from} onChange={e => { setFrom(e.target.value); setPreview(undefined); }} /></label><label>조회 종료 <input className="input" type="date" required min={from} value={to} onChange={e => { setTo(e.target.value); setPreview(undefined); }} /></label></div><div className="toolbar">{PLATFORMS.map(p => <label key={p}><input type="checkbox" checked={platforms.includes(p)} onChange={e => { setPlatforms(PLATFORMS.filter(v => v === p ? e.target.checked : platforms.includes(v))); setPreview(undefined); }} />{p}</label>)}</div><p>이 선택은 미리보기 조회 조건입니다. 저장된 배분 비중과 원천 수집 설정을 바꾸지 않습니다.</p>
      <div className="toolbar"><button className="button" type="submit">{busy ? "처리 중…" : "판정·영향 미리보기"}</button>{can("mappings.manage") && <button className="button primary" type="button" disabled={!currentPreview?.canSave} onClick={() => void save()}>미리본 규칙 저장</button>}</div>
    </fieldset>
    {currentPreview && <div role="status"><p>{currentPreview.canSave ? "저장 가능한 규칙입니다." : `저장 불가: 버전 충돌 ${currentPreview.versionConflict ? "있음" : "없음"}, 중첩 규칙 ${currentPreview.overlaps.length}개, 별칭 충돌 ${currentPreview.aliasConflicts.join(", ") || "없음"}`}</p><p>전체 영향기간: {currentPreview.affectedRange.from} ~ {currentPreview.affectedRange.to ?? "종료 없음"}</p>{currentPreview.impact && <><p>미리보기 기간: {from} ~ {to} · 포함: {currentPreview.impact.selectedPlatforms.join(", ") || "없음"} · 제외: {currentPreview.impact.excludedPlatforms.join(", ") || "없음"}</p><p>재검토 제품: {currentPreview.impact.affectedProducts.join(", ") || "없음"}</p><p>기존 발행 매출 {money(currentPreview.impact.publishedRevenue)} · 광고비 {money(currentPreview.impact.publishedAdSpend)} · 집계 사실 {currentPreview.impact.publishedRows}개 · 미분류·미배분 {currentPreview.impact.unallocatedRows}개</p>{currentPreview.impact.zeroDenominator && <p className="warning-strip">매출 분모가 없거나 0 이하입니다. 배분되지 않은 금액을 유지합니다.</p>}<p>재검토 대상 범위의 보수적 합계이며 변경되는 금액의 확정값이 아닙니다. 미발행 데이터와 수집 누락은 0원으로 표시하지 않습니다.</p></>}</div>}
    </form>
    {saved && <div className="panel"><h2>저장 후 재집계 상태</h2>
      <p>설정 저장 완료 · 영향기간 {saved.from ?? "전체 과거"} ~ {saved.to ?? "종료 없음"}. 위 조회 날짜를 사용하며 최대 92일씩 나누어 처리합니다. 전체 영향기간을 처리하기 전에는 반영 완료로 보지 않습니다.</p>
      <p>재집계 플랫폼: {saved.platforms.join(", ")} · 원천: {saved.scopeKeys?.join(", ") ?? "허용된 전체 범위"}. 변경 전·후 범위를 모두 포함하며 미리보기 체크와 독립적입니다.</p>
      {pending.length > 0 && <details><summary>이전에 저장한 영향 범위 {pending.length}개</summary>{pending.map(p => <p key={p.saved.key}>{p.saved.from ?? "전체 과거"} ~ {p.saved.to ?? "종료 없음"} · {p.saved.platforms.join(", ")} <button className="button" disabled={busy} onClick={() => { setPending(list => [...list.filter(v => v.saved.key !== p.saved.key), { saved, jobs, batch: rebuildBatch }]); setSaved(p.saved); setJobs(p.jobs); setRebuildBatch(p.batch); }}>이 범위의 상태 보기</button></p>)}</details>}
      {can("operations.run") ? <div className="toolbar"><button className="button" disabled={busy} onClick={() => void rebuild()}>해당 기간 재집계 요청·동일 요청 확인</button>
        <button className="button" disabled={busy || !jobs.length} onClick={() => void run(async () => setJobs(await Promise.all(jobs.map(j => apiGet<Job>(`/unified-performance/rebuild/${j.jobId}`)))))}>작업 상태 갱신</button>
        <button className="button" disabled={busy || !jobs.length || jobs.some(j => !["FAILED", "PUBLISHED"].includes(j.status))} onClick={() => { setRebuildBatch(undefined); setJobs([]); setNotice("새 요청을 준비했습니다. 위 날짜를 확인하고 재집계를 요청하세요."); }}>실패 재시도·새 실행 준비</button></div>
        : <p>재집계 요청과 작업 조회에는 실행 권한이 필요합니다. 실행 권한이 있는 관리자가 처리해야 합니다.</p>}
      {rebuildBatch && <p>현재 작업 요청 기간: {rebuildBatch.from} ~ {rebuildBatch.to}</p>}{jobs.map(j => <p key={j.jobId}>{j.platform} {j.date} · {j.status} / {j.phase} · 시도 {j.attempts ?? 0}{j.issues?.length ? ` · ${j.issues.join(", ")}` : ""}</p>)}
      <p>이 브라우저의 현재 로그인 사용자별 세션에 요청을 보관합니다. 브라우저 세션 종료 이후에는 설정 이력을 다시 확인하고 필요한 기간을 요청하세요.</p>
    </div>}
    {auditId && <div className="panel"><h2>규칙 변경 이력과 복구</h2><p>복구는 이전 값을 현재 버전의 새 수정으로 저장합니다. 과거 이력은 보존합니다.</p>{audit.isPending && <p>이력을 불러오고 있습니다.</p>}{audit.isError && <p role="alert">{configurationError(audit.error)}</p>}{audit.data?.map(a => <details key={a.id}><summary>{a.createdAt} · {a.action} · {a.reason}</summary><pre>{JSON.stringify({ before: a.before, after: a.after }, null, 2)}</pre>{can("mappings.manage") && a.before && "kind" in a.before && <button className="button" disabled={busy} onClick={() => { const current = data.rules.find(r => r.id === auditId); if (current && a.before && "kind" in a.before) { setEditingId(current.id); setDraft({ ...editRule(a.before as Rule), expectedVersion: current.version, reason: `이전 설정 복구: ${a.reason}` }); setPreview(undefined); setSamples([]); } }}>이전 값으로 복구안 불러오기</button>}</details>)}</div>}
    <LegacyNameRules products={data.products} disabled={busy} onUse={next => { setEditingId(undefined); setDraft(next); setFilter("NAME"); setPreview(undefined); setSamples([]); }} />
    <LegacyLinks />
  </section>;
}

function LegacyLinks() {
  return <div className="panel"><h2>기존 이름·비용 설정</h2><p>기존 화면의 이름 규칙·원가·비용 적용기간을 그대로 확인할 수 있습니다. 통합 규칙 이관은 별도 검토 대상입니다.</p><div className="toolbar"><Link className="button" href="/mappings">Meta 이름 규칙</Link><Link className="button" href="/settings/products">Meta 제품·비용</Link><Link className="button" href="/sales">Cafe24 이름·판매 비용</Link><Link className="button" href="/google/mappings">Google 이름·판매단위</Link><Link className="button" href="/coupang/mappings">쿠팡 이름 규칙</Link><Link className="button" href="/coupang/products">쿠팡 판매·비용</Link></div></div>;
}
