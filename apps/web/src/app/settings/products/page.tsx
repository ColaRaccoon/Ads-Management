"use client";

import { Ban, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { money } from "@/lib/date-range";
import { koreaTodayDateInput, koreaYesterdayDateInput } from "@/lib/korea-date";
import {
  currentMetaProductCostRuleMap,
  currentMetaProductRuleMap,
  META_PRODUCT_RULE_DEPENDENT_QUERY_KEYS,
  metaProductCostCorrectionPath,
  metaProductCostRulePayload,
  metaProductCostSnapshotPath,
  metaProductCpaCorrectionPath,
  metaProductCpaRulePayload,
  metaProductCpaSnapshotPath,
  metaProductRuleHistory,
  previewMetaProductRuleHistory,
  type MetaProductCostRule,
  type MetaProductEffectiveRule,
  type MetaProductRuleHistoryPreview
} from "@/lib/meta-product-cost";
import {
  type Cafe24CouponRule,
  type Cafe24CouponScope,
  CAFE24_COUPON_DEPENDENT_QUERY_KEYS,
  CAFE24_COUPON_PRODUCTS_QUERY_KEY,
  CAFE24_COUPON_PRODUCTS_QUERY_PATH,
  couponScopeLabel,
  dateInputText
} from "@/lib/cafe24-coupon";
import { useCan } from "@/features/auth/use-auth";

type ProductRow = {
  id: string;
  code: string;
  name: string;
  displayName?: string | null;
  sku?: string | null;
  isActive?: boolean;
  costRules?: Array<{ salePriceKrw?: number | string | null }>;
};

type MetaProductCpaRule = MetaProductEffectiveRule & {
  targetRatio: number | string;
  watchRatio: number | string;
  stopRatio: number | string;
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
  const canManageProducts = useCan("products.manage");
  const queryClient = useQueryClient();
  const ruleEditorRef = useRef<HTMLDivElement>(null);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [correctingCostRuleId, setCorrectingCostRuleId] = useState<string | null>(null);
  const [correctingCpaRuleId, setCorrectingCpaRuleId] = useState<string | null>(null);
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => apiGet<ProductRow[]>("/products")
  });
  const costRules = useQuery({
    queryKey: ["product-cost-rules"],
    queryFn: () => apiGet<MetaProductCostRule[]>("/product-cost-rules")
  });
  const cpaRules = useQuery({
    queryKey: ["product-cpa-rules"],
    queryFn: () => apiGet<MetaProductCpaRule[]>("/product-cpa-rules")
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
  const invalidateProductRuleQueries = () => Promise.all(
    META_PRODUCT_RULE_DEPENDENT_QUERY_KEYS.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey: [...queryKey] })
    )
  );
  const saveCostRule = useMutation({
    mutationFn: ({ productId, ruleId, body }: { productId: string; ruleId?: string; body: unknown }) =>
      ruleId
        ? apiPatch(metaProductCostCorrectionPath(productId, ruleId), body)
        : apiPost(metaProductCostSnapshotPath(productId), body),
    onSuccess: async () => {
      setCorrectingCostRuleId(null);
      await invalidateProductRuleQueries();
    }
  });
  const saveCpaRule = useMutation({
    mutationFn: ({ productId, ruleId, body }: { productId: string; ruleId?: string; body: unknown }) =>
      ruleId
        ? apiPatch(metaProductCpaCorrectionPath(productId, ruleId), body)
        : apiPost(metaProductCpaSnapshotPath(productId), body),
    onSuccess: async () => {
      setCorrectingCpaRuleId(null);
      await invalidateProductRuleQueries();
    }
  });
  const createCouponRule = useMutation({
    mutationFn: (body: CouponRulePayload) => apiPost<Cafe24CouponRule>("/sales/cafe24/coupon-rules", body),
    onSuccess: () => invalidateCouponQueries()
  });
  const updateCouponRule = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CouponRulePayload> }) =>
      apiPatch<Cafe24CouponRule>(`/sales/cafe24/coupon-rules/${id}`, body),
    onSuccess: () => invalidateCouponQueries()
  });
  const today = koreaTodayDateInput();
  const currentCostRules = useMemo(
    () => currentMetaProductCostRuleMap(costRules.data ?? [], today),
    [costRules.data, today]
  );
  const currentCpaRules = useMemo(
    () => currentMetaProductRuleMap(cpaRules.data ?? [], today),
    [cpaRules.data, today]
  );
  const configuredProductCount = (products.data ?? []).filter((product) => currentCostRules.has(product.id)).length;
  const selectedProduct = (products.data ?? []).find((product) => product.id === selectedProductId);
  const selectedCostRule = currentCostRules.get(selectedProductId);
  const selectedCpaRule = currentCpaRules.get(selectedProductId);
  const selectedCostHistory = useMemo(
    () => metaProductRuleHistory(costRules.data ?? [], selectedProductId),
    [costRules.data, selectedProductId]
  );
  const selectedCpaHistory = useMemo(
    () => metaProductRuleHistory(cpaRules.data ?? [], selectedProductId),
    [cpaRules.data, selectedProductId]
  );
  const correctingCostRule = selectedCostHistory.find((rule) => rule.id === correctingCostRuleId);
  const correctingCpaRule = selectedCpaHistory.find((rule) => rule.id === correctingCpaRuleId);
  const ruleHistoriesUnavailable =
    costRules.data === undefined || cpaRules.data === undefined ||
    costRules.isFetching || cpaRules.isFetching || costRules.isError || cpaRules.isError;

  const selectProduct = (productId: string) => {
    setSelectedProductId(productId);
    setCorrectingCostRuleId(null);
    setCorrectingCpaRuleId(null);
    ruleEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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
        {canManageProducts ? <form className="panel" onSubmit={onProduct}>
          <h2>제품 생성</h2>
          <div className="form-grid">
            <input className="input" name="code" placeholder="code" required />
            <input className="input" name="name" placeholder="name" required />
            <input className="input" name="displayName" placeholder="display name" required />
            <button className="button primary" type="submit"><Plus size={16} />제품 추가</button>
          </div>
        </form> : (
          <div className="panel">
            <h2>제품 생성</h2>
            <div className="warning-strip"><span>읽기 전용 계정입니다. 기존 제품과 비용·CPA 이력은 계속 확인할 수 있습니다.</span></div>
          </div>
        )}
        <div className="panel" ref={ruleEditorRef}>
          <h2>Product Rule Editor</h2>
          <div className="rule-form-title" style={{ marginBottom: 14 }}>
            <strong>{selectedProduct ? `${productLabel(selectedProduct)} 규칙 편집` : "편집할 제품을 선택해주세요"}</strong>
            <span>아래 제품 목록의 행을 클릭하면 현재 적용 중인 원가와 CPA 값이 입력됩니다.</span>
          </div>
          {(costRules.error ?? cpaRules.error ?? saveCostRule.error ?? saveCpaRule.error) ? (
            <div className="warning-strip">
              <span>규칙 정보를 처리하지 못했습니다: {((costRules.error ?? cpaRules.error ?? saveCostRule.error ?? saveCpaRule.error) as Error).message}</span>
              {(costRules.error ?? cpaRules.error) ? <span>비용·CPA 이력을 모두 정상 조회하기 전에는 저장할 수 없습니다.</span> : null}
            </div>
          ) : null}
          {canManageProducts ? <RuleForms
            costRule={selectedCostRule}
            costHistory={selectedCostHistory}
            correctingCostRule={correctingCostRule}
            cpaRule={selectedCpaRule}
            cpaHistory={selectedCpaHistory}
            correctingCpaRule={correctingCpaRule}
            isCostSaving={saveCostRule.isPending}
            isCpaSaving={saveCpaRule.isPending}
            isRuleHistoryUnavailable={ruleHistoriesUnavailable}
            onCancelCostCorrection={() => setCorrectingCostRuleId(null)}
            onCancelCpaCorrection={() => setCorrectingCpaRuleId(null)}
            onCost={(body, ruleId) => saveCostRule.mutate({ body, productId: selectedProductId, ruleId })}
            onCpa={(body, ruleId) => saveCpaRule.mutate({ body, productId: selectedProductId, ruleId })}
            onProductChange={selectProduct}
            products={products.data ?? []}
            selectedProductId={selectedProductId}
            today={today}
          /> : (
            <div className="warning-strip"><span>읽기 전용입니다. 아래 제품 목록에서 행을 선택하면 원가·CPA 이력을 확인할 수 있습니다.</span></div>
          )}
          {selectedProduct ? (
            <ProductRuleHistoryTables
              canManage={canManageProducts}
              correctingCostRuleId={correctingCostRuleId}
              correctingCpaRuleId={correctingCpaRuleId}
              costHistory={selectedCostHistory}
              cpaHistory={selectedCpaHistory}
              currentCostRuleId={selectedCostRule?.id}
              currentCpaRuleId={selectedCpaRule?.id}
              isLoading={ruleHistoriesUnavailable}
              onCorrectCost={(ruleId) => {
                setCorrectingCostRuleId(ruleId);
                ruleEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              onCorrectCpa={(ruleId) => {
                setCorrectingCpaRuleId(ruleId);
                ruleEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            />
          ) : null}
        </div>
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <div className="rule-form-title">
          <strong>제품 목록 · 현재 비용 설정</strong>
          <span>
            {today} 기준 적용값 · {costRules.isFetching
              ? "비용 정보를 불러오는 중"
              : costRules.isError
                ? "비용 조회 실패"
                : `${configuredProductCount}/${products.data?.length ?? 0}개 제품 설정됨`}
          </span>
          <span>제품 행을 클릭하면 위 편집기에 현재 설정값이 표시됩니다.</span>
        </div>
        {costRules.error ? (
          <div className="warning-strip" style={{ marginBottom: 12 }}>
            <span>현재 비용 정보를 불러오지 못했습니다: {(costRules.error as Error).message}</span>
          </div>
        ) : null}
        <DataTable<ProductRow>
          rows={products.data ?? []}
          getRowKey={(row) => row.id}
          onRowClick={(row) => selectProduct(row.id)}
          rowClassName={(row) => row.id === selectedProductId ? "active" : undefined}
          columns={[
          { key: "code", header: "Code", render: (row) => row.code },
          { key: "name", header: "Name", render: (row) => row.displayName },
          { key: "sku", header: "SKU", render: (row) => row.sku ?? "-" },
          {
            key: "costStatus",
            header: "비용 설정",
            render: (row) => costRules.isFetching ? (
              <span className="muted">불러오는 중</span>
            ) : costRules.isError ? (
              <span className="badge stop_candidate">조회 실패</span>
            ) : currentCostRules.has(row.id) ? (
              <span className="badge scale">적용 중</span>
            ) : (
              <span className="badge stop_candidate">미설정</span>
            )
          },
          { key: "salePrice", header: "판매가", render: (row) => costRuleMoney(currentCostRules.get(row.id)?.salePriceKrw) },
          { key: "productCost", header: "상품 원가", render: (row) => costRuleMoney(currentCostRules.get(row.id)?.productCostKrw) },
          { key: "shipping", header: "배송비", render: (row) => costRuleMoney(currentCostRules.get(row.id)?.shippingKrw) },
          { key: "extraCost", header: "기타 비용", render: (row) => costRuleMoney(currentCostRules.get(row.id)?.extraCostKrw) },
          { key: "vat", header: "부가세", render: (row) => costRuleMoney(currentCostRules.get(row.id)?.vatKrw) },
          { key: "period", header: "적용 기간", render: (row) => costRulePeriod(currentCostRules.get(row.id)) },
          { key: "cpa", header: "Target Ratio", render: (row) => currentCpaRules.get(row.id)?.targetRatio ?? "-" },
          ...(canManageProducts ? [{
            key: "actions",
            header: "",
            render: (row: ProductRow) => (
              <div className="toolbar">
                <button
                  aria-label={`${productLabel(row)} 규칙 편집`}
                  className="icon-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    selectProduct(row.id);
                  }}
                  title="제품 규칙 편집"
                  type="button"
                >
                  <Pencil size={15} />
                </button>
                <button
                  aria-label={`${productLabel(row)} 삭제`}
                  className="icon-button danger"
                  disabled={deleteProduct.isPending}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteProduct(row);
                  }}
                  title="제품 삭제"
                  type="button"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            )
          }] : [])
        ]}
        />
      </div>
      <CouponSettingsPanel
        canManage={canManageProducts}
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
  canManage,
  products,
  rules,
  isLoading,
  isSaving,
  error,
  onCreate,
  onUpdate
}: {
  canManage: boolean;
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
        {canManage ? (
          <CouponRuleForm
            draft={draft}
            isEditing={Boolean(editingRule)}
            isSaving={isSaving}
            onCancel={editingRule ? stopEditing : undefined}
            onChange={setDraft}
            onSubmit={submit}
            products={products}
          />
        ) : (
          <div className="warning-strip"><span>읽기 전용입니다. 저장된 쿠폰 규칙은 계속 확인할 수 있습니다.</span></div>
        )}
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
              render: (rule: Cafe24CouponRule) => (
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
            ...(canManage ? [{
              key: "edit",
              header: "편집",
              render: (rule: Cafe24CouponRule) => (
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
            }, {
              key: "deactivate",
              header: "비활성화",
              render: (rule: Cafe24CouponRule) =>
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
            }] : [])
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

function RuleForms({
  products,
  selectedProductId,
  costRule,
  costHistory,
  correctingCostRule,
  cpaRule,
  cpaHistory,
  correctingCpaRule,
  isCostSaving,
  isCpaSaving,
  isRuleHistoryUnavailable,
  onProductChange,
  onCancelCostCorrection,
  onCancelCpaCorrection,
  onCost,
  onCpa,
  today
}: {
  products: ProductRow[];
  selectedProductId: string;
  costRule?: MetaProductCostRule;
  costHistory: MetaProductCostRule[];
  correctingCostRule?: MetaProductCostRule;
  cpaRule?: MetaProductCpaRule;
  cpaHistory: MetaProductCpaRule[];
  correctingCpaRule?: MetaProductCpaRule;
  isCostSaving: boolean;
  isCpaSaving: boolean;
  isRuleHistoryUnavailable: boolean;
  onProductChange: (productId: string) => void;
  onCancelCostCorrection: () => void;
  onCancelCpaCorrection: () => void;
  onCost: (body: unknown, ruleId?: string) => void;
  onCpa: (body: unknown, ruleId?: string) => void;
  today: string;
}) {
  return (
    <div className="rule-editor">
      <CostRuleForm
        key={`cost:${selectedProductId}:${correctingCostRule?.id ?? "snapshot"}:${costRuleHistoryRevision(costHistory)}`}
        correctingRule={correctingCostRule}
        currentRule={costRule}
        history={costHistory}
        isHistoryUnavailable={isRuleHistoryUnavailable}
        isSaving={isCostSaving}
        onCancelCorrection={onCancelCostCorrection}
        onProductChange={onProductChange}
        onSave={onCost}
        products={products}
        selectedProductId={selectedProductId}
        today={today}
      />
      <CpaRuleForm
        key={`cpa:${selectedProductId}:${correctingCpaRule?.id ?? "snapshot"}:${cpaRuleHistoryRevision(cpaHistory)}`}
        correctingRule={correctingCpaRule}
        currentRule={cpaRule}
        history={cpaHistory}
        isHistoryUnavailable={isRuleHistoryUnavailable}
        isSaving={isCpaSaving}
        onCancelCorrection={onCancelCpaCorrection}
        onProductChange={onProductChange}
        onSave={onCpa}
        products={products}
        selectedProductId={selectedProductId}
        today={today}
      />
    </div>
  );
}

type CostRuleDraft = {
  salePriceKrw: string;
  productCostKrw: string;
  shippingKrw: string;
  extraCostKrw: string;
  effectiveFrom: string;
  note: string;
};

function CostRuleForm({
  products,
  selectedProductId,
  currentRule,
  correctingRule,
  history,
  today,
  isSaving,
  isHistoryUnavailable,
  onProductChange,
  onSave,
  onCancelCorrection
}: {
  products: ProductRow[];
  selectedProductId: string;
  currentRule?: MetaProductCostRule;
  correctingRule?: MetaProductCostRule;
  history: MetaProductCostRule[];
  today: string;
  isSaving: boolean;
  isHistoryUnavailable: boolean;
  onProductChange: (productId: string) => void;
  onSave: (body: unknown, ruleId?: string) => void;
  onCancelCorrection: () => void;
}) {
  const isCorrection = Boolean(correctingRule);
  const initialBasis = correctingRule ?? currentRule ?? previewMetaProductRuleHistory(history, today, today).basisRule;
  const [draft, setDraft] = useState<CostRuleDraft>(() => costRuleDraft(initialBasis, correctingRule?.effectiveFrom ?? today));
  const preview = useMemo(
    () => previewMetaProductRuleHistory(history, draft.effectiveFrom, today, correctingRule?.id),
    [correctingRule?.id, draft.effectiveFrom, history, today]
  );
  useEffect(() => {
    if (correctingRule) return;
    setDraft((value) => ({ ...costRuleDraft(preview.basisRule, value.effectiveFrom), effectiveFrom: value.effectiveFrom }));
  }, [correctingRule, preview.basisRule?.id, preview.basisRule?.updatedAt]);
  const change = (field: keyof CostRuleDraft, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const dateCollision = Boolean(preview.dateCollisionRule);
  const payloadBasis = correctingRule
    ? costRuleDraft(correctingRule, correctingRule.effectiveFrom)
    : preview.basisRule
      ? costRuleDraft(preview.basisRule, draft.effectiveFrom)
      : null;
  const payload = metaProductCostRulePayload(draft, payloadBasis, isCorrection ? "CORRECTION" : "SNAPSHOT");
  const isEmptySave = isCorrection
    ? Object.keys(payload).length === 0
    : Object.keys(payload).every((field) => field === "effectiveFrom");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isEmptySave) {
      window.alert(isCorrection ? "정정할 원가 값을 하나 이상 변경해주세요." : "새로 적용할 원가 값을 하나 이상 변경해주세요.");
      return;
    }
    if (isCorrection && !window.confirm("이 이력을 직접 정정하면 해당 기간의 과거 보고서 값이 바뀔 수 있습니다. 계속할까요?")) return;
    onSave(payload, correctingRule?.id);
  };

  return (
    <form className={`rule-form${isCorrection ? " rule-correction-form" : ""}`} onSubmit={submit}>
      <div className="rule-form-title">
        <strong>{isCorrection ? "과거 원가 이력 정정" : "새 원가 적용값 저장"}</strong>
        <span>{isCorrection
          ? "선택한 이력 레코드를 직접 수정합니다. 과거 Sales·Meta 보고서가 다시 계산될 수 있습니다."
          : "기존 이력은 보존하고 선택 날짜부터 적용할 전체 원가 스냅샷을 저장합니다."}</span>
      </div>
      <Field label="제품" help="원가 기준을 적용할 제품">
        <ProductSelect disabled={isCorrection} onChange={onProductChange} products={products} value={selectedProductId} />
      </Field>
      <Field label="판매가" help="변경하면 부가세가 판매가의 10%로 다시 계산됩니다">
        <AmountInput onChange={(value) => change("salePriceKrw", value)} placeholder="예: 50000" required value={draft.salePriceKrw} />
      </Field>
      <Field label="상품 원가" help="구매 1건당 제품 매입/제조 원가">
        <AmountInput onChange={(value) => change("productCostKrw", value)} required value={draft.productCostKrw} />
      </Field>
      <Field label="배송비" help="구매 1건당 배송/포장 비용">
        <AmountInput onChange={(value) => change("shippingKrw", value)} required value={draft.shippingKrw} />
      </Field>
      <Field label="기타 비용" help="수수료, 포장재 등 추가 차감 비용">
        <AmountInput onChange={(value) => change("extraCostKrw", value)} required value={draft.extraCostKrw} />
      </Field>
      <Field label="적용 시작일" help={isCorrection ? "선택 이력의 시작일을 정정" : `기본값은 한국시간 오늘(${today})`}>
        <input className="input" onChange={(event) => change("effectiveFrom", event.target.value)} required type="date" value={draft.effectiveFrom} />
      </Field>
      <Field label="예상 적용 종료일" help="다음 이력 시작일의 전날로 서버가 자동 계산">
        <output className="input rule-readonly-value">{dateCollision ? "날짜 충돌" : preview.expectedEffectiveTo ?? "계속"}</output>
      </Field>
      <Field label="메모" help="선택 입력용 내부 메모">
        <input className="input" onChange={(event) => change("note", event.target.value)} value={draft.note} />
      </Field>
      <RuleHistoryImpactPreview preview={preview} correcting={isCorrection} />
      <p className="rule-note">환율 fallback 값은 기준 규칙에서 보존되며, 기준 규칙이 없는 첫 저장에서만 서버가 환율을 조회합니다.</p>
      {isEmptySave ? <p className="rule-note">{isCorrection ? "정정할" : "새로 적용할"} 값을 하나 이상 변경하면 저장할 수 있습니다.</p> : null}
      <div className="toolbar" style={{ alignSelf: "end" }}>
        <button className="button primary" disabled={isSaving || isHistoryUnavailable || !selectedProductId || dateCollision || isEmptySave} type="submit">
          <Save size={16} />{isCorrection ? "이 원가 이력 정정" : "새 원가 적용값 저장"}
        </button>
        {isCorrection ? <button className="button" disabled={isSaving} onClick={onCancelCorrection} type="button"><X size={16} />정정 취소</button> : null}
      </div>
    </form>
  );
}

type CpaRuleDraft = {
  targetRatio: string;
  watchRatio: string;
  stopRatio: string;
  effectiveFrom: string;
  note: string;
};

function CpaRuleForm({
  products,
  selectedProductId,
  currentRule,
  correctingRule,
  history,
  today,
  isSaving,
  isHistoryUnavailable,
  onProductChange,
  onSave,
  onCancelCorrection
}: {
  products: ProductRow[];
  selectedProductId: string;
  currentRule?: MetaProductCpaRule;
  correctingRule?: MetaProductCpaRule;
  history: MetaProductCpaRule[];
  today: string;
  isSaving: boolean;
  isHistoryUnavailable: boolean;
  onProductChange: (productId: string) => void;
  onSave: (body: unknown, ruleId?: string) => void;
  onCancelCorrection: () => void;
}) {
  const isCorrection = Boolean(correctingRule);
  const initialBasis = correctingRule ?? currentRule ?? previewMetaProductRuleHistory(history, today, today).basisRule;
  const [draft, setDraft] = useState<CpaRuleDraft>(() => cpaRuleDraft(initialBasis, correctingRule?.effectiveFrom ?? today));
  const preview = useMemo(
    () => previewMetaProductRuleHistory(history, draft.effectiveFrom, today, correctingRule?.id),
    [correctingRule?.id, draft.effectiveFrom, history, today]
  );
  useEffect(() => {
    if (correctingRule) return;
    setDraft((value) => ({ ...cpaRuleDraft(preview.basisRule, value.effectiveFrom), effectiveFrom: value.effectiveFrom }));
  }, [correctingRule, preview.basisRule?.id, preview.basisRule?.updatedAt]);
  const change = (field: keyof CpaRuleDraft, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const dateCollision = Boolean(preview.dateCollisionRule);
  const payloadBasis = correctingRule
    ? cpaRuleDraft(correctingRule, correctingRule.effectiveFrom)
    : preview.basisRule
      ? cpaRuleDraft(preview.basisRule, draft.effectiveFrom)
      : null;
  const payload = metaProductCpaRulePayload(draft, payloadBasis, isCorrection ? "CORRECTION" : "SNAPSHOT");
  const isEmptySave = isCorrection
    ? Object.keys(payload).length === 0
    : Object.keys(payload).every((field) => field === "effectiveFrom");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isEmptySave) {
      window.alert(isCorrection ? "정정할 CPA 값을 하나 이상 변경해주세요." : "새로 적용할 CPA 값을 하나 이상 변경해주세요.");
      return;
    }
    if (isCorrection && !window.confirm("이 CPA 이력을 직접 정정하면 해당 기간의 과거 판단 기준이 바뀔 수 있습니다. 계속할까요?")) return;
    onSave(payload, correctingRule?.id);
  };

  return (
    <form className={`rule-form${isCorrection ? " rule-correction-form" : ""}`} onSubmit={submit}>
      <div className="rule-form-title">
        <strong>{isCorrection ? "과거 CPA 이력 정정" : "새 CPA 적용값 저장"}</strong>
        <span>{isCorrection
          ? "선택한 CPA 이력을 직접 수정합니다. 과거 판단 결과가 바뀔 수 있습니다."
          : "기존 이력은 보존하고 선택 날짜부터 사용할 CPA 기준 스냅샷을 저장합니다."}</span>
      </div>
      <Field label="제품" help="CPA 기준을 적용할 제품">
        <ProductSelect disabled={isCorrection} onChange={onProductChange} products={products} value={selectedProductId} />
      </Field>
      <Field label="Target 비율" help="0.8이면 손익분기 CPA의 80%">
        <RatioInput onChange={(value) => change("targetRatio", value)} value={draft.targetRatio} />
      </Field>
      <Field label="Watch 비율" help="1.1이면 손익분기 CPA의 110%">
        <RatioInput onChange={(value) => change("watchRatio", value)} value={draft.watchRatio} />
      </Field>
      <Field label="Stop 비율" help="1.25이면 손익분기 CPA의 125%">
        <RatioInput onChange={(value) => change("stopRatio", value)} value={draft.stopRatio} />
      </Field>
      <Field label="적용 시작일" help={isCorrection ? "선택 이력의 시작일을 정정" : `기본값은 한국시간 오늘(${today})`}>
        <input className="input" onChange={(event) => change("effectiveFrom", event.target.value)} required type="date" value={draft.effectiveFrom} />
      </Field>
      <Field label="예상 적용 종료일" help="다음 이력 시작일의 전날로 서버가 자동 계산">
        <output className="input rule-readonly-value">{dateCollision ? "날짜 충돌" : preview.expectedEffectiveTo ?? "계속"}</output>
      </Field>
      <Field label="메모" help="선택 입력용 내부 메모">
        <input className="input" onChange={(event) => change("note", event.target.value)} value={draft.note} />
      </Field>
      <RuleHistoryImpactPreview preview={preview} correcting={isCorrection} />
      {isEmptySave ? <p className="rule-note">{isCorrection ? "정정할" : "새로 적용할"} 값을 하나 이상 변경하면 저장할 수 있습니다.</p> : null}
      <div className="toolbar" style={{ alignSelf: "end" }}>
        <button className="button primary" disabled={isSaving || isHistoryUnavailable || !selectedProductId || dateCollision || isEmptySave} type="submit">
          <Save size={16} />{isCorrection ? "이 CPA 이력 정정" : "새 CPA 적용값 저장"}
        </button>
        {isCorrection ? <button className="button" disabled={isSaving} onClick={onCancelCorrection} type="button"><X size={16} />정정 취소</button> : null}
      </div>
    </form>
  );
}

function RuleHistoryImpactPreview<T extends MetaProductEffectiveRule>({
  preview,
  correcting
}: {
  preview: MetaProductRuleHistoryPreview<T>;
  correcting: boolean;
}) {
  return (
    <div className="rule-history-preview">
      <span className="field-label">저장 전 이력 영향</span>
      <span>기존 현재 규칙: {effectiveRuleRangeLabel(preview.currentRule)}</span>
      <span>저장 기준 규칙: {effectiveRuleRangeLabel(preview.basisRule)}</span>
      <span>{correcting ? "다른 동일 날짜 규칙" : "동일 날짜 규칙"}: {preview.sameDateRule
        ? correcting ? `${ruleDateInput(preview.sameDateRule.effectiveFrom)} (충돌)` : `${ruleDateInput(preview.sameDateRule.effectiveFrom)} (새 행 없이 갱신)`
        : "없음"}</span>
      <span>다음 규칙: {effectiveRuleRangeLabel(preview.nextRule)}</span>
      <span>예상 종료일: {preview.dateCollisionRule ? "날짜 충돌" : preview.expectedEffectiveTo ?? "계속"}</span>
      <strong className={preview.currentValueImpact === "CURRENT" ? "rule-impact-current" : "rule-impact-warning"}>
        오늘 현재값 영향: {ruleImpactLabel(preview.currentValueImpact)}
      </strong>
    </div>
  );
}

function ProductRuleHistoryTables({
  canManage,
  costHistory,
  cpaHistory,
  currentCostRuleId,
  currentCpaRuleId,
  correctingCostRuleId,
  correctingCpaRuleId,
  isLoading,
  onCorrectCost,
  onCorrectCpa
}: {
  canManage: boolean;
  costHistory: MetaProductCostRule[];
  cpaHistory: MetaProductCpaRule[];
  currentCostRuleId?: string;
  currentCpaRuleId?: string;
  correctingCostRuleId: string | null;
  correctingCpaRuleId: string | null;
  isLoading: boolean;
  onCorrectCost: (id: string) => void;
  onCorrectCpa: (id: string) => void;
}) {
  return (
    <div className="rule-history-sections">
      <div>
        <div className="rule-form-title">
          <strong>원가 이력</strong>
          <span>정정은 과거 보고서를 바꿀 수 있으므로 오입력 수정에만 사용하세요.</span>
        </div>
        <DataTable<MetaProductCostRule>
          empty={isLoading ? "원가 이력을 불러오는 중입니다." : "원가 이력이 없습니다."}
          getRowKey={(row) => row.id}
          rows={isLoading ? [] : costHistory}
          columns={[
            { key: "from", header: "적용 시작일", render: (row) => ruleDateInput(row.effectiveFrom) },
            { key: "to", header: "적용 종료일", render: (row) => ruleDateInput(row.effectiveTo, "계속") },
            { key: "sale", header: "판매가", render: (row) => costRuleMoney(row.salePriceKrw) },
            { key: "cost", header: "상품 원가", render: (row) => costRuleMoney(row.productCostKrw) },
            { key: "shipping", header: "배송비", render: (row) => costRuleMoney(row.shippingKrw) },
            { key: "extra", header: "기타 비용", render: (row) => costRuleMoney(row.extraCostKrw) },
            { key: "vat", header: "부가세", render: (row) => costRuleMoney(row.vatKrw) },
            { key: "current", header: "현재 적용 여부", render: (row) => row.id === currentCostRuleId ? <span className="badge scale">적용 중</span> : "-" },
            { key: "created", header: "생성 시각", render: (row) => ruleDateTime(row.createdAt) },
            { key: "updated", header: "수정 시각", render: (row) => ruleDateTime(row.updatedAt) },
            { key: "note", header: "메모", render: (row) => row.note || "-" },
            ...(canManage ? [{
              key: "correct",
              header: "관리",
              render: (row: MetaProductCostRule) => <button className="button" disabled={correctingCostRuleId === row.id} onClick={() => onCorrectCost(row.id)} type="button">
                {correctingCostRuleId === row.id ? "정정 중" : "이 이력 정정"}
              </button>
            }] : [])
          ]}
        />
      </div>
      <div>
        <div className="rule-form-title">
          <strong>CPA 이력</strong>
          <span>Target/Watch/Stop의 적용 기간을 서버가 연속되도록 관리합니다.</span>
        </div>
        <DataTable<MetaProductCpaRule>
          empty={isLoading ? "CPA 이력을 불러오는 중입니다." : "CPA 이력이 없습니다."}
          getRowKey={(row) => row.id}
          rows={isLoading ? [] : cpaHistory}
          columns={[
            { key: "from", header: "적용 시작일", render: (row) => ruleDateInput(row.effectiveFrom) },
            { key: "to", header: "적용 종료일", render: (row) => ruleDateInput(row.effectiveTo, "계속") },
            { key: "target", header: "CPA Target", render: (row) => row.targetRatio },
            { key: "watch", header: "CPA Watch", render: (row) => row.watchRatio },
            { key: "stop", header: "CPA Stop", render: (row) => row.stopRatio },
            { key: "current", header: "현재 적용 여부", render: (row) => row.id === currentCpaRuleId ? <span className="badge scale">적용 중</span> : "-" },
            { key: "created", header: "생성 시각", render: (row) => ruleDateTime(row.createdAt) },
            { key: "updated", header: "수정 시각", render: (row) => ruleDateTime(row.updatedAt) },
            { key: "note", header: "메모", render: (row) => row.note || "-" },
            ...(canManage ? [{
              key: "correct",
              header: "관리",
              render: (row: MetaProductCpaRule) => <button className="button" disabled={correctingCpaRuleId === row.id} onClick={() => onCorrectCpa(row.id)} type="button">
                {correctingCpaRuleId === row.id ? "정정 중" : "이 이력 정정"}
              </button>
            }] : [])
          ]}
        />
      </div>
    </div>
  );
}

function ProductSelect({
  products,
  value,
  onChange,
  disabled = false
}: {
  products: ProductRow[];
  value: string;
  onChange: (productId: string) => void;
  disabled?: boolean;
}) {
  return (
    <select className="select" disabled={disabled} onChange={(event) => onChange(event.target.value)} required value={value}>
      <option value="">제품 선택</option>
      {products.map((product) => <option key={product.id} value={product.id}>{productLabel(product)}</option>)}
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

function AmountInput({
  placeholder,
  required,
  value,
  onChange
}: {
  placeholder?: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="input-with-unit">
      <input
        className="input"
        inputMode="decimal"
        min="0"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        step="1"
        type="number"
        value={value}
      />
      <span>KRW</span>
    </div>
  );
}

function RatioInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <input
      className="input"
      inputMode="decimal"
      min="0"
      onChange={(event) => onChange(event.target.value)}
      required
      step="0.0001"
      type="number"
      value={value}
    />
  );
}

function productLabel(product: ProductRow) {
  return product.displayName ?? product.name ?? product.code;
}

function ruleInputValue(value: number | string | null | undefined, fallback = "") {
  return value === null || value === undefined ? fallback : String(value);
}

function ruleDateInput(value: string | null | undefined, fallback = "") {
  return value?.slice(0, 10) || fallback;
}

function costRuleDraft(rule: MetaProductCostRule | null | undefined, effectiveFrom: string): CostRuleDraft {
  return {
    salePriceKrw: ruleInputValue(rule?.salePriceKrw),
    productCostKrw: ruleInputValue(rule?.productCostKrw, "0"),
    shippingKrw: ruleInputValue(rule?.shippingKrw, "0"),
    extraCostKrw: ruleInputValue(rule?.extraCostKrw, "0"),
    effectiveFrom: ruleDateInput(effectiveFrom),
    note: rule?.note ?? ""
  };
}

function cpaRuleDraft(rule: MetaProductCpaRule | null | undefined, effectiveFrom: string): CpaRuleDraft {
  return {
    targetRatio: ruleInputValue(rule?.targetRatio, "0.8"),
    watchRatio: ruleInputValue(rule?.watchRatio, "1.1"),
    stopRatio: ruleInputValue(rule?.stopRatio, "1.25"),
    effectiveFrom: ruleDateInput(effectiveFrom),
    note: rule?.note ?? ""
  };
}

function costRuleHistoryRevision(rules: readonly MetaProductCostRule[]) {
  return rules.map((rule) => [
    rule.id,
    rule.updatedAt ?? "",
    rule.effectiveFrom,
    rule.effectiveTo ?? "",
    rule.salePriceKrw,
    rule.productCostKrw,
    rule.shippingKrw,
    rule.extraCostKrw,
    rule.note ?? ""
  ].join(":"))
    .join("|");
}

function cpaRuleHistoryRevision(rules: readonly MetaProductCpaRule[]) {
  return rules.map((rule) => [
    rule.id,
    rule.updatedAt ?? "",
    rule.effectiveFrom,
    rule.effectiveTo ?? "",
    rule.targetRatio,
    rule.watchRatio,
    rule.stopRatio,
    rule.note ?? ""
  ].join(":"))
    .join("|");
}

function effectiveRuleRangeLabel(rule: MetaProductEffectiveRule | null) {
  return rule ? `${ruleDateInput(rule.effectiveFrom)} ~ ${ruleDateInput(rule.effectiveTo, "계속")}` : "없음";
}

function ruleImpactLabel(impact: MetaProductRuleHistoryPreview<MetaProductEffectiveRule>["currentValueImpact"]) {
  if (impact === "CURRENT") return "오늘 적용값이 변경됨";
  if (impact === "FUTURE") return "오늘 적용값 영향 없음 (미래 예약)";
  if (impact === "REJECTED_DATE_COLLISION") return "동일 날짜 충돌로 저장 불가";
  return "오늘 적용값 영향 없음 (과거 기간)";
}

function ruleDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

function costRuleMoney(value: number | string | null | undefined) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return "-";
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? money(parsed) : "-";
}

function costRulePeriod(rule: MetaProductCostRule | undefined) {
  if (!rule) {
    return "-";
  }
  return `${rule.effectiveFrom.slice(0, 10)} ~ ${rule.effectiveTo?.slice(0, 10) ?? "계속"}`;
}
