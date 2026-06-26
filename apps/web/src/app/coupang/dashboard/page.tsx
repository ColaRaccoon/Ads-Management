"use client";

import { AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiGet, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { KpiCard } from "@/components/kpi-card";
import { DataTable } from "@/components/data-table";

type CoupangDashboard = {
  period: { from: string; to: string };
  summary: {
    netSalesKrw: number;
    totalCostKrw: number;
    marginKrw: number;
    adSpendKrw: number;
    adConversionSalesKrw: number;
    organicSalesKrw: number;
    returnCostKrw: number;
    marginRate: number | null;
    roas: number | null;
    missingCostRuleCount: number;
    warningCount: number;
  };
  rows: CoupangProfitRow[];
};

type CoupangProfitRow = {
  productName: string;
  netSalesKrw: number;
  adSpendKrw: number;
  organicSalesKrw: number;
  marginKrw: number | null;
  roas: number | null;
  ruleStatus: string;
};

export default function CoupangDashboardPage() {
  const range = useRange();
  const dashboard = useQuery({
    queryKey: ["coupang-dashboard", range],
    queryFn: () => apiGet<CoupangDashboard>(`/coupang/dashboard?${rangeQuery(range)}`)
  });
  const data = dashboard.data;

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Coupang Dashboard</h1>
          <p>Coupang sales, ad spend, return cost, and margin by selected period.</p>
        </div>
      </div>

      {dashboard.isError ? (
        <div className="warning-strip">
          <span>
            <AlertTriangle size={15} />
            Coupang API or database settings need attention.
          </span>
        </div>
      ) : null}

      <div className="warning-strip">
        <span>
          <AlertTriangle size={15} />
          Missing cost rules {data?.summary.missingCostRuleCount ?? 0}
        </span>
        <span>
          <AlertTriangle size={15} />
          Warnings {data?.summary.warningCount ?? 0}
        </span>
      </div>

      <div className="grid kpi">
        <KpiCard label="Net Sales" value={money(data?.summary.netSalesKrw)} />
        <KpiCard label="Ad Spend" value={money(data?.summary.adSpendKrw)} />
        <KpiCard label="Organic Sales" value={money(data?.summary.organicSalesKrw)} />
        <KpiCard label="Margin" value={money(data?.summary.marginKrw)} helper={percent(data?.summary.marginRate)} />
        <KpiCard label="ROAS" value={ratio(data?.summary.roas)} />
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>Product Summary</h2>
        <DataTable
          rows={data?.rows ?? []}
          columns={[
            { key: "product", header: "Product", render: (row) => row.productName },
            { key: "netSales", header: "Net Sales", render: (row) => money(row.netSalesKrw) },
            { key: "adSpend", header: "Ad Spend", render: (row) => money(row.adSpendKrw) },
            { key: "organic", header: "Organic Sales", render: (row) => money(row.organicSalesKrw) },
            { key: "margin", header: "Margin", render: (row) => money(row.marginKrw) },
            { key: "roas", header: "ROAS", render: (row) => ratio(row.roas) },
            { key: "status", header: "Status", render: (row) => row.ruleStatus }
          ]}
        />
      </div>
    </section>
  );
}

function money(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`;
}

function ratio(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`;
}
