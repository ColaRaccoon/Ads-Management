"use client";

import { useMemo } from "react";
import { Download, RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";
import { buildXlsxWorkbook, downloadXlsx } from "@/lib/xlsx";
import type { XlsxCell } from "@/lib/xlsx";

type SalesProductPerformance = {
  rows: SalesProductRow[];
  summary: {
    salesLineCount: number;
    salesUnmatchedCount: number;
    adUnmatchedMetricCount: number;
    adUnmatchedSpendUsd: number;
    adUnmatchedSpendKrw: number | null;
  };
};

type SalesProductRow = {
  productId: string;
  product?: { displayName?: string | null; name?: string | null; code?: string | null } | null;
  quantity: number;
  revenueKrw: number;
  adSpendUsd: number;
  adSpendKrw: number | null;
  grossCostKrw: number | null;
  totalCostKrw: number | null;
  marginKrw: number | null;
  roas: number | null;
  cpaKrw: number | null;
};

type SalesProductTotals = {
  quantity: number | null;
  revenueKrw: number | null;
  adSpendKrw: number | null;
  totalCostKrw: number | null;
  marginKrw: number | null;
  roas: number | null;
  cpaKrw: number | null;
};

type Cafe24UnmatchedLine = {
  id: string;
  orderDate?: string | null;
  orderNo: string;
  productNo: string;
  productName: string;
  optionName: string;
  quantity: number;
};

export default function SalesPage() {
  const range = useRange();
  const queryClient = useQueryClient();
  const query = rangeQuery(range);
  const performance = useQuery({
    queryKey: ["sales-product-performance", range],
    queryFn: () => apiGet<SalesProductPerformance>(`/sales/product-performance?${query}`)
  });
  const unmatched = useQuery({
    queryKey: ["sales-cafe24-unmatched", range],
    queryFn: () => apiGet<Cafe24UnmatchedLine[]>(`/sales/cafe24/unmatched?${query}`)
  });
  const rematch = useMutation({
    mutationFn: () => apiPost(`/sales/cafe24/rematch?${query}`, {}),
    onSuccess: () => queryClient.invalidateQueries()
  });

  const summary = performance.data?.summary;
  const productRows = performance.data?.rows ?? [];
  const productTotals = useMemo(() => summarizeSalesRows(productRows), [productRows]);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>판매</h1>
          <p>카페24 실제 판매와 현재 Meta 광고비를 제품별로 확인합니다.</p>
        </div>
        <div className="toolbar">
          <button
            className="button"
            type="button"
            onClick={() => downloadSalesExcel(productRows, productTotals, summary, range)}
            disabled={productRows.length === 0}
          >
            <Download size={16} />
            엑셀 출력
          </button>
          <button className="button" type="button" onClick={() => rematch.mutate()} disabled={rematch.isPending}>
            <RefreshCw size={16} />
            다시 매칭
          </button>
        </div>
      </div>

      <div className="warning-strip">
        <span>판매 행 {summary?.salesLineCount ?? 0}</span>
        <span>카페24 미매칭 {summary?.salesUnmatchedCount ?? 0}</span>
        <span>Meta 미매칭 {summary?.adUnmatchedMetricCount ?? 0}</span>
        <span>Meta 미매칭 광고비 {money(summary?.adUnmatchedSpendKrw)}</span>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>제품별 성과</h2>
        <DataTable<SalesProductRow>
          rows={productRows}
          empty="데이터가 없습니다."
          footer={
            productRows.length > 0 ? (
              <tr>
                <td>합계</td>
                <td>{number(productTotals.quantity)}</td>
                <td>{money(productTotals.revenueKrw)}</td>
                <td>{money(productTotals.adSpendKrw)}</td>
                <td>{money(productTotals.totalCostKrw)}</td>
                <td>{money(productTotals.marginKrw)}</td>
                <td>{ratio(productTotals.roas)}</td>
                <td>{money(productTotals.cpaKrw)}</td>
              </tr>
            ) : undefined
          }
          columns={[
            { key: "product", header: "제품", render: (row) => row.product?.displayName ?? row.product?.name ?? row.productId },
            { key: "qty", header: "수량", render: (row) => number(row.quantity) },
            { key: "revenue", header: "매출", render: (row) => money(row.revenueKrw) },
            { key: "ad", header: "광고비", render: (row) => money(row.adSpendKrw) },
            { key: "cost", header: "총비용", render: (row) => money(row.totalCostKrw) },
            { key: "margin", header: "마진", render: (row) => money(row.marginKrw) },
            { key: "roas", header: "광고수익률", render: (row) => ratio(row.roas) },
            { key: "cpa", header: "전환당 비용", render: (row) => money(row.cpaKrw) }
          ]}
        />
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>카페24 미매칭 주문</h2>
        <DataTable<Cafe24UnmatchedLine>
          rows={unmatched.data ?? []}
          empty="데이터가 없습니다."
          columns={[
            { key: "date", header: "일자", render: (row) => String(row.orderDate ?? "").slice(0, 10) || "-" },
            { key: "order", header: "주문번호", render: (row) => row.orderNo },
            { key: "productNo", header: "상품번호", render: (row) => row.productNo },
            { key: "name", header: "상품명", render: (row) => row.productName },
            { key: "option", header: "옵션", render: (row) => row.optionName },
            { key: "qty", header: "수량", render: (row) => number(row.quantity) }
          ]}
        />
      </div>
    </section>
  );
}

function summarizeSalesRows(rows: SalesProductRow[]): SalesProductTotals {
  const quantity = nullableSumRows(rows, (row) => row.quantity);
  const revenueKrw = nullableSumRows(rows, (row) => row.revenueKrw);
  const adSpendKrw = nullableSumRows(rows, (row) => row.adSpendKrw);
  const totalCostKrw = nullableSumRows(rows, (row) => row.totalCostKrw);
  const marginKrw = nullableSumRows(rows, (row) => row.marginKrw);

  return {
    quantity,
    revenueKrw,
    adSpendKrw,
    totalCostKrw,
    marginKrw,
    roas: divideOrNull(revenueKrw, adSpendKrw),
    cpaKrw: divideOrNull(adSpendKrw, quantity)
  };
}

function downloadSalesExcel(
  rows: SalesProductRow[],
  totals: SalesProductTotals,
  summary: SalesProductPerformance["summary"] | undefined,
  range: { from: string; to: string }
) {
  const datePart = range.from === range.to ? range.from : `${range.from}~${range.to}`;
  const headerRowIndex = 5;
  const dataRows = rows.map(
    (row): XlsxCell[] => [
      { value: productLabel(row), style: "Text" },
      { value: toFiniteNumber(row.quantity), style: "Number" },
      { value: toFiniteNumber(row.revenueKrw), style: "Krw" },
      { value: toFiniteNumber(row.adSpendKrw), style: "Krw" },
      { value: toFiniteNumber(row.totalCostKrw), style: "Krw" },
      { value: toFiniteNumber(row.marginKrw), style: "Krw" },
      { value: toFiniteNumber(row.roas), style: "Ratio" },
      { value: toFiniteNumber(row.cpaKrw), style: "Krw" }
    ]
  );
  const totalRow: XlsxCell[] = [
    { value: "합계", style: "TotalText" },
    { value: totals.quantity, style: "TotalNumber" },
    { value: totals.revenueKrw, style: "TotalKrw" },
    { value: totals.adSpendKrw, style: "TotalKrw" },
    { value: totals.totalCostKrw, style: "TotalKrw" },
    { value: totals.marginKrw, style: "TotalKrw" },
    { value: totals.roas, style: "TotalRatio" },
    { value: totals.cpaKrw, style: "TotalKrw" }
  ];
  const excelRows: XlsxCell[][] = [
    [
      { value: "조회 기간", style: "Header" },
      { value: datePart, style: "Text" },
      { value: "생성 시각", style: "Header" },
      { value: new Date().toLocaleString("ko-KR"), style: "Text" }
    ],
    [
      { value: "판매 행", style: "Header" },
      { value: summary?.salesLineCount ?? 0, style: "Number" },
      { value: "카페24 미매칭", style: "Header" },
      { value: summary?.salesUnmatchedCount ?? 0, style: "Number" }
    ],
    [
      { value: "Meta 미매칭", style: "Header" },
      { value: summary?.adUnmatchedMetricCount ?? 0, style: "Number" },
      { value: "Meta 미매칭 광고비", style: "Header" },
      { value: summary?.adUnmatchedSpendKrw, style: "Krw" }
    ],
    [],
    [
      { value: "제품", style: "Header" },
      { value: "수량", style: "Header" },
      { value: "매출", style: "Header" },
      { value: "광고비", style: "Header" },
      { value: "총비용", style: "Header" },
      { value: "마진", style: "Header" },
      { value: "광고수익률", style: "Header" },
      { value: "전환당 비용", style: "Header" }
    ],
    ...dataRows,
    totalRow
  ];
  const workbook = buildXlsxWorkbook({
    sheetName: "판매",
    columns: [{ width: 28 }, { width: 11 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 13 }, { width: 15 }],
    rows: excelRows,
    freezeRow: headerRowIndex,
    autoFilter: { fromRow: headerRowIndex, toRow: excelRows.length }
  });

  downloadXlsx(`${datePart}_판매성과.xlsx`, workbook);
}

function nullableSumRows(rows: SalesProductRow[], selector: (row: SalesProductRow) => number | null | undefined) {
  let total = 0;
  for (const row of rows) {
    const value = toFiniteNumber(selector(row));
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

function divideOrNull(numerator: number | null, denominator: number | null) {
  const parsedNumerator = toFiniteNumber(numerator);
  const parsedDenominator = toFiniteNumber(denominator);
  if (parsedNumerator === null || parsedDenominator === null || parsedDenominator === 0) {
    return null;
  }
  return parsedNumerator / parsedDenominator;
}

function toFiniteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function productLabel(row: SalesProductRow) {
  return row.product?.displayName ?? row.product?.name ?? row.productId;
}

function money(value: unknown) {
  const parsed = toFiniteNumber(value);
  return parsed === null ? "-" : `${Math.round(parsed).toLocaleString("ko-KR")}원`;
}

function number(value: unknown) {
  const parsed = toFiniteNumber(value);
  return parsed === null ? "-" : parsed.toLocaleString("ko-KR");
}

function ratio(value: unknown) {
  const parsed = toFiniteNumber(value);
  return parsed === null ? "-" : `${parsed.toFixed(2)}배`;
}
