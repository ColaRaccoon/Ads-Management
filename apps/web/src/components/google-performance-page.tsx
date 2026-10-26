"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCan } from "@/features/auth/use-auth";
import { apiGet, apiErrorMessage } from "@/lib/api";
import type { GoogleOptions } from "@/types/google";
import { GoogleMappingEditor } from "./google-mapping-editor";
import { GoogleReport } from "./google-report";

export type GoogleView = "dashboard" | "campaigns" | "mappings" | "profit";
const titles = { dashboard: "Google 요약", campaigns: "Google 캠페인", mappings: "Google 상품 연결", profit: "Google 상품별 마진" };
type Filters = { from: string; to: string; connectionId: string; cafe24ConnectionId: string; productId: string };
const emptyFilters: Filters = { from: "", to: "", connectionId: "", cafe24ConnectionId: "", productId: "" };

export function GooglePerformancePage({ view }: { view: GoogleView }) {
  const search = useSearchParams().toString();
  const canRead = useCan("data.read");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(search);
    const values = Object.fromEntries(Object.keys(emptyFilters).map((key) => [key, params.get(key) ?? ""])) as Filters;
    setFilters(values); setApplied(values); setReady(true);
  }, [search]);
  const options = useQuery({ queryKey: ["google", "options"], queryFn: () => apiGet<GoogleOptions>("/google/options"), enabled: canRead, retry: false });
  const query = new URLSearchParams(Object.entries(applied).filter(([, value]) => Boolean(value))).toString();
  const apply = (next: Filters) => {
    setFilters(next); setApplied(next);
    const search = new URLSearchParams(Object.entries(next).filter(([, value]) => Boolean(value))).toString();
    window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  };
  return <section className="page">
    <div className="page-title"><div><h1>{titles[view]}</h1><p>판매 당시 상품명에 [유튜브]가 포함된 카페24 주문행을 Google 독립 성과로 분류합니다.</p></div></div>
    <nav className="toolbar" aria-label="Google 메뉴" style={{ marginBottom: 16 }}>{(Object.keys(titles) as GoogleView[]).map((key) => <Link className="button" aria-current={key === view ? "page" : undefined} key={key} href={`/google/${key}${query ? `?${query}` : ""}`}>{titles[key]}</Link>)}</nav>
    <div className="warning-strip">
      <p>이 화면은 판매 페이지 이름에 따른 운영상 귀속 기준이며 Google Ads 클릭·전환 실적이 아닙니다. 매출은 적용일의 설정 판매가 × 수량입니다. Google 전용 판매 구성을 지정한 경우 그 구성의 판매가·비용을 적용하며, 그 외에는 기존 비용·쿠폰 규칙을 따릅니다.</p>
      <p>기존 Meta 집계에도 같은 판매가 포함될 수 있습니다. Meta와 Google 매출·마진을 더하면 중복될 수 있으며, 자사몰 통합 이익은 <Link href="/storefront">자사몰 통합</Link>에서 확인하세요.</p>
    </div>
    {!canRead ? <p className="panel" role="alert">데이터 조회 권한이 없습니다.</p> : null}
    {options.isLoading ? <p className="panel" role="status">Google 조회 설정을 읽고 있습니다.</p> : null}
    {options.isError ? <p className="warning-strip" role="alert">{apiErrorMessage(options.error, "Google 조회 설정을 읽지 못했습니다.")}</p> : null}
    {canRead && options.data?.enabled === false ? <p className="panel" role="status">Google 독립 성과 기능이 비활성화되어 있습니다. 운영 적용 승인 후 기능을 활성화할 수 있습니다.</p> : null}
    {canRead && options.data?.enabled && ready ? <>
      <form className="panel" onSubmit={(event) => { event.preventDefault(); apply(filters); }}>
        <div className="toolbar">
          <label className="field">시작일<input className="input" type="date" required={Boolean(filters.to)} max={filters.to || undefined} value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
          <label className="field">종료일<input className="input" type="date" required={Boolean(filters.from)} min={filters.from || undefined} value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
          <label className="field">Google 광고 계정<select className="select" value={filters.connectionId} onChange={(event) => setFilters({ ...filters, connectionId: event.target.value })}><option value="">전체 광고 계정</option>{options.data.connections.filter((item) => item.provider === "GOOGLE").map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.externalAccountId}</option>)}</select></label>
          <label className="field">카페24 쇼핑몰<select className="select" value={filters.cafe24ConnectionId} onChange={(event) => setFilters({ ...filters, cafe24ConnectionId: event.target.value })}><option value="">전체 쇼핑몰</option>{options.data.connections.filter((item) => item.provider === "CAFE24").map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
          <label className="field">상품<select className="select" value={filters.productId} onChange={(event) => setFilters({ ...filters, productId: event.target.value })}><option value="">전체 상품</option>{options.data.products.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
          <button type="submit" className="button primary">조회</button>
          <button type="button" className="button" onClick={() => apply({ ...filters, from: "", to: "" })}>공통 수집 완료 기간</button>
        </div>
        <p className="field-help">날짜를 비워 두면 두 소스의 수집 완료 범위가 겹치는 기간을 조회합니다. 직접 선택은 최대 92일이며 미완료 일자의 마진은 미확정입니다. 광고 계정 필터는 광고비 범위를 선택하며 상품 매출의 캠페인별 기여도를 뜻하지 않습니다.</p>
      </form>
      {view === "mappings" ? <GoogleMappingEditor key={query} options={options.data} query={query} /> : <GoogleReport key={`${view}:${query}`} view={view} query={query} options={options.data} />}
    </> : null}
  </section>;
}
