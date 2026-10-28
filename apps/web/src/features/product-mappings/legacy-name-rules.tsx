"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet, apiErrorMessage } from "@/lib/api";
import { useCan } from "@/features/auth/use-auth";
import type { GoogleMappings } from "@/types/google";
import type { Platform, Product, RuleDraft } from "./types";

type Source = "META" | "CAFE24" | "GOOGLE" | "COUPANG";
type Row = Record<string, unknown>;
export type LegacyNameCandidate = {
  key: string; label: string; productName: string; platform: Platform; scopeKey: string | null;
  validFrom: string | null; validTo: string | null; active: boolean;
  payload: Record<string, unknown> | null; notes: string[];
};
type Result = { candidates: LegacyNameCandidate[]; notice?: string };
type Props = { onUse: (draft: RuleDraft) => void; products: Product[]; disabled?: boolean };

const sources: Array<{ key: Source; label: string; path: string }> = [
  { key: "META", label: "Meta", path: "/mappings/product-rules" },
  { key: "CAFE24", label: "Cafe24", path: "/sales/cafe24/rules?includeInactive=true" },
  { key: "GOOGLE", label: "Google", path: "/google/mappings?page=1&pageSize=100" },
  { key: "COUPANG", label: "쿠팡", path: "/coupang/mapping-rules?includeInactive=true" },
];
const text = (value: unknown) => typeof value === "string" ? value : "";
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
const normalize = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ").replace(/[A-Z]/g, letter => letter.toLowerCase());
const date = (value: unknown) => /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text(value)) ? text(value).slice(0, 10) : null;
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
const label = (row: Row) => text(record(row.product).displayName) || text(record(row.product).standardName) || text(row.productName);

/** Project only explicit name conditions. Source identifiers never become match terms. */
export function projectLegacyNameRules(source: Source, rows: Row[]): LegacyNameCandidate[] {
  return rows.flatMap((row, index) => {
    const base: LegacyNameCandidate = {
      key: `${source}:${text(row.id) || index}`, label: text(row.displayName) || `${source} 규칙 ${index + 1}`,
      productName: label(row), platform: source, scopeKey: source === "COUPANG" ? "LEGACY_COUPANG_SINGLE_UPLOAD" : null,
      validFrom: date(row.validFrom), validTo: date(row.validTo), active: row.isActive !== false,
      payload: null, notes: [],
    };
    if (row.priority !== undefined) base.notes.push(`기존 우선순위 ${String(row.priority)}는 이관하지 않습니다. 통합 판정은 모든 일치 제품을 검토합니다.`);
    if (!base.validFrom) base.notes.push("기존 적용 시작일을 확인할 수 없어 한국 날짜 기준 오늘을 초안에 넣습니다. 과거 적용기간을 직접 검토하세요.");
    if (!base.scopeKey) base.notes.push("원천 계정 범위가 없는 초안입니다. 전체 계정에 적용할지 검토하세요.");
    if (source === "META") {
      const matchType = text(row.matchType), pattern = text(row.pattern);
      if (["EXACT", "CONTAINS"].includes(matchType) && pattern.trim()) base.payload = { matchType, terms: [pattern], excludeTerms: [], nameField: "adset_name" };
      else base.notes.push(matchType === "REGEX" ? "정규식은 통합 이름 규칙으로 자동 복사할 수 없습니다. 검토한 정확 별칭이나 포함 조건으로 새로 작성하세요." : "복사할 명시적인 이름 조건이 없습니다.");
      base.notes.push("기존 공백 정규화와 통합 공백 보존 규칙이 다를 수 있습니다. 실제 광고세트명으로 미리보기를 확인하세요.");
      return [base];
    }
    if (source === "COUPANG") {
      const terms = strings(row.includeKeywords), excludeTerms = strings(row.excludeKeywords);
      if (terms.length) base.payload = { matchType: "CONTAINS", terms, excludeTerms, ...(row.adEnabled === false ? { nameField: "product_name" } : {}) };
      else base.notes.push("포함할 상품명 조건이 없어 자동 복사할 수 없습니다.");
      base.notes.push("기존 쿠팡 규칙은 공백 제거 및 상품명·옵션 결합 검사를 사용합니다. 통합 초안은 이름 조건이므로 옵션에만 있는 단어는 옵션 조건으로 옮긴 후 검증하세요.");
      if (row.adEnabled === false) base.notes.push("기존 광고 미적용을 보존하도록 판매 상품명 필드로 제한합니다.");
      if (row.saleMethod) base.notes.push(`기존 판매방식 ${text(row.saleMethod)}은 비용 설정에 보존됩니다. 이 이름 초안에는 판매방식 조건이 포함되지 않습니다.`);
      return [base];
    }
    // Cafe24 aliases are OR branches; every branch also requires all include terms.
    const aliases = strings(row.productNameAliases), terms = strings(row.productNameIncludeKeywords);
    const excluded = strings(row.productNameExcludeKeywords), externalCount = strings(row.productNumbers).length;
    if (externalCount) base.notes.push(`외부 상품번호 조건 ${externalCount}개를 제거합니다. 이전에 번호로 제한했던 적용 범위가 넓어질 수 있습니다.`);
    base.notes.push("기존 공백 제거 방식은 이관하지 않습니다. 이름과 옵션의 실제 표기로 미리보기를 확인하세요.");
    if (row.matchTarget !== "SEPARATE") base.notes.push("기존 상품명 포함 옵션 문자열 검사를 상품명·원본 옵션의 별도 조건으로 옮긴 초안입니다. 옵션에만 존재하는 별칭은 직접 수정하세요.");
    return (aliases.length ? aliases : [""]).map((alias, branch) => {
      const branchTerms = [...terms, ...(alias ? [alias] : [])];
      return { ...base, key: `${base.key}:alias:${branch}`, label: `${base.label}${aliases.length > 1 ? ` · 별칭 ${branch + 1}` : ""}`,
        payload: branchTerms.length ? { matchType: "CONTAINS", terms: branchTerms, excludeTerms: excluded,
          optionInclude: strings(row.optionIncludeKeywords), optionExclude: strings(row.optionExcludeKeywords), nameField: "product_name" } : null,
        notes: [...base.notes, ...(!branchTerms.length ? ["상품번호 또는 옵션만 있는 규칙입니다. 명시적인 상품명 조건이 없어 자동 복사를 막았습니다."] : []),
          ...(aliases.length > 1 ? ["여러 별칭 중 하나가 일치하는 기존 조건을 별칭별 초안으로 분리했습니다. 필요한 각 별칭을 개별 검토하세요."] : [])] };
    });
  });
}

export function legacyCandidateDraft(candidate: LegacyNameCandidate, products: Product[], productId?: string): RuleDraft | null {
  if (!candidate.payload) return null;
  const matches = products.filter(product => normalize(product.canonicalName) === normalize(candidate.productName));
  const selected = productId ? products.find(product => product.id === productId) : matches.length === 1 ? matches[0] : undefined;
  return { kind: "NAME", productId: selected?.id ?? null, platform: candidate.platform, scopeKey: candidate.scopeKey,
    payload: structuredClone(candidate.payload), validFrom: candidate.validFrom ?? today(), validTo: candidate.validTo,
    active: candidate.active, reason: `기존 ${candidate.platform} 이름 규칙 검토 이관: ${candidate.label}`.slice(0, 1024) };
}

async function load(source: typeof sources[number]): Promise<Result> {
  if (source.key !== "GOOGLE") {
    const rows = await apiGet<unknown>(source.path);
    if (!Array.isArray(rows)) throw new Error("기존 이름 규칙 응답을 확인할 수 없습니다.");
    if (rows.length > 10000) throw new Error("기존 규칙이 10,000개를 초과했습니다. 기존 설정 화면에서 범위를 나누어 확인하세요.");
    return { candidates: projectLegacyNameRules(source.key, rows.map(record)) };
  }
  const data = await apiGet<GoogleMappings>(source.path);
  const candidates: LegacyNameCandidate[] = (data.nameAutomaticProducts ?? []).flatMap(product => [...new Set([product.displayName, product.name].filter(Boolean))].map((name, index) => ({
    key: `GOOGLE:${product.id}:name:${index}`, label: `${product.displayName} · 자동 이름 ${index + 1}`, productName: product.displayName,
    platform: "GOOGLE" as const, scopeKey: null, validFrom: null, validTo: null, active: true,
    payload: { matchType: "CONTAINS", terms: [name], excludeTerms: [], nameField: "campaign_name" },
    notes: ["현재 Google 캠페인명 자동 연결에 사용하는 제품 이름입니다.", "기존 공백 제거 방식은 이관하지 않습니다. 실제 캠페인명으로 검증하세요.", "유효일이 없는 이름이므로 한국 날짜 기준 오늘을 초안에 넣습니다. 적용기간과 계정 범위를 검토하세요."]
  })));
  for (const mapping of [...data.campaignMappings, ...data.salesMappings]) candidates.push({
    key: `GOOGLE:identifier:${mapping.id}`, label: `${mapping.productName ?? "제품 미지정"} · ${mapping.kind === "SALE" ? "기존 판매 연결" : "기존 캠페인 연결"}`,
    productName: mapping.productName ?? "", platform: "GOOGLE", scopeKey: mapping.connectionId,
    validFrom: mapping.startDate, validTo: mapping.endDate, active: true, payload: null,
    notes: ["외부 캠페인 ID 또는 상품번호에 의존하는 설정입니다. 이름 조건이 없으므로 통합 이름 규칙으로 복사할 수 없습니다. 판매단위·비용은 기존 Google 설정에서 확인하세요."]
  });
  return { candidates, notice: data.pagination.total > data.campaignMappings.length + data.salesMappings.length
    ? `자동 이름 목록은 전체입니다. ID 기반 기존 연결은 ${data.pagination.total}개 중 첫 ${data.campaignMappings.length + data.salesMappings.length}개를 참고로 표시하며 이름 규칙으로 복사하지 않습니다. 전체 연결은 기존 Google 설정에서 확인하세요.` : undefined };
}

function SourceRules({ source, products, onUse, disabled }: Props & { source: typeof sources[number] }) {
  const canRead = useCan("data.read");
  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const query = useQuery({ queryKey: ["unified", "legacy-name-rules", source.key], queryFn: () => load(source), enabled: canRead && enabled, retry: false });
  return <section>
    <div className="toolbar"><h3>{source.label} 기존 이름 규칙</h3><button type="button" className="button" disabled={!canRead || disabled || query.isFetching} onClick={() => enabled ? void query.refetch() : setEnabled(true)}>{query.isFetching ? "불러오는 중…" : enabled ? "다시 불러오기" : "불러오기"}</button></div>
    {query.isError && <p className="warning-strip" role="alert">{apiErrorMessage(query.error, `${source.label} 기존 규칙을 불러오지 못했습니다.`)}</p>}
    {query.data?.notice && <p className="field-help">{query.data.notice}</p>}
    {query.data && <div className="table-wrap"><table aria-label={`${source.label} 기존 이름 규칙`}><thead><tr><th>기존 규칙 / 제품</th><th>이름 조건</th><th>적용기간·상태</th><th>이관 검토</th></tr></thead><tbody>
      {query.data.candidates.map(candidate => {
        const matches = products.filter(product => normalize(product.canonicalName) === normalize(candidate.productName));
        const productId = selected[candidate.key] ?? (matches.length === 1 ? matches[0].id : "");
        return <tr key={candidate.key}><td>{candidate.label}<br /><span className="field-help">기존 제품: {candidate.productName || "확인 필요"}</span></td>
          <td>{candidate.payload ? <pre>{JSON.stringify(candidate.payload, null, 2)}</pre> : "복사할 이름 조건 없음"}</td>
          <td>{candidate.validFrom ?? "시작일 미확인"} ~ {candidate.validTo ?? "종료 없음"}<br />{candidate.active ? "활성" : "비활성"}</td>
          <td>{candidate.notes.map((note, index) => <p className="field-help" key={index}>{note}</p>)}{candidate.payload && <>
            <label className="field">통합 기준 제품<select className="select" value={productId} disabled={disabled} onChange={event => setSelected({ ...selected, [candidate.key]: event.target.value })}><option value="">제품을 직접 선택하세요</option>{products.map(product => <option key={product.id} value={product.id}>{product.canonicalName}{product.active ? "" : " (비활성)"}</option>)}</select></label>
            <button type="button" className="button" disabled={disabled || !productId} onClick={() => { const draft = legacyCandidateDraft(candidate, products, productId); if (draft) onUse(draft); }}>이름 규칙 초안으로 사용</button>
          </>}</td></tr>;
      })}
      {!query.data.candidates.length && <tr><td colSpan={4}>이 원천에 저장된 이름 규칙이 없습니다.</td></tr>}
    </tbody></table></div>}
  </section>;
}

export function LegacyNameRules(props: Props) {
  return <section className="panel"><h2>기존 이름 규칙 불러오기</h2>
    <p>원천별 기존 설정을 읽어 검토할 이름 규칙 초안으로 가져옵니다. 기준 제품명은 공백·대소문자 정규화 후 유일하게 일치할 때만 자동 선택합니다.</p>
    <p className="field-help">초안을 불러온 뒤 이름·옵션·날짜·적용 범위를 검토하고 실제 API 미리보기를 실행하세요. 저장 버튼을 누르기 전까지 설정은 바뀌지 않습니다. 기존 비용과 판매단위 설정은 아래 기존 화면 링크에서 확인할 수 있습니다.</p>
    {sources.map(source => <SourceRules {...props} source={source} key={source.key} />)}
  </section>;
}
