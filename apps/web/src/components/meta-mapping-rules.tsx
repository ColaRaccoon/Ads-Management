"use client";

import React, { useState, type FormEvent } from "react";
import { koreaYesterdayDateInput } from "@/lib/korea-date";

export type MetaMappingRule = {
  id: string; productId: string; product?: { displayName?: string }; pattern: string;
  matchType: string; priority: number; isActive: boolean; validFrom: string;
  validTo: string | null; note?: string | null; updatedAt: string;
};
type Product = { id: string; displayName: string };
export function metaRuleBody(rule: MetaMappingRule) {
  return { productId: rule.productId, pattern: rule.pattern, matchType: rule.matchType, priority: rule.priority,
    isActive: rule.isActive, validFrom: rule.validFrom.slice(0, 10), validTo: rule.validTo?.slice(0, 10) ?? null,
    note: rule.note ?? null, expectedUpdatedAt: rule.updatedAt };
}

export function MetaMappingRuleForm({ products, rule, busy, onSave, onCancel }: {
  products: Product[]; rule?: MetaMappingRule; busy: boolean;
  onSave: (body: Record<string, unknown>) => void; onCancel?: () => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    onSave({ productId: form.get("productId"), matchType: form.get("matchType"), pattern: form.get("pattern"),
      priority: Number(form.get("priority")), validFrom: form.get("validFrom"), validTo: form.get("validTo") || null,
      isActive: form.get("isActive") === "on", note: form.get("note") || null,
      ...(rule ? { expectedUpdatedAt: rule.updatedAt } : {}) });
  };
  return <form className="panel" onSubmit={submit}>
    <h2>{rule ? "메타 광고 매핑 규칙 수정" : "제품 자동 매핑 규칙"}</h2>
    <p className="field-help">메타 광고명·광고세트명·캠페인명의 패턴으로 제품을 연결합니다. 저장 후 기존 광고에는 선택 기간 다시 적용을 실행해 주세요.</p>
    <div className="form-grid">
      <label>연결 제품<select className="select" name="productId" required defaultValue={rule?.productId ?? ""}>
        <option value="">제품 선택</option>{products.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
      </select></label>
      <label>매칭 방식<select className="select" name="matchType" defaultValue={rule?.matchType ?? "CONTAINS"}>
        <option value="CONTAINS">포함</option><option value="EXACT">정확히 일치</option><option value="REGEX">정규식</option>
      </select></label>
      <label>광고 이름 패턴<input className="input" name="pattern" required maxLength={512} defaultValue={rule?.pattern ?? ""} placeholder="예: 케겔" /></label>
      <label>우선순위<input className="input" name="priority" type="number" min={-1000000} max={1000000} required defaultValue={rule?.priority ?? 100} /></label>
      <label>적용 시작일<input className="input" name="validFrom" type="date" required defaultValue={rule?.validFrom.slice(0, 10) ?? koreaYesterdayDateInput()} /></label>
      <label>적용 종료일<input className="input" name="validTo" type="date" defaultValue={rule?.validTo?.slice(0, 10) ?? ""} /></label>
      <label>메모<input className="input" name="note" maxLength={2000} defaultValue={rule?.note ?? ""} /></label>
      <label className="toolbar"><input name="isActive" type="checkbox" defaultChecked={rule?.isActive ?? true} />활성</label>
      <button className="button primary" disabled={busy} type="submit">{busy ? "저장 중" : rule ? "규칙 저장" : "규칙 등록"}</button>
      {onCancel ? <button className="button" type="button" onClick={onCancel}>수정 취소</button> : null}
    </div>
  </form>;
}

export function MetaMappingRules({ rules, canManage, busy, from, to, onUpdate, onApply, products }: {
  rules: MetaMappingRule[]; products: Product[]; canManage: boolean; busy: boolean; from: string; to: string;
  onUpdate: (id: string, body: Record<string, unknown>) => void;
  onApply: (id: string) => void;
}) {
  const [editing, setEditing] = useState<MetaMappingRule>();
  const current = editing && rules.find(r => r.id === editing.id);
  return <section className="panel" style={{ marginTop: 12 }}>
    <h2>저장된 메타 광고 매핑 규칙</h2>
    <p className="field-help">비활성 규칙도 보관됩니다. 선택 기간 다시 적용은 {from} ~ {to}의 이 규칙 연결과 미매칭 광고를 다시 계산합니다. 수동 지정은 유지합니다.</p>
    {current && canManage ? <MetaMappingRuleForm key={current.updatedAt} products={products} rule={current} busy={busy}
      onCancel={() => setEditing(undefined)} onSave={body => onUpdate(current.id, body)} /> : null}
    <div className="table-wrap"><table><thead><tr><th>제품</th><th>유형 / 패턴</th><th>적용기간</th><th>우선순위</th><th>상태</th>{canManage ? <th>관리</th> : null}</tr></thead>
      <tbody>{rules.map(rule => <tr key={rule.id}>
        <td>{rule.product?.displayName ?? rule.productId}</td><td>{rule.matchType === "CONTAINS" ? "포함" : rule.matchType === "EXACT" ? "정확히 일치" : "정규식"}<br />{rule.pattern}</td>
        <td>{rule.validFrom.slice(0, 10)} ~ {rule.validTo?.slice(0, 10) ?? "종료일 없음"}</td><td>{rule.priority}</td><td>{rule.isActive ? "활성" : "비활성"}</td>
        {canManage ? <td><div className="toolbar" style={{ flexWrap: "wrap" }}>
          <button className="button" type="button" disabled={busy} aria-label={`${rule.pattern} 규칙 수정`} onClick={() => setEditing(rule)}>수정</button>
          <button className="button" type="button" disabled={busy} aria-label={`${rule.pattern} 규칙 ${rule.isActive ? "비활성화" : "활성화"}`}
            onClick={() => onUpdate(rule.id, { ...metaRuleBody(rule), isActive: !rule.isActive })}>{rule.isActive ? "비활성화" : "활성화"}</button>
          <button className="button" type="button" disabled={busy} aria-label={`${rule.pattern} 선택 기간 다시 적용`} onClick={() => onApply(rule.id)}>선택 기간 다시 적용</button>
        </div></td> : null}
      </tr>)}{!rules.length ? <tr><td colSpan={canManage ? 6 : 5}>저장된 메타 광고 규칙이 없습니다.</td></tr> : null}</tbody></table></div>
  </section>;
}
