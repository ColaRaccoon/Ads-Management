"use client";

type Props = {
  payload: Record<string, unknown>;
  onChange: (payload: Record<string, unknown>) => void;
  disabled?: boolean;
};

const amountFields = [
  ["salePrice", "판매가"], ["productCost", "제품 원가"],
  ["shippingCost", "직접 배송비"], ["otherCost", "기타 직접비"]
] as const;

function valueText(value: unknown) { return typeof value === "string" ? value : ""; }

export function SaleUnitFields({ payload, onChange, disabled = false }: Props) {
  const update = (key: string, value: unknown) => onChange({ ...payload, [key]: value });
  const includes = Array.isArray(payload.optionInclude) ? payload.optionInclude.map(valueText) : [];
  const invalidAmounts = amountFields.some(([key]) => payload[key] != null &&
    (!/^(?:0|[1-9]\d{0,23})(?:\.\d{1,6})?$/.test(valueText(payload[key]))));
  const physical = valueText(payload.unitsPerSaleUnit);
  const invalidPhysical = Boolean(physical) && (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(physical) || /^0(?:\.0+)?$/.test(physical));
  return <fieldset disabled={disabled} className="rule-editor">
    <legend>판매단위·옵션별 판매 및 비용</legend>
    <p className="field-help">단품과 세트는 각각 판매단위를 만드세요. 판매가와 비용은 판매단위 1개 전체 금액입니다. 2개입 세트의 비용에 구성 수량을 다시 곱하지 않습니다.</p>
    <div className="form-grid">
      <label className="field">판매단위명<input className="input" required maxLength={256} value={valueText(payload.saleUnitName)} placeholder="예: 단품 / 2개입 세트" onChange={event => update("saleUnitName", event.target.value)} /></label>
      <label className="field">옵션 완전 일치<input className="input" maxLength={1024} value={valueText(payload.optionExact)} placeholder="비우면 옵션 제한 없음" onChange={event => update("optionExact", event.target.value || null)} /></label>
      <label className="field">판매단위당 구성 수량<input className="input" inputMode="decimal" aria-invalid={invalidPhysical} value={physical} placeholder="미입력은 구성 수량 미상" onChange={event => update("unitsPerSaleUnit", event.target.value || null)} /></label>
      <label className="field">금액 적용 기준<select className="select" value={valueText(payload.quantityBasis)} required onChange={event => update("quantityBasis", event.target.value)}><option value="">기준 선택</option><option value="SALE_UNIT_TOTAL">판매단위 1개 전체 금액</option></select></label>
    </div>
    <div>
      <p className="field-label">옵션 포함어 (모두 포함해야 적용)</p>
      {includes.map((term, index) => <div className="toolbar" key={index}>
        <label className="field">옵션 포함어 {index + 1}<input className="input" required maxLength={1024} value={term} onChange={event => update("optionInclude", includes.map((value, position) => position === index ? event.target.value : value))} /></label>
        <button type="button" className="button" onClick={() => update("optionInclude", includes.filter((_, position) => position !== index))}>포함어 {index + 1} 삭제</button>
      </div>)}
      <button type="button" className="button" onClick={() => update("optionInclude", [...includes, ""])} disabled={disabled || includes.length >= 100}>옵션 포함어 추가</button>
    </div>
    <div className="form-grid">{amountFields.map(([key, label]) => <label className="field" key={key}>{label} (원)<input className="input" inputMode="decimal" value={valueText(payload[key])} placeholder="미입력" onChange={event => update(key, event.target.value || null)} /></label>)}</div>
    <p className="field-help">빈 금액은 미입력으로 보존하며 0원은 유효한 설정입니다. 금액은 소수 6자리까지 입력할 수 있습니다. 적용기간과 판매 플랫폼은 위 공통 설정을 사용합니다.</p>
    {invalidAmounts || invalidPhysical ? <p className="warning-strip" role="alert">금액은 0 이상의 십진수, 구성 수량은 0보다 큰 십진수여야 합니다. 소수 6자리와 저장 범위를 확인하세요.</p> : null}
  </fieldset>;
}
