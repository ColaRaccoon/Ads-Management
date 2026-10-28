"use client";

import { PLATFORMS, PLATFORM_LABELS, type ComparisonMode, type Filters, type Grain, type Options } from "./types";

export function PerformanceFilters({ value, options, onChange }: {
  value: Filters; options: Options | undefined; onChange: (next: Filters) => void;
}) {
  const change = (next: Partial<Filters>) => onChange({ ...value, ...next });
  const scopes = options?.scopes.filter(scope => value.platforms.includes(scope.platform)) ?? [];
  const selectedScopeKeys = value.scopeKeys ?? [...new Set(scopes.map(scope => scope.scopeKey))];
  const platformsLocked = !options && value.scopeKeys !== undefined;
  return <section className="panel" aria-label="제품 통합 성과 조회 조건">
    <fieldset disabled={platformsLocked}>
      <legend>포함할 플랫폼</legend>
      <div className="toolbar" style={{ flexWrap: "wrap", gap: 16 }}>
        {PLATFORMS.map(platform => <label key={platform} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={value.platforms.includes(platform)} onChange={event => change({
            platforms: event.target.checked ? PLATFORMS.filter(item => item === platform || value.platforms.includes(item)) : value.platforms.filter(item => item !== platform)
          })} />{PLATFORM_LABELS[platform]}
        </label>)}
        <button className="button" type="button" onClick={() => change({ platforms: [...PLATFORMS] })}>전체 선택</button>
        <button className="button" type="button" onClick={() => change({ platforms: [] })}>전체 해제</button>
      </div>
      <p className="field-help">Meta·Google은 광고비, Cafe24는 자사몰 판매를 반영합니다. 같은 자사몰 매출을 광고 매체마다 더하지 않습니다. 네이버 광고는 DA 범위입니다.</p>
      <p className="field-help">체크박스는 조회 범위와 합계를 바꿉니다. 차트 범례는 표시만 바꾸며 원천 수집·설정은 변경하지 않습니다.</p>
      {platformsLocked ? <p role="status">선택 계정·스토어의 플랫폼 정보를 불러온 뒤 플랫폼을 변경할 수 있습니다.</p> : null}
      <p role="status">{value.platforms.length === 0 ? "플랫폼을 선택하세요." : value.platforms.length === PLATFORMS.length ? "전체 플랫폼 기준" : "선택 플랫폼 기준"}
        {value.platforms.includes("NAVER") ? " · 추정 데이터 포함" : ""}</p>
      <p className="field-help">포함: {value.platforms.map(platform => PLATFORM_LABELS[platform]).join(", ") || "없음"} / 제외: {PLATFORMS.filter(platform => !value.platforms.includes(platform)).map(platform => PLATFORM_LABELS[platform]).join(", ") || "없음"}</p>
    </fieldset>
    <div className="form-grid" style={{ marginTop: 16 }}>
      <label className="field">고정 제품명
        <select className="select" value={value.productName} onChange={event => change({ productName: event.target.value })}>
          <option value="">전체 제품</option>
          {value.productName && !options?.products.some(product => product.productName === value.productName) ? <option value={value.productName}>{value.productName}</option> : null}
          {options?.products.map(product => <option key={product.productName} value={product.productName}>{product.productName}{product.historical ? " (과거 발행)" : product.active ? "" : " (비활성)"}</option>)}
        </select>
      </label>
      <label className="field">시작일 (한국시간)<input className="input" type="date" value={value.from} onChange={event => change({ from: event.target.value })} /></label>
      <label className="field">종료일 (한국시간)<input className="input" type="date" value={value.to} onChange={event => change({ to: event.target.value })} /></label>
      <label className="field">집계 간격<select className="select" value={value.grain} onChange={event => change({ grain: event.target.value as Grain })}>
        <option value="day">일</option><option value="week">주 (월요일 시작)</option><option value="month">월</option>
      </select></label>
      <label className="field">비교기간<select className="select" value={value.compareMode} onChange={event => change({ compareMode: event.target.value as ComparisonMode })}>
        <option value="previous">직전 동일 일수</option><option value="week">전주 동일 요일 (7일 전)</option><option value="custom">직접 지정</option>
      </select></label>
      <label className="field">비교 시작일<input className="input" type="date" value={value.compareFrom} disabled={value.compareMode !== "custom"} onChange={event => change({ compareFrom: event.target.value })} /></label>
      <label className="field">비교 종료일<input className="input" type="date" value={value.compareTo} disabled={value.compareMode !== "custom"} onChange={event => change({ compareTo: event.target.value })} /></label>
    </div>
    <fieldset style={{ marginTop: 16 }}>
      <legend>계정 / 스토어 범위</legend>
      <div className="toolbar" style={{ flexWrap: "wrap", gap: 12 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={value.scopeKeys === undefined} onChange={event => change({ scopeKeys: event.target.checked ? undefined : [] })} />선택 플랫폼의 전체 계정·스토어</label>
        {scopes.map(scope => <label key={`${scope.platform}:${scope.scopeKey}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={selectedScopeKeys.includes(scope.scopeKey)} onChange={event => change({ scopeKeys: event.target.checked
            ? [...new Set([...selectedScopeKeys, scope.scopeKey])].sort() : selectedScopeKeys.filter(key => key !== scope.scopeKey) })} />
          {PLATFORM_LABELS[scope.platform]} · {scope.label} <small>({scope.scopeKey})</small>
        </label>)}
      </div>
      {!options ? <p className="field-help">계정·스토어 목록을 불러오는 중입니다.</p> : scopes.length === 0 ? <p className="field-help">선택 플랫폼에 조회 가능한 계정·스토어가 없습니다.</p> : null}
      {value.scopeKeys?.length === 0 ? <p role="status">계정·스토어를 선택하세요.</p> : null}
    </fieldset>
  </section>;
}
