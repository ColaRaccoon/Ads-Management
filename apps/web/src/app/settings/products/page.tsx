"use client";

import { Ban, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { money } from "@/lib/date-range";
import { koreaYesterdayDateInput } from "@/lib/korea-date";
import {
  type Cafe24CouponRule,
  type Cafe24CouponScope,
  CAFE24_COUPON_DEPENDENT_QUERY_KEYS,
  CAFE24_COUPON_PRODUCTS_QUERY_KEY,
  CAFE24_COUPON_PRODUCTS_QUERY_PATH,
  couponScopeLabel,
  dateInputText
} from "@/lib/cafe24-coupon";

type ProductRow = {
  id: string;
  code: string;
  name: string;
  displayName?: string | null;
  sku?: string | null;
  isActive?: boolean;
  costRules?: Array<{ salePriceKrw?: number | string | null }>;
  cpaRules?: Array<{ targetRatio?: number | string | null }>;
};

type CouponRuleDraft = {
  name: string;
  scope: Cafe24CouponScope;
  productId: string;
  discountKrw: string;
  priority: string;
  validFrom: string;
  validTo: string;
  note: string;
  isActive: boolean;
};

type CouponRulePayload = {
  name: string;
  scope: Cafe24CouponScope;
  productId: string | null;
  discountKrw: number;
  priority: number;
  validFrom: string;
  validTo: string | null;
  note: string | null;
  isActive: boolean;
};

export default function ProductSettingsPage() {
  const queryClient = useQueryClient();
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => apiGet<ProductRow[]>("/products")
  });
  const couponProducts = useQuery({
    queryKey: [...CAFE24_COUPON_PRODUCTS_QUERY_KEY],
    queryFn: () => apiGet<ProductRow[]>(CAFE24_COUPON_PRODUCTS_QUERY_PATH)
  });
  const couponRules = useQuery({
    queryKey: ["cafe24-coupon-rules"],
    queryFn: () => apiGet<Cafe24CouponRule[]>("/sales/cafe24/coupon-rules?includeInactive=true")
  });
  const invalidateCouponQueries = () =>
    Promise.all(
      CAFE24_COUPON_DEPENDENT_QUERY_KEYS.map((queryKey) =>
        queryClient.invalidateQueries({ queryKey: [...queryKey] })
      )
    );
  const createProduct = useMutation({
    mutationFn: (body: unknown) => apiPost("/products", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["products"] })
  });
  const deleteProduct = useMutation({
    mutationFn: (id: string) => apiDelete(`/products/${id}`),
    onSuccess: () => invalidateCouponQueries(),
    onError: (error) => window.alert(error instanceof Error ? error.message : "제품 삭제에 실패했습니다.")
  });
  const createCostRule = useMutation({ mutationFn: (body: unknown) => apiPost("/product-cost-rules", body), onSuccess: () => queryClient.invalidateQueries() });
  const createCpaRule = useMutation({ mutationFn: (body: unknown) => apiPost("/product-cpa-rules", body), onSuccess: () => queryClient.invalidateQueries() });
  const createCouponRule = useMutation({
    mutationFn: (body: CouponRulePayload) => apiPost<Cafe24CouponRule>("/sales/cafe24/coupon-rules", body),
    onSuccess: () => invalidateCouponQueries()
  });
  const updateCouponRule = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CouponRulePayload> }) =>
      apiPatch<Cafe24CouponRule>(`/sales/cafe24/coupon-rules/${id}`, body),
    onSuccess: () => invalidateCouponQueries()
  });

  const onProduct = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createProduct.mutate({ code: form.get("code"), name: form.get("name"), displayName: form.get("displayName") });
  };
  const onDeleteProduct = (product: ProductRow) => {
    const label = product.displayName ?? product.name ?? product.code;
    if (window.confirm(`${label} 제품을 삭제할까요?`)) {
      deleteProduct.mutate(String(product.id));
    }
  };

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Product Settings</h1>
          <p>제품 master, 원가 rule, CPA target/watch/stop 비율을 effective period로 관리합니다.</p>
        </div>
      </div>
      <div className="grid two">
        <form className="panel" onSubmit={onProduct}>
          <h2>제품 생성</h2>
          <div className="form-grid">
            <input className="input" name="code" placeholder="code" required />
            <input className="input" name="name" placeholder="name" required />
            <input className="input" name="displayName" placeholder="display name" required />
            <button className="button primary" type="submit"><Plus size={16} />제품 추가</button>
          </div>
        </form>
        <div className="panel">
          <h2>Product Rule Editor</h2>
          <RuleForms products={products.data ?? []} onCost={(body) => createCostRule.mutate(body)} onCpa={(body) => createCpaRule.mutate(body)} />
        </div>
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <h2>제품 목록</h2>
        <DataTable rows={products.data ?? []} columns={[
          { key: "code", header: "Code", render: (row) => row.code },
          { key: "name", header: "Name", render: (row) => row.displayName },
          { key: "sku", header: "SKU", render: (row) => row.sku ?? "-" },
          { key: "active", header: "Active", render: (row) => String(row.isActive) },
          { key: "cost", header: "최근 판매가", render: (row) => money(Number(row.costRules?.[0]?.salePriceKrw ?? 0)) },
          { key: "cpa", header: "Target Ratio", render: (row) => row.cpaRules?.[0]?.targetRatio ?? "-" },
          {
            key: "actions",
            header: "",
            render: (row) => (
              <button
                aria-label={`${row.displayName ?? row.name ?? row.code} 삭제`}
                className="icon-button danger"
                disabled={deleteProduct.isPending}
                onClick={() => onDeleteProduct(row)}
                title="제품 삭제"
                type="button"
              >
                <Trash2 size={15} />
              </button>
            )
          }
        ]} />
      </div>
      <CouponSettingsPanel
        error={(couponRules.error ?? couponProducts.error ?? createCouponRule.error ?? updateCouponRule.error) as Error | null}
        isLoading={couponRules.isLoading || couponProducts.isLoading}
        isSaving={createCouponRule.isPending || updateCouponRule.isPending}
        onCreate={(body, onSuccess) => createCouponRule.mutate(body, { onSuccess })}
        onUpdate={(id, body, onSuccess) => updateCouponRule.mutate({ id, body }, { onSuccess })}
        products={couponProducts.data ?? []}
        rules={couponRules.data ?? []}
      />
    </section>
  );
}

function CouponSettingsPanel({
  products,
  rules,
  isLoading,
  isSaving,
  error,
  onCreate,
  onUpdate
}: {
  products: ProductRow[];
  rules: Cafe24CouponRule[];
  isLoading: boolean;
  isSaving: boolean;
  error: Error | null;
  onCreate: (body: CouponRulePayload, onSuccess: () => void) => void;
  onUpdate: (id: string, body: Partial<CouponRulePayload>, onSuccess?: () => void) => void;
}) {
  const [editingRule, setEditingRule] = useState<Cafe24CouponRule | null>(null);
  const [draft, setDraft] = useState<CouponRuleDraft>(() => newCouponRuleDraft());

  const startEditing = (rule: Cafe24CouponRule) => {
    setEditingRule(rule);
    setDraft(couponRuleDraft(rule));
  };
  const stopEditing = () => {
    setEditingRule(null);
    setDraft(newCouponRuleDraft());
  };
  const submit = (payload: CouponRulePayload) => {
    if (!editingRule) {
      onCreate(payload, () => setDraft(newCouponRuleDraft()));
      return;
    }
    if (
      Number(editingRule.discountKrw) !== payload.discountKrw &&
      !window.confirm(
        "기존 규칙을 수정하면 과거 기간의 마진도 다시 계산될 수 있습니다.\n금액 변경 이력을 유지하려면 기존 규칙의 종료일을 설정하고 새 규칙을 추가하세요.\n\n그래도 금액을 수정할까요?"
      )
    ) {
      return;
    }
    onUpdate(editingRule.id, payload, stopEditing);
  };
  const deactivate = (rule: Cafe24CouponRule) => {
    if (window.confirm(`${rule.name} 규칙을 비활성화할까요? 과거 계산을 위해 규칙 이력은 보존됩니다.`)) {
      onUpdate(rule.id, { isActive: false }, editingRule?.id === rule.id ? stopEditing : undefined);
    }
  };

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h2>Cafe24 쿠폰 설정</h2>
      <div className="warning-strip">
        <span>쿠폰은 주문당 하나만 적용됩니다.</span>
        <span>같은 상품에 여러 쿠폰을 등록할 수 있으며, 결제 차이에 가장 맞는 활성 쿠폰 하나만 선택합니다.</span>
        <span>금액이 바뀌면 기존 규칙의 종료일을 지정하고 새 규칙을 추가하세요.</span>
      </div>
      {error ? <div className="warning-strip"><span>쿠폰 규칙 오류: {error.message}</span></div> : null}
      <div className="rule-editor">
        <CouponRuleForm
          draft={draft}
          isEditing={Boolean(editingRule)}
          isSaving={isSaving}
          onCancel={editingRule ? stopEditing : undefined}
          onChange={setDraft}
          onSubmit={submit}
          products={products}
        />
        <div className="rule-form-title">
          <strong>저장된 쿠폰 규칙</strong>
          <span>{isLoading ? "규칙을 불러오는 중입니다." : `비활성 포함 ${rules.length}개 규칙`}</span>
        </div>
        <DataTable<Cafe24CouponRule>
          rows={rules}
          empty={isLoading ? "규칙을 불러오는 중입니다." : "등록된 쿠폰 규칙이 없습니다."}
          getRowKey={(rule) => rule.id}
          columns={[
            {
              key: "active",
              header: "활성 상태",
              render: (rule) => (
                <span className={rule.isActive ? "badge scale" : "badge stop_candidate"}>
                  {rule.isActive ? "활성" : "비활성"}
                </span>
              )
            },
            { key: "scope", header: "범위", render: (rule) => couponScopeLabel(rule.scope) },
            { key: "product", header: "상품", render: (rule) => couponRuleProductLabel(rule) },
            { key: "name", header: "쿠폰명", render: (rule) => rule.name },
            { key: "amount", header: "금액", render: (rule) => money(Number(rule.discountKrw)) },
            {
              key: "period",
              header: "적용 기간",
              render: (rule) => `${dateInputText(rule.validFrom)} ~ ${dateInputText(rule.validTo) || "계속"}`
            },
            { key: "priority", header: "우선순위", render: (rule) => rule.priority },
            { key: "note", header: "메모", render: (rule) => rule.note || "-" },
            {
              key: "edit",
              header: "편집",
              render: (rule) => (
                <button
                  aria-label={`${rule.name} 편집`}
                  className="icon-button"
                  disabled={isSaving}
                  onClick={() => startEditing(rule)}
                  title="쿠폰 규칙 편집"
                  type="button"
                >
                  <Pencil size={15} />
                </button>
              )
            },
            {
              key: "deactivate",
              header: "비활성화",
              render: (rule) =>
                rule.isActive ? (
                  <button
                    aria-label={`${rule.name} 비활성화`}
                    className="icon-button danger"
                    disabled={isSaving}
                    onClick={() => deactivate(rule)}
                    title="쿠폰 규칙 비활성화"
                    type="button"
                  >
                    <Ban size={15} />
                  </button>
                ) : (
                  "-"
                )
            }
          ]}
        />
      </div>
    </div>
  );
}

function CouponRuleForm({
  products,
  draft,
  isEditing,
  isSaving,
  onChange,
  onSubmit,
  onCancel
}: {
  products: ProductRow[];
  draft: CouponRuleDraft;
  isEditing: boolean;
  isSaving: boolean;
  onChange: (draft: CouponRuleDraft) => void;
  onSubmit: (body: CouponRulePayload) => void;
  onCancel?: () => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.name.trim()) {
      window.alert("쿠폰명을 입력해주세요.");
      return;
    }
    if (draft.scope === "PRODUCT" && !draft.productId) {
      window.alert("상품별 쿠폰은 상품 선택이 필요합니다.");
      return;
    }
    if (draft.validTo && draft.validTo < draft.validFrom) {
      window.alert("적용 종료일은 시작일보다 빠를 수 없습니다.");
      return;
    }
    const discountKrw = Number(draft.discountKrw);
    const priority = Number(draft.priority);
    if (!Number.isInteger(discountKrw) || discountKrw < 1) {
      window.alert("쿠폰 금액은 1원 이상의 정수로 입력해주세요.");
      return;
    }
    if (!Number.isInteger(priority)) {
      window.alert("우선순위는 정수로 입력해주세요.");
      return;
    }
    onSubmit({
      name: draft.name.trim(),
      scope: draft.scope,
      productId: draft.scope === "PRODUCT" ? draft.productId : null,
      discountKrw,
      priority,
      validFrom: draft.validFrom,
      validTo: draft.validTo || null,
      note: draft.note.trim() || null,
      isActive: draft.isActive
    });
  };
  const change = <K extends keyof CouponRuleDraft>(key: K, value: CouponRuleDraft[K]) =>
    onChange({ ...draft, [key]: value });

  return (
    <form className="rule-form" onSubmit={submit}>
      <div className="rule-form-title">
        <strong>{isEditing ? "쿠폰 규칙 수정" : "새 쿠폰 규칙"}</strong>
        <span>기간이 겹치는 쿠폰도 등록할 수 있으며, 금액과 우선순위에 따라 주문당 하나만 선택됩니다.</span>
      </div>
      <Field label="쿠폰명" help="설정 목록과 점검 표에 표시할 이름">
        <input className="input" onChange={(event) => change("name", event.target.value)} required value={draft.name} />
      </Field>
      <Field label="범위" help="상품별 쿠폰 또는 모든 상품에 적용할 쿠폰">
        <select
          className="select"
          onChange={(event) => {
            const scope = event.target.value as Cafe24CouponScope;
            onChange({ ...draft, scope, productId: scope === "GLOBAL" ? "" : draft.productId });
          }}
          value={draft.scope}
        >
          <option value="PRODUCT">상품별</option>
          <option value="GLOBAL">전체 상품</option>
        </select>
      </Field>
      <Field label="상품 선택" help={draft.scope === "PRODUCT" ? "상품별 쿠폰은 필수" : "전체 상품 쿠폰은 상품을 지정하지 않음"}>
        <select
          className="select"
          disabled={draft.scope === "GLOBAL"}
          onChange={(event) => change("productId", event.target.value)}
          required={draft.scope === "PRODUCT"}
          value={draft.scope === "GLOBAL" ? "" : draft.productId}
        >
          <option value="">제품 선택</option>
          {products.map((product) => (
            <option disabled={product.isActive === false} key={product.id} value={product.id}>
              {product.displayName ?? product.name ?? product.code}{product.isActive === false ? " (비활성)" : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="쿠폰 금액" help="1원 이상의 원 단위 정수">
        <div className="input-with-unit">
          <input
            className="input"
            inputMode="numeric"
            min="1"
            onChange={(event) => change("discountKrw", event.target.value)}
            required
            step="1"
            type="number"
            value={draft.discountKrw}
          />
          <span>KRW</span>
        </div>
      </Field>
      <Field label="우선순위" help="같은 금액이면 숫자가 낮은 규칙을 우선">
        <input
          className="input"
          inputMode="numeric"
          onChange={(event) => change("priority", event.target.value)}
          required
          step="1"
          type="number"
          value={draft.priority}
        />
      </Field>
      <Field label="적용 시작일" help="이 날짜 주문부터 후보로 사용">
        <input
          className="input"
          onChange={(event) => change("validFrom", event.target.value)}
          required
          type="date"
          value={draft.validFrom}
        />
      </Field>
      <Field label="적용 종료일" help="종료일이 없으면 비워 둡니다">
        <input
          className="input"
          min={draft.validFrom}
          onChange={(event) => change("validTo", event.target.value)}
          type="date"
          value={draft.validTo}
        />
      </Field>
      <Field label="활성 여부" help="비활성 규칙은 과거 이력만 보존">
        <span className="toolbar">
          <input
            checked={draft.isActive}
            onChange={(event) => change("isActive", event.target.checked)}
            type="checkbox"
          />
          활성
        </span>
      </Field>
      <Field label="메모" help="선택 입력용 내부 메모">
        <textarea
          className="textarea"
          onChange={(event) => change("note", event.target.value)}
          placeholder="예: 자사몰 상품 쿠폰"
          value={draft.note}
        />
      </Field>
      <div className="toolbar" style={{ alignSelf: "end" }}>
        <button className="button primary" disabled={isSaving} type="submit">
          <Save size={16} />{isEditing ? "변경 저장" : "쿠폰 추가"}
        </button>
        {onCancel ? (
          <button className="button" disabled={isSaving} onClick={onCancel} type="button">
            <X size={16} />취소
          </button>
        ) : null}
      </div>
    </form>
  );
}

function newCouponRuleDraft(): CouponRuleDraft {
  return {
    name: "",
    scope: "PRODUCT",
    productId: "",
    discountKrw: "",
    priority: "100",
    validFrom: koreaYesterdayDateInput(),
    validTo: "",
    note: "",
    isActive: true
  };
}

function couponRuleDraft(rule: Cafe24CouponRule): CouponRuleDraft {
  return {
    name: rule.name,
    scope: rule.scope,
    productId: rule.productId ?? "",
    discountKrw: String(rule.discountKrw),
    priority: String(rule.priority),
    validFrom: dateInputText(rule.validFrom),
    validTo: dateInputText(rule.validTo),
    note: rule.note ?? "",
    isActive: rule.isActive
  };
}

function couponRuleProductLabel(rule: Cafe24CouponRule) {
  if (rule.scope === "GLOBAL") {
    return "전체 상품";
  }
  return rule.product?.displayName ?? rule.product?.name ?? rule.product?.code ?? rule.productId ?? "-";
}

function RuleForms({ products, onCost, onCpa }: { products: ProductRow[]; onCost: (body: unknown) => void; onCpa: (body: unknown) => void }) {
  const submitCost = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onCost(Object.fromEntries(form.entries()));
  };
  const submitCpa = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onCpa(Object.fromEntries(form.entries()));
  };
  return (
    <div className="rule-editor">
      <form className="rule-form" onSubmit={submitCost}>
        <div className="rule-form-title">
          <strong>원가 Rule</strong>
          <span>마진과 손익분기 CPA 계산에 사용</span>
        </div>
        <Field label="제품" help="원가 기준을 적용할 제품">
          <ProductSelect products={products} />
        </Field>
        <Field label="판매가" help="구매 1건당 매출로 잡을 실제 판매가">
          <AmountInput name="salePriceKrw" placeholder="예: 50000" required />
        </Field>
        <Field label="상품 원가" help="구매 1건당 제품 매입/제조 원가">
          <AmountInput name="productCostKrw" defaultValue="0" />
        </Field>
        <Field label="배송비" help="구매 1건당 배송/포장 비용">
          <AmountInput name="shippingKrw" defaultValue="0" />
        </Field>
        <Field label="기타 비용" help="수수료, 포장재 등 추가 차감 비용">
          <AmountInput name="extraCostKrw" defaultValue="0" />
        </Field>
        <Field label="적용 시작일" help="이 날짜부터 업로드 데이터 계산에 적용">
          <input className="input" defaultValue={koreaYesterdayDateInput()} name="effectiveFrom" type="date" required />
        </Field>
        <p className="rule-note">부가세는 판매가의 10%로 자동 차감됩니다. 환율은 업로드 날짜 기준 USD/KRW 값으로 자동 적용됩니다.</p>
        <button className="button primary" type="submit"><Save size={16} />원가 Rule 저장</button>
      </form>
      <form className="rule-form" onSubmit={submitCpa}>
        <div className="rule-form-title">
          <strong>CPA Rule</strong>
          <span>손익분기 CPA에 곱해 판단 기준 생성</span>
        </div>
        <Field label="제품" help="CPA 기준을 적용할 제품">
          <ProductSelect products={products} />
        </Field>
        <Field label="Target 비율" help="목표 CPA. 0.8이면 손익분기 CPA의 80%">
          <RatioInput name="targetRatio" defaultValue="0.8" step="0.0001" />
        </Field>
        <Field label="Watch 비율" help="주의 CPA. 1.1이면 손익분기 CPA의 110%">
          <RatioInput name="watchRatio" defaultValue="1.1" step="0.0001" />
        </Field>
        <Field label="Stop 비율" help="중단 후보 CPA. 1.25이면 손익분기 CPA의 125%">
          <RatioInput name="stopRatio" defaultValue="1.25" step="0.0001" />
        </Field>
        <Field label="적용 시작일" help="이 날짜부터 의사결정 기준에 적용">
          <input className="input" defaultValue={koreaYesterdayDateInput()} name="effectiveFrom" type="date" required />
        </Field>
        <button className="button primary" type="submit"><Save size={16} />CPA Rule 저장</button>
      </form>
    </div>
  );
}

function ProductSelect({ products }: { products: ProductRow[] }) {
  return (
    <select className="select" name="productId" required>
      <option value="">제품 선택</option>
      {products.map((product) => <option key={product.id} value={product.id}>{product.displayName}</option>)}
    </select>
  );
}

function Field({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      <span className="field-help">{help}</span>
    </label>
  );
}

function AmountInput({ name, placeholder, defaultValue, required }: { name: string; placeholder?: string; defaultValue?: string; required?: boolean }) {
  return (
    <div className="input-with-unit">
      <input
        className="input"
        defaultValue={defaultValue}
        inputMode="decimal"
        min="0"
        name={name}
        placeholder={placeholder}
        required={required}
        step="1"
        type="number"
      />
      <span>KRW</span>
    </div>
  );
}

function RatioInput({ name, defaultValue, step }: { name: string; defaultValue: string; step: string }) {
  return (
    <input
      className="input"
      defaultValue={defaultValue}
      inputMode="decimal"
      min="0"
      name={name}
      step={step}
      type="number"
    />
  );
}
