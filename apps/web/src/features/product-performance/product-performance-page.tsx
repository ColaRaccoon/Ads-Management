"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PermissionPage } from "@/components/permission-page";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/features/auth/use-auth";
import { PerformanceFilters } from "./filters";
import { DiagnosticsPanel } from "./diagnostics";
import { DailyReport } from "./daily-report";
import { ChangeAnalysis } from "./change-analysis";
import { changeFilters, dashboardError, dashboardKey, defaultFilters, diagnosticsKey, filterParams, loadDashboard, loadDiagnostics, parseFilters, readPerformance, responseMatches, selectionOptionsKey, validateFilters } from "./model";
import type { Diagnostic, Filters, SelectionOptions, PageResult } from "./types";

const QUERY_OPTIONS = { retry: false, staleTime: 30_000, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

export function ProductPerformancePage() {
  const { user, permissions } = useAuth();
  const identity = `${user?.id ?? "anonymous"}:${[...(permissions ?? [])].sort().join(",")}`;
  return <PermissionPage permission="data.read"><Performance key={identity} identity={identity} /></PermissionPage>;
}

function Performance({ identity }: { identity: string }) {
  const searchParams = useSearchParams(), pathname = usePathname(), client = useQueryClient();
  const search = searchParams.toString();
  const view = searchParams.get("view") === "daily" ? "daily" : "analysis";
  const setView = (next: "analysis" | "daily") => { const params = new URLSearchParams(search); params.set("view", next); window.history.pushState(null, "", `${pathname}?${params}`); };
  const setDailyDate = (date: string) => { const params = new URLSearchParams(search); params.set("view", "daily"); if (date) params.set("dailyDate", date); else params.delete("dailyDate"); window.history.pushState(null, "", `${pathname}?${params}`); };
  const { filters, urlError } = useMemo(() => {
    try { return { filters: { ...parseFilters(new URLSearchParams(search)), grain: "day" as const }, urlError: null }; }
    catch { return { filters: defaultFilters(), urlError: "URL의 조회 조건이 올바르지 않습니다. 필터를 다시 선택해 주세요." }; }
  }, [search]);
  const currentDates = defaultFilters();
  const optionBase = view === "daily" ? { ...filters, from: currentDates.from, to: currentDates.to, compareMode: "previous" as const, compareFrom: currentDates.compareFrom, compareTo: currentDates.compareTo } : filters;
  const invalid = urlError ?? validateFilters(optionBase);
  const empty = filters.platforms.length === 0 || filters.scopeKeys?.length === 0;
  // Metadata is independent of the selected product and exposes alternative authorized accounts.
  const optionFilters = { ...optionBase, productName: "", scopeKeys: undefined };
  const optionQuery = filterParams(optionFilters).toString();
  const options = useQuery({ ...QUERY_OPTIONS, queryKey: selectionOptionsKey(identity, optionBase), staleTime: 300_000, enabled: !invalid,
    queryFn: ({ signal }) => readPerformance<SelectionOptions>(`/unified-performance/selection-options?${optionQuery}`, signal) });
  const key = dashboardKey(identity, filters);
  const query = useQuery({ ...QUERY_OPTIONS, queryKey: key, enabled: view === "analysis" && !invalid && !empty,
    queryFn: ({ signal }) => loadDashboard(filters, readPerformance, signal) });
  // Never attach previous selection data, or partially refreshed endpoints, to a new filter label.
  const data = !invalid && !empty && !query.isError && query.data && responseMatches(query.data.summary, filters) ? query.data : undefined;
  const optionData = !options.isError ? options.data : undefined;
  const [pageError, setPageError] = useState("");
  const [paginationNeedsRefresh, setPaginationNeedsRefresh] = useState(false);
  const [paging, setPaging] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const diagnosticKey = diagnosticsKey(identity, filters, data?.summary);
  const diagnostics = useQuery({ ...QUERY_OPTIONS, queryKey: diagnosticKey, enabled: view === "analysis" && showDiagnostics && Boolean(data),
    queryFn: ({ signal }) => loadDiagnostics(filters, data!.summary, undefined, readPerformance, signal) });
  const diagnosticData = data && diagnostics.data && diagnostics.data.snapshotHash === data.summary.snapshotHash ? diagnostics.data : undefined;
  const lock = useRef(false);
  const activeSearch = useRef(search);
  activeSearch.current = search;
  useEffect(() => { setPageError(""); setPaginationNeedsRefresh(false); }, [search]);
  const change = (raw: Filters) => {
    const next = changeFilters(filters, raw, options.data?.scopes ?? []);
    const params = filterParams(next, true);
    if (view === "daily") params.set("view", "daily");
    if (searchParams.get("dailyDate")) params.set("dailyDate", searchParams.get("dailyDate")!);
    window.history.pushState(null, "", `${pathname}?${params}`);
  };
  const refresh = () => { setPageError(""); setPaginationNeedsRefresh(false); void options.refetch(); if (!invalid && !empty) void query.refetch(); };
  const moreDiagnostics = async () => {
    if (!data || !diagnosticData?.nextCursor || lock.current) return;
    lock.current = true; setPaging(true); setPageError("");
    try {
      const next = await loadDiagnostics(filters, data.summary, diagnosticData.nextCursor);
      if (activeSearch.current !== search) return;
      client.setQueryData<PageResult<Diagnostic>>(diagnosticKey, old => old && old.snapshotHash === next.snapshotHash ? {
        ...next, items: [...old.items, ...next.items]
      } : old);
    } catch (error) {
      if (activeSearch.current !== search) return;
      setPageError(dashboardError(error));
      setPaginationNeedsRefresh(error instanceof ApiError && error.status === 409);
      // Keep calculated results visible. A diagnostics failure must not discard dashboard data.
    } finally { lock.current = false; setPaging(false); }
  };
  return <section className="page integrated-performance-page" style={{ display: "grid", gap: 16 }}>
    <div className="page-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}><div><h1>제품 통합 성과</h1><p>{view === "daily" ? "선택일의 매출·이익·광고비와 전일 대비 변화를 확인하고 보고서를 출력하세요." : "광고비가 바뀐 뒤, 어디에서 매출과 이익이 달라졌는지 확인하세요."}</p></div>
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <label className="field" style={{ minWidth: 180 }}>분석 제품
          <select className="select" value={filters.productName} onChange={event => change({ ...filters, productName: event.target.value })}>
            <option value="">전체 제품</option>
            {filters.productName && !optionData?.products.some(product => product.productName === filters.productName) ? <option value={filters.productName}>{filters.productName}</option> : null}
            {optionData?.products.map(product => <option key={product.productName} value={product.productName}>{product.productName}{product.historical ? " (과거 발행)" : product.active ? "" : " (비활성)"}</option>)}
          </select>
        </label>
        {view === "analysis" ? <button type="button" className="button" disabled={query.isFetching || options.isFetching || Boolean(invalid)} onClick={refresh}>다시 조회</button> : null}
      </div></div>
    <div className="integrated-performance-tabs" role="tablist" aria-label="제품 통합 성과 보기"><button type="button" role="tab" id="performance-analysis-tab" aria-controls="performance-analysis-panel" aria-selected={view === "analysis"} onClick={() => setView("analysis")}>광고비 변화 분석</button><button type="button" role="tab" id="performance-daily-tab" aria-controls="performance-daily-panel" aria-selected={view === "daily"} onClick={() => setView("daily")}>데일리 보고</button></div>
    <details className="panel" open={Boolean(invalid) || empty}>
      <summary style={{ cursor: "pointer", color: "#61766d", fontSize: 13 }}>조회 범위 설정 · {view === "daily" ? "제품·플랫폼·계정 선택" : `${filters.from} ~ ${filters.to}`} · {filters.platforms.length}개 플랫폼</summary>
      <div style={{ marginTop: 12 }}><PerformanceFilters value={filters} options={optionData} onChange={change} showProduct={false} showGrain={false} showPeriod={view !== "daily"} /></div>
    </details>
    {invalid ? <div className="panel" role="alert">{invalid}</div> : null}
    {!invalid && options.isError ? <div className="panel" role="alert">조회 조건 목록: {dashboardError(options.error)}</div> : null}
    {!invalid && empty ? <div className="panel" role="status">{filters.platforms.length === 0 ? "플랫폼을 선택하세요." : "계정·스토어를 선택하세요."} 선택하지 않은 범위는 0원으로 표시하지 않습니다.</div> : null}
    {!invalid && !empty && view === "daily" ? <DailyReport identity={identity} filters={filters} options={optionData} requestedDate={searchParams.get("dailyDate") ?? ""} onDateChange={setDailyDate} onRefreshLatest={() => { void options.refetch(); }} /> : null}
    {view === "analysis" && !invalid && !empty && query.isFetching && !data ? <div className="panel" role="status" aria-busy="true">선택한 범위의 성과와 발행 버전을 확인하고 있습니다.</div> : null}
    {view === "analysis" && !invalid && !empty && query.isError ? <div className="panel" role="alert">{dashboardError(query.error)}</div> : null}
    {view === "analysis" && data ? <div id="performance-analysis-panel" role="tabpanel" aria-labelledby="performance-analysis-tab" style={{ display: "grid", gap: 16 }}>
      {Object.values(data.summary.knownTotals).every(value => value === null) ? <div className="panel" role="status">선택 범위에 확인 가능한 발행 데이터가 없습니다. 아래 데이터 확인에서 미수집·미매핑과 적용 여부를 확인하세요.</div> : null}
      {query.isFetching ? <p role="status" className="muted">선택 범위의 최신 성과를 확인하고 있습니다.</p> : null}
      <ChangeAnalysis key={filterParams(filters).toString()} data={data} filters={filters} />
      <details className="panel" onToggle={event => setShowDiagnostics(event.currentTarget.open)}>
        <summary style={{ cursor: "pointer", color: "#61766d", fontSize: 13 }}>원천 데이터 상세 진단{data.summary.provisional ? " · 잠정 자료" : ""}{data.summary.isEstimate ? " · 추정 데이터 포함" : ""}</summary>
        {showDiagnostics ? <>
          {diagnostics.isPending ? <p role="status">상세 진단을 읽고 있습니다.</p> : null}
          {diagnostics.isError ? <div role="alert"><p>{dashboardError(diagnostics.error)}</p><button type="button" className="button" onClick={() => { if (diagnostics.error instanceof ApiError && diagnostics.error.status === 409) refresh(); else void diagnostics.refetch(); }}>{diagnostics.error instanceof ApiError && diagnostics.error.status === 409 ? "성과·진단 다시 조회" : "상세 진단 다시 조회"}</button></div> : null}
          {diagnosticData ? <DiagnosticsPanel data={{ ...data, diagnostics: diagnosticData }} /> : null}
          {diagnosticData?.nextCursor ? <div className="toolbar"><span>상세 진단 {diagnosticData.items.length} / {diagnosticData.total}개</span>
            <button type="button" className="button" disabled={paging} onClick={() => void moreDiagnostics()}>{paging ? "진단을 읽는 중…" : "다음 진단 100개"}</button></div> : null}
        </> : null}
      </details>
      {pageError ? <div className="panel" role="alert">{pageError}{paginationNeedsRefresh ? <button type="button" className="button" onClick={refresh}>성과·진단 다시 조회</button> : null}</div> : null}
      <p className="muted" style={{ fontSize: 12 }}>선택 매체와 다른 매체의 광고비, 행사·가격·품절이 함께 변할 수 있습니다. 관측된 전후 변화이며 선택 매체만의 광고 효과를 뜻하지 않습니다. <Link href="/products/mappings">제품명과 배분 설정</Link></p>
    </div> : null}
  </section>;
}
