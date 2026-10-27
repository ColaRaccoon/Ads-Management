"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiGet, apiErrorMessage } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { googleCampaignColumns, googleMoney, googleNumber, googleRatio } from "@/lib/google-display";
import { buildGoogleProfitExcel, googleProfitExcelFileName, loadGoogleProfitExport } from "@/lib/google-profit-excel";
import { loadGoogleProfitProducts } from "@/lib/google-profit-data";
import { downloadXlsx } from "@/lib/xlsx";
import { GoogleProfitOverview, GoogleProfitTotal } from "./google-profit-overview";
import { GoogleCampaignTable } from "./google-campaign-table";
import { GoogleDiagnostics } from "./google-diagnostics";
import type { GoogleOptions, GoogleReportResponse } from "@/types/google";
import type { GoogleView } from "./google-performance-page";

export function GoogleReport({ view, query, options }: { view: Exclude<GoogleView, "mappings">; query: string; options: GoogleOptions }) {
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const endpoint = view === "dashboard" ? "summary" : view === "diagnostics" ? "profit" : view;
  const allProducts = view === "profit" || view === "dashboard";
  const report = useQuery({
    queryKey: ["google", endpoint, query, allProducts ? "all-products" : page],
    queryFn: () => allProducts
      ? loadGoogleProfitProducts(query, (params) => apiGet<GoogleReportResponse>(`/google/${endpoint}?${params}`))
      : apiGet<GoogleReportResponse>(`/google/${endpoint}?${query}&page=${page}&pageSize=50`),
    retry: false,
    refetchOnWindowFocus: false
  });
  const productName = (id: string | null) => id ? options.products.find((item) => item.id === id)?.displayName ?? id : "미연결 / 미배분";
  const data = report.data;
  const filtered = ["productId", "connectionId", "cafe24ConnectionId"].some((key) => Boolean(new URLSearchParams(query).get(key)));
  const diagnosticsHref = `/google/diagnostics${query ? `?${query}` : ""}`;
  const exportExcel = async () => {
    if (exportInFlight.current) return;
    exportInFlight.current = true;
    setExporting(true);
    setExportError(null);
    try {
      const all = await loadGoogleProfitExport(query, (params) => apiGet<GoogleReportResponse>(`/google/profit?${params}`));
      if (!mounted.current) return;
      const params = new URLSearchParams(query);
      const filterLabel = [
        options.connections.find((item) => item.id === params.get("connectionId"))?.displayName ?? "전체 광고 계정",
        options.connections.find((item) => item.id === params.get("cafe24ConnectionId"))?.displayName ?? "전체 쇼핑몰",
        params.get("productId") ? productName(params.get("productId")) : "전체 상품"
      ].join(" / ");
      downloadXlsx(googleProfitExcelFileName(all.range), buildGoogleProfitExcel(all, productName, { filterLabel }));
    } catch (error) {
      if (mounted.current) setExportError(apiErrorMessage(error, "엑셀을 내려받지 못했습니다. 새로고침 후 다시 시도하세요."));
    } finally {
      exportInFlight.current = false;
      if (mounted.current) setExporting(false);
    }
  };
  const needsReview = data && (!data.completeness.complete || !data.summary.complete || !data.reconciliation.balanced || data.completeness.warningCodes.length > 0 || data.summary.warningCodes.length > 0);
  const pager = data ? <div className="toolbar"><button className="button" disabled={page <= 1 || report.isFetching} onClick={() => setPage(page - 1)}>이전</button><span>{page} / {Math.max(1, Math.ceil(data.pagination.total / data.pagination.pageSize))} 페이지 · {data.pagination.total}건</span><button className="button" disabled={page * data.pagination.pageSize >= data.pagination.total || report.isFetching} onClick={() => setPage(page + 1)}>다음</button></div> : null;
  return <>
    <div className="toolbar" style={{ margin: "16px 0" }}>
      {view === "profit" || view === "dashboard" ? <button className="button" type="button" disabled={!data?.pagination.total || report.isFetching || exporting} onClick={() => void exportExcel()}><Download size={16} />{exporting ? "엑셀 생성 중…" : "엑셀 출력"}</button> : null}
      <button className="button" type="button" disabled={report.isFetching || exporting} onClick={() => void report.refetch()}><RefreshCw size={16} />새로고침</button>
    </div>
    {exportError ? <p className="warning-strip" role="alert">{exportError}</p> : null}
    {report.isLoading ? <div className="panel" role="status">Google 성과를 읽고 있습니다.</div> : null}
    {report.isError ? <div className="warning-strip" role="alert">{apiErrorMessage(report.error, "Google 성과를 읽지 못했습니다. 기간과 계정 선택을 확인하세요.")}</div> : null}
    {data ? <>
      {view !== "diagnostics" && needsReview ? <p className="warning-strip" role="status">{data.summary.marginKrw === null ? "마진이 미확정입니다." : "확인이 필요한 데이터가 있습니다."} <Link href={diagnosticsHref}>데이터 점검에서 확인</Link></p> : null}
      {view === "dashboard" ? <GoogleProfitTotal data={data} filtered={filtered} /> : null}
      {view === "profit" || view === "dashboard" ? <section className="panel google-profit-products"><h2>제품별 성과</h2><GoogleProfitOverview data={data} productName={productName} filtered={filtered} /></section> : null}
      {view === "campaigns" ? <section className="panel"><div className="page-title"><h2>캠페인별 광고 지표</h2><button className="button" onClick={() => downloadCsv(`google-campaigns-${data.range.from}-${data.range.to}-page${page}.csv`, googleCampaignColumns(productName), data.campaigns)}>현재 페이지 CSV</button></div><div className="metric-strip">
        <Metric label="광고비" value={googleMoney(data.summary.adSpendKrwExact)} />
        <Metric label="노출수" value={googleNumber(data.summary.impressions)} />
        <Metric label="클릭수" value={googleNumber(data.summary.clicks)} />
        <Metric label="클릭률" value={googleRatio(data.summary.ctr ?? null, true)} />
        <Metric label="클릭당 비용" value={googleMoney(data.summary.cpcKrw)} />
      </div><GoogleCampaignTable rows={data.campaigns} productName={productName} options={options} />{pager}</section> : null}
      {view === "diagnostics" ? <GoogleDiagnostics data={data} options={options} productName={productName} query={query} productPager={pager} /> : null}
      {view === "profit" ? <GoogleProfitTotal data={data} filtered={filtered} /> : null}
    </> : null}
  </>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric-cell"><span>{label}</span><strong>{value}</strong></div>; }
