"use client";

import { AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { KpiCard } from "@/components/kpi-card";
import { DataTable, type Column } from "@/components/data-table";
import type { CoupangDashboardResponse, CoupangGroupBy, CoupangProductProfitRow } from "@/types/coupang";

export default function CoupangDashboardPage() {
  const range = useRange();
  const [groupBy, setGroupBy] = useState<CoupangGroupBy>("product");
  const [showReported, setShowReported] = useState(false);
  const dashboard = useQuery({
    queryKey: ["coupang-dashboard", range, groupBy],
    queryFn: () => apiGet<CoupangDashboardResponse>(`/coupang/dashboard?${rangeQuery(range, { groupBy })}`)
  });
  const data = dashboard.data;
  const columns: Column<CoupangProductProfitRow>[] = [
    { key: "product", header: groupBy === "group" ? "제품그룹" : "상품", render: (row) => row.productName },
    ...(showReported ? [
      { key: "reportedNet", header: "쿠팡 원본순매출", render: (row: CoupangProductProfitRow) => money(row.reportedNetSalesKrw) },
      { key: "reportedQty", header: "쿠팡 원본판매수량", render: (row: CoupangProductProfitRow) => numberFmt(row.reportedSalesQuantity) }
    ] : []),
    { key: "actualNet", header: "순매출", render: (row) => money(row.actualNetSalesKrw) },
    { key: "actualQty", header: "판매수량", render: (row) => numberFmt(row.actualSalesQuantity) },
    { key: "manualSales", header: "가구매 매출 조정", render: (row) => money(row.manualPurchaseSalesKrw) },
    { key: "manualCost", header: "가구매 비용(업체수수료)", render: (row) => money(row.manualPurchaseTotalCostKrw) },
    { key: "adSpend", header: "광고비", render: (row) => money(row.adSpendKrw) },
    { key: "organic", header: "유기적 매출", render: (row) => money(row.organicSalesKrw) },
    { key: "normalMargin", header: "정상 판매 순이익", render: (row) => money(row.normalMarginKrw) },
    { key: "margin", header: "최종/부분 순이익", render: (row) => row.calculationStatus === "COMPLETE" ? money(row.marginKrw) : row.rowType === "GROUP" ? `${money(row.knownMarginKrw)} (부분)` : "-" },
    { key: "status", header: "상태", render: (row) => {
      const incompleteChildren = row.children?.filter((child) => child.calculationStatus === "INCOMPLETE") ?? [];
      return [
        `정상:${row.normalCalculationStatus} / 가구매:${row.manualCalculationStatus}`,
        ...(incompleteChildren.length > 0 ? [`제외 상품: ${incompleteChildren.map((child) => child.productName).join(", ")}`] : []),
        ...row.warnings
      ].join(" | ");
    } }
  ];

  return (
    <section className="page">
      <div className="page-title"><div><h1>Coupang Dashboard</h1><p>원본 판매와 가구매를 분리한 정상 판매 손익 및 가구매 업체수수료 요약입니다.</p></div></div>
      {dashboard.isError ? <div className="warning-strip"><AlertTriangle size={15} /> Coupang API or database settings need attention.</div> : null}
      <div className="warning-strip">
        <span><AlertTriangle size={15} /> Missing cost rules {data?.summary.missingCostRuleCount ?? 0}</span>
        <span><AlertTriangle size={15} /> 계산 불완전 {data?.summary.incompleteProductCount ?? 0}개 상품 / 제외 순매출 {money(data?.summary.excludedNetSalesKrw)}</span>
        <span><AlertTriangle size={15} /> Warnings {data?.summary.warningCount ?? 0}</span>
      </div>
      <div className="grid kpi">
        <KpiCard label="순매출" value={money(data?.summary.actualNetSalesKrw)} />
        <KpiCard label="판매수량" value={numberFmt(data?.summary.actualSalesQuantity)} />
        <KpiCard
          label={data?.summary.isComplete === false ? "계산 가능한 상품 순이익(부분 합계)" : "최종 순이익"}
          value={money(data?.summary.isComplete === false ? data.summary.knownMarginKrw : data?.summary.marginKrw)}
          helper={data?.summary.isComplete === false ? `${data.summary.incompleteProductCount}개 상품 제외` : percent(data?.summary.marginRate)}
        />
        <KpiCard label="광고비" value={money(data?.summary.adSpendKrw)} />
        <KpiCard label="유기적 매출" value={money(data?.summary.organicSalesKrw)} />
        <KpiCard label="가구매 수량" value={numberFmt(data?.summary.manualPurchaseQuantity)} />
        <KpiCard label="가구매 매출 조정" value={money(data?.summary.manualPurchaseSalesKrw)} />
        <KpiCard label="정상 판매 순이익" value={money(data?.summary.normalMarginKrw)} />
        <KpiCard label="가구매 비용(업체수수료)" value={money(data?.summary.manualPurchaseTotalCostKrw)} />
        <KpiCard label="ROAS" value={percent(data?.summary.roas)} />
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <div className="toolbar">
          <h2>Product Summary</h2>
          <select className="input" value={groupBy} onChange={(event) => setGroupBy(event.target.value as CoupangGroupBy)}><option value="product">By Option</option><option value="group">By Product Group</option></select>
          <label><input type="checkbox" checked={showReported} onChange={(event) => setShowReported(event.target.checked)} /> 원본값 보기</label>
        </div>
        <DataTable rows={data?.rows ?? []} columns={columns} rowClassName={(row) => row.calculationStatus === "INCOMPLETE" ? "incomplete-row" : undefined} />
      </div>
    </section>
  );
}

function money(value: number | null | undefined) { return value === null || value === undefined || Number.isNaN(value) ? "-" : `${Math.round(value).toLocaleString("ko-KR")}원`; }
function numberFmt(value: number | null | undefined) { return value === null || value === undefined || Number.isNaN(value) ? "-" : value.toLocaleString("ko-KR"); }
function percent(value: number | null | undefined) { return value === null || value === undefined || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(1)}%`; }
