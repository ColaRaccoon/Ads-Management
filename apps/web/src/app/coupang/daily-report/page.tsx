"use client";

import { Download } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "@/lib/api";
import {
  formatCoupangDailyRowStatus,
  formatCoupangDailySummaryExportStatus,
  summarizeCoupangCalculationPartStatuses
} from "@/lib/coupang-report-status";
import { downloadCsv } from "@/lib/csv";
import { buildXlsxWorkbook, downloadXlsx, type XlsxCell, type XlsxCellStyle } from "@/lib/xlsx";
import { DataTable, type Column } from "@/components/data-table";
import type { CoupangDailyReportResponse, CoupangDailyReportRow, CoupangGroupBy } from "@/types/coupang";

type CoupangDailyExportRow = CoupangDailyReportRow & { exportStatus?: string };

type DailyColumn = {
  key: string;
  header: string;
  style: XlsxCellStyle;
  width: number;
  value: (row: CoupangDailyExportRow) => string | number | null | undefined;
};

export default function CoupangDailyReportPage() {
  const [date, setDate] = useState(todayInputValue());
  const [groupBy, setGroupBy] = useState<CoupangGroupBy>("product");
  const report = useQuery({
    queryKey: ["coupang-daily-report", date, groupBy],
    queryFn: () => apiGet<CoupangDailyReportResponse>(`/coupang/daily-report?date=${encodeURIComponent(date)}&groupBy=${groupBy}`)
  });
  const rows = report.data?.rows ?? [];
  const columns = dailyReportColumns(groupBy);
  const exportRows = report.data ? [...rows, dailySummaryExportRow(report.data)] : rows;
  const tableColumns: Column<CoupangDailyReportRow>[] = columns.map((column) => ({
    key: column.key,
    header: column.header,
    render: (row) => displayCell(column.value(row), column.style)
  }));

  const exportXlsx = () => {
    const workbook = buildXlsxWorkbook({
      sheetName: "Coupang Daily Report",
      columns: columns.map((column) => ({ width: column.width })),
      freezeRow: 1,
      autoFilter: { fromRow: 1 },
      rows: [
        columns.map((column): XlsxCell => ({ value: column.header, style: "Header" })),
        ...exportRows.map((row) => columns.map((column): XlsxCell => ({ value: column.value(row), style: column.style })))
      ]
    });
    downloadXlsx(`${date}_쿠팡_데일리리포트.xlsx`, workbook);
  };

  return (
    <section className="page">
      <div className="page-title">
        <div><h1>Coupang Daily Report</h1><p>화면, XLSX, CSV가 같은 API 값과 열 정의를 사용합니다.</p></div>
        <div className="toolbar">
          <input className="input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <select className="input" value={groupBy} onChange={(event) => setGroupBy(event.target.value as CoupangGroupBy)}><option value="product">옵션별</option><option value="group">제품그룹별</option></select>
          <button className="button primary" type="button" disabled={rows.length === 0} onClick={exportXlsx}><Download size={16} /> XLSX</button>
          <button className="button" type="button" disabled={rows.length === 0} onClick={() => downloadCsv(`${date}_쿠팡_데일리리포트.csv`, columns, exportRows)}><Download size={16} /> CSV</button>
        </div>
      </div>
      {report.data?.summary.isComplete === false ? <div className="warning-strip">계산 불완전 {report.data.summary.incompleteProductCount}개 상품, 순매출 {displayCell(report.data.summary.excludedNetSalesKrw, "Krw")}은 부분 합계에서 제외되며 내보내기 요약 행에도 기록됩니다.</div> : null}
      <div className="panel">
        <DataTable rows={rows} columns={tableColumns} rowClassName={(row) => row.calculationStatus === "INCOMPLETE" ? "incomplete-row" : undefined} />
      </div>
    </section>
  );
}

function dailyReportColumns(groupBy: CoupangGroupBy): DailyColumn[] {
  return [
    { key: "product", header: groupBy === "group" ? "제품그룹" : "제품명", style: "Text", width: 28, value: (row) => row.productName },
    { key: "reportedSales", header: "쿠팡 원본매출", style: "Krw", width: 17, value: (row) => row.reportedSalesKrw },
    { key: "reportedNet", header: "쿠팡 원본순매출", style: "Krw", width: 18, value: (row) => row.reportedNetSalesKrw },
    { key: "reportedQty", header: "쿠팡 원본판매수량", style: "Number", width: 19, value: (row) => row.reportedSalesQuantity },
    { key: "reportedOrders", header: "쿠팡 원본주문건수", style: "Number", width: 19, value: (row) => row.reportedOrderCount },
    { key: "cancel", header: "취소금액", style: "Krw", width: 15, value: (row) => row.cancelAmountKrw },
    { key: "manualQty", header: "가구매 수량", style: "Number", width: 13, value: (row) => row.manualPurchaseQuantity },
    { key: "manualSales", header: "가구매 매출 조정", style: "Krw", width: 18, value: (row) => row.manualPurchaseSalesKrw },
    { key: "manualProductCost", header: "가구매 제품 원가", style: "Krw", width: 18, value: (row) => row.manualPurchaseProductCostKrw },
    { key: "manualVendor", header: "가구매 업체수수료", style: "Krw", width: 18, value: (row) => row.manualPurchaseVendorFeeKrw },
    { key: "manualCoupang", header: "가구매 쿠팡수수료", style: "Krw", width: 18, value: (row) => row.manualPurchaseCoupangSalesFeeKrw },
    { key: "manualShipping", header: "가구매 배송비", style: "Krw", width: 15, value: (row) => row.manualPurchaseShippingCostKrw },
    { key: "manualVat", header: "가구매 VAT", style: "Krw", width: 14, value: (row) => row.manualPurchaseVatKrw },
    { key: "manualOther", header: "가구매 기타비용", style: "Krw", width: 16, value: (row) => row.manualPurchaseOtherCostKrw },
    { key: "manualTotal", header: "가구매 총비용", style: "Krw", width: 18, value: (row) => row.manualPurchaseTotalCostKrw },
    { key: "actualSales", header: "실제 판매매출", style: "Krw", width: 17, value: (row) => row.actualSalesKrw },
    { key: "actualNet", header: "실제 판매순매출", style: "Krw", width: 18, value: (row) => row.actualNetSalesKrw },
    { key: "actualQty", header: "실제 판매수량", style: "Number", width: 17, value: (row) => row.actualSalesQuantity },
    { key: "productCost", header: "상품원가", style: "Krw", width: 15, value: (row) => row.productCostKrw },
    { key: "salesFee", header: "판매수수료", style: "Krw", width: 16, value: (row) => row.salesFeeKrw },
    { key: "shipping", header: "배송비", style: "Krw", width: 14, value: (row) => row.shippingCostKrw },
    { key: "return", header: "반품예상비", style: "Krw", width: 16, value: (row) => row.returnCostKrw },
    { key: "extra", header: "기타비용", style: "Krw", width: 14, value: (row) => row.extraCostKrw },
    { key: "vat", header: "VAT", style: "Krw", width: 13, value: (row) => row.vatKrw },
    { key: "adSpend", header: "광고비", style: "Krw", width: 13, value: (row) => row.adSpendKrw },
    { key: "totalCost", header: "총비용", style: "Krw", width: 14, value: (row) => row.totalCostKrw },
    { key: "reportedOrganic", header: "원본 오가닉매출", style: "Krw", width: 18, value: (row) => row.reportedOrganicSalesKrw },
    { key: "actualOrganic", header: "실제 오가닉매출", style: "Krw", width: 18, value: (row) => row.actualOrganicSalesKrw },
    { key: "normalMargin", header: "정상 판매 순이익", style: "Krw", width: 19, value: (row) => row.normalMarginKrw },
    { key: "margin", header: "최종/부분 순이익", style: "Krw", width: 19, value: (row) => row.marginKrw },
    { key: "roas", header: "광고 수익률", style: "Ratio", width: 14, value: (row) => row.roas },
    { key: "status", header: "경고/계산상태", style: "Text", width: 70, value: (row) => formatCoupangDailyRowStatus(row) }
  ];
}

function dailySummaryExportRow(data: CoupangDailyReportResponse): CoupangDailyExportRow {
  const summary = data.summary;
  const partStatuses = summarizeCoupangCalculationPartStatuses(data.rows);
  return {
    productName: summary.isComplete ? "전체 확정 합계" : "계산 가능한 상품 부분 합계",
    reportedSalesKrw: summary.reportedSalesKrw,
    reportedNetSalesKrw: summary.reportedNetSalesKrw,
    reportedSalesQuantity: summary.reportedSalesQuantity,
    reportedOrderCount: summary.reportedOrderCount,
    cancelAmountKrw: summary.cancelAmountKrw,
    manualPurchaseSalesKrw: summary.manualPurchaseSalesKrw,
    manualPurchaseQuantity: summary.manualPurchaseQuantity,
    manualPurchaseProductCostKrw: summary.manualPurchaseProductCostKrw,
    manualPurchaseVendorFeeKrw: summary.manualPurchaseVendorFeeKrw,
    manualPurchaseCoupangSalesFeeKrw: summary.manualPurchaseCoupangSalesFeeKrw,
    manualPurchaseShippingCostKrw: summary.manualPurchaseShippingCostKrw,
    manualPurchaseVatKrw: summary.manualPurchaseVatKrw,
    manualPurchaseOtherCostKrw: summary.manualPurchaseOtherCostKrw,
    manualPurchaseTotalCostKrw: summary.manualPurchaseTotalCostKrw,
    actualSalesKrw: summary.actualSalesKrw,
    actualNetSalesKrw: summary.actualNetSalesKrw,
    actualSalesQuantity: summary.actualSalesQuantity,
    productCostKrw: summary.productCostKrw,
    salesFeeKrw: summary.salesFeeKrw,
    shippingCostKrw: summary.shippingCostKrw,
    returnCostKrw: summary.returnCostKrw,
    extraCostKrw: summary.extraCostKrw,
    vatKrw: summary.vatKrw,
    adSpendKrw: summary.adSpendKrw,
    organicSalesKrw: summary.actualOrganicSalesKrw,
    reportedOrganicSalesKrw: summary.reportedOrganicSalesKrw,
    actualOrganicSalesKrw: summary.actualOrganicSalesKrw,
    normalMarginKrw: summary.normalMarginKrw,
    totalCostKrw: summary.isComplete ? summary.totalCostKrw : summary.knownTotalCostKrw,
    marginKrw: summary.isComplete ? summary.marginKrw : summary.knownMarginKrw,
    marginRate: summary.marginRate,
    roas: summary.roas,
    normalCalculationStatus: partStatuses.normalCalculationStatus,
    manualCalculationStatus: partStatuses.manualCalculationStatus,
    calculationStatus: summary.isComplete ? "COMPLETE" : "INCOMPLETE",
    warnings: [],
    incompleteProductNames: [],
    salePriceKrw: null,
    baseSalePriceKrw: null,
    promotionPriceKrw: null,
    priceSource: "SUMMARY",
    priceWarnings: [],
    exportStatus: formatCoupangDailySummaryExportStatus({
      isComplete: summary.isComplete,
      incompleteProductCount: summary.incompleteProductCount,
      excludedNetSalesKrw: summary.excludedNetSalesKrw,
      excludedSalesQuantity: summary.excludedSalesQuantity,
      normalCalculationStatus: partStatuses.normalCalculationStatus,
      manualCalculationStatus: partStatuses.manualCalculationStatus
    })
  };
}

function displayCell(value: string | number | null | undefined, style: XlsxCellStyle) {
  if (value === null || value === undefined || (typeof value === "number" && Number.isNaN(value))) return "-";
  if (typeof value !== "number") return value;
  if (style === "Krw") return `${Math.round(value).toLocaleString("ko-KR")}원`;
  if (style === "Ratio" || style === "Percent") return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString("ko-KR");
}

function todayInputValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}
