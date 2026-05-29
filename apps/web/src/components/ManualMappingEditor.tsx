"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useState } from "react";
import { apiGet, apiPost, withPeriod } from "@/lib/api";
import { usePeriod } from "@/lib/usePeriod";

export function ManualMappingEditor() {
  const { from, to } = usePeriod();
  const queryClient = useQueryClient();
  const { data: unmatched = [] } = useQuery<Array<Record<string, any>>>({
    queryKey: ["unmatched", from, to],
    queryFn: () => apiGet(withPeriod("/metrics/unmatched", from, to))
  });
  const { data: products = [] } = useQuery<Array<Record<string, any>>>({
    queryKey: ["products"],
    queryFn: () => apiGet("/products")
  });
  const [metaAdsetId, setMetaAdsetId] = useState("");
  const [productId, setProductId] = useState("");
  const [stage, setStage] = useState("SC");
  const [applyToCurrentMetrics, setApplyToCurrentMetrics] = useState(false);

  const productMutation = useMutation({
    mutationFn: () =>
      apiPost("/mappings/product/manual", {
        metaAdsetId,
        productId,
        effectiveFrom: from,
        applyCurrentMetrics: applyToCurrentMetrics
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unmatched"] });
      queryClient.invalidateQueries({ queryKey: ["adsets"] });
    }
  });
  const stageMutation = useMutation({
    mutationFn: () =>
      apiPost("/mappings/stage/manual", {
        metaAdsetId,
        stage,
        effectiveFrom: from,
        applyCurrentMetrics: applyToCurrentMetrics
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adsets"] })
  });

  return (
    <div className="panel">
      <h2>Manual Mapping</h2>
      <div className="form-grid">
        <select className="select wide" value={metaAdsetId} onChange={(event) => setMetaAdsetId(event.target.value)}>
          <option value="">Adset</option>
          {unmatched.map((item) => (
            <option key={item.metaAdsetId} value={item.metaAdsetId}>
              {item.adsetName}
            </option>
          ))}
        </select>
        <select className="select" value={productId} onChange={(event) => setProductId(event.target.value)}>
          <option value="">Product</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.displayName}
            </option>
          ))}
        </select>
        <select className="select" value={stage} onChange={(event) => setStage(event.target.value)}>
          <option value="SC">SC</option>
          <option value="CBO">CBO</option>
          <option value="ASC">ASC</option>
          <option value="UNKNOWN">UNKNOWN</option>
        </select>
        <label className="toolbar">
          <input type="checkbox" checked={applyToCurrentMetrics} onChange={(event) => setApplyToCurrentMetrics(event.target.checked)} />
          current metric 반영
        </label>
      </div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        <button className="btn primary" type="button" onClick={() => productMutation.mutate()} disabled={!metaAdsetId || !productId}>
          <Save size={17} />
          Product
        </button>
        <button className="btn" type="button" onClick={() => stageMutation.mutate()} disabled={!metaAdsetId}>
          <Save size={17} />
          Stage
        </button>
      </div>
    </div>
  );
}
