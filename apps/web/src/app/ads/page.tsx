"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, rangeQuery } from "@/lib/api";
import { money, numberFmt } from "@/lib/date-range";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";

export default function AdsPage() {
  const range = useRange();
  const [adName, setAdName] = useState("");
  const ads = useQuery({
    queryKey: ["ads", range],
    queryFn: () => apiGet<Array<Record<string, any>>>(`/metrics/ads?${rangeQuery(range, { deliveryStatus: "all" })}`)
  });
  const comparison = useQuery({
    queryKey: ["ads-compare", range, adName],
    queryFn: () => apiGet<Array<Record<string, any>>>(`/metrics/ads/compare-by-name?${rangeQuery(range, { adName })}`),
    enabled: adName.trim().length > 0
  });

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Ads</h1>
          <p>광고명 단독이 아니라 일자, 캠페인 ID, 광고세트 ID, 광고 identity 기준으로 소재 성과를 봅니다.</p>
        </div>
        <div className="toolbar">
          <input className="input" value={adName} onChange={(event) => setAdName(event.target.value)} placeholder="소재명 비교" />
        </div>
      </div>
      <DataTable
        rows={ads.data ?? []}
        columns={[
          { key: "ad", header: "광고", render: (row) => row.adName },
          { key: "campaign", header: "캠페인", render: (row) => row.campaignName },
          { key: "adset", header: "광고세트", render: (row) => row.adsetName },
          { key: "status", header: "게재", render: (row) => row.deliveryStatus ?? "-" },
          { key: "spend", header: "광고비", render: (row) => money(row.totals?.spendUsd, "USD") },
          { key: "purchase", header: "구매", render: (row) => numberFmt(row.totals?.purchaseCount) },
          { key: "cpa", header: "CPA", render: (row) => money(row.totals?.cpaUsd, "USD") },
          { key: "ctr", header: "CTR Link", render: (row) => `${numberFmt(row.totals?.ctrLinkPct, 2)}%` },
          { key: "cpc", header: "CPC Link", render: (row) => money(row.totals?.cpcLinkUsd, "USD") },
          { key: "cpm", header: "CPM", render: (row) => money(row.totals?.cpmUsd, "USD") },
          { key: "lpv", header: "LPV", render: (row) => numberFmt(row.totals?.landingPageViews) }
        ]}
      />
      {adName.trim() ? (
        <div className="panel" style={{ marginTop: 12 }}>
          <h2>소재명 비교</h2>
          <DataTable
            rows={comparison.data ?? []}
            columns={[
              { key: "adset", header: "광고세트", render: (row) => row.adsetName },
              { key: "campaign", header: "캠페인", render: (row) => row.campaignName },
              { key: "spend", header: "광고비", render: (row) => money(row.totals?.spendUsd, "USD") },
              { key: "purchase", header: "구매", render: (row) => numberFmt(row.totals?.purchaseCount) },
              { key: "cpa", header: "CPA", render: (row) => money(row.totals?.cpaUsd, "USD") },
              { key: "ctr", header: "CTR Link", render: (row) => `${numberFmt(row.totals?.ctrLinkPct, 2)}%` },
              { key: "lpv", header: "LPV", render: (row) => numberFmt(row.totals?.landingPageViews) }
            ]}
          />
        </div>
      ) : null}
    </section>
  );
}
