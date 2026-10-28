"use client";

import { useEffect, useState } from "react";

type Props = {
  payload: Record<string, unknown>;
  onChange: (payload: Record<string, unknown>) => void;
  disabled?: boolean;
};

const stringValue = (value: unknown) => typeof value === "string" ? value : "";
const listValue = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const parseLines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);

/** Keep unfinished lines locally so typing a newline does not move the cursor. */
function TermsField({ label, value, onChange, required = false }: {
  label: string; value: string[]; onChange: (value: string[]) => void; required?: boolean;
}) {
  const [text, setText] = useState(() => value.join("\n"));
  const signature = JSON.stringify(value);
  useEffect(() => {
    if (JSON.stringify(parseLines(text)) !== signature) setText((JSON.parse(signature) as string[]).join("\n"));
  }, [signature, text]);
  return <label className="field">{label}
    <textarea className="textarea" rows={3} required={required} maxLength={32768} value={text}
      onChange={event => { setText(event.target.value); onChange(parseLines(event.target.value)); }} />
    <span className="field-help">한 줄에 하나씩 입력하세요.</span>
  </label>;
}

export function NameRuleFields({ payload, onChange, disabled }: Props) {
  const update = (change: Record<string, unknown>) => onChange({ ...payload, ...change });
  return <fieldset disabled={disabled}>
    <legend>이름 판정 조건</legend>
    <p className="field-help">같은 이름과 판매단위는 상품 ID가 바뀌어도 이 규칙으로 판정합니다. 복수 제품이 일치하면 후보와 원인을 확인하고 이름 조건을 보완하세요.</p>
    <div className="form-grid">
      <label className="field">일치 방식
        <select className="select" value={stringValue(payload.matchType)} required onChange={event => update({ matchType: event.target.value })}>
          <option value="">방식 선택</option><option value="EXACT">정확히 일치 · 별칭 중 하나</option><option value="CONTAINS">포함 · 모든 조건어</option>
        </select>
      </label>
      <TermsField label="이름 조건 / 별칭" required value={listValue(payload.terms)} onChange={terms => update({ terms })} />
      <TermsField label="이름 제외어" value={listValue(payload.excludeTerms)} onChange={excludeTerms => update({ excludeTerms })} />
      <label className="field">정확 옵션 (선택)
        <input className="input" maxLength={1024} value={stringValue(payload.optionExact)} onChange={event => update({ optionExact: event.target.value || null })} />
      </label>
      <TermsField label="옵션 포함어" value={listValue(payload.optionInclude)} onChange={optionInclude => update({ optionInclude })} />
      <TermsField label="옵션 제외어" value={listValue(payload.optionExclude)} onChange={optionExclude => update({ optionExclude })} />
      <label className="field">원문 필드 조건 (선택)
        <input className="input" maxLength={128} placeholder="예: product_name" value={stringValue(payload.nameField)} onChange={event => update({ nameField: event.target.value || null })} />
      </label>
      <label className="field">판정할 판매단위 (선택)
        <input className="input" maxLength={256} placeholder="예: 단품 / 1+1 세트" value={stringValue(payload.saleUnitName)} onChange={event => update({ saleUnitName: event.target.value || null })} />
      </label>
    </div>
  </fieldset>;
}
