"use client";

import { AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { KpiCard } from "@/components/kpi-card";
import { DataTable } from "@/components/data-table";

type CoupangGroupBy = "product" | "group";

type CoupangDashboard = {
  period: { from: string; to: string };
  groupBy: CoupangGroupBy;
  summary: {
    netSalesKrw: number;
    totalCostKrw: number;
    marginKrw: number;
    adSpendKrw: number;
    adConversionSalesKrw: number;
    organicSalesKrw: number;
    returnCostKrw: number;
    vatKrw: number;
    manualPurchaseQuantity: number;
    manualPurchaseVatKrw: number;
    manualPurchaseTotalCostKrw: number;
    marginRate: number | null;
    roas: number | null;
    missingCostRuleCount: number;
    warningCount: number;
  };
  rows: CoupangProfitRow[];
};

type CoupangProfitRow = {
  rowType?: "PRODUCT" | "GROUP";
  productName: string;
  groupId?: string | null;
  groupName?: string | null;
  netSalesKrw: number;
  vatKrw: number | null;
  adSpendKrw: number;
  organicSalesKrw: number;
  manualPurchaseVatKrw: number;
  manualPurchaseTotalCostKrw: number;
  marginKrw: number | null;
  roas: number | null;
  ruleStatus: string;
};

export default function CoupangDashboardPage() {
  const range = useRange();
  const [groupBy, setGroupBy] = useState<CoupangGroupBy>("product");
  const dashboard = useQuery({
    queryKey: ["coupang-dashboard", range, groupBy],
    queryFn: () => apiGet<CoupangDashboard>(`/coupang/dashboard?${rangeQuery(range, { groupBy })}`)
  });
  const data = dashboard.data;
  const nameHeader = groupBy === "group" ? "Product Group" : "Product";

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
        <KpiCard label="VAT" value={money(data?.summary.vatKrw)} />
        <KpiCard label="Ad Spend" value={money(data?.summary.adSpendKrw)} />
        <KpiCard label="Organic Sales" value={money(data?.summary.organicSalesKrw)} />
        <KpiCard label="가구매 수량" value={numberFmt(data?.summary.manualPurchaseQuantity)} />
        <KpiCard label="가구매 비용" value={money(data?.summary.manualPurchaseTotalCostKrw)} />
        <KpiCard label="Margin" value={money(data?.summary.marginKrw)} helper={percent(data?.summary.marginRate)} />
        <KpiCard label="ROAS" value={ratio(data?.summary.roas)} />
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="toolbar">
          <h2>Product Summary</h2>
          <select className="input" value={groupBy} onChange={(event) => setGroupBy(event.target.value as CoupangGroupBy)}>
            <option value="product">By Option</option>
            <option value="group">By Product Group</option>
          </select>
        </div>
        <DataTable
          rows={data?.rows ?? []}
          columns={[
            { key: "product", header: nameHeader, render: (row) => row.productName },
            { key: "netSales", header: "Net Sales", render: (row) => money(row.netSalesKrw) },
            { key: "vat", header: "VAT", render: (row) => money(row.vatKrw) },
            { key: "adSpend", header: "Ad Spend", render: (row) => money(row.adSpendKrw) },
            { key: "manualPurchase", header: "가구매 비용", render: (row) => money(row.manualPurchaseTotalCostKrw) },
            { key: "manualPurchaseVat", header: "가구매 VAT", render: (row) => money(row.manualPurchaseVatKrw) },
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

function numberFmt(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : value.toLocaleString("ko-KR");
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`;
}

function ratio(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`;
}
