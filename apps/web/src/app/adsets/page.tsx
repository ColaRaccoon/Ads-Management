"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, rangeQuery } from "@/lib/api";
import { money, numberFmt } from "@/lib/date-range";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";
import { DecisionBadge } from "@/components/decision-badge";

export default function AdsetsPage() {
  const range = useRange();
  const adsets = useQuery({
    queryKey: ["adsets", range],
    queryFn: () => apiGet<Array<Record<string, any>>>(`/metrics/adsets?${rangeQuery(range)}`)
  });
  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Adsets</h1>
          <p>광고세트별 지출, 구매수, CPA, CTR, CPC, LPV, 마진과 판정 후보를 봅니다.</p>
        </div>
        <div className="toolbar">
          <select className="select">
            <option>All Products</option>
          </select>
          <select className="select">
            <option>All Stages</option>
            <option>SC</option>
            <option>CBO</option>
            <option>ASC</option>
          </select>
        </div>
      </div>
      <DataTable
        rows={adsets.data ?? []}
        columns={[
          { key: "adset", header: "광고세트", render: (row) => row.adsetName },
          { key: "product", header: "제품", render: (row) => row.product?.displayName ?? "미매칭" },
          { key: "stage", header: "단계", render: (row) => row.stage },
          { key: "spend", header: "광고비", render: (row) => money(row.totals?.spendKrw) },
          { key: "purchase", header: "구매수", render: (row) => numberFmt(row.totals?.purchaseCount) },
          { key: "cpa", header: "CPA", render: (row) => money(row.totals?.cpaKrw) },
          { key: "ctr", header: "CTR Link", render: (row) => `${numberFmt(row.totals?.ctrLinkPct, 2)}%` },
          { key: "cpc", header: "CPC Link", render: (row) => money(row.totals?.cpcLinkUsd, "USD") },
          { key: "lpv", header: "LPV", render: (row) => numberFmt(row.totals?.landingPageViews) },
          { key: "margin", header: "마진", render: (row) => money(row.totals?.marginKrw) },
          { key: "status", header: "기준", render: (row) => row.ruleStatus },
          { key: "decision", header: "판정", render: () => <DecisionBadge decision={null} /> }
        ]}
      />
    </section>
  );
}
