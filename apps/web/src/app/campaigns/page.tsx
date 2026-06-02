"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, rangeQuery } from "@/lib/api";
import { money, numberFmt } from "@/lib/date-range";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";

export default function CampaignsPage() {
  const range = useRange();
  const campaigns = useQuery({
    queryKey: ["campaigns", range],
    queryFn: () => apiGet<Array<Record<string, any>>>(`/metrics/campaigns?${rangeQuery(range, { deliveryStatus: "all" })}`)
  });

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Campaigns</h1>
          <p>광고 단위 원천 데이터에서 캠페인별 성과와 예산 배분을 집계합니다.</p>
        </div>
      </div>
      <DataTable
        rows={campaigns.data ?? []}
        columns={[
          { key: "campaign", header: "캠페인", render: (row) => row.campaignName },
          { key: "adsets", header: "광고세트", render: (row) => numberFmt(row.adsetCount) },
          { key: "ads", header: "광고", render: (row) => numberFmt(row.adCount) },
          { key: "spend", header: "광고비", render: (row) => money(row.totals?.spendUsd, "USD") },
          { key: "purchase", header: "구매", render: (row) => numberFmt(row.totals?.purchaseCount) },
          { key: "cpa", header: "CPA", render: (row) => money(row.totals?.cpaUsd, "USD") },
          { key: "ctr", header: "CTR Link", render: (row) => `${numberFmt(row.totals?.ctrLinkPct, 2)}%` },
          { key: "cpc", header: "CPC Link", render: (row) => money(row.totals?.cpcLinkUsd, "USD") },
          { key: "cpm", header: "CPM", render: (row) => money(row.totals?.cpmUsd, "USD") },
          { key: "lpv", header: "LPV", render: (row) => numberFmt(row.totals?.landingPageViews) }
        ]}
      />
    </section>
  );
}
