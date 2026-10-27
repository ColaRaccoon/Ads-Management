"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCan } from "@/features/auth/use-auth";
import { apiGet, apiErrorMessage } from "@/lib/api";
import { emptyGoogleDateFilters, googleDateFilterError, googleFilterQuery, readGoogleDateFilters, type GoogleDateFilters } from "@/lib/google-date-filters";
import type { GoogleOptions } from "@/types/google";
import { GoogleMappingEditor } from "./google-mapping-editor";
import { GoogleMappingDiagnostics } from "./google-mapping-diagnostics";
import { GoogleReport } from "./google-report";
import { DateRangeControl } from "./date-range-picker";

export type GoogleView = "dashboard" | "campaigns" | "mappings" | "profit" | "diagnostics";
const titles = { dashboard: "Google 요약", campaigns: "Google 캠페인", mappings: "Google 상품 연결", profit: "Google 마진", diagnostics: "Google 데이터 점검" };
type Filters = GoogleDateFilters;

export function GooglePerformancePage({ view }: { view: GoogleView }) {
  const search = useSearchParams().toString();
  const canRead = useCan("data.read");
  const [filters, setFilters] = useState<Filters>(emptyGoogleDateFilters);
  const [applied, setApplied] = useState<Filters>(emptyGoogleDateFilters);
  const [readySearch, setReadySearch] = useState<string | null>(null);
  useEffect(() => {
    const values = readGoogleDateFilters(search);
    setFilters(values); setApplied(values); setReadySearch(search);
    const canonicalSearch = googleFilterQuery(values);
    if (!googleDateFilterError(values) && canonicalSearch !== search) {
      window.history.replaceState(null, "", `${window.location.pathname}?${canonicalSearch}${window.location.hash}`);
    }
  }, [search]);
  const options = useQuery({ queryKey: ["google", "options"], queryFn: () => apiGet<GoogleOptions>("/google/options"), enabled: canRead, retry: false });
  const ready = readySearch === search;
  const query = googleFilterQuery(applied);
  const dateError = googleDateFilterError(filters);
  const appliedDateError = googleDateFilterError(applied);
  const apply = (next: Filters) => {
    if (googleDateFilterError(next)) return;
    setFilters(next); setApplied(next);
    const nextSearch = googleFilterQuery(next);
    window.history.replaceState(null, "", `${window.location.pathname}?${nextSearch}${window.location.hash}`);
  };
  return <section className="page">
    <div className="page-title"><div><h1>{titles[view]}</h1><p>{view === "diagnostics" ? "계산 기준, 수집 상태와 연결 이력을 확인합니다." : "[유튜브] 판매 기준의 Google 성과"}</p></div></div>
    {view === "diagnostics" ? <details className="google-profit-guidance" open><summary>Google 매출·마진 집계 기준</summary><div className="warning-strip">
      <p>이 화면은 판매 페이지 이름에 따른 운영상 귀속 기준이며 Google Ads 클릭·전환 실적이 아닙니다. 매출은 적용일의 설정 판매가 × 수량입니다. Google 전용 판매 구성을 지정한 경우 그 구성의 판매가·비용을 적용하며, 그 외에는 기존 비용·쿠폰 규칙을 따릅니다.</p>
      <p>기존 Meta 집계에도 같은 판매가 포함될 수 있습니다. Meta와 Google 매출·마진을 더하면 중복될 수 있으며, 자사몰 통합 이익은 <Link href="/storefront">자사몰 통합</Link>에서 확인하세요.</p>
    </div></details> : null}
    {!canRead ? <p className="panel" role="alert">데이터 조회 권한이 없습니다.</p> : null}
    {options.isLoading ? <p className="panel" role="status">Google 조회 설정을 읽고 있습니다.</p> : null}
    {options.isError ? <p className="warning-strip" role="alert">{apiErrorMessage(options.error, "Google 조회 설정을 읽지 못했습니다.")}</p> : null}
    {canRead && options.data?.enabled === false ? <p className="panel" role="status">Google 성과 기능을 사용할 수 없습니다.</p> : null}
    {canRead && options.data?.enabled && ready ? <>
      <div className="panel">
        <div className="toolbar">
          <DateRangeControl value={filters} onChange={(range) => apply({ ...filters, ...range })} />
        </div>
        {view === "diagnostics" ? <p className="field-help">기본 조회는 한국시간 기준 어제이며 URL의 날짜·필터는 유지합니다. 최대 92일까지 조회할 수 있습니다. 새로고침은 저장된 자료를 다시 읽으며 새 수집을 시작하지 않습니다.</p> : null}
        {dateError ? <p className="field-help" role="alert">{dateError}</p> : null}
      </div>
      {!appliedDateError ? (view === "mappings" ? <GoogleMappingEditor key={query} options={options.data} query={query} /> : <><GoogleReport key={`${view}:${query}`} view={view} query={query} options={options.data} />{view === "diagnostics" ? <GoogleMappingDiagnostics key={`mappings:${query}`} options={options.data} query={query} /> : null}</>) : null}
    </> : null}
  </section>;
}
