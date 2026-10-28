"use client";

import type { Product } from "./types";

type Target = { productName: string; weight: string | null };
type Props = {
  payload: Record<string, unknown>;
  onChange: (payload: Record<string, unknown>) => void;
  products: Product[];
  disabled?: boolean;
};

const scale = BigInt("10000000000");
function fixedWeight(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(?:0|1)(?:\.\d{1,10})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * scale + BigInt(fraction.padEnd(10, "0"));
  return amount > BigInt(0) && amount <= scale ? amount : null;
}
function displayWeight(value: bigint) {
  const whole = value / scale, fraction = (value % scale).toString().padStart(10, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

export function AllocationFields({ payload, onChange, products, disabled = false }: Props) {
  const method = typeof payload.method === "string" ? payload.method : "";
  const targets: Target[] = Array.isArray(payload.targets) ? payload.targets.map(row => {
    const target = row as Partial<Target>;
    return { productName: typeof target?.productName === "string" ? target.productName : "", weight: typeof target?.weight === "string" ? target.weight : null };
  }) : [];
  const update = (key: string, value: unknown) => onChange({ ...payload, [key]: value });
  const updateTarget = (index: number, change: Partial<Target>) => update("targets", targets.map((target, position) => position === index ? { ...target, ...change } : target));
  const weights = targets.map(target => fixedWeight(target.weight));
  const total = weights.reduce<bigint>((sum, weight) => sum + (weight ?? BigInt(0)), BigInt(0));
  const invalidWeights = !targets.length || weights.some(weight => weight === null) || total !== scale;
  const normalize = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ").replace(/[A-Z]/g, char => char.toLowerCase());
  const duplicate = new Set(targets.map(target => normalize(target.productName))).size !== targets.length;
  return <fieldset disabled={disabled} className="rule-editor">
    <legend>공통 광고비·배송·가구매 배분</legend>
    <p className="field-help">직접 귀속은 원천 이름 판정으로 제품이 확인된 금액입니다. 아래 규칙은 제품이 정해지지 않은 공통 금액에 적용하며 직접 귀속 금액을 재배분하지 않습니다.</p>
    <div className="form-grid">
      <label className="field">비용·수입 항목<select className="select" required value={typeof payload.component === "string" ? payload.component : ""} onChange={event => update("component", event.target.value)}><option value="">항목 선택</option><option value="AD_SPEND">공통 광고비</option><option value="SHIPPING_INCOME">고객 배송수입</option><option value="SHIPPING_COST">공통 배송비</option><option value="FAKE_PURCHASE">가구매 비용</option><option value="OTHER">기타 공통비</option></select></label>
      <label className="field">배분 방식<select className="select" required value={method} onChange={event => {
        const next = event.target.value;
        onChange({ ...payload, method: next, targets: next === "UNALLOCATED" ? [] : targets.map(target => ({ ...target, weight: next === "FIXED_WEIGHTS" ? target.weight : null })) });
      }}><option value="">방식 선택</option><option value="UNALLOCATED">미배분으로 유지</option><option value="FIXED_WEIGHTS">고정 비중 배분</option><option value="REVENUE_SHARE">원천 매출 비중 배분</option></select></label>
      <label className="field">특정 광고·비용 이름 완전 일치<input className="input" maxLength={1024} value={typeof payload.nameExact === "string" ? payload.nameExact : ""} placeholder="비우면 해당 항목 전체" onChange={event => update("nameExact", event.target.value || null)} /></label>
    </div>
    {method === "UNALLOCATED" ? <p role="status">공통 금액을 어느 제품에도 배정하지 않고 미배분 잔액으로 보존합니다.</p> : null}
    {method === "REVENUE_SHARE" ? <p className="warning-strip" role="status">같은 원천·계정·날짜의 대상 제품 매출을 분모로 사용합니다. 분모가 0이거나 매출이 불완전하면 미배분으로 남습니다. Meta·Google 광고 원천에는 자체 판매 분모가 없으므로 매출 비중 배분을 확정할 수 없습니다. 조회 플랫폼을 해제해도 다른 제품에 다시 배분하지 않습니다.</p> : null}
    {method === "FIXED_WEIGHTS" || method === "REVENUE_SHARE" ? <>
      <div className="table-wrap"><table aria-label="공통 금액 배분 대상"><thead><tr><th>기준 제품명</th>{method === "FIXED_WEIGHTS" ? <th>배분 비중 (1 = 100%)</th> : null}<th>대상 관리</th></tr></thead><tbody>{targets.map((target, index) => <tr key={index}>
        <td><select className="select" required aria-label={`배분 제품 ${index + 1}`} value={target.productName} onChange={event => updateTarget(index, { productName: event.target.value })}><option value="">제품 선택</option>{target.productName && !products.some(product => product.canonicalName === target.productName) ? <option value={target.productName}>{target.productName} (현재 목록에 없음)</option> : null}{products.map(product => <option value={product.canonicalName} key={product.id}>{product.canonicalName}{product.active ? "" : " (비활성)"}</option>)}</select></td>
        {method === "FIXED_WEIGHTS" ? <td><input className="input" required aria-label={`배분 비중 ${index + 1}`} aria-invalid={weights[index] === null} inputMode="decimal" value={target.weight ?? ""} placeholder="예: 0.5" onChange={event => updateTarget(index, { weight: event.target.value })} /></td> : null}
        <td><button type="button" className="button" onClick={() => update("targets", targets.filter((_, position) => position !== index))}>대상 {index + 1} 삭제</button></td>
      </tr>)}</tbody></table></div>
      <button type="button" className="button" disabled={disabled || targets.length >= 100} onClick={() => update("targets", [...targets, { productName: "", weight: null }])}>배분 대상 추가</button>
      {method === "FIXED_WEIGHTS" ? <p className={invalidWeights ? "warning-strip" : "field-help"} role="status">비중 합계: {displayWeight(total)} / 1. 각 비중은 0 초과 1 이하, 소수 10자리까지이며 합계가 정확히 1이어야 합니다.{invalidWeights ? " 비중을 확인하세요." : " 비중 합계가 유효합니다."}</p> : null}
      {!targets.length || targets.some(target => !target.productName) || duplicate ? <p className="warning-strip" role="alert">서로 다른 기준 제품을 하나 이상 선택하세요. 같은 제품을 중복 지정할 수 없습니다.</p> : null}
    </> : null}
  </fieldset>;
}
