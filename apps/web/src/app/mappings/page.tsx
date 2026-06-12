"use client";

import { RefreshCw, Save, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";

export default function MappingsPage() {
  const range = useRange();
  const queryClient = useQueryClient();
  const unmatched = useQuery({
    queryKey: ["unmatched", range],
    queryFn: () => apiGet<Array<Record<string, any>>>(`/metrics/unmatched?${rangeQuery(range)}`)
  });
  const products = useQuery({ queryKey: ["products"], queryFn: () => apiGet<Array<Record<string, any>>>("/products") });
  const rules = useQuery({ queryKey: ["product-rules"], queryFn: () => apiGet<Array<Record<string, any>>>("/mappings/product-rules") });
  const cafe24Rules = useQuery({
    queryKey: ["cafe24-rules"],
    queryFn: () => apiGet<Array<Record<string, any>>>("/sales/cafe24/rules?includeInactive=true")
  });
  const createRule = useMutation({
    mutationFn: (body: unknown) => apiPost("/mappings/product-rules", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["product-rules"] })
  });
  const createCafe24Rule = useMutation({
    mutationFn: (body: unknown) => apiPost("/sales/cafe24/rules", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cafe24-rules"] })
  });
  const updateCafe24Rule = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => apiPatch(`/sales/cafe24/rules/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cafe24-rules"] })
  });
  const deleteCafe24Rule = useMutation({
    mutationFn: (id: string) => apiDelete(`/sales/cafe24/rules/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cafe24-rules"] })
  });
  const manualProduct = useMutation({ mutationFn: (body: unknown) => apiPost("/mappings/product/manual", body) });
  const manualStage = useMutation({ mutationFn: (body: unknown) => apiPost("/mappings/stage/manual", body) });
  const rematch = useMutation({
    mutationFn: () => apiPost<{ scannedCount: number; rematchedCount: number; stillUnmatchedCount: number }>("/mappings/rematch", range),
    onSuccess: () => queryClient.invalidateQueries()
  });

  const submitRule = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createRule.mutate({
      productId: form.get("productId"),
      matchType: form.get("matchType"),
      pattern: form.get("pattern"),
      priority: Number(form.get("priority") ?? 100),
      validFrom: form.get("validFrom")
    });
  };

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>매핑</h1>
          <p>미매칭 광고세트와 제품/SC-CBO-ASC 수동 이력, 자동 매칭 규칙을 관리합니다.</p>
        </div>
        <button className="button" type="button" onClick={() => rematch.mutate()} disabled={rematch.isPending}>
          <RefreshCw size={16} />
          {rematch.isPending ? "\uACC4\uC0B0 \uC911" : "\uC790\uB3D9\uB9E4\uD551\uACC4\uC0B0"}
        </button>
      </div>
      {rematch.data ? (
        <div className="warning-strip">
          <span>{"\uC790\uB3D9\uB9E4\uD551 \uBC18\uC601"} {rematch.data.rematchedCount}{"\uAC74"}</span>
          <span>{"\uD655\uC778 \uB300\uC0C1"} {rematch.data.scannedCount}{"\uAC74"}</span>
          <span>{"\uBBF8\uB9E4\uD551 \uC720\uC9C0"} {rematch.data.stillUnmatchedCount}{"\uAC74"}</span>
        </div>
      ) : null}
      {rematch.isError ? (
        <div className="warning-strip"><span>{"\uC790\uB3D9\uB9E4\uD551 \uACC4\uC0B0 \uC2E4\uD328"}: {String(rematch.error.message)}</span></div>
      ) : null}
      <div className="grid two">
        <form className="panel" onSubmit={submitRule}>
          <h2>제품 자동 매핑 규칙</h2>
          <div className="form-grid">
            <select className="select" name="productId" required>
              <option value="">제품 선택</option>
              {(products.data ?? []).map((product) => (
                <option key={product.id} value={product.id}>{product.displayName}</option>
              ))}
            </select>
            <select className="select" name="matchType" defaultValue="CONTAINS">
              <option value="CONTAINS">포함</option>
              <option value="EXACT">정확히 일치</option>
              <option value="REGEX">정규식</option>
            </select>
            <input className="input" name="pattern" placeholder="광고세트명 패턴" required />
            <input className="input" name="priority" type="number" defaultValue={100} />
            <input className="input" name="validFrom" type="date" required />
            <button className="button primary" type="submit"><Save size={16} />저장</button>
          </div>
        </form>
        <div className="panel">
          <h2>수동 매핑</h2>
          <ManualForm products={products.data ?? []} onProduct={(body) => manualProduct.mutate(body)} onStage={(body) => manualStage.mutate(body)} />
        </div>
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <h2>카페24 상품/옵션 매핑</h2>
        <Cafe24MappingRules
          error={cafe24Rules.error ?? createCafe24Rule.error ?? updateCafe24Rule.error ?? deleteCafe24Rule.error}
          isLoading={cafe24Rules.isLoading}
          isSaving={createCafe24Rule.isPending || updateCafe24Rule.isPending || deleteCafe24Rule.isPending}
          onCreate={(body) => createCafe24Rule.mutate(body)}
          onDelete={(id) => deleteCafe24Rule.mutate(id)}
          onUpdate={(id, body) => updateCafe24Rule.mutate({ id, body })}
          products={products.data ?? []}
          rules={cafe24Rules.data ?? []}
        />
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <h2>미매칭 광고세트</h2>
        <DataTable rows={unmatched.data ?? []} columns={[
          { key: "date", header: "일자", render: (row) => String(row.metricDate).slice(0, 10) },
          { key: "adset", header: "광고세트", render: (row) => row.adsetName },
          { key: "externalAdsetId", header: "Meta 광고세트 ID", render: (row) => row.metaAdset?.externalAdsetId ?? "-" },
          { key: "stage", header: "단계", render: (row) => row.stage },
          { key: "spend", header: "광고비 USD", render: (row) => row.spendUsd }
        ]} />
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <h2>매칭 규칙</h2>
        <DataTable rows={rules.data ?? []} columns={[
          { key: "product", header: "제품", render: (row) => row.product?.displayName },
          { key: "type", header: "유형", render: (row) => matchTypeLabel(row.matchType) },
          { key: "pattern", header: "패턴", render: (row) => row.pattern },
          { key: "priority", header: "우선순위", render: (row) => row.priority },
          { key: "active", header: "활성", render: (row) => String(row.isActive) }
        ]} />
      </div>
    </section>
  );
}

function ManualForm({ products, onProduct, onStage }: { products: Array<Record<string, any>>; onProduct: (body: unknown) => void; onStage: (body: unknown) => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      adsetName: form.get("adsetName"),
      externalAdsetId: form.get("externalAdsetId"),
      productId: form.get("productId"),
      stage: form.get("stage"),
      effectiveFrom: form.get("effectiveFrom"),
      applyCurrentMetrics: form.get("applyCurrentMetrics") === "on"
    };
    if (body.productId) onProduct(body);
    if (body.stage) onStage(body);
  };
  return (
    <form className="form-grid" onSubmit={submit}>
      <input className="input" name="adsetName" placeholder="광고세트 이름" required />
      <input className="input" name="externalAdsetId" placeholder="Meta 광고세트 ID(선택)" />
      <select className="select" name="productId">
        <option value="">제품 미지정</option>
        {products.map((product) => <option key={product.id} value={product.id}>{product.displayName}</option>)}
      </select>
      <select className="select" name="stage">
        <option value="">단계 미지정</option>
        <option>SC</option>
        <option>CBO</option>
        <option>ASC</option>
      </select>
      <input className="input" name="effectiveFrom" type="date" required />
      <label className="toolbar"><input name="applyCurrentMetrics" type="checkbox" /> 과거 current metric 일괄 재매칭</label>
      <button className="button primary" type="submit"><Save size={16} />수동 지정</button>
    </form>
  );
}

function Cafe24MappingRules({
  products,
  rules,
  isLoading,
  isSaving,
  error,
  onCreate,
  onUpdate,
  onDelete
}: {
  products: Array<Record<string, any>>;
  rules: Array<Record<string, any>>;
  isLoading: boolean;
  isSaving: boolean;
  error: Error | null;
  onCreate: (body: unknown) => void;
  onUpdate: (id: string, body: unknown) => void;
  onDelete: (id: string) => void;
}) {
  const groups = cafe24RuleGroups(rules, products);

  return (
    <div className="rule-editor">
      {error ? <div className="warning-strip"><span>카페24 매핑 규칙 오류: {error.message}</span></div> : null}
      <Cafe24RuleForm
        isSaving={isSaving}
        onSubmit={(body) => onCreate(body)}
        products={products}
        submitLabel="카페24 규칙 생성"
      />
      <div className="rule-form-title">
        <strong>제품별 저장된 카페24 규칙</strong>
        <span>{isLoading ? "규칙을 불러오는 중" : `비활성 포함 ${rules.length}개 규칙`}</span>
      </div>
      {groups.length === 0 && !isLoading ? <p className="muted">아직 카페24 상품/옵션 규칙이 없습니다.</p> : null}
      {groups.map((group) => (
        <div className="rule-editor" key={group.key}>
          <div className="rule-form-title">
            <strong>{group.label}</strong>
            <span>
              {group.rules.length}개 규칙. 포함 키워드는 해당 옵션 행을 이 제품으로 보내고, 제외 키워드는 이 규칙에서 빼냅니다.
            </span>
          </div>
          {group.rules.map((rule) => (
            <Cafe24SavedRule
              key={cafe24RuleFormKey(rule)}
              isSaving={isSaving}
              onDelete={() => onDelete(String(rule.id))}
              onSubmit={(body) => onUpdate(String(rule.id), body)}
              products={products}
              rule={rule}
              submitLabel="규칙 저장"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Cafe24SavedRule({
  products,
  rule,
  isSaving,
  submitLabel,
  onSubmit,
  onDelete
}: {
  products: Array<Record<string, any>>;
  rule: Record<string, any>;
  isSaving: boolean;
  submitLabel: string;
  onSubmit: (body: unknown) => void;
  onDelete: () => void;
}) {
  const includeKeywords = listArray(rule.optionIncludeKeywords);
  const excludeKeywords = listArray(rule.optionExcludeKeywords);
  const title = String(rule.displayName ?? productLabel(rule.product) ?? "카페24 규칙");
  const status = rule.isActive === false ? "비활성" : "활성";

  return (
    <details className="rule-editor" style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
      <summary style={{ cursor: "pointer", padding: "2px 0" }}>
        <span className="toolbar" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <strong>{title}</strong>
          <span className="toolbar">
            <span className={rule.isActive === false ? "badge stop_candidate" : "badge scale"}>{status}</span>
            <span className="muted">우선순위 {rule.priority ?? 100}</span>
          </span>
        </span>
        <Cafe24KeywordBadges excludeKeywords={excludeKeywords} includeKeywords={includeKeywords} />
      </summary>
      <Cafe24RuleForm
        isSaving={isSaving}
        onDelete={onDelete}
        onSubmit={onSubmit}
        products={products}
        rule={rule}
        showKeywordSummary={false}
        submitLabel={submitLabel}
      />
    </details>
  );
}

function Cafe24RuleForm({
  products,
  rule,
  isSaving,
  submitLabel,
  onSubmit,
  onDelete,
  showKeywordSummary = true
}: {
  products: Array<Record<string, any>>;
  rule?: Record<string, any>;
  isSaving: boolean;
  submitLabel: string;
  onSubmit: (body: unknown) => void;
  onDelete?: () => void;
  showKeywordSummary?: boolean;
}) {
  const includeKeywords = listArray(rule?.optionIncludeKeywords);
  const excludeKeywords = listArray(rule?.optionExcludeKeywords);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(cafe24RulePayload(new FormData(event.currentTarget)));
  };
  const deleteRule = () => {
    const label = String(rule?.displayName ?? "이 카페24 규칙");
    if (window.confirm(`${label} 규칙을 삭제 또는 비활성화할까요? 이미 주문 행에 사용된 규칙은 비활성화됩니다.`)) {
      onDelete?.();
    }
  };

  return (
    <form className="rule-form" onSubmit={submit} style={rule ? { marginTop: 12, paddingTop: 12 } : undefined}>
      <div className="rule-form-title">
        <strong>{rule ? String(rule.displayName ?? productLabel(rule.product) ?? "카페24 규칙") : "새 카페24 상품/옵션 규칙"}</strong>
        <span>
          {rule
            ? `우선순위 ${rule.priority ?? 100} / ${rule.isActive === false ? "비활성" : "활성"}`
            : "카페24 상품번호, 상품명, 옵션 키워드로 제품을 매핑합니다."}
        </span>
      </div>
      {rule && showKeywordSummary ? <Cafe24KeywordSummary excludeKeywords={excludeKeywords} includeKeywords={includeKeywords} /> : null}

      <div className="rule-form-title">
        <strong>상품 식별 조건</strong>
        <span>카페24 상품번호나 상품명 별칭으로 후보 주문 행을 찾습니다.</span>
      </div>
      <Field label="매핑 제품" help="이 카페24 규칙이 맞을 때 연결할 제품">
        <Cafe24ProductSelect
          defaultValue={inputText(rule?.productId)}
          fallbackLabel={productLabel(rule?.product)}
          products={products}
          required
        />
      </Field>
      <Field label="규칙 표시명" help="규칙 목록과 매칭 기록에 표시되는 이름">
        <input className="input" defaultValue={inputText(rule?.displayName)} name="displayName" placeholder="비우면 제품명 사용" />
      </Field>
      <Field label="카페24 상품번호" help="쉼표 또는 줄바꿈으로 구분">
        <TextareaInput defaultValue={listText(rule?.productNumbers)} name="productNumbers" placeholder="12345, 67890" />
      </Field>
      <Field label="상품명 별칭" help="쉼표 또는 줄바꿈으로 구분한 상품명 키워드">
        <TextareaInput defaultValue={listText(rule?.productNameAliases)} name="productNameAliases" placeholder="웨이브바, 슬라이드 매트" />
      </Field>

      <div className="rule-form-title">
        <strong>옵션 키워드 조건</strong>
        <span>포함 키워드는 모두 옵션명에 있어야 합니다. 제외 키워드는 하나라도 있으면 이 규칙에서 제외됩니다.</span>
      </div>
      <Field label="포함 키워드" help="모든 키워드가 포함된 주문 행만 이 매핑으로 연결">
        <TextareaInput defaultValue={listText(rule?.optionIncludeKeywords)} name="optionIncludeKeywords" placeholder="+, 블랙, 2개" />
      </Field>
      <Field label="제외 키워드" help="키워드가 하나라도 포함된 주문 행은 이 매핑에서 제외">
        <TextareaInput defaultValue={listText(rule?.optionExcludeKeywords)} name="optionExcludeKeywords" placeholder="+, 샘플, 리필" />
      </Field>

      <div className="rule-form-title">
        <strong>보고서 및 비용 우선 적용값</strong>
        <span>입력한 값은 카페24 실제 성과 계산에서 제품 기본값보다 먼저 적용됩니다.</span>
      </div>
      <Field label="ROAS 그룹" help="선택 입력용 보고 그룹">
        <input className="input" defaultValue={inputText(rule?.roasGroup)} name="roasGroup" placeholder="그룹명" />
      </Field>
      <Field label="광고비 기준 제품" help="이 규칙의 광고비를 귀속할 제품을 선택 입력">
        <Cafe24ProductSelect
          defaultValue={inputText(rule?.adCostSourceProductId)}
          fallbackLabel={productLabel(rule?.adCostSourceProduct)}
          name="adCostSourceProductId"
          products={products}
        />
      </Field>
      <Field label="판매가 우선 적용값" help="선택 입력용 원화 판매가">
        <AmountInput defaultValue={inputText(rule?.salePriceKrwOverride)} name="salePriceKrwOverride" />
      </Field>
      <Field label="상품 원가 우선 적용값" help="선택 입력용 원화 상품 원가">
        <AmountInput defaultValue={inputText(rule?.productCostKrwOverride)} name="productCostKrwOverride" />
      </Field>
      <Field label="배송비 우선 적용값" help="선택 입력용 원화 배송비">
        <AmountInput defaultValue={inputText(rule?.shippingKrwOverride)} name="shippingKrwOverride" />
      </Field>
      <Field label="기타 비용 우선 적용값" help="선택 입력용 원화 기타 비용">
        <AmountInput defaultValue={inputText(rule?.extraCostKrwOverride)} name="extraCostKrwOverride" />
      </Field>

      <div className="rule-form-title">
        <strong>적용 상태</strong>
        <span>우선순위 숫자가 낮을수록 먼저 매칭됩니다. 비활성 규칙은 목록에는 보이지만 매칭에는 사용되지 않습니다.</span>
      </div>
      <Field label="우선순위" help="낮은 숫자가 먼저 매칭됨">
        <input className="input" defaultValue={inputText(rule?.priority ?? 100)} inputMode="numeric" name="priority" type="number" />
      </Field>
      <Field label="적용 시작일" help="이 규칙이 매칭될 첫 주문일">
        <input className="input" defaultValue={dateInputText(rule?.validFrom)} name="validFrom" required type="date" />
      </Field>
      <Field label="적용 종료일" help="종료일이 없으면 비워 둡니다">
        <input className="input" defaultValue={dateInputText(rule?.validTo)} name="validTo" type="date" />
      </Field>
      <Field label="활성 여부" help="비활성 규칙은 목록에만 보이고 매칭에는 사용되지 않음">
        <span className="toolbar">
          <input defaultChecked={rule?.isActive !== false} name="isActive" type="checkbox" />
          활성
        </span>
      </Field>
      <Field label="메모" help="선택 입력용 내부 메모">
        <TextareaInput defaultValue={inputText(rule?.note)} name="note" placeholder="규칙 메모" />
      </Field>
      <div className="toolbar" style={{ alignSelf: "end" }}>
        <button className="button primary" disabled={isSaving} type="submit"><Save size={16} />{submitLabel}</button>
        {onDelete ? (
          <button className="button danger" disabled={isSaving} onClick={deleteRule} type="button">
            <Trash2 size={16} />삭제 / 비활성화
          </button>
        ) : null}
      </div>
    </form>
  );
}

function Cafe24KeywordSummary({ includeKeywords, excludeKeywords }: { includeKeywords: string[]; excludeKeywords: string[] }) {
  return (
    <div className="rule-form-title">
      <span>옵션 키워드 매핑 미리보기</span>
      <Cafe24KeywordBadges excludeKeywords={excludeKeywords} includeKeywords={includeKeywords} />
    </div>
  );
}

function Cafe24KeywordBadges({ includeKeywords, excludeKeywords }: { includeKeywords: string[]; excludeKeywords: string[] }) {
  return (
    <span className="toolbar" style={{ flexWrap: "wrap" }}>
      {includeKeywords.length > 0 ? (
        includeKeywords.map((keyword) => (
          <span className="badge scale" key={`include:${keyword}`} title="포함 키워드는 모두 있어야 합니다">
            포함: {keyword}
          </span>
        ))
      ) : (
        <span className="badge keep">포함: 모든 옵션</span>
      )}
      {excludeKeywords.length > 0 ? (
        excludeKeywords.map((keyword) => (
          <span className="badge stop_candidate" key={`exclude:${keyword}`} title="제외 키워드는 하나라도 있으면 제외됩니다">
            발견 시 제외: {keyword}
          </span>
        ))
      ) : (
        <span className="badge keep">제외: 없음</span>
      )}
    </span>
  );
}

function Cafe24ProductSelect({
  products,
  defaultValue,
  fallbackLabel,
  name = "productId",
  required = false
}: {
  products: Array<Record<string, any>>;
  defaultValue?: string;
  fallbackLabel?: string;
  name?: string;
  required?: boolean;
}) {
  const needsFallback = Boolean(defaultValue) && !products.some((product) => String(product.id) === defaultValue);
  return (
    <select className="select" defaultValue={defaultValue} key={`${defaultValue ?? ""}:${needsFallback}`} name={name} required={required}>
      <option value="">{required ? "제품 선택" : "매칭된 제품 사용"}</option>
      {needsFallback ? <option value={defaultValue}>{fallbackLabel || "현재 제품"}</option> : null}
      {products.map((product) => (
        <option key={String(product.id)} value={String(product.id)}>{productLabel(product)}</option>
      ))}
    </select>
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

function AmountInput({ name, defaultValue }: { name: string; defaultValue?: string }) {
  return (
    <div className="input-with-unit">
      <input
        className="input"
        defaultValue={defaultValue}
        inputMode="decimal"
        min="0"
        name={name}
        step="1"
        type="number"
      />
      <span>KRW</span>
    </div>
  );
}

function TextareaInput({ name, defaultValue, placeholder }: { name: string; defaultValue?: string; placeholder?: string }) {
  return <textarea className="textarea" defaultValue={defaultValue} name={name} placeholder={placeholder} style={{ width: "100%" }} />;
}

function cafe24RuleGroups(rules: Array<Record<string, any>>, products: Array<Record<string, any>>) {
  const productById = new Map(products.map((product) => [String(product.id), product]));
  const groups = new Map<string, { key: string; label: string; rules: Array<Record<string, any>> }>();

  for (const rule of rules) {
    const productId = String(rule.productId ?? rule.product?.id ?? "");
    const product = rule.product ?? productById.get(productId);
    const key = productId || "unknown";
    const label = productLabel(product) || (productId ? `제품 ${productId}` : "제품 미지정");
    const group = groups.get(key) ?? { key, label, rules: [] };
    group.rules.push(rule);
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      rules: group.rules.sort((left, right) => Number(left.priority ?? 100) - Number(right.priority ?? 100))
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function cafe24RuleFormKey(rule: Record<string, any>) {
  return [
    rule.id,
    rule.updatedAt,
    rule.isActive,
    rule.productId,
    rule.adCostSourceProductId
  ].map((value) => String(value ?? "")).join(":");
}

function cafe24RulePayload(form: FormData) {
  return {
    productId: textValue(form.get("productId")),
    displayName: textValue(form.get("displayName")),
    productNumbers: listValue(form.get("productNumbers")),
    productNameAliases: listValue(form.get("productNameAliases")),
    optionIncludeKeywords: listValue(form.get("optionIncludeKeywords")),
    optionExcludeKeywords: listValue(form.get("optionExcludeKeywords")),
    roasGroup: nullableTextValue(form.get("roasGroup")),
    adCostSourceProductId: nullableTextValue(form.get("adCostSourceProductId")),
    salePriceKrwOverride: nullableNumberValue(form.get("salePriceKrwOverride")),
    productCostKrwOverride: nullableNumberValue(form.get("productCostKrwOverride")),
    shippingKrwOverride: nullableNumberValue(form.get("shippingKrwOverride")),
    extraCostKrwOverride: nullableNumberValue(form.get("extraCostKrwOverride")),
    priority: integerValue(form.get("priority")) ?? 100,
    isActive: form.get("isActive") === "on",
    validFrom: textValue(form.get("validFrom")),
    validTo: nullableTextValue(form.get("validTo")),
    note: nullableTextValue(form.get("note"))
  };
}

function listValue(value: FormDataEntryValue | null) {
  return Array.from(
    new Set(
      String(value ?? "")
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function listArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : listValue(inputText(value));
}

function textValue(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function nullableTextValue(value: FormDataEntryValue | null) {
  return textValue(value) ?? null;
}

function nullableNumberValue(value: FormDataEntryValue | null) {
  const text = textValue(value);
  if (text === undefined) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerValue(value: FormDataEntryValue | null) {
  const text = textValue(value);
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function inputText(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function dateInputText(value: unknown) {
  return inputText(value).slice(0, 10);
}

function listText(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).join("\n") : inputText(value);
}

function matchTypeLabel(value: unknown) {
  switch (String(value ?? "")) {
    case "CONTAINS":
      return "포함";
    case "EXACT":
      return "정확히 일치";
    case "REGEX":
      return "정규식";
    default:
      return inputText(value) || "-";
  }
}

function productLabel(product: Record<string, any> | null | undefined) {
  return inputText(product?.displayName ?? product?.name ?? product?.code);
}
