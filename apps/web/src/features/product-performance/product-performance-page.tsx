"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PermissionPage } from "@/components/permission-page";
import { useAuth } from "@/features/auth/use-auth";
import { apiGet } from "@/lib/api";
import { PerformanceFilters } from "./filters";
import { DiagnosticsPanel } from "./diagnostics";
import { ChangeAnalysis } from "./change-analysis";
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
    try { return { filters: { ...parseFilters(new URLSearchParams(search)), grain: "day" as const }, urlError: null }; }
    catch { return { filters: defaultFilters(), urlError: "URL의 조회 조건이 올바르지 않습니다. 필터를 다시 선택해 주세요." }; }
  }, [search]);
  const invalid = urlError ?? validateFilters(filters);
  const empty = filters.platforms.length === 0 || filters.scopeKeys?.length === 0;
  // The server projects alternative product names separately from financial
  // payloads. Keep the chosen product so options do not load every product's money.
  // An explicit account selection must still expose alternative accounts.
  const optionFilters = { ...filters, scopeKeys: undefined };
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
  const [showDiagnostics, setShowDiagnostics] = useState(false);
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
    <div className="page-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}><div><h1>제품 통합 성과</h1><p>광고비가 바뀐 뒤, 어디에서 매출과 이익이 달라졌는지 확인하세요.</p></div>
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <label className="field" style={{ minWidth: 180 }}>분석 제품
          <select className="select" value={filters.productName} onChange={event => change({ ...filters, productName: event.target.value })}>
            <option value="">전체 제품</option>
            {filters.productName && !optionData?.products.some(product => product.productName === filters.productName) ? <option value={filters.productName}>{filters.productName}</option> : null}
            {optionData?.products.map(product => <option key={product.productName} value={product.productName}>{product.productName}{product.historical ? " (과거 발행)" : product.active ? "" : " (비활성)"}</option>)}
          </select>
        </label>
        <button type="button" className="button" disabled={query.isFetching || options.isFetching || Boolean(invalid)} onClick={refresh}>다시 조회</button>
      </div></div>
    <details className="panel" open={Boolean(invalid) || empty}>
      <summary style={{ cursor: "pointer", color: "#61766d", fontSize: 13 }}>조회 범위 설정 · {filters.from} ~ {filters.to} · {filters.platforms.length}개 플랫폼</summary>
      <div style={{ marginTop: 12 }}><PerformanceFilters value={filters} options={optionData} onChange={change} showProduct={false} showGrain={false} /></div>
    </details>
    {invalid ? <div className="panel" role="alert">{invalid}</div> : null}
    {!invalid && options.isError ? <div className="panel" role="alert">조회 조건 목록: {dashboardError(options.error)}</div> : null}
    {!invalid && empty ? <div className="panel" role="status">{filters.platforms.length === 0 ? "플랫폼을 선택하세요." : "계정·스토어를 선택하세요."} 선택하지 않은 범위는 0원으로 표시하지 않습니다.</div> : null}
    {!invalid && !empty && query.isFetching ? <div className="panel" role="status" aria-busy="true">선택한 범위의 성과와 발행 버전을 확인하고 있습니다.</div> : null}
    {!invalid && !empty && query.isError ? <div className="panel" role="alert">{dashboardError(query.error)}</div> : null}
    {data ? <>
      {Object.values(data.summary.knownTotals).every(value => value === null) ? <div className="panel" role="status">선택 범위에 확인 가능한 발행 데이터가 없습니다. 아래 데이터 확인에서 미수집·미매핑과 적용 여부를 확인하세요.</div> : null}
      <ChangeAnalysis key={filterParams(filters).toString()} data={data} filters={filters} />
      <details className="panel" onToggle={event => setShowDiagnostics(event.currentTarget.open)}>
        <summary style={{ cursor: "pointer", color: "#61766d", fontSize: 13 }}>원천 데이터 상세 진단{data.summary.provisional ? " · 잠정 자료" : ""}{data.summary.isEstimate ? " · 추정 데이터 포함" : ""}</summary>
        {showDiagnostics ? <>
          <DiagnosticsPanel data={data} />
      {data.diagnostics.nextCursor ? <div className="toolbar"><span>상세 진단 {data.diagnostics.items.length} / {data.diagnostics.total}개</span>
        <button type="button" className="button" disabled={paging} onClick={() => void moreDiagnostics()}>{paging ? "진단을 읽는 중…" : "다음 진단 100개"}</button></div> : null}
        </> : null}
      </details>
      {pageError ? <div className="panel" role="alert">{pageError}</div> : null}
      <p className="muted" style={{ fontSize: 12 }}>선택 매체와 다른 매체의 광고비, 행사·가격·품절이 함께 변할 수 있습니다. 관측된 전후 변화이며 선택 매체만의 광고 효과를 뜻하지 않습니다. <Link href="/products/mappings">제품명과 배분 설정</Link></p>
    </> : null}
  </section>;
}
