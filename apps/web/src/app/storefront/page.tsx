"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { apiGet, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { useCan } from "@/features/auth/use-auth";
import { STOREFRONT_QUERY_OPTIONS, storefrontError } from "@/lib/storefront-display";
import { StorefrontSummary } from "@/types/storefront";
import { StorefrontOverview } from "@/components/storefront-overview";
import { StorefrontOperations } from "@/components/storefront-operations";

export default function StorefrontPage() {
  const range = useRange();
  const canRead = useCan("data.read");
  const canManageImports = useCan("imports.manage");
  const canManageSettings = useCan("settings.manage");
  const summary = useQuery({
    ...STOREFRONT_QUERY_OPTIONS,
    queryKey: ["storefront-summary", range], enabled: canRead,
    queryFn: () => apiGet<StorefrontSummary>(`/storefront/summary?${rangeQuery(range)}`)
  });
  const refresh = async () => {
    const result = await summary.refetch();
    if (result.error) throw result.error;
    return result.data;
  };
  return <section className="page">
    <div className="page-title">
      <div>
        <h1>자사몰 통합</h1>
        <p>Cafe24 매출과 Meta·Google 광고비, 날짜별 수집 상태를 같은 기간으로 확인합니다. 한 번에 최대 92일을 조회합니다.</p>
      </div>
      {canRead ? <button type="button" className="button" disabled={summary.isFetching} onClick={() => void summary.refetch()}>
        <RefreshCw size={15} /> 저장된 자료 새로고침
      </button> : null}
    </div>
    {!canRead ? <div className="panel" role="alert">데이터 조회 권한이 없습니다.</div> : null}
    {summary.isLoading && canRead ? <div className="panel" role="status">저장된 자료를 읽고 있습니다. 새 수집을 시작하지 않습니다.</div> : null}
    {summary.isError && canRead ? <div className="warning-strip" role="alert">{storefrontError(summary.error, "저장된 자료를 읽지 못했습니다. 기존 성공 자료를 변경하지 않았습니다.")}</div> : null}
    {summary.data && canRead ? <>
      <StorefrontOverview data={summary.data} />
      <StorefrontOperations connections={summary.data.connections} canManageImports={canManageImports}
        canManageSettings={canManageSettings} onRefresh={refresh} />
    </> : null}
  </section>;
}
