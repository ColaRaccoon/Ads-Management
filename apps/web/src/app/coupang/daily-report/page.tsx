"use client";

import { Download } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "@/lib/api";
import { buildXlsxWorkbook, downloadXlsx, XlsxCell } from "@/lib/xlsx";
import { DataTable } from "@/components/data-table";

type CoupangDailyReport = {
  date: string;
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
  totalCostKrw: number | null;
  organicSalesKrw: number;
  marginKrw: number | null;
  roas: number | null;
};

const columns = [
  "제품명",
  "판매가",
  "광고비",
  "총비용",
  "오가닉매출",
  "마진금액",
  "광고 수익률"
] as const;

export default function CoupangDailyReportPage() {
  const [date, setDate] = useState(todayInputValue());
  const report = useQuery({
    queryKey: ["coupang-daily-report", date],
    queryFn: () => apiGet<CoupangDailyReport>(`/coupang/daily-report?date=${encodeURIComponent(date)}`)
  });
  const rows = report.data?.rows ?? [];

  const exportReport = () => {
    const workbook = buildXlsxWorkbook({
      sheetName: "Coupang Daily Report",
      columns: [{ width: 28 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 14 }],
      freezeRow: 1,
      autoFilter: { fromRow: 1 },
      rows: [
        columns.map((column): XlsxCell => ({ value: column, style: "Header" })),
        ...rows.map((row): XlsxCell[] => [
          { value: row.productName, style: "Text" },
          { value: row.salePriceKrw, style: "Krw" },
          { value: row.adSpendKrw, style: "Krw" },
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
            { key: "total", header: columns[3], render: (row) => money(row.totalCostKrw) },
            { key: "organic", header: columns[4], render: (row) => money(row.organicSalesKrw) },
            { key: "margin", header: columns[5], render: (row) => money(row.marginKrw) },
            { key: "roas", header: columns[6], render: (row) => ratio(row.roas) }
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

function money(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function ratio(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`;
}
