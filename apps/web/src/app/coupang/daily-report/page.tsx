"use client";

import { Download } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "@/lib/api";
import { buildXlsxWorkbook, downloadXlsx, XlsxCell } from "@/lib/xlsx";
import { DataTable } from "@/components/data-table";

type CoupangGroupBy = "product" | "group";

type CoupangDailyReport = {
  date: string;
  groupBy: CoupangGroupBy;
  rows: DailyReportRow[];
};

type DailyReportRow = {
  productName: string;
  salePriceKrw: number | null;
  baseSalePriceKrw: number | null;
  promotionPriceKrw: number | null;
  priceSource: string;
  priceWarnings: string[];
  adSpendKrw: number;
  manualPurchaseQuantity: number;
  manualPurchaseTotalCostKrw: number;
  totalCostKrw: number | null;
  organicSalesKrw: number;
  marginKrw: number | null;
  roas: number | null;
};

export default function CoupangDailyReportPage() {
  const [date, setDate] = useState(todayInputValue());
  const [groupBy, setGroupBy] = useState<CoupangGroupBy>("product");
  const report = useQuery({
    queryKey: ["coupang-daily-report", date, groupBy],
    queryFn: () => apiGet<CoupangDailyReport>(`/coupang/daily-report?date=${encodeURIComponent(date)}&groupBy=${groupBy}`)
  });
  const rows = report.data?.rows ?? [];
  const columns = dailyReportColumns(groupBy);

  const exportReport = () => {
    const workbook = buildXlsxWorkbook({
      sheetName: "Coupang Daily Report",
      columns: [
        { width: 28 },
        { width: 14 },
        { width: 14 },
        { width: 14 },
        { width: 14 },
        { width: 14 },
        { width: 16 },
        { width: 14 },
        { width: 14 }
      ],
      freezeRow: 1,
      autoFilter: { fromRow: 1 },
      rows: [
        columns.map((column): XlsxCell => ({ value: column, style: "Header" })),
        ...rows.map((row): XlsxCell[] => [
          { value: row.productName, style: "Text" },
          { value: row.salePriceKrw, style: "Krw" },
          { value: row.adSpendKrw, style: "Krw" },
          { value: row.manualPurchaseQuantity, style: "Number" },
          { value: row.manualPurchaseTotalCostKrw, style: "Krw" },
          { value: row.totalCostKrw, style: "Krw" },
          { value: row.organicSalesKrw, style: "Krw" },
          { value: row.marginKrw, style: "Krw" },
          { value: row.roas, style: "Ratio" }
        ])
      ]
    });
    downloadXlsx(`${date}_쿠팡_데일리리포트.xlsx`, workbook);
  };

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Coupang Daily Report</h1>
          <p>Preview and export the exact Coupang daily report columns.</p>
        </div>
        <div className="toolbar">
          <input className="input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <select className="input" value={groupBy} onChange={(event) => setGroupBy(event.target.value as CoupangGroupBy)}>
            <option value="product">옵션별</option>
            <option value="group">제품그룹별</option>
          </select>
          <button className="button primary" type="button" disabled={rows.length === 0} onClick={exportReport}>
            <Download size={16} />
            Export
          </button>
        </div>
      </div>
      <div className="panel">
        <DataTable
          rows={rows}
          columns={[
            { key: "product", header: columns[0], render: (row) => row.productName },
            { key: "price", header: columns[1], render: (row) => money(row.salePriceKrw) },
            { key: "ad", header: columns[2], render: (row) => money(row.adSpendKrw) },
            { key: "manualQty", header: columns[3], render: (row) => numberFmt(row.manualPurchaseQuantity) },
            { key: "manualCost", header: columns[4], render: (row) => money(row.manualPurchaseTotalCostKrw) },
            { key: "total", header: columns[5], render: (row) => money(row.totalCostKrw) },
            { key: "organic", header: columns[6], render: (row) => money(row.organicSalesKrw) },
            { key: "margin", header: columns[7], render: (row) => money(row.marginKrw) },
            { key: "roas", header: columns[8], render: (row) => ratio(row.roas) }
          ]}
        />
      </div>
    </section>
  );
}

function todayInputValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function dailyReportColumns(groupBy: CoupangGroupBy) {
  return [
    groupBy === "group" ? "제품그룹" : "제품명",
    "판매가",
    "광고비",
    "가구매수량",
    "가구매비용",
    "총비용",
    "오가닉매출",
    "마진금액",
    "광고 수익률"
  ] as const;
}

function money(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function numberFmt(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : value.toLocaleString("ko-KR");
}

function ratio(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`;
}
