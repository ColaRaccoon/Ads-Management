"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, rangeQuery } from "@/lib/api";
import { money, numberFmt } from "@/lib/date-range";
import { useRange } from "@/lib/use-range";
import { ProductBarChart } from "@/components/Charts";
import { DataTable } from "@/components/data-table";

export default function ProductsPerformancePage() {
  const range = useRange();
  const products = useQuery({
    queryKey: ["products-performance", range],
    queryFn: () => apiGet<Array<Record<string, any>>>(`/metrics/products?${rangeQuery(range)}`)
  });
  const rows = products.data ?? [];
  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Products Performance</h1>
          <p>제품별 손익분기 CPA, 목표 CPA, 중단 후보 CPA와 실제 CPA를 비교합니다.</p>
        </div>
      </div>
      <div className="panel">
        <h2>제품별 광고비/마진</h2>
        <ProductBarChart
          data={rows.map((row) => ({
            name: row.product?.displayName ?? "-",
            spendKrw: row.totals?.spendKrw ?? 0,
            marginKrw: row.totals?.marginKrw ?? 0
          }))}
        />
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <h2>제품별 기준선</h2>
        <DataTable
          rows={rows}
          columns={[
            { key: "product", header: "제품", render: (row) => row.product?.displayName ?? "-" },
            { key: "spend", header: "광고비", render: (row) => money(row.totals?.spendKrw) },
            { key: "purchase", header: "구매수", render: (row) => numberFmt(row.totals?.purchaseCount) },
            { key: "cpa", header: "실제 CPA", render: (row) => money(row.totals?.cpaKrw) },
            { key: "target", header: "목표 CPA", render: (row) => money(row.targetCpaKrw) },
            { key: "be", header: "손익분기 CPA", render: (row) => money(row.breakEvenCpaKrw) },
            { key: "watch", header: "관찰 CPA", render: (row) => money(row.watchCpaKrw) },
            { key: "stop", header: "중단 후보 CPA", render: (row) => money(row.stopCpaKrw) },
            { key: "revenue", header: "매출", render: (row) => money(row.totals?.revenueKrw) },
            { key: "margin", header: "마진", render: (row) => money(row.totals?.marginKrw) },
            { key: "rule", header: "기준 상태", render: (row) => row.ruleStatus }
          ]}
        />
      </div>
    </section>
  );
}
