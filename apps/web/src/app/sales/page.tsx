"use client";

import { useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";
import { buildXlsxWorkbook, downloadXlsx } from "@/lib/xlsx";
import type { XlsxCell } from "@/lib/xlsx";
import {
  type Cafe24CouponAuditResponse,
  type Cafe24CouponAuditRow,
  type CouponAggregateStatus,
  type CouponAuditCategory,
  couponAggregateLabel,
  couponAuditCategory,
  couponAuditLabel,
  couponProductLabel,
  couponScopeLabel,
  salesExcelDataLastRow
} from "@/lib/cafe24-coupon";

type SalesProductPerformance = {
  rows: SalesProductRow[];
  summary: {
    salesLineCount: number;
    salesUnmatchedCount: number;
    adUnmatchedMetricCount: number;
    adUnmatchedSpendUsd: number;
    adUnmatchedSpendKrw: number | null;
    couponDetectedOrderCount: number;
    couponAppliedOrderCount: number;
    couponExactOrderCount: number;
    couponEstimatedOrderCount: number;
    couponUnmatchedOrderCount: number;
    couponDeductionKrw: number;
    couponIgnoredResidualKrw: number;
    couponMissingTotalOrderCount: number;
  };
};

type SalesProductRow = {
  productId: string;
  product?: { displayName?: string | null; name?: string | null; code?: string | null } | null;
  quantity: number;
  revenueKrw: number;
  totalPaidKrw?: number | null;
  adSpendUsd: number;
  adSpendKrw: number | null;
  grossCostKrw: number | null;
  totalCostKrw: number | null;
  marginBeforeCouponKrw: number | null;
  couponDeductionKrw: number;
  marginKrw: number | null;
  roas: number | null;
  cpaKrw: number | null;
  couponOrderCount: number;
  couponExactOrderCount: number;
  couponEstimatedOrderCount: number;
  couponUnmatchedOrderCount: number;
  couponIgnoredResidualKrw: number;
  couponStatus: CouponAggregateStatus;
};

type SalesProductTotals = {
  quantity: number | null;
  revenueKrw: number | null;
  couponDeductionKrw: number;
  adSpendKrw: number | null;
  totalCostKrw: number | null;
  marginBeforeCouponKrw: number | null;
  marginKrw: number | null;
  roas: number | null;
  cpaKrw: number | null;
};

type CouponAuditFilter = "ATTENTION" | CouponAuditCategory | "ALL";

type Cafe24UnmatchedLine = {
  id: string;
  orderDate?: string | null;
  orderNo: string;
  productNo: string;
  productName: string;
  optionName: string;
  quantity: number;
};

const successSummaryStyle = {
  borderColor: "#a9d5c2",
  background: "#eef8f3",
  color: "#13744a"
} as const;

export default function SalesPage() {
  const range = useRange();
  const queryClient = useQueryClient();
  const [couponAuditFilter, setCouponAuditFilter] = useState<CouponAuditFilter>("ATTENTION");
  const query = rangeQuery(range);
  const performance = useQuery({
    queryKey: ["sales-product-performance", range],
    queryFn: () => apiGet<SalesProductPerformance>(`/sales/product-performance?${query}`)
  });
  const unmatched = useQuery({
    queryKey: ["sales-cafe24-unmatched", range],
    queryFn: () => apiGet<Cafe24UnmatchedLine[]>(`/sales/cafe24/unmatched?${query}`)
  });
  const couponMatches = useQuery({
    queryKey: ["sales-cafe24-coupon-matches", range],
    queryFn: () => apiGet<Cafe24CouponAuditResponse>(`/sales/cafe24/coupon-matches?${query}`)
  });
  const rematch = useMutation({
    mutationFn: () => apiPost(`/sales/cafe24/rematch?${query}`, {}),
    onSuccess: () => queryClient.invalidateQueries()
  });

  const summary = performance.data?.summary;
  const productRows = useMemo(() => (performance.data?.rows ?? []).filter(hasSalesOrAdActivity), [performance.data?.rows]);
  const productTotals = useMemo(() => summarizeSalesRows(productRows), [productRows]);
  const couponMatchRows = useMemo(
    () => filterCouponAuditRows(couponMatches.data?.rows ?? [], couponAuditFilter),
    [couponAuditFilter, couponMatches.data?.rows]
  );
  const hasCouponWarning =
    (summary?.couponEstimatedOrderCount ?? 0) > 0 || (summary?.couponUnmatchedOrderCount ?? 0) > 0;

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
        <span>쿠폰 감지 주문 {number(summary?.couponDetectedOrderCount ?? 0)}</span>
        <span>쿠폰 적용 주문 {number(summary?.couponAppliedOrderCount ?? 0)}</span>
        <span>정확 일치 {number(summary?.couponExactOrderCount ?? 0)}</span>
        <span style={hasCouponWarning ? undefined : successSummaryStyle}>추정 일치 {number(summary?.couponEstimatedOrderCount ?? 0)}</span>
        <span style={hasCouponWarning ? undefined : successSummaryStyle}>미적용 {number(summary?.couponUnmatchedOrderCount ?? 0)}</span>
        <span>총 쿠폰 차감 {money(summary?.couponDeductionKrw ?? 0)}</span>
        <span>무시 잔여 차이 {money(summary?.couponIgnoredResidualKrw ?? 0)}</span>
        {(summary?.couponMissingTotalOrderCount ?? 0) > 0 ? (
          <span>총 주문금액 누락 {number(summary?.couponMissingTotalOrderCount ?? 0)}건</span>
        ) : null}
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
                <td>{money(productTotals.couponDeductionKrw)}</td>
                <td>{money(productTotals.adSpendKrw)}</td>
                <td>{money(productTotals.totalCostKrw)}</td>
                <td>{money(productTotals.marginBeforeCouponKrw)}</td>
                <td>{money(productTotals.marginKrw)}</td>
                <td>{ratio(productTotals.roas)}</td>
                <td>{money(productTotals.cpaKrw)}</td>
                <td>
                  {couponCountSummary({
                    couponExactOrderCount: summary?.couponExactOrderCount ?? 0,
                    couponEstimatedOrderCount: summary?.couponEstimatedOrderCount ?? 0,
                    couponUnmatchedOrderCount: summary?.couponUnmatchedOrderCount ?? 0
                  })}
                </td>
              </tr>
            ) : undefined
          }
          columns={[
            { key: "product", header: "제품", render: (row) => row.product?.displayName ?? row.product?.name ?? row.productId },
            { key: "qty", header: "수량", render: (row) => number(row.quantity) },
            { key: "revenue", header: "매출", render: (row) => money(row.revenueKrw) },
            { key: "coupon", header: "쿠폰 차감", render: (row) => money(row.couponDeductionKrw) },
            { key: "ad", header: "광고비", render: (row) => money(row.adSpendKrw) },
            { key: "cost", header: "총비용", render: (row) => money(row.totalCostKrw) },
            { key: "marginBeforeCoupon", header: "쿠폰 적용 전 마진", render: (row) => money(row.marginBeforeCouponKrw) },
            { key: "margin", header: "최종 순마진", render: (row) => money(row.marginKrw) },
            { key: "roas", header: "광고수익률", render: (row) => ratio(row.roas) },
            { key: "cpa", header: "전환당 비용", render: (row) => money(row.cpaKrw) },
            {
              key: "couponStatus",
              header: "쿠폰 상태",
              render: (row) => (
                <span className="toolbar" style={{ flexWrap: "nowrap" }}>
                  <CouponAggregateBadge status={row.couponStatus} />
                  <span>{couponCountSummary(row)}</span>
                </span>
              )
            }
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

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>쿠폰 계산 점검</h2>
            <p className="muted">기본으로 추정 및 미적용 주문을 표시합니다. 정확 일치도 필터에서 확인할 수 있습니다.</p>
          </div>
          <select
            aria-label="쿠폰 계산 점검 상태"
            className="select"
            onChange={(event) => setCouponAuditFilter(event.target.value as CouponAuditFilter)}
            value={couponAuditFilter}
          >
            <option value="ATTENTION">점검 필요 (추정 + 미적용)</option>
            <option value="ESTIMATED">추정</option>
            <option value="UNMATCHED">미적용</option>
            <option value="EXACT">정확</option>
            <option value="ALL">전체</option>
          </select>
        </div>
        {couponMatches.isError ? (
          <div className="warning-strip"><span>쿠폰 계산 점검 데이터를 불러오지 못했습니다.</span></div>
        ) : null}
        <DataTable<Cafe24CouponAuditRow>
          rows={couponMatchRows}
          empty={couponMatches.isLoading ? "쿠폰 계산 결과를 불러오는 중입니다." : "조건에 맞는 쿠폰 주문이 없습니다."}
          getRowKey={(row) => row.orderNo}
          columns={[
            { key: "date", header: "주문일", render: (row) => String(row.orderDate ?? "").slice(0, 10) || "-" },
            { key: "order", header: "주문번호", render: (row) => row.orderNo },
            { key: "products", header: "포함 상품", render: (row) => couponProductLabel(row) },
            { key: "payment", header: "결제수단", render: (row) => row.paymentMethod || "-" },
            { key: "orderTotal", header: "총 주문금액", render: (row) => money(row.totalOrderKrw) },
            { key: "paidTotal", header: "총 결제금액", render: (row) => money(row.totalPaidKrw) },
            { key: "gap", header: "관측 차이", render: (row) => money(row.observedGapKrw) },
            {
              key: "rule",
              header: "선택 쿠폰",
              render: (row) => row.selectedRuleName
                ? `${row.selectedRuleName} · ${couponScopeLabel(row.selectedScope)}`
                : "-"
            },
            { key: "deduction", header: "쿠폰 차감", render: (row) => money(row.couponDeductionKrw) },
            { key: "residual", header: "무시 잔여", render: (row) => money(row.ignoredResidualKrw) },
            { key: "status", header: "상태", render: (row) => <CouponAuditBadge row={row} /> },
            { key: "warnings", header: "경고 코드", render: (row) => row.warningCodes.join(", ") || "-" }
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
  const marginBeforeCouponKrw = nullableSumRows(rows, (row) => row.marginBeforeCouponKrw);
  const marginKrw = nullableSumRows(rows, (row) => row.marginKrw);

  return {
    quantity,
    revenueKrw,
    couponDeductionKrw: sumRows(rows, (row) => row.couponDeductionKrw),
    adSpendKrw,
    totalCostKrw,
    marginBeforeCouponKrw,
    marginKrw,
    roas: divideOrNull(revenueKrw, adSpendKrw),
    cpaKrw: divideOrNull(adSpendKrw, quantity)
  };
}

function hasSalesOrAdActivity(row: SalesProductRow) {
  return (
    hasNonZeroNumber(row.quantity) ||
    hasNonZeroNumber(row.revenueKrw) ||
    hasNonZeroNumber(row.totalPaidKrw) ||
    hasNonZeroNumber(row.adSpendUsd) ||
    hasNonZeroNumber(row.adSpendKrw) ||
    hasNonZeroNumber(row.couponDeductionKrw) ||
    hasNonZeroNumber(row.couponUnmatchedOrderCount)
  );
}

function downloadSalesExcel(
  rows: SalesProductRow[],
  totals: SalesProductTotals,
  summary: SalesProductPerformance["summary"] | undefined,
  range: { from: string; to: string }
) {
  const datePart = range.from === range.to ? range.from : `${range.from}~${range.to}`;
  const headerRowIndex = 9;
  const dataRows = rows.map(
    (row): XlsxCell[] => [
      { value: productLabel(row), style: "Text" },
      { value: toFiniteNumber(row.quantity), style: "Number" },
      { value: toFiniteNumber(row.revenueKrw), style: "Krw" },
      { value: toFiniteNumber(row.couponDeductionKrw), style: "Krw" },
      { value: toFiniteNumber(row.adSpendKrw), style: "Krw" },
      { value: toFiniteNumber(row.totalCostKrw), style: "Krw" },
      { value: toFiniteNumber(row.marginBeforeCouponKrw), style: "Krw" },
      { value: toFiniteNumber(row.marginKrw), style: "Krw" },
      { value: toFiniteNumber(row.roas), style: "Percent" },
      { value: toFiniteNumber(row.cpaKrw), style: "Krw" },
      { value: toFiniteNumber(row.couponExactOrderCount), style: "Number" },
      { value: toFiniteNumber(row.couponEstimatedOrderCount), style: "Number" },
      { value: toFiniteNumber(row.couponUnmatchedOrderCount), style: "Number" }
    ]
  );
  const totalRow: XlsxCell[] = [
    { value: "합계", style: "TotalText" },
    { value: totals.quantity, style: "TotalNumber" },
    { value: totals.revenueKrw, style: "TotalKrw" },
    { value: totals.couponDeductionKrw, style: "TotalKrw" },
    { value: totals.adSpendKrw, style: "TotalKrw" },
    { value: totals.totalCostKrw, style: "TotalKrw" },
    { value: totals.marginBeforeCouponKrw, style: "TotalKrw" },
    { value: totals.marginKrw, style: "TotalKrw" },
    { value: totals.roas, style: "TotalPercent" },
    { value: totals.cpaKrw, style: "TotalKrw" },
    { value: summary?.couponExactOrderCount ?? 0, style: "TotalNumber" },
    { value: summary?.couponEstimatedOrderCount ?? 0, style: "TotalNumber" },
    { value: summary?.couponUnmatchedOrderCount ?? 0, style: "TotalNumber" }
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
    [
      { value: "쿠폰 감지 주문", style: "Header" },
      { value: summary?.couponDetectedOrderCount ?? 0, style: "Number" },
      { value: "쿠폰 적용 주문", style: "Header" },
      { value: summary?.couponAppliedOrderCount ?? 0, style: "Number" }
    ],
    [
      { value: "정확 일치", style: "Header" },
      { value: summary?.couponExactOrderCount ?? 0, style: "Number" },
      { value: "추정 일치", style: "Header" },
      { value: summary?.couponEstimatedOrderCount ?? 0, style: "Number" }
    ],
    [
      { value: "미적용", style: "Header" },
      { value: summary?.couponUnmatchedOrderCount ?? 0, style: "Number" },
      { value: "총 쿠폰 차감", style: "Header" },
      { value: summary?.couponDeductionKrw ?? 0, style: "Krw" }
    ],
    [
      { value: "무시 잔여 차이", style: "Header" },
      { value: summary?.couponIgnoredResidualKrw ?? 0, style: "Krw" },
      { value: "총 주문금액 누락", style: "Header" },
      { value: summary?.couponMissingTotalOrderCount ?? 0, style: "Number" }
    ],
    [],
    [
      { value: "제품", style: "Header" },
      { value: "수량", style: "Header" },
      { value: "매출", style: "Header" },
      { value: "쿠폰 차감", style: "Header" },
      { value: "광고비", style: "Header" },
      { value: "총비용", style: "Header" },
      { value: "쿠폰 적용 전 마진", style: "Header" },
      { value: "최종 순마진", style: "Header" },
      { value: "광고수익률", style: "Header" },
      { value: "전환당 비용", style: "Header" },
      { value: "정확 주문 수", style: "Header" },
      { value: "추정 주문 수", style: "Header" },
      { value: "미적용 주문 수", style: "Header" }
    ],
    ...dataRows,
    totalRow
  ];
  const workbook = buildXlsxWorkbook({
    sheetName: "판매",
    columns: [
      { width: 28 },
      { width: 11 },
      { width: 15 },
      { width: 15 },
      { width: 15 },
      { width: 15 },
      { width: 19 },
      { width: 15 },
      { width: 13 },
      { width: 15 },
      { width: 13 },
      { width: 13 },
      { width: 15 }
    ],
    rows: excelRows,
    freezeRow: headerRowIndex,
    autoFilter: { fromRow: headerRowIndex, toRow: salesExcelDataLastRow(excelRows.length) }
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

function sumRows(rows: SalesProductRow[], selector: (row: SalesProductRow) => number | null | undefined) {
  return rows.reduce((total, row) => total + (toFiniteNumber(selector(row)) ?? 0), 0);
}

function filterCouponAuditRows(rows: Cafe24CouponAuditRow[], filter: CouponAuditFilter) {
  if (filter === "ALL") {
    return rows;
  }
  if (filter === "ATTENTION") {
    return rows.filter((row) => couponAuditCategory(row) !== "EXACT");
  }
  return rows.filter((row) => couponAuditCategory(row) === filter);
}

function couponCountSummary(row: {
  couponExactOrderCount: number;
  couponEstimatedOrderCount: number;
  couponUnmatchedOrderCount: number;
}) {
  return `정확 ${number(row.couponExactOrderCount)} / 추정 ${number(row.couponEstimatedOrderCount)} / 미적용 ${number(row.couponUnmatchedOrderCount)}`;
}

function CouponAggregateBadge({ status }: { status: CouponAggregateStatus }) {
  const className =
    status === "EXACT" ? "badge scale" :
      status === "ESTIMATED" || status === "MIXED" ? "badge watch" :
        status === "UNMATCHED" ? "badge stop_candidate" :
          "badge keep";
  return <span className={className}>{couponAggregateLabel(status)}</span>;
}

function CouponAuditBadge({ row }: { row: Cafe24CouponAuditRow }) {
  const category = couponAuditCategory(row);
  const className =
    category === "EXACT" ? "badge scale" :
      category === "ESTIMATED" ? "badge watch" :
        "badge stop_candidate";
  return <span className={className}>{couponAuditLabel(row)}</span>;
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

function hasNonZeroNumber(value: unknown) {
  const parsed = toFiniteNumber(value);
  return parsed !== null && Math.abs(parsed) > 0;
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
