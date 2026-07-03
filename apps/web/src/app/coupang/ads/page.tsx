"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";

type CoupangGroupBy = "product" | "group";

type CoupangAdsAnalysis = {
  period: { from: string; to: string };
  groupBy: CoupangGroupBy;
  rows: AdsRow[];
};

type AdsRow = {
  rowType?: "PRODUCT" | "GROUP";
  productName: string;
  groupId?: string | null;
  groupName?: string | null;
  campaignName: string | null;
  adGroupName: string | null;
  impressions: number;
  clicks: number;
  adSpendKrw: number;
  totalOrders1d: number;
  directOrders1d: number;
  indirectOrders1d: number;
  totalConversionSales1dKrw: number;
  directConversionSales1dKrw: number;
  indirectConversionSales1dKrw: number;
  roas: number | null;
};

export default function CoupangAdsPage() {
  const range = useRange();
  const [groupBy, setGroupBy] = useState<CoupangGroupBy>("product");
  const analysis = useQuery({
    queryKey: ["coupang-ads-analysis", range, groupBy],
    queryFn: () => apiGet<CoupangAdsAnalysis>(`/coupang/ads-analysis?${rangeQuery(range, { groupBy })}`)
  });
  const nameHeader = groupBy === "group" ? "Product Group" : "Product";

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Coupang Ads Analysis</h1>
          <p>Ad spend is attributed by execution product; conversion sales by conversion product.</p>
        </div>
      </div>
      <div className="panel">
        <div className="toolbar">
          <select className="input" value={groupBy} onChange={(event) => setGroupBy(event.target.value as CoupangGroupBy)}>
            <option value="product">By Option</option>
            <option value="group">By Product Group</option>
          </select>
        </div>
        <DataTable
          rows={analysis.data?.rows ?? []}
          columns={[
            { key: "product", header: nameHeader, render: (row) => row.productName },
            { key: "campaign", header: "Campaign", render: (row) => row.campaignName ?? "-" },
            { key: "adGroup", header: "Ad Group", render: (row) => row.adGroupName ?? "-" },
            { key: "impressions", header: "Impressions", render: (row) => numberFmt(row.impressions) },
            { key: "clicks", header: "Clicks", render: (row) => numberFmt(row.clicks) },
            { key: "spend", header: "Ad Spend", render: (row) => money(row.adSpendKrw) },
            { key: "orders", header: "Orders", render: (row) => numberFmt(row.totalOrders1d) },
            { key: "directOrders", header: "Direct", render: (row) => numberFmt(row.directOrders1d) },
            { key: "indirectOrders", header: "Indirect", render: (row) => numberFmt(row.indirectOrders1d) },
            { key: "sales", header: "Conv Sales", render: (row) => money(row.totalConversionSales1dKrw) },
            { key: "directSales", header: "Direct Sales", render: (row) => money(row.directConversionSales1dKrw) },
            { key: "indirectSales", header: "Indirect Sales", render: (row) => money(row.indirectConversionSales1dKrw) },
            { key: "roas", header: "ROAS", render: (row) => percent(row.roas) }
          ]}
        />
      </div>
    </section>
  );
}

function money(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function numberFmt(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : value.toLocaleString("ko-KR");
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`;
}
