"use client";

import { Plus, Save, Trash2 } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { money } from "@/lib/date-range";

export default function ProductSettingsPage() {
  const queryClient = useQueryClient();
  const products = useQuery({ queryKey: ["products"], queryFn: () => apiGet<Array<Record<string, any>>>("/products") });
  const createProduct = useMutation({
    mutationFn: (body: unknown) => apiPost("/products", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["products"] })
  });
  const deleteProduct = useMutation({
    mutationFn: (id: string) => apiDelete(`/products/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["products"] }),
    onError: (error) => window.alert(error instanceof Error ? error.message : "제품 삭제에 실패했습니다.")
  });
  const createCostRule = useMutation({ mutationFn: (body: unknown) => apiPost("/product-cost-rules", body), onSuccess: () => queryClient.invalidateQueries() });
  const createCpaRule = useMutation({ mutationFn: (body: unknown) => apiPost("/product-cpa-rules", body), onSuccess: () => queryClient.invalidateQueries() });

  const onProduct = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createProduct.mutate({ code: form.get("code"), name: form.get("name"), displayName: form.get("displayName") });
  };
  const onDeleteProduct = (product: Record<string, any>) => {
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
    </section>
  );
}

function RuleForms({ products, onCost, onCpa }: { products: Array<Record<string, any>>; onCost: (body: unknown) => void; onCpa: (body: unknown) => void }) {
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
          <input className="input" name="effectiveFrom" type="date" required />
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
          <input className="input" name="effectiveFrom" type="date" required />
        </Field>
        <button className="button primary" type="submit"><Save size={16} />CPA Rule 저장</button>
      </form>
    </div>
  );
}

function ProductSelect({ products }: { products: Array<Record<string, any>> }) {
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
