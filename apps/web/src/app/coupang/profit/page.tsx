"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";

type CoupangGroupBy = "product" | "group";

type CoupangProductProfit = {
  period: { from: string; to: string };
  groupBy: CoupangGroupBy;
  rows: ProductProfitRow[];
};

type ProductProfitRow = {
  rowType?: "PRODUCT" | "GROUP";
  productId?: string;
  productName: string;
  groupId?: string | null;
  groupName?: string | null;
  childProductCount?: number;
  saleMethod: string | null;
  matchedSalesLineCount: number;
  salesQuantity: number;
  salesKrw: number;
  cancelAmountKrw: number;
  netSalesKrw: number;
  salePriceKrw: number | null;
  baseSalePriceKrw: number | null;
  promotionPriceKrw: number | null;
  priceSource: string;
  priceWarnings: string[];
  productCostKrw: number | null;
  salesFeeKrw: number | null;
  shippingCostKrw: number | null;
  returnCostKrw: number | null;
  adSpendKrw: number;
  adConversionSalesKrw: number;
  adConversionQuantity: number;
  organicSalesKrw: number;
  totalCostKrw: number | null;
  marginKrw: number | null;
  marginRate: number | null;
  roas: number | null;
  warnings: string[];
  ruleStatus: string;
};

export default function CoupangProfitPage() {
  const range = useRange();
  const [groupBy, setGroupBy] = useState<CoupangGroupBy>("product");
  const profit = useQuery({
    queryKey: ["coupang-product-profit", range, groupBy],
    queryFn: () => apiGet<CoupangProductProfit>(`/coupang/product-profit?${rangeQuery(range, { groupBy })}`)
  });
  const rows = profit.data?.rows ?? [];
  const nameHeader = groupBy === "group" ? "Product Group" : "Product";
  const totals = rows.reduce(
    (acc, row) => ({
      netSalesKrw: acc.netSalesKrw + row.netSalesKrw,
      totalCostKrw: acc.totalCostKrw + (row.totalCostKrw ?? 0),
      marginKrw: acc.marginKrw + (row.marginKrw ?? 0),
      adSpendKrw: acc.adSpendKrw + row.adSpendKrw,
      adConversionSalesKrw: acc.adConversionSalesKrw + row.adConversionSalesKrw
    }),
    { netSalesKrw: 0, totalCostKrw: 0, marginKrw: 0, adSpendKrw: 0, adConversionSalesKrw: 0 }
  );

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Coupang Profit Table</h1>
          <p>Product-level net sales, cost, ad attribution, organic sales, and margin.</p>
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
          rows={rows}
          columns={[
            { key: "product", header: nameHeader, render: (row) => row.productName },
            { key: "price", header: "Sale Price", render: (row) => money(row.salePriceKrw) },
            { key: "priceSource", header: "Price Source", render: (row) => priceLabel(row) },
            { key: "method", header: "Sale Method", render: (row) => row.saleMethod ?? "-" },
            { key: "lines", header: "Sales Rows", render: (row) => row.matchedSalesLineCount },
            { key: "qty", header: "Qty", render: (row) => numberFmt(row.salesQuantity) },
            { key: "netSales", header: "Net Sales", render: (row) => money(row.netSalesKrw) },
            { key: "productCost", header: "Product Cost", render: (row) => money(row.productCostKrw) },
            { key: "fee", header: "Sales Fee", render: (row) => money(row.salesFeeKrw) },
            { key: "ship", header: "Shipping/Growth", render: (row) => money(row.shippingCostKrw) },
            { key: "return", header: "Return Cost", render: (row) => money(row.returnCostKrw) },
            { key: "ad", header: "Ad Spend", render: (row) => money(row.adSpendKrw) },
            { key: "conv", header: "Ad Conv Sales", render: (row) => money(row.adConversionSalesKrw) },
            { key: "organic", header: "Organic Sales", render: (row) => money(row.organicSalesKrw) },
            { key: "total", header: "Total Cost", render: (row) => money(row.totalCostKrw) },
            { key: "margin", header: "Margin", render: (row) => money(row.marginKrw) },
            { key: "rate", header: "Margin Rate", render: (row) => percent(row.marginRate) },
            { key: "roas", header: "ROAS", render: (row) => percent(row.roas) },
            { key: "status", header: "Status", render: (row) => row.warnings[0] ?? row.ruleStatus }
          ]}
          footer={
            <tr>
              <td>Total</td>
              <td colSpan={5} />
              <td>{money(totals.netSalesKrw)}</td>
              <td colSpan={7} />
              <td>{money(totals.totalCostKrw)}</td>
              <td>{money(totals.marginKrw)}</td>
              <td>{percent(totals.marginKrw / totals.netSalesKrw)}</td>
              <td>{percent(totals.adConversionSalesKrw / totals.adSpendKrw)}</td>
              <td />
            </tr>
          }
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
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(1)}%`;
}

function priceLabel(row: ProductProfitRow) {
  if (row.priceWarnings.length > 0) {
    return `${row.priceSource} (${row.priceWarnings[0]})`;
  }
  return row.priceSource;
}
