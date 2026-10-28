"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PermissionPage } from "@/components/permission-page";
import { useAuth } from "@/features/auth/use-auth";
import { apiGet } from "@/lib/api";
import { PerformanceFilters } from "./filters";
import { PerformanceKpis } from "./kpis";
import { ComparisonTable } from "./comparison-table";
import { PerformanceCharts } from "./charts";
import { DiagnosticsPanel } from "./diagnostics";
import { assertResponse, changeFilters, dashboardError, dashboardKey, defaultFilters, filterParams, loadDashboard, parseFilters, responseMatches, validateFilters } from "./model";
import type { DashboardData, Diagnostic, Filters, Options, PageResult } from "./types";

const QUERY_OPTIONS = { retry: false, staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

export function ProductPerformancePage() {
  const { user, permissions } = useAuth();
  const identity = `${user?.id ?? "anonymous"}:${[...(permissions ?? [])].sort().join(",")}`;
  return <PermissionPage permission="data.read"><Performance key={identity} identity={identity} /></PermissionPage>;
}

function Performance({ identity }: { identity: string }) {
  const searchParams = useSearchParams(), pathname = usePathname(), client = useQueryClient();
  const search = searchParams.toString();
  const { filters, urlError } = useMemo(() => {
    try { return { filters: parseFilters(new URLSearchParams(search)), urlError: null }; }
    catch { return { filters: defaultFilters(), urlError: "URL의 조회 조건이 올바르지 않습니다. 필터를 다시 선택해 주세요." }; }
  }, [search]);
  const invalid = urlError ?? validateFilters(filters);
  const empty = filters.platforms.length === 0 || filters.scopeKeys?.length === 0;
  // Options are metadata for the selected platforms. An explicit account selection must not hide alternative accounts.
  const optionFilters = { ...filters, productName: "", scopeKeys: undefined };
  const optionQuery = filterParams(optionFilters).toString();
  const options = useQuery({ ...QUERY_OPTIONS, queryKey: ["product-performance-options", identity, optionQuery], enabled: !invalid,
    queryFn: () => apiGet<Options>(`/unified-performance/options?${optionQuery}`) });
  const key = dashboardKey(identity, filters);
  const query = useQuery({ ...QUERY_OPTIONS, queryKey: key, enabled: !invalid && !empty,
    queryFn: ({ signal }) => loadDashboard(filters, apiGet, signal) });
  // Never attach previous selection data, or partially refreshed endpoints, to a new filter label.
  const data = !invalid && !empty && !query.isFetching && !query.isError && query.data && responseMatches(query.data.summary, filters) ? query.data : undefined;
  const optionData = !options.isError && !options.isFetching ? options.data : undefined;
  const [pageError, setPageError] = useState("");
  const [paging, setPaging] = useState(false);
  const lock = useRef(false);
  const activeSearch = useRef(search);
  activeSearch.current = search;
  useEffect(() => { setPageError(""); }, [search]);
  const change = (raw: Filters) => {
    const next = changeFilters(filters, raw, options.data?.scopes ?? []);
    window.history.pushState(null, "", `${pathname}?${filterParams(next, true).toString()}`);
  };
  const refresh = () => { setPageError(""); void options.refetch(); if (!invalid && !empty) void query.refetch(); };
  const moreDiagnostics = async () => {
    if (!data?.diagnostics.nextCursor || lock.current) return;
    lock.current = true; setPaging(true); setPageError("");
    try {
      const next = await apiGet<PageResult<Diagnostic>>(`/unified-performance/diagnostics?${filterParams(filters)}&cursor=${encodeURIComponent(data.diagnostics.nextCursor)}`);
      if (activeSearch.current !== search) return;
      assertResponse(next, filters, data.summary);
      client.setQueryData<DashboardData>(key, old => old && old.summary.snapshotHash === next.snapshotHash ? {
        ...old, diagnostics: { ...next, items: [...old.diagnostics.items, ...next.items] }
      } : old);
    } catch (error) {
      if (activeSearch.current !== search) return;
      setPageError(dashboardError(error));
      // A cursor cannot be continued across a newly published snapshot. Restart all panels together.
      void client.invalidateQueries({ queryKey: key, exact: true });
    } finally { lock.current = false; setPaging(false); }
  };
  return <section className="page" style={{ display: "grid", gap: 16 }}>
    <div className="page-heading"><div><h1>제품 통합 성과</h1><p>고정 제품명의 판매·광고비·추정이익을 같은 범위로 확인합니다.</p></div>
      <div className="toolbar" style={{ flexWrap: "wrap" }}><button type="button" className="button" disabled={query.isFetching || options.isFetching || Boolean(invalid)} onClick={refresh}>다시 조회</button>
        <Link className="button" href="/products/mappings">제품명과 배분 설정</Link></div></div>
    <PerformanceFilters value={filters} options={optionData} onChange={change} />
    {invalid ? <div className="panel" role="alert">{invalid}</div> : null}
    {!invalid && options.isError ? <div className="panel" role="alert">조회 조건 목록: {dashboardError(options.error)}</div> : null}
    {!invalid && empty ? <div className="panel" role="status">{filters.platforms.length === 0 ? "플랫폼을 선택하세요." : "계정·스토어를 선택하세요."} 선택하지 않은 범위는 0원으로 표시하지 않습니다.</div> : null}
    {!invalid && !empty && query.isFetching ? <div className="panel" role="status" aria-busy="true">선택한 범위의 성과와 발행 버전을 확인하고 있습니다.</div> : null}
    {!invalid && !empty && query.isError ? <div className="panel" role="alert">{dashboardError(query.error)}</div> : null}
    {data ? <>
      <div className="warning-strip" role="status"><span>{data.summary.selectedPlatforms.length === 5 ? "전체 플랫폼 기준" : "선택 플랫폼 기준"}</span>
        {data.summary.selectedPlatforms.includes("NAVER") ? <span>추정 데이터 포함 · 네이버는 기존 저장 결과 기준입니다.</span> : null}
        {data.summary.provisional ? <span>당일 이후가 포함된 잠정 자료</span> : null}
        <span>기간 {data.summary.selection.from} ~ {data.summary.selection.to} · 한국시간</span></div>
      <PerformanceKpis data={data.summary} />
      {Object.values(data.summary.knownTotals).every(value => value === null) ? <div className="panel" role="status">선택 범위에 확인 가능한 발행 데이터가 없습니다. 아래 진단에서 미수집·미매핑과 적용 여부를 확인하세요.</div> : null}
      <PerformanceCharts data={data} />
      <ComparisonTable data={data.summary} />
      <DiagnosticsPanel data={data} />
      {data.diagnostics.nextCursor ? <div className="toolbar"><span>상세 진단 {data.diagnostics.items.length} / {data.diagnostics.total}개</span>
        <button type="button" className="button" disabled={paging} onClick={() => void moreDiagnostics()}>{paging ? "진단을 읽는 중…" : "다음 진단 100개"}</button></div> : null}
      {pageError ? <div className="panel" role="alert">{pageError}</div> : null}
      <p className="muted">선택 변경은 저장된 원천별 배분을 유지한 조회입니다. 제외 비용을 남은 플랫폼에 재배분하지 않으며, 광고 중단 후 매출·이익을 예측하는 값이 아닙니다.</p>
    </> : null}
  </section>;
}
