"use client";

import { RefreshCw, Save, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";

type CoupangProductSetting = {
  id: string;
  displayName: string;
  standardName: string;
  isActive: boolean;
};

type CoupangMappingRule = {
  id: string;
  coupangProductId: string;
  displayName: string;
  includeKeywords: unknown;
  excludeKeywords: unknown;
  priority: number;
  saleMethod?: string | null;
  adEnabled: boolean;
  isActive: boolean;
  validFrom: string;
  validTo?: string | null;
  note?: string | null;
  product?: {
    id: string;
    displayName: string;
  } | null;
};

type CoupangMappingIssue = {
  issueType: "UNMATCHED" | "AMBIGUOUS" | "EXCLUDED";
  sourceType: "SALES" | "ADS" | "PROMOTION";
  targetKind: "SALES_PRODUCT" | "ADS_SPEND_PRODUCT" | "ADS_CONVERSION_PRODUCT" | "PROMOTION_PRODUCT";
  rowNumber: number | null;
  sourceName: string;
  productText: string;
  amountKrw: number | null;
  reason: string;
  candidates: string[];
  date: string | null;
  rowId: string;
};

type CoupangMappingIssuesResponse = {
  period: { from: string; to: string };
  summary: {
    totalCount: number;
    unmatchedCount: number;
    ambiguousCount: number;
    excludedCount: number;
    salesCount: number;
    adsCount: number;
    promotionCount: number;
  };
  rows: CoupangMappingIssue[];
};

type IssueFilter = "ALL" | CoupangMappingIssue["issueType"];
type TargetFilter = "ALL" | CoupangMappingIssue["targetKind"];

type RuleDraft = {
  coupangProductId: string;
  displayName: string;
  includeKeywords: string;
  excludeKeywords: string;
  priority: string;
  validFrom: string;
  validTo: string;
  adEnabled: boolean;
  isActive: boolean;
  note: string;
};

const defaultDraft = (): RuleDraft => ({
  coupangProductId: "",
  displayName: "",
  includeKeywords: "",
  excludeKeywords: "",
  priority: "100",
  validFrom: todayInput(),
  validTo: "",
  adEnabled: true,
  isActive: true,
  note: ""
});

export default function CoupangMappingsPage() {
  const range = useRange();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RuleDraft>(defaultDraft);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [issueFilter, setIssueFilter] = useState<IssueFilter>("ALL");
  const [targetFilter, setTargetFilter] = useState<TargetFilter>("ALL");

  const products = useQuery({
    queryKey: ["coupang-products"],
    queryFn: () => apiGet<CoupangProductSetting[]>("/coupang/product-settings")
  });
  const rules = useQuery({
    queryKey: ["coupang-product-rules"],
    queryFn: () => apiGet<CoupangMappingRule[]>("/coupang/mapping-rules?includeInactive=true")
  });
  const issues = useQuery({
    queryKey: ["coupang-mapping-issues", range],
    queryFn: () => apiGet<CoupangMappingIssuesResponse>(`/coupang/mapping-issues?${rangeQuery(range)}`)
  });

  const invalidateMappingQueries = () => {
    void queryClient.invalidateQueries({ queryKey: ["coupang-product-rules"] });
    void queryClient.invalidateQueries({ queryKey: ["coupang-mapping-issues"] });
  };

  const createRule = useMutation({
    mutationFn: (body: unknown) => apiPost<CoupangMappingRule>("/coupang/mapping-rules", body),
    onSuccess: () => {
      setDraft(defaultDraft());
      setEditingRuleId(null);
      invalidateMappingQueries();
    }
  });
  const updateRule = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => apiPatch<CoupangMappingRule>(`/coupang/mapping-rules/${id}`, body),
    onSuccess: () => {
      setDraft(defaultDraft());
      setEditingRuleId(null);
      invalidateMappingQueries();
    }
  });
  const disableRule = useMutation({
    mutationFn: (id: string) => apiDelete<CoupangMappingRule>(`/coupang/mapping-rules/${id}`),
    onSuccess: invalidateMappingQueries
  });
  const rematch = useMutation({
    mutationFn: () => apiPost(`/coupang/rematch?${rangeQuery(range)}`, {}),
    onSuccess: () => void queryClient.invalidateQueries()
  });

  const filteredIssues = useMemo(() => {
    return (issues.data?.rows ?? []).filter((issue) => {
      return (issueFilter === "ALL" || issue.issueType === issueFilter) && (targetFilter === "ALL" || issue.targetKind === targetFilter);
    });
  }, [issueFilter, issues.data?.rows, targetFilter]);

  const productOptions = products.data ?? [];
  const savedRules = rules.data ?? [];
  const isSaving = createRule.isPending || updateRule.isPending || disableRule.isPending;
  const mutationError = createRule.error ?? updateRule.error ?? disableRule.error ?? rematch.error;

  const submitRule = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = rulePayload(draft);
    if (editingRuleId) {
      updateRule.mutate({ id: editingRuleId, body });
      return;
    }
    createRule.mutate(body);
  };

  const editRule = (rule: CoupangMappingRule) => {
    setEditingRuleId(rule.id);
    setDraft({
      coupangProductId: rule.coupangProductId,
      displayName: inputText(rule.displayName),
      includeKeywords: listText(rule.includeKeywords),
      excludeKeywords: listText(rule.excludeKeywords),
      priority: inputText(rule.priority ?? 100),
      validFrom: dateInputText(rule.validFrom) || todayInput(),
      validTo: dateInputText(rule.validTo),
      adEnabled: rule.adEnabled !== false,
      isActive: rule.isActive !== false,
      note: inputText(rule.note)
    });
  };

  const createRuleFromIssue = (issue: CoupangMappingIssue) => {
    setEditingRuleId(null);
    setDraft((current) => ({
      ...current,
      displayName: issue.productText,
      includeKeywords: issue.productText,
      note: issue.reason
    }));
  };

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>쿠팡 매핑관리</h1>
          <p>쿠팡 판매/광고/프로모션 데이터의 상품 자동매핑 규칙과 확인 필요 항목을 관리합니다.</p>
        </div>
        <button className="button" type="button" onClick={() => rematch.mutate()} disabled={rematch.isPending}>
          <RefreshCw size={16} />
          {rematch.isPending ? "계산 중" : "자동매핑 다시 계산"}
        </button>
      </div>

      {mutationError ? <div className="warning-strip"><span>처리 실패: {mutationError.message}</span></div> : null}
      {rematch.isSuccess ? <div className="warning-strip"><span>자동매핑 계산이 반영되었습니다.</span></div> : null}

      <div className="warning-strip">
        <span>미매칭 {issues.data?.summary.unmatchedCount ?? 0}</span>
        <span>충돌 {issues.data?.summary.ambiguousCount ?? 0}</span>
        <span>제외 {issues.data?.summary.excludedCount ?? 0}</span>
        <span>확인 필요 {issues.data?.summary.totalCount ?? 0}</span>
      </div>

      <div className="grid two">
        <form className="panel" onSubmit={submitRule}>
          <h2>{editingRuleId ? "매핑 규칙 수정" : "새 매핑 규칙"}</h2>
          <div className="rule-form">
            <Field label="상품" help="규칙이 연결될 쿠팡 상품">
              <select
                className="select"
                value={draft.coupangProductId}
                onChange={(event) => setDraftValue("coupangProductId", event.target.value, setDraft)}
                required
              >
                <option value="">상품 선택</option>
                {productOptions.map((product) => (
                  <option key={product.id} value={product.id}>{product.displayName}</option>
                ))}
              </select>
            </Field>
            <Field label="규칙 표시명" help="목록과 충돌 후보에 표시되는 이름">
              <input className="input" value={draft.displayName} onChange={(event) => setDraftValue("displayName", event.target.value, setDraft)} />
            </Field>
            <Field label="포함 키워드" help="모두 포함되어야 매칭">
              <TextareaInput value={draft.includeKeywords} onChange={(value) => setDraftValue("includeKeywords", value, setDraft)} placeholder="상품명 또는 키워드" />
            </Field>
            <Field label="제외 키워드" help="하나라도 포함되면 제외">
              <TextareaInput value={draft.excludeKeywords} onChange={(value) => setDraftValue("excludeKeywords", value, setDraft)} placeholder="제외할 키워드" />
            </Field>
            <Field label="우선순위" help="낮은 숫자가 먼저 적용">
              <input className="input" inputMode="numeric" type="number" value={draft.priority} onChange={(event) => setDraftValue("priority", event.target.value, setDraft)} />
            </Field>
            <Field label="적용 시작일" help="규칙 적용 시작일">
              <input className="input" type="date" value={draft.validFrom} onChange={(event) => setDraftValue("validFrom", event.target.value, setDraft)} required />
            </Field>
            <Field label="적용 종료일" help="비워두면 종료일 없음">
              <input className="input" type="date" value={draft.validTo} onChange={(event) => setDraftValue("validTo", event.target.value, setDraft)} />
            </Field>
            <Field label="상태" help="비활성 규칙은 매칭에 사용하지 않음">
              <span className="toolbar">
                <label className="toolbar"><input checked={draft.adEnabled} type="checkbox" onChange={(event) => setDraft((current) => ({ ...current, adEnabled: event.target.checked }))} /> 광고 반영</label>
                <label className="toolbar"><input checked={draft.isActive} type="checkbox" onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))} /> 활성</label>
              </span>
            </Field>
            <Field label="메모" help="운영 메모">
              <TextareaInput value={draft.note} onChange={(value) => setDraftValue("note", value, setDraft)} />
            </Field>
            <div className="toolbar" style={{ alignSelf: "end" }}>
              <button className="button primary" disabled={isSaving || !draft.coupangProductId || listValue(draft.includeKeywords).length === 0} type="submit">
                <Save size={16} />
                {editingRuleId ? "규칙 저장" : "규칙 생성"}
              </button>
              {editingRuleId ? (
                <button className="button" disabled={isSaving} type="button" onClick={() => { setEditingRuleId(null); setDraft(defaultDraft()); }}>
                  새 규칙
                </button>
              ) : null}
            </div>
          </div>
        </form>

        <div className="panel">
          <h2>확인 필요 항목</h2>
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <select className="select" value={issueFilter} onChange={(event) => setIssueFilter(event.target.value as IssueFilter)}>
              <option value="ALL">전체</option>
              <option value="UNMATCHED">미매칭</option>
              <option value="AMBIGUOUS">충돌</option>
              <option value="EXCLUDED">제외</option>
            </select>
            <select className="select" value={targetFilter} onChange={(event) => setTargetFilter(event.target.value as TargetFilter)}>
              <option value="ALL">전체 대상</option>
              <option value="SALES_PRODUCT">판매 상품</option>
              <option value="ADS_SPEND_PRODUCT">광고 집행 상품</option>
              <option value="ADS_CONVERSION_PRODUCT">광고 전환 상품</option>
              <option value="PROMOTION_PRODUCT">프로모션 상품</option>
            </select>
          </div>
          <DataTable
            rows={filteredIssues}
            empty={issues.isLoading ? "불러오는 중입니다." : "확인 필요 항목이 없습니다."}
            columns={[
              { key: "type", header: "구분", render: (row) => <IssueBadge type={row.issueType} /> },
              { key: "source", header: "출처", render: (row) => sourceLabel(row.sourceType, row.targetKind) },
              { key: "date", header: "일자", render: (row) => row.date ?? "-" },
              { key: "row", header: "파일/행", render: (row) => `${row.sourceName} / ${row.rowNumber ?? "-"}` },
              { key: "text", header: "상품 텍스트", render: (row) => row.productText },
              { key: "amount", header: "금액", render: (row) => money(row.amountKrw) },
              { key: "candidates", header: "후보", render: (row) => keywordBadges(row.candidates, "후보") },
              {
                key: "action",
                header: "작업",
                render: (row) => (
                  <button className="button" type="button" onClick={() => createRuleFromIssue(row)}>
                    규칙 만들기
                  </button>
                )
              }
            ]}
          />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>저장된 매핑 규칙</h2>
        <DataTable
          rows={savedRules}
          empty={rules.isLoading ? "불러오는 중입니다." : "저장된 매핑 규칙이 없습니다."}
          columns={[
            { key: "product", header: "상품", render: (row) => row.product?.displayName ?? productLabel(row.coupangProductId, productOptions) },
            { key: "name", header: "규칙명", render: (row) => row.displayName },
            { key: "include", header: "포함 키워드", render: (row) => keywordBadges(listArray(row.includeKeywords), "포함") },
            { key: "exclude", header: "제외 키워드", render: (row) => keywordBadges(listArray(row.excludeKeywords), "제외") },
            { key: "priority", header: "우선순위", render: (row) => row.priority },
            { key: "period", header: "적용기간", render: (row) => `${dateInputText(row.validFrom) || "-"} ~ ${dateInputText(row.validTo) || "-"}` },
            { key: "ad", header: "광고", render: (row) => (row.adEnabled ? "반영" : "제외") },
            { key: "status", header: "상태", render: (row) => <span className={row.isActive === false ? "badge stop_candidate" : "badge scale"}>{row.isActive === false ? "비활성" : "활성"}</span> },
            {
              key: "actions",
              header: "작업",
              render: (row) => (
                <span className="toolbar">
                  <button className="button" type="button" onClick={() => editRule(row)}>편집</button>
                  <button className="button danger" disabled={isSaving || row.isActive === false} type="button" onClick={() => disableRule.mutate(row.id)}>
                    <Trash2 size={16} />
                    비활성화
                  </button>
                </span>
              )
            }
          ]}
        />
      </div>
    </section>
  );
}

function Field({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
      <span className="field-help">{help}</span>
    </div>
  );
}

function TextareaInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <textarea className="textarea" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} style={{ width: "100%" }} />;
}

function IssueBadge({ type }: { type: CoupangMappingIssue["issueType"] }) {
  const className = type === "AMBIGUOUS" ? "watch" : type === "EXCLUDED" ? "stop_candidate" : "keep";
  return <span className={`badge ${className}`}>{issueTypeLabel(type)}</span>;
}

function rulePayload(draft: RuleDraft) {
  return {
    coupangProductId: draft.coupangProductId,
    displayName: draft.displayName.trim() || undefined,
    includeKeywords: listValue(draft.includeKeywords),
    excludeKeywords: listValue(draft.excludeKeywords),
    priority: integerValue(draft.priority) ?? 100,
    validFrom: draft.validFrom,
    validTo: draft.validTo.trim() || null,
    adEnabled: draft.adEnabled,
    isActive: draft.isActive,
    note: draft.note.trim() || null
  };
}

function setDraftValue(key: keyof RuleDraft, value: string, setDraft: (updater: (draft: RuleDraft) => RuleDraft) => void) {
  setDraft((draft) => ({ ...draft, [key]: value }));
}

function listValue(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function listArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : listValue(inputText(value));
}

function listText(value: unknown) {
  return listArray(value).join("\n");
}

function inputText(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function dateInputText(value: unknown) {
  return inputText(value).slice(0, 10);
}

function integerValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function todayInput() {
  return new Date().toISOString().slice(0, 10);
}

function money(value: number | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number !== 0 ? `${Math.round(number).toLocaleString("ko-KR")}원` : "-";
}

function keywordBadges(values: string[], prefix: string) {
  return values.length > 0 ? (
    <span className="toolbar" style={{ flexWrap: "wrap" }}>
      {values.map((value) => (
        <span className="badge keep" key={`${prefix}:${value}`}>{prefix}: {value}</span>
      ))}
    </span>
  ) : "-";
}

function productLabel(productId: string, products: CoupangProductSetting[]) {
  return products.find((product) => product.id === productId)?.displayName ?? productId;
}

function issueTypeLabel(type: CoupangMappingIssue["issueType"]) {
  switch (type) {
    case "UNMATCHED":
      return "미매칭";
    case "AMBIGUOUS":
      return "충돌";
    case "EXCLUDED":
      return "제외";
  }
}

function sourceLabel(sourceType: CoupangMappingIssue["sourceType"], targetKind: CoupangMappingIssue["targetKind"]) {
  if (targetKind === "ADS_SPEND_PRODUCT") {
    return "광고 집행 상품";
  }
  if (targetKind === "ADS_CONVERSION_PRODUCT") {
    return "광고 전환 상품";
  }
  if (sourceType === "SALES") {
    return "판매";
  }
  return "프로모션";
}
