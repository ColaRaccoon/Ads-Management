"use client";

import { AlertTriangle, PlayCircle } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost, DashboardSummary, DecisionLog, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { KpiCard } from "@/components/kpi-card";
import { DataTable } from "@/components/data-table";
import { DecisionBadge } from "@/components/decision-badge";
import { ProductBarChart, StageBarChart, TrendChart } from "@/components/Charts";

export default function DashboardPage() {
  const range = useRange();
  const [deliveryStatus, setDeliveryStatus] = useState("active");
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryKey: ["dashboard-summary", range, deliveryStatus],
    queryFn: () => apiGet<DashboardSummary>(`/dashboard/summary?${rangeQuery(range, { deliveryStatus })}`)
  });
  const trends = useQuery({
    queryKey: ["dashboard-trends", range, deliveryStatus],
    queryFn: () => apiGet<Array<Record<string, unknown>>>(`/dashboard/trends?${rangeQuery(range, { deliveryStatus })}`)
  });
  const products = useQuery({
    queryKey: ["products-performance", range, deliveryStatus],
    queryFn: () => apiGet<Array<Record<string, any>>>(`/metrics/products?${rangeQuery(range, { deliveryStatus })}`)
  });
  const stages = useQuery({
    queryKey: ["stage-trends", range, deliveryStatus],
    queryFn: () => apiGet<Array<Record<string, any>>>(`/dashboard/trends?${rangeQuery(range, { deliveryStatus, groupBy: "stage" })}`)
  });
  const runDecision = useMutation({
    mutationFn: () => apiPost("/decisions/run", { ...range, filters: { deliveryStatus } }),
    onSuccess: () => queryClient.invalidateQueries()
  });

  const data = summary.data;
  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Dashboard</h1>
          <p>기간 합계 기반 CPA/CTR/CPC와 운영 판정 후보를 확인합니다.</p>
        </div>
        <div className="toolbar">
        <select className="select" value={deliveryStatus} onChange={(event) => setDeliveryStatus(event.target.value)}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>
        <button className="button primary" type="button" onClick={() => runDecision.mutate()}>
          <PlayCircle size={16} />
          판정 실행
        </button>
        </div>
      </div>

      {summary.isError ? <div className="warning-strip"><span><AlertTriangle size={15} />API 연결 또는 DB 설정이 필요합니다.</span></div> : null}

      <div className="warning-strip">
        <span><AlertTriangle size={15} />미매칭 {data?.health.unmatchedCount ?? 0}</span>
        <span><AlertTriangle size={15} />원가 기준 미설정 {data?.health.missingCostRuleCount ?? 0}</span>
        <span><AlertTriangle size={15} />CPA 기준 미설정 {data?.health.missingCpaRuleCount ?? 0}</span>
        <span><AlertTriangle size={15} />환율 미확보 {data?.health.missingExchangeRateCount ?? 0}</span>
        <span><AlertTriangle size={15} />업로드 오류 {data?.health.uploadErrorCount ?? 0}</span>
      </div>

      <div className="grid kpi">
        <KpiCard label="총 광고비" value={dashboardMoney(data?.totals.spendKrw)} helper={`${dashboardMoney(data?.totals.spendUsd, "USD")} 원본`} />
        <KpiCard label="총 구매수" value={dashboardNumber(data?.totals.purchaseCount)} helper={`${data?.selectedPeriod.dataDays ?? 0} data days`} />
        <KpiCard label="누적 CPA" value={dashboardMoney(data?.totals.cpaKrw)} helper="기간 합계 기반" />
        <KpiCard label="총 매출" value={dashboardMoney(data?.totals.revenueKrw)} />
        <KpiCard label="총 마진" value={dashboardMoney(data?.totals.marginKrw)} />
      </div>

      <div className="grid two" style={{ marginTop: 12 }}>
        <div className="panel">
          <h2>Trend</h2>
          <TrendChart data={trends.data ?? []} />
        </div>
        <div className="panel">
          <h2>자동 판정</h2>
          <DataTable<DecisionLog>
            rows={data?.decisions.topRecommendations ?? []}
            columns={[
              { key: "decision", header: "판정", render: (row) => <DecisionBadge decision={row.decision} /> },
              { key: "scope", header: "Scope", render: (row) => row.scopeType },
              { key: "reason", header: "근거", render: (row) => row.reason }
            ]}
          />
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 12 }}>
        <div className="panel">
          <h2>제품별 광고비/마진</h2>
          <ProductBarChart
            data={(products.data ?? []).map((row) => ({
              name: row.product?.displayName ?? "미매칭",
              spendKrw: row.totals?.spendKrw ?? 0,
              marginKrw: row.totals?.marginKrw ?? 0
            }))}
          />
        </div>
        <div className="panel">
          <h2>SC/CBO/ASC 단계 현황</h2>
          <StageBarChart data={collapseStageRows(stages.data ?? [])} />
        </div>
      </div>
    </section>
  );
}

function collapseStageRows(rows: Array<Record<string, any>>) {
  const map = new Map<string, { group: string; spendKrw: number; purchaseCount: number }>();
  for (const row of rows) {
    const group = String(row.group ?? "UNKNOWN");
    const current = map.get(group) ?? { group, spendKrw: 0, purchaseCount: 0 };
    current.spendKrw += Number(row.spendKrw ?? 0);
    current.purchaseCount += Number(row.purchaseCount ?? 0);
    map.set(group, current);
  }
  return Array.from(map.values());
}

function roundDown(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return Math.floor(value);
}

function dashboardMoney(value: number | null | undefined, currency = "KRW") {
  const number = roundDown(value);
  if (number === null) {
    return "-";
  }
  if (currency === "USD") {
    return `$${number.toLocaleString("en-US")}`;
  }
  return `${number.toLocaleString("ko-KR")}원`;
}

function dashboardNumber(value: number | null | undefined) {
  const number = roundDown(value);
  return number === null ? "-" : number.toLocaleString("ko-KR");
}
