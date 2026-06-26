"use client";

import { RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";

type CoupangUnmatched = {
  period: { from: string; to: string };
  rows: UnmatchedRow[];
};

type UnmatchedRow = {
  sourceType: string;
  rowNumber: number | null;
  sourceName: string;
  productText: string;
  amountKrw: number | null;
  reason: string;
  candidates: string[];
};

export default function CoupangUnmatchedPage() {
  const range = useRange();
  const queryClient = useQueryClient();
  const unmatched = useQuery({
    queryKey: ["coupang-unmatched", range],
    queryFn: () => apiGet<CoupangUnmatched>(`/coupang/unmatched?${rangeQuery(range)}`)
  });
  const rematch = useMutation({
    mutationFn: () => apiPost(`/coupang/rematch?${rangeQuery(range)}`, {}),
    onSuccess: () => void queryClient.invalidateQueries()
  });

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Coupang Unmatched Review</h1>
          <p>Review no-match, ambiguous, missing cost, and warning rows.</p>
        </div>
        <button className="button primary" type="button" disabled={rematch.isPending} onClick={() => rematch.mutate()}>
          <RefreshCw size={16} />
          Rematch
        </button>
      </div>
      {rematch.data ? (
        <div className="warning-strip">
          <span>{JSON.stringify(rematch.data)}</span>
        </div>
      ) : null}
      <div className="panel">
        <DataTable
          rows={unmatched.data?.rows ?? []}
          columns={[
            { key: "source", header: "Source", render: (row) => row.sourceType },
            { key: "row", header: "Row", render: (row) => row.rowNumber ?? "-" },
            { key: "file", header: "File", render: (row) => row.sourceName || "-" },
            { key: "product", header: "Product Text", render: (row) => row.productText },
            { key: "amount", header: "Amount", render: (row) => money(row.amountKrw) },
            { key: "reason", header: "Reason", render: (row) => row.reason },
            { key: "candidates", header: "Candidates", render: (row) => row.candidates.join(", ") || "-" }
          ]}
        />
      </div>
    </section>
  );
}

function money(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${Math.round(value).toLocaleString("ko-KR")}원`;
}
