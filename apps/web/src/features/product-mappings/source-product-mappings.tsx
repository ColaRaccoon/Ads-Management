"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { configurationError, editRule, newRule } from "./model";
import type { NameSample, Platform, Product, Rule, RuleDraft } from "./types";

export const SOURCE_GROUPS = {
  STOREFRONT: { label: "자사몰 · Meta 보고", platform: "CAFE24" },
  GOOGLE: { label: "자사몰 · Google 보고", platform: "CAFE24" },
  NAVER: { label: "네이버", platform: "NAVER" }, COUPANG: { label: "쿠팡", platform: "COUPANG" },
  META_ADS: { label: "Meta 광고", platform: "META" }, GOOGLE_ADS: { label: "Google 광고", platform: "GOOGLE" }
} as const;
type Group = keyof typeof SOURCE_GROUPS;
export type SourceProduct = {
  key: string; group: Group; platform: Platform; scopeKey: string; sourceName: string; nameField: string;
  firstDate: string; lastDate: string; publishedName: string | null; targetName: string | null;
  matchStatus: string; pending: boolean; ruleIds: string[];
};
type Props = { products: Product[]; rules: Rule[]; from: string; to: string; userId?: string;
  busy: boolean; canManage: boolean; onRange: (from: string, to: string) => void;
  onPrepare: (draft: RuleDraft, id: string | undefined, samples: NameSample[]) => void };
const normalize = (name: string) => name.normalize("NFC").trim().replace(/\s+/gu, " ").replace(/[A-Z]/g, c => c.toLowerCase());
export function sourceLinkRules(rules: Rule[], group: Group, scopeKey: string, name: string) {
  return rules.filter(rule => rule.kind === "NAME" && rule.platform === SOURCE_GROUPS[group].platform &&
    (rule.scopeKey ?? "") === scopeKey && rule.payload.nameField === `native:${group}` &&
    rule.payload.matchType === "EXACT" && (rule.payload.terms as string[] ?? []).some(term => normalize(term) === normalize(name)));
}
export function sourceLinkDraft(group: Group, name: string, scopeKey: string, productId: string,
  validFrom: string, validTo: string, reason: string, existing?: Rule): RuleDraft {
  return { ...(existing ? editRule(existing) : newRule("NAME", validFrom)), productId,
    platform: SOURCE_GROUPS[group].platform, scopeKey: scopeKey || null, validFrom, validTo: validTo || null,
    payload: { matchType: "EXACT", terms: [name.trim()], nameField: `native:${group}` }, reason };
}

export function SourceProductMappings({ products, rules, from, to, userId, busy, canManage, onRange, onPrepare }: Props) {
  const source = useQuery({ queryKey: ["unified-source-products", userId, from, to],
    queryFn: () => apiGet<{ products: SourceProduct[]; note: string }>(`/unified-products/source-products?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    enabled: Boolean(from && to && from <= to), retry: false });
  const [search, setSearch] = useState("");
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);
  const [group, setGroup] = useState<Group>("COUPANG");
  const [name, setName] = useState("");
  const [scopeKey, setScopeKey] = useState("");
  const [productId, setProductId] = useState("");
  const [validFrom, setValidFrom] = useState(from);
  const [validTo, setValidTo] = useState("");
  const [reason, setReason] = useState("");
  const [ruleId, setRuleId] = useState("");
  const candidates = sourceLinkRules(rules, group, scopeKey, name);
  const existing = candidates.find(rule => rule.id === ruleId);
  const rows = (source.data?.products ?? []).filter(row => (!onlyUnlinked || row.matchStatus !== "MATCHED" || row.pending) &&
    normalize(`${row.sourceName} ${row.targetName ?? ""} ${SOURCE_GROUPS[row.group]?.label ?? row.group}`).includes(normalize(search)));
  const useRow = (row: SourceProduct) => {
    setGroup(row.group); setName(row.sourceName); setScopeKey(row.scopeKey); setReason("");
    const matches = sourceLinkRules(rules, row.group, row.scopeKey, row.sourceName).filter(rule => rule.active &&
      rule.validFrom <= row.lastDate && (!rule.validTo || rule.validTo >= row.lastDate));
    const rule = matches.length === 1 ? matches[0] : undefined;
    setRuleId(rule?.id ?? ""); setProductId(rule?.productId ?? products.find(product => product.canonicalName === row.targetName)?.id ?? "");
    setValidFrom(rule?.validFrom ?? from); setValidTo(rule?.validTo ?? "");
  };
  return <div className="panel">
    <h2>플랫폼 통합 제품 매핑</h2>
    <p>플랫폼 상품을 하나의 기준 제품에 연결합니다. 베놈 공용·여성, 두줄보호대 2개입을 같은 제품에 묶어도 원본 상품 구분·수량·금액은 유지됩니다.</p>
    <div className="toolbar">
      <label>상품 조회 시작 <input className="input" type="date" value={from} onChange={e => onRange(e.target.value, to)} /></label>
      <label>상품 조회 종료 <input className="input" type="date" min={from} value={to} onChange={e => onRange(from, e.target.value)} /></label>
      <button className="button" type="button" disabled={source.isFetching || busy} onClick={() => void source.refetch()}>원천 상품 새로고침</button>
      <label>상품 검색 <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="두줄, 버닝웨이브, 베놈" /></label>
      <label><input type="checkbox" checked={onlyUnlinked} onChange={e => setOnlyUnlinked(e.target.checked)} /> 미연결·충돌·반영 대기만</label>
    </div>
    {source.isPending && <p role="status">발행된 플랫폼 상품을 조회하고 있습니다.</p>}
    {source.isError && <p role="alert">{configurationError(source.error)}</p>}
    {source.data && <p>{source.data.note}</p>}
    <div className="table-wrap" style={{ maxHeight: 360 }}><table><thead><tr><th>플랫폼 / 원천 상품</th><th>현재 보고서 제품</th><th>설정상 연결 제품</th><th>상태 / 최근 날짜</th><th>관리</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.key}><td>{SOURCE_GROUPS[row.group]?.label ?? row.group}<br />{row.sourceName}</td><td>{row.publishedName ?? "미분류"}</td>
        <td>{row.targetName ?? "미연결"}</td><td>{row.matchStatus === "AMBIGUOUS" ? "연결 충돌" : row.pending ? "재집계 대기" : row.matchStatus === "MATCHED" ? "연결됨" : "미연결"}<br />{row.lastDate}</td>
        <td><button className="button" type="button" disabled={busy} onClick={() => useRow(row)}>연결 설정</button></td></tr>)}</tbody></table></div>
    {source.data && !rows.length && <p>조건에 맞는 발행 상품이 없습니다. 기간을 넓히거나 아래에서 상품명을 직접 입력하세요.</p>}
    <form onSubmit={event => {
      event.preventDefault();
      const draft = sourceLinkDraft(group, name, scopeKey, productId, validFrom, validTo, reason, existing);
      onPrepare(draft, existing?.id, [{ originalName: name.trim(), nameField: `native:${group}`, platform: SOURCE_GROUPS[group].platform,
        scopeKey: scopeKey || "preview", businessDate: validFrom }]);
    }}><fieldset disabled={busy}><legend>원천 상품 → 기준 제품 연결</legend>
      <div className="form-grid">
        <label className="field">원천 플랫폼<select className="select" value={group} onChange={e => { setGroup(e.target.value as Group); setRuleId(""); setScopeKey(""); }}>{Object.entries(SOURCE_GROUPS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
        <label className="field">원천 상품명<input className="input" required maxLength={1024} value={name} onChange={e => { setName(e.target.value); setRuleId(""); }} /></label>
        <label className="field">연결할 기준 제품<select className="select" required value={productId} onChange={e => setProductId(e.target.value)}><option value="">기준 제품 선택</option>{products.filter(product => product.active || product.id === productId).map(product => <option key={product.id} value={product.id}>{product.canonicalName}</option>)}</select></label>
        <label className="field">원천 범위 (비우면 해당 플랫폼 전체)<input className="input" maxLength={256} value={scopeKey} onChange={e => { setScopeKey(e.target.value); setRuleId(""); }} /></label>
        <label className="field">연결 시작일<input className="input" type="date" required value={validFrom} onChange={e => setValidFrom(e.target.value)} /></label>
        <label className="field">연결 종료일 (선택)<input className="input" type="date" min={validFrom} value={validTo} onChange={e => setValidTo(e.target.value)} /></label>
        <label className="field">기존 연결 수정<select className="select" value={existing?.id ?? ""} onChange={e => { const rule = candidates.find(rule => rule.id === e.target.value); setRuleId(rule?.id ?? ""); if (rule) { setProductId(rule.productId ?? ""); setValidFrom(rule.validFrom); setValidTo(rule.validTo ?? ""); } }}><option value="">새 연결 · 적용기간 중복 시 저장 불가</option>{candidates.map(rule => <option key={rule.id} value={rule.id}>{rule.validFrom} ~ {rule.validTo ?? "종료 없음"} · {rule.active ? "활성" : "비활성"}</option>)}</select></label>
        <label className="field">변경 사유<input className="input" required maxLength={1024} value={reason} onChange={e => setReason(e.target.value)} /></label>
      </div>
      <button className="button primary" type="submit">연결안 검토로 가져오기</button>
      <p>아래 이름 규칙에 연결안이 채워집니다. 판정·영향 미리보기 후 {canManage ? "저장하고 해당 기간을 재집계하세요." : "매핑 관리 권한이 있는 사용자에게 저장을 요청하세요."} Meta·Google 광고 연결은 광고에 이미 분류된 제품명을 입력하세요.</p>
    </fieldset></form>
  </div>;
}
