"use client";

import type { NameResolution, NameSample } from "./types";

type Props = {
  samples: NameSample[];
  onSamplesChange: (samples: NameSample[]) => void;
  results?: NameResolution[];
  disabled?: boolean;
};

const platforms = ["META", "GOOGLE", "NAVER", "COUPANG", "CAFE24"] as const;
const labels: Record<string, string> = { META: "Meta 광고", GOOGLE: "Google 광고", NAVER: "네이버", COUPANG: "쿠팡", CAFE24: "자사몰 Cafe24" };
const statuses: Record<string, string> = { MATCHED: "판정 완료", AMBIGUOUS: "복수 제품 후보", UNMATCHED: "미분류", NAME_MISSING: "이름 없음", UNIT_REQUIRED: "판매단위 확인 필요", NOT_CONFIGURED: "판매단위 설정 없음" };
const reasons: Record<string, string> = {
  SOURCE_NAME_EMPTY: "원천 이름이 비어 있습니다.",
  NO_EFFECTIVE_NAME_RULE: "해당 날짜와 원천 범위에 일치하는 기준 제품명이나 이름 규칙이 없습니다.",
  CANONICAL_NORMALIZATION_COLLISION: "정규화한 기준 제품명이 여러 제품과 일치합니다. 기준 제품명을 확인하세요.",
  EXACT_NAME_OR_ALIAS: "고정 기준 제품명 또는 정확 별칭이 일치합니다.",
  ALL_NAME_CONDITIONS_MATCHED: "이름의 모든 포함 조건이 일치합니다.",
  MULTIPLE_PRODUCT_CANDIDATES: "서로 다른 제품이 함께 일치합니다. 이름 포함어·제외어·옵션 조건을 수정하세요.",
  SALE_UNIT_RULE_MISSING: "이 제품의 판매단위 규칙을 확인하세요.",
  MULTIPLE_SALE_UNIT_CANDIDATES: "판매단위 후보가 여러 개입니다. 옵션이나 판매단위 조건을 보완하세요.",
  SALE_UNIT_UNRESOLVED: "날짜·원천 범위·옵션에 일치하는 판매단위 규칙이 없습니다.",
  UNIQUE_SALE_UNIT_RULE: "하나의 판매단위 규칙이 일치합니다.",
};

export function NamePreview({ samples, onSamplesChange, results, disabled }: Props) {
  const update = (index: number, change: Partial<NameSample>) => onSamplesChange(samples.map((sample, row) => row === index ? { ...sample, ...change } : sample));
  const add = () => {
    const previous = samples.at(-1);
    const businessDate = previous?.businessDate ?? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
    onSamplesChange([...samples, { originalName: "", originalOption: "", nameField: previous?.nameField ?? "product_name", platform: previous?.platform ?? "CAFE24", scopeKey: previous?.scopeKey ?? "", businessDate }]);
  };
  return <section aria-label="이름 자동 판정 미리보기">
    <h3>원문 이름 자동 판정</h3>
    <p className="field-help">확인할 이름과 옵션만 입력하세요. 미리보기는 설정이나 원천 데이터를 저장하지 않습니다. 상품 ID를 다시 등록할 필요가 없습니다.</p>
    <fieldset disabled={disabled}>
      <legend>판정할 표본 · 최대 100개</legend>
      {samples.map((sample, index) => <fieldset key={index}>
        <legend>표본 {index + 1}</legend>
        <div className="form-grid">
          <label className="field">이름 원문<input className="input" maxLength={4096} value={sample.originalName} onChange={event => update(index, { originalName: event.target.value })} /></label>
          <label className="field">옵션 원문<input className="input" maxLength={4096} value={sample.originalOption ?? ""} onChange={event => update(index, { originalOption: event.target.value })} /></label>
          <label className="field">플랫폼<select className="select" value={sample.platform} onChange={event => update(index, { platform: event.target.value as NameSample["platform"] })}>{platforms.map(platform => <option value={platform} key={platform}>{labels[platform]}</option>)}</select></label>
          <label className="field">원천 범위 키<input className="input" required maxLength={256} value={sample.scopeKey} onChange={event => update(index, { scopeKey: event.target.value })} /></label>
          <label className="field">실적 날짜<input className="input" required type="date" value={sample.businessDate} onChange={event => update(index, { businessDate: event.target.value })} /></label>
          <label className="field">이름을 읽은 필드<input className="input" required maxLength={128} value={sample.nameField} onChange={event => update(index, { nameField: event.target.value })} /></label>
          <label className="field">원천 판매단위 (선택)<input className="input" maxLength={1024} value={sample.saleUnitName ?? ""} onChange={event => update(index, { saleUnitName: event.target.value || undefined })} /></label>
          <label className="field"><span>판매단위 확인</span><span><input type="checkbox" checked={sample.requiresSaleUnit ?? false} onChange={event => update(index, { requiresSaleUnit: event.target.checked })} /> 이 표본은 판매단위 판정이 필요합니다</span></label>
        </div>
        <button type="button" className="button" onClick={() => onSamplesChange(samples.filter((_, row) => row !== index))}>표본 {index + 1} 삭제</button>
      </fieldset>)}
      <button className="button" type="button" disabled={samples.length >= 100} onClick={add}>이름 표본 추가</button>
    </fieldset>
    {results ? <div className="table-wrap"><table aria-label="이름 자동 판정 결과">
      <thead><tr><th>이름 / 옵션 원문</th><th>인식된 제품</th><th>판매단위</th><th>사용 규칙</th><th>판정 상태 / 후보</th><th>사유와 수정 안내</th></tr></thead>
      <tbody>{results.map((result, index) => <tr key={index}>
        <td>{result.originalName || "이름 없음"}<br /><span className="field-help">{result.originalOption || "옵션 없음"}</span></td>
        <td>{result.canonicalProductName ?? "미분류"}</td>
        <td>{result.saleUnitName ?? "미확정"}{result.unitPreview ? <><br /><span className="field-help">{statuses[result.unitPreview.status] ?? result.unitPreview.status}</span>{result.unitPreview.candidates.length > 1 ? <div>후보: {result.unitPreview.candidates.map(candidate => typeof candidate.saleUnitName === "string" ? candidate.saleUnitName : "판매단위 이름 없음").join(" / ")}</div> : null}</> : null}</td>
        <td>{result.ruleIds.length ? result.ruleIds.join(" / ") : result.canonicalProductName ? "고정 기준 제품명" : "일치 규칙 없음"}{result.unitPreview?.candidates.map((candidate, row) => typeof candidate.ruleId === "string" ? <div key={row}>판매단위 규칙: {candidate.ruleId}</div> : null)}</td>
        <td>{statuses[result.matchStatus] ?? result.matchStatus}{result.candidateNames.length ? <><br />{result.candidateNames.join(" / ")}</> : null}</td>
        <td>{[...result.reasons, ...(result.unitPreview ? [result.unitPreview.reason] : [])].map((reason, row) => <div key={row}>{reasons[reason] ?? reason}</div>)}{result.matchStatus === "AMBIGUOUS" ? <p>일치한 이름 규칙의 포함어·제외어·옵션 조건을 확인하세요.</p> : ["UNMATCHED", "NAME_MISSING"].includes(result.matchStatus) ? <p>원문 이름과 적용기간·플랫폼·범위를 확인한 뒤 이름 규칙을 수정하세요.</p> : null}</td>
      </tr>)}{!results.length ? <tr><td colSpan={6}>판정할 이름 표본을 추가한 뒤 미리보기를 실행하세요.</td></tr> : null}</tbody>
    </table></div> : null}
  </section>;
}
