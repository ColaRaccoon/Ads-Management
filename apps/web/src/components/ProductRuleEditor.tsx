"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { DataTable } from "./DataTable";

export function ProductRuleEditor() {
  const queryClient = useQueryClient();
  const { data: products = [] } = useQuery<Array<Record<string, any>>>({ queryKey: ["products"], queryFn: () => apiGet("/products") });
  const { data: rules = [] } = useQuery<Array<Record<string, any>>>({
    queryKey: ["product-rules"],
    queryFn: () => apiGet("/mappings/product-rules")
  });
  const [form, setForm] = useState({ productId: "", matchType: "CONTAINS", pattern: "", priority: 100 });
  const mutation = useMutation({
    mutationFn: () => apiPost("/mappings/product-rules", form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product-rules"] });
      setForm({ productId: "", matchType: "CONTAINS", pattern: "", priority: 100 });
    }
  });

  return (
    <div className="panel">
      <h2>Product Rules</h2>
      <div className="form-grid">
        <select className="select" value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })}>
          <option value="">Product</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.displayName}
            </option>
          ))}
        </select>
        <select className="select" value={form.matchType} onChange={(event) => setForm({ ...form, matchType: event.target.value })}>
          <option value="CONTAINS">CONTAINS</option>
          <option value="EXACT">EXACT</option>
          <option value="REGEX">REGEX</option>
        </select>
        <input className="input" value={form.pattern} onChange={(event) => setForm({ ...form, pattern: event.target.value })} placeholder="pattern" />
        <input className="input" type="number" value={form.priority} onChange={(event) => setForm({ ...form, priority: Number(event.target.value) })} />
      </div>
      <button className="btn primary" style={{ marginTop: 10 }} type="button" onClick={() => mutation.mutate()}>
        <Plus size={17} />
        Rule
      </button>
      <div style={{ marginTop: 12 }}>
        <DataTable
          rows={rules}
          columns={[
            { key: "priority", header: "Priority" },
            { key: "matchType", header: "Type" },
            { key: "pattern", header: "Pattern" },
            { key: "product", header: "Product", render: (row) => row.product?.displayName ?? "-" },
            { key: "isActive", header: "Active", render: (row) => (row.isActive ? "Y" : "N") }
          ]}
        />
      </div>
    </div>
  );
}
