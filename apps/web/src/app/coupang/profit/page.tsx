"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, rangeQuery } from "@/lib/api";
import { formatCoupangIncompleteReasons } from "@/lib/coupang-profit-warning";
import { useRange } from "@/lib/use-range";
import { DataTable, type Column } from "@/components/data-table";
import type {
  CoupangGroupBy,
  CoupangProductProfitResponse,
  CoupangProductProfitRow,
  CoupangProfitSummary
} from "@/types/coupang";

export default function CoupangProfitPage() {
  const range = useRange();
  const [groupBy, setGroupBy] = useState<CoupangGroupBy>("product");
  const [showReported, setShowReported] = useState(false);
  const [showReference, setShowReference] = useState(false);
  const [showManualDetails, setShowManualDetails] = useState(false);
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const profit = useQuery({
    queryKey: ["coupang-product-profit", range, groupBy],
    queryFn: () => apiGet<CoupangProductProfitResponse>(`/coupang/product-profit?${rangeQuery(range, { groupBy })}`)
  });
  const allRows = profit.data?.rows ?? [];
  const rows = incompleteOnly ? allRows.filter((row) => row.calculationStatus === "INCOMPLETE") : allRows;
  const summary = profit.data?.summary;
  const incompleteReasonSummary = formatCoupangIncompleteReasons(allRows);
  const columns = productProfitColumns(groupBy, showReported, showReference, showManualDetails);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Coupang Profit Table</h1>
          <p>쿠팡 원본에서 가구매 매출·수량을 분리하고, 정상 판매와 가구매 비용을 각각 한 번만 반영합니다.</p>
        </div>
      </div>
      {summary && !summary.isComplete ? (
        <div className="warning-strip">
          <span>계산 불완전 {summary.incompleteProductCount}개 상품 — 순매출 {money(summary.excludedNetSalesKrw)}, 판매수량 {numberFmt(summary.excludedSalesQuantity)}은 합계에서 제외됨
          (정상 판매 오류 {summary.incompleteNormalCount}, 가구매 오류 {summary.incompleteManualCount})</span>
          {incompleteReasonSummary ? <span>{incompleteReasonSummary}</span> : null}
        </div>
      ) : null}
      <div className="manual-purchase-summary">
        <Summary label="실제 정상 판매 순매출" value={money(summary?.actualNetSalesKrw)} />
        <Summary label="가구매 매출 조정" value={money(summary?.manualPurchaseSalesKrw)} />
        <Summary label="정상 판매 순이익" value={money(summary?.normalMarginKrw)} />
        <Summary label="가구매 총비용" value={money(summary?.manualPurchaseTotalCostKrw)} />
        <Summary
          label={summary?.isComplete === false ? "계산 가능한 상품 순이익(부분 합계)" : "최종 순이익"}
          value={money(summary?.isComplete === false ? summary.knownMarginKrw : summary?.marginKrw)}
        />
      </div>
      <div className="panel">
        <div className="toolbar">
          <select className="input" value={groupBy} onChange={(event) => setGroupBy(event.target.value as CoupangGroupBy)}>
            <option value="product">By Option</option>
            <option value="group">By Product Group</option>
          </select>
          <label><input type="checkbox" checked={showReported} onChange={(event) => setShowReported(event.target.checked)} /> 원본값 보기</label>
          <label><input type="checkbox" checked={showReference} onChange={(event) => setShowReference(event.target.checked)} /> 참고값 보기</label>
          <label><input type="checkbox" checked={showManualDetails} onChange={(event) => setShowManualDetails(event.target.checked)} /> 가구매 비용 상세</label>
          <label><input type="checkbox" checked={incompleteOnly} onChange={(event) => setIncompleteOnly(event.target.checked)} /> 불완전 상품만</label>
        </div>
        <DataTable
          rows={rows}
          columns={columns}
          rowClassName={(row) => row.calculationStatus === "INCOMPLETE" ? "incomplete-row" : undefined}
          footer={summary ? <tr>{columns.map((column, index) => <td key={column.key}>{index === 0 ? "Total" : summaryCell(column.key, summary)}</td>)}</tr> : undefined}
        />
      </div>
    </section>
  );
}

function productProfitColumns(groupBy: CoupangGroupBy, showReported: boolean, showReference: boolean, showManualDetails: boolean) {
  const columns: Column<CoupangProductProfitRow>[] = [
    { key: "product", header: groupBy === "group" ? "제품그룹" : "상품", render: (row) => row.productName },
    { key: "actualSales", header: "매출", render: (row) => money(row.actualSalesKrw) },
    { key: "actualNet", header: "순매출", render: (row) => money(row.actualNetSalesKrw) },
    { key: "actualQty", header: "판매수량", render: (row) => numberFmt(row.actualSalesQuantity) },
    { key: "productCost", header: "상품원가", render: (row) => money(row.productCostKrw) },
    { key: "salesFee", header: "판매수수료", render: (row) => money(row.salesFeeKrw) },
    { key: "shipping", header: "배송/그로스", render: (row) => money(row.shippingCostKrw) },
    { key: "return", header: "반품예상비", render: (row) => money(row.returnCostKrw) },
    { key: "extra", header: "기타비용", render: (row) => money(row.extraCostKrw) },
    { key: "vat", header: "VAT", render: (row) => money(row.vatKrw) },
    { key: "manualQty", header: "가구매 수량", render: (row) => numberFmt(row.manualPurchaseQuantity) },
    { key: "manualSales", header: "가구매 매출 조정", render: (row) => money(row.manualPurchaseSalesKrw) },
    { key: "manualTotal", header: "가구매 총비용", render: (row) => money(row.manualPurchaseTotalCostKrw) },
    { key: "adSpend", header: "광고비", render: (row) => money(row.adSpendKrw) },
    { key: "organic", header: "유기적 매출", render: (row) => money(row.organicSalesKrw) },
    { key: "totalCost", header: "총비용", render: (row) => money(row.totalCostKrw) },
    { key: "normalMargin", header: "정상 판매 순이익", render: (row) => money(row.normalMarginKrw) },
    { key: "margin", header: "최종/부분 순이익", render: (row) => row.calculationStatus === "COMPLETE" ? money(row.marginKrw) : row.rowType === "GROUP" ? `${money(row.knownMarginKrw)} (부분)` : "-" },
    { key: "marginRate", header: "마진율", render: (row) => percent(row.marginRate) }
  ];
  if (showManualDetails) {
    columns.splice(11, 0,
      { key: "manualProductCost", header: "가구매 제품 원가", render: (row) => money(row.manualPurchaseProductCostKrw) },
      { key: "manualVendor", header: "가구매 업체수수료", render: (row) => money(row.manualPurchaseVendorFeeKrw) },
      { key: "manualCoupang", header: "가구매 쿠팡수수료", render: (row) => money(row.manualPurchaseCoupangSalesFeeKrw) },
      { key: "manualShipping", header: "가구매 배송비", render: (row) => money(row.manualPurchaseShippingCostKrw) },
      { key: "manualVat", header: "가구매 VAT", render: (row) => money(row.manualPurchaseVatKrw) },
      { key: "manualOther", header: "가구매 기타비용", render: (row) => money(row.manualPurchaseOtherCostKrw) }
    );
  }
  if (showReported) {
    columns.splice(1, 0,
      { key: "reportedSales", header: "쿠팡 원본매출", render: (row) => money(row.reportedSalesKrw) },
      { key: "reportedNet", header: "쿠팡 원본순매출", render: (row) => money(row.reportedNetSalesKrw) },
      { key: "reportedQty", header: "쿠팡 원본판매수량", render: (row) => numberFmt(row.reportedSalesQuantity) },
      { key: "reportedOrders", header: "쿠팡 원본주문건수", render: (row) => numberFmt(row.reportedOrderCount) },
      { key: "cancel", header: "취소금액", render: (row) => money(row.cancelAmountKrw) }
    );
  }
  if (showReference) {
    columns.splice(1, 0,
      { key: "salesRows", header: "Sales Rows", render: (row) => numberFmt(row.matchedSalesLineCount) },
      { key: "salePrice", header: "참고 판매가", render: (row) => money(row.salePriceKrw) },
      { key: "basePrice", header: "기본 판매가", render: (row) => money(row.baseSalePriceKrw) },
      { key: "promotionPrice", header: "프로모션가", render: (row) => money(row.promotionPriceKrw) },
      { key: "priceSource", header: "가격 출처", render: (row) => row.priceWarnings[0] ? `${row.priceSource} (${row.priceWarnings[0]})` : row.priceSource },
      { key: "saleMethod", header: "판매 방식", render: (row) => row.saleMethod ?? "-" },
      { key: "adConversion", header: "광고 전환매출", render: (row) => money(row.adConversionSalesKrw) },
      { key: "roas", header: "ROAS", render: (row) => percent(row.roas) }
    );
  }
  columns.push({ key: "status", header: "상태/경고", render: (row) => {
    const incompleteChildren = row.children?.filter((child) => child.calculationStatus === "INCOMPLETE") ?? [];
    return [
      `정상:${row.normalCalculationStatus}`,
      `가구매:${row.manualCalculationStatus}`,
      ...(incompleteChildren.length > 0 ? [`제외 상품: ${incompleteChildren.map((child) => child.productName).join(", ")}`] : []),
      ...row.warnings
    ].join(" | ");
  } });
  return columns;
}

function summaryCell(key: string, summary: CoupangProfitSummary) {
  const values: Record<string, string> = {
    actualSales: money(summary.actualSalesKrw), actualNet: money(summary.actualNetSalesKrw), actualQty: numberFmt(summary.actualSalesQuantity),
    productCost: money(summary.productCostKrw), salesFee: money(summary.salesFeeKrw), shipping: money(summary.shippingCostKrw), return: money(summary.returnCostKrw), extra: money(summary.extraCostKrw), vat: money(summary.vatKrw),
    manualQty: numberFmt(summary.manualPurchaseQuantity), manualSales: money(summary.manualPurchaseSalesKrw), manualTotal: money(summary.manualPurchaseTotalCostKrw),
    manualProductCost: money(summary.manualPurchaseProductCostKrw), manualVendor: money(summary.manualPurchaseVendorFeeKrw), manualCoupang: money(summary.manualPurchaseCoupangSalesFeeKrw), manualShipping: money(summary.manualPurchaseShippingCostKrw), manualVat: money(summary.manualPurchaseVatKrw), manualOther: money(summary.manualPurchaseOtherCostKrw),
    adSpend: money(summary.adSpendKrw), organic: money(summary.organicSalesKrw), totalCost: money(summary.isComplete ? summary.totalCostKrw : summary.knownTotalCostKrw), normalMargin: money(summary.normalMarginKrw), margin: money(summary.isComplete ? summary.marginKrw : summary.knownMarginKrw), marginRate: percent(summary.marginRate),
    adConversion: money(summary.adConversionSalesKrw), roas: percent(summary.roas),
    reportedSales: money(summary.reportedSalesKrw), reportedNet: money(summary.reportedNetSalesKrw), reportedQty: numberFmt(summary.reportedSalesQuantity)
  };
  return values[key] ?? "";
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="manual-purchase-metric"><span>{label}</span><strong>{value}</strong></div>;
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
