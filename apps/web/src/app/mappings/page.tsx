"use client";

import { Save } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent } from "react";
import { apiGet, apiPost, rangeQuery } from "@/lib/api";
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
  const createRule = useMutation({
    mutationFn: (body: unknown) => apiPost("/mappings/product-rules", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["product-rules"] })
  });
  const manualProduct = useMutation({ mutationFn: (body: unknown) => apiPost("/mappings/product/manual", body) });
  const manualStage = useMutation({ mutationFn: (body: unknown) => apiPost("/mappings/stage/manual", body) });

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
          <h1>Mappings</h1>
          <p>미매칭 광고세트와 제품/SC-CBO-ASC 수동 이력, 자동 매칭 rule을 관리합니다.</p>
        </div>
      </div>
      <div className="grid two">
        <form className="panel" onSubmit={submitRule}>
          <h2>Product Rule Editor</h2>
          <div className="form-grid">
            <select className="select" name="productId" required>
              <option value="">제품 선택</option>
              {(products.data ?? []).map((product) => (
                <option key={product.id} value={product.id}>{product.displayName}</option>
              ))}
            </select>
            <select className="select" name="matchType" defaultValue="CONTAINS">
              <option>CONTAINS</option>
              <option>EXACT</option>
              <option>REGEX</option>
            </select>
            <input className="input" name="pattern" placeholder="광고세트명 패턴" required />
            <input className="input" name="priority" type="number" defaultValue={100} />
            <input className="input" name="validFrom" type="date" required />
            <button className="button primary" type="submit"><Save size={16} />저장</button>
          </div>
        </form>
        <div className="panel">
          <h2>Manual Mapping Editor</h2>
          <ManualForm products={products.data ?? []} onProduct={(body) => manualProduct.mutate(body)} onStage={(body) => manualStage.mutate(body)} />
        </div>
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <h2>미매칭 광고세트</h2>
        <DataTable rows={unmatched.data ?? []} columns={[
          { key: "date", header: "일자", render: (row) => String(row.metricDate).slice(0, 10) },
          { key: "adset", header: "광고세트", render: (row) => row.adsetName },
          { key: "stage", header: "단계", render: (row) => row.stage },
          { key: "spend", header: "Spend USD", render: (row) => row.spendUsd }
        ]} />
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <h2>매칭 Rule</h2>
        <DataTable rows={rules.data ?? []} columns={[
          { key: "product", header: "제품", render: (row) => row.product?.displayName },
          { key: "type", header: "Type", render: (row) => row.matchType },
          { key: "pattern", header: "Pattern", render: (row) => row.pattern },
          { key: "priority", header: "Priority", render: (row) => row.priority },
          { key: "active", header: "Active", render: (row) => String(row.isActive) }
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
