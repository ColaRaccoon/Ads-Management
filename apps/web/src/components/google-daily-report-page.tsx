"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Printer, Search, Settings2 } from "lucide-react";
import { useCan } from "@/features/auth/use-auth";
import { apiGet, apiErrorMessage } from "@/lib/api";
import { googleDateFilterError, googleFilterQuery, readGoogleDateFilters } from "@/lib/google-date-filters";
import { googleMoney, googleNumber, googleRatio, googleReasons, googleSaleUnit } from "@/lib/google-display";
import { buildGoogleDailyGroups, DEFAULT_GOOGLE_DAILY_SETTINGS, formatGoogleDailyValue, GOOGLE_DAILY_COLUMNS, GOOGLE_DAILY_SETTINGS_KEY,
  googleCreativeKey, googleDailyCreativeValue, googleDailyCreativeTotals, googleDailyQueries, googleDailySalesMetrics, loadGoogleDailyReport,
  normalizeGoogleDailySettings, type GoogleDailyColumnKey, type GoogleDailySettings } from "@/lib/google-daily-report";
import { buildGoogleDailyXlsx } from "@/lib/google-daily-xlsx";
import { downloadXlsx } from "@/lib/xlsx";
import type { GoogleOptions, GoogleReportResponse } from "@/types/google";

const fetchReport = (endpoint: "profit" | "creatives", query: string) => apiGet<GoogleReportResponse>(`/google/${endpoint}?${query}`);

export function GoogleDailyReportPage() {
  const search = useSearchParams().toString();
  const canRead = useCan("data.read");
  const filters = useMemo(() => readGoogleDateFilters(search), [search]);
  const dateError = googleDateFilterError(filters);
  const dates = dateError ? null : googleDailyQueries(filters);
  const [settings, setSettings] = useState<GoogleDailySettings>(DEFAULT_GOOGLE_DAILY_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => {
    if (!dateError) {
      const canonical = googleFilterQuery(filters);
      if (canonical !== search) window.history.replaceState(null, "", `${window.location.pathname}?${canonical}${window.location.hash}`);
    }
  }, [search, filters, dateError]);
  useEffect(() => {
    try { setSettings(normalizeGoogleDailySettings(JSON.parse(localStorage.getItem(GOOGLE_DAILY_SETTINGS_KEY) ?? "null"))); } catch { /* Defaults remain usable if storage is blocked. */ }
    setSettingsLoaded(true);
  }, []);
  useEffect(() => {
    if (settingsLoaded) {
      try { localStorage.setItem(GOOGLE_DAILY_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Optional preference persistence. */ }
    }
  }, [settings, settingsLoaded]);
  const options = useQuery({ queryKey: ["google", "options"], queryFn: () => apiGet<GoogleOptions>("/google/options"), enabled: canRead, retry: false });
  const enabled = canRead && options.data?.enabled === true && !!dates;
  const current = useQuery({ queryKey: ["google", "daily-report", dates?.current], queryFn: () => loadGoogleDailyReport(dates!.current, fetchReport), enabled, retry: false, refetchOnWindowFocus: false });
  const previous = useQuery({ queryKey: ["google", "daily-report", dates?.previous], queryFn: () => loadGoogleDailyReport(dates!.previous, fetchReport), enabled, retry: false, refetchOnWindowFocus: false });
  const model = useMemo(() => {
    if (!current.data || !options.data) return { groups: [], error: null };
    const names = new Map(options.data.products.map(product => [product.id, product.displayName]));
    try { return { groups: buildGoogleDailyGroups(current.data, id => id === null ? "미연결 / 미배분" : names.get(id) ?? id, settings), error: null }; }
    catch (error) { return { groups: [], error: apiErrorMessage(error, "리포트 데이터를 확인해 주세요.") }; }
  }, [current.data, options.data, settings]);
  const columns = GOOGLE_DAILY_COLUMNS.filter(column => settings.columns.includes(column.key));
  const previousRows = useMemo(() => new Map((previous.isError ? [] : previous.data?.creatives ?? []).map(row => [googleCreativeKey(row), row])), [previous.data, previous.isError]);
  const busy = options.isLoading || (enabled && (current.isFetching || previous.isFetching)) || !settingsLoaded;
  const canExport = enabled && !!current.data && !!previous.data && !busy && !current.isError && !previous.isError && !model.error && model.groups.length > 0;
  const toggleColumn = (key: GoogleDailyColumnKey) => {
    if (key === "creative") return;
    setSettings(value => ({ ...value, columns: value.columns.includes(key) ? value.columns.filter(column => column !== key) : [...value.columns, key] }));
  };
  const exportXlsx = () => {
    if (!canExport || !dates || !current.data || !previous.data) return;
    setExportError(null);
    try {
      downloadXlsx(`${dates.reportDate}_구글_데일리리포트.xlsx`, buildGoogleDailyXlsx({ ...dates, data: current.data, previous: previous.data,
        groups: model.groups, columns: settings.columns, filterLabel: `${settings.spendOnly ? "광고비 존재" : "전체"} / 검색: ${settings.query || "없음"}` }));
    } catch (error) { setExportError(apiErrorMessage(error, "엑셀을 생성하지 못했습니다.")); }
  };
  const report = canRead && options.data?.enabled && !dateError && !current.isError ? current.data : undefined;
  const diagnosticsHref = `/google/diagnostics${dates ? `?${dates.current}` : ""}`;
  const creativeTotal = report ? googleDailyCreativeTotals(report) : null;
  return <section className="page daily-report-page google-daily-report-page">
    <div className="page-title no-print"><div><h1>Google Daily Report</h1><p>보고 기준일: {dates?.reportDate ?? "날짜를 선택해 주세요"}</p></div>
      <div className="daily-report-controls">
        <select className="select" aria-label="광고비 필터" value={settings.spendOnly ? "hasSpend" : "all"} onChange={event => setSettings(value => ({ ...value, spendOnly: event.target.value === "hasSpend" }))}>
          <option value="all">전체</option><option value="hasSpend">광고비 존재</option>
        </select>
        <label className="daily-report-search"><Search size={15} /><input aria-label="제품명 또는 소재명" placeholder="제품명 또는 소재명" value={settings.query} onChange={event => setSettings(value => ({ ...value, query: event.target.value }))} /></label>
        <details className="daily-column-picker"><summary><Settings2 size={15} />표시 항목</summary><div className="daily-column-options">
          {GOOGLE_DAILY_COLUMNS.map(column => <label key={column.key}><input type="checkbox" checked={settings.columns.includes(column.key)} disabled={column.key === "creative"} onChange={() => toggleColumn(column.key)} />{column.label}</label>)}
        </div></details>
        <button className="button" type="button" disabled={!canExport} onClick={() => window.print()}><Printer size={15} />출력</button>
        <button className="button primary" type="button" disabled={!canExport} onClick={exportXlsx}><Download size={15} />XLSX</button>
      </div>
    </div>
    <header className="daily-report-print-header"><div><h1>Google Daily Report</h1><p>보고 기준일: {dates?.reportDate ?? "—"}</p></div><span>전일 기준일: {dates?.previousDate ?? "—"}</span></header>
    {filters.from !== filters.to && dates ? <p className="field-help">메타 데일리 리포트와 동일하게 선택 기간의 마지막 날({dates.reportDate})을 보고합니다.</p> : null}
    {!canRead ? <p className="warning-strip" role="alert">데이터 조회 권한이 없습니다.</p> : null}
    {canRead && options.data?.enabled === false ? <p className="panel">Google 성과 기능을 사용할 수 없습니다.</p> : null}
    {dateError ? <p className="warning-strip" role="alert">{dateError}</p> : null}
    {options.isError || current.isError || model.error ? <p className="warning-strip" role="alert">{model.error ?? apiErrorMessage(options.error ?? current.error, "Google 데일리 리포트를 읽지 못했습니다.")}</p> : null}
    {previous.isError ? <p className="warning-strip" role="alert">전일 데이터를 불러오지 못했습니다. 전일 비교와 출력은 새로고침 후 다시 확인하세요.</p> : null}
    {exportError ? <p className="warning-strip" role="alert">{exportError}</p> : null}
    {busy ? <p className="daily-report-empty" role="status">보고 데이터를 불러오는 중입니다.</p> : null}
    {report && !model.error ? <>
      {!report.completeness.complete || !report.summary.complete || !report.reconciliation.balanced || previous.data?.completeness.complete === false ||
        report.creativeCompleteness?.complete !== true || previous.data?.creativeCompleteness?.complete !== true ?
        <p className="warning-strip" role="status">현재 또는 전일에 미확정 데이터가 있습니다. 미확정 지표는 ‘—’로 표시합니다. <Link href={diagnosticsHref}>데이터 점검</Link></p> : null}
      <p className="field-help">전체 집계 · 표시 {model.groups.length}개 그룹 / 전체 {report.products.filter(row => row.productId !== null).length}개 제품. 검색은 일치하는 제품의 모든 소재을 표시합니다.</p>
      <div className="daily-report-summary">
        <Tile label="전체 제품수" value={`${report.products.filter(row => row.productId !== null).length}개`} />
        <Tile label="총 광고비 KRW" value={googleMoney(creativeTotal?.spend)} />
        <Tile label="총 구매 전환수" value={formatGoogleDailyValue(creativeTotal?.purchases, "purchaseCount")} />
        <Tile label="구매 CPA (원)" value={googleMoney(creativeTotal?.cpa)} />
        <Tile label="Google ROAS" value={googleRatio(creativeTotal?.roas ?? null, false, 2)} />
        <Tile label="최종 순마진" value={googleMoney(report.summary.marginKrw)} />
      </div>
      <p className="field-help">구매 전환·Google ROAS는 Google Ads 기준입니다. 하단 판매·마진은 카페24 [유튜브] 판매 기준이며 소재별 전환매출과 다릅니다.</p>
      {!busy && !model.groups.length ? <p className="daily-report-empty">조건에 맞는 소재 또는 카페24 판매 데이터가 없습니다.</p> : null}
      <div className="daily-product-list">{model.groups.map(group => <article className="daily-product-box" key={group.productId ?? "unallocated"}>
        <div className="daily-product-header"><div className="daily-product-title"><h2>{group.productName}</h2><span>{group.creatives.length}개 소재 · {group.sales.complete ? "확정" : "미확정"}</span></div>
          <div className="daily-product-stats">
            <Stat label="광고비 KRW" value={googleMoney(group.sales.adSpendKrwExact)} /><Stat label="판매수량" value={googleNumber(group.sales.quantity)} />
            <Stat label="판매 1개당 광고비" value={googleMoney(group.sales.costPerSaleKrw)} /><Stat label="페이지 기준 ROAS" value={googleRatio(group.sales.roas, false, 2)} />
            <Stat label="최종 순마진" value={googleMoney(group.sales.marginKrw)} />
          </div>
        </div>
        <details className="meta-report-details muted"><summary>지표 기준 및 수집 정보</summary>
          <p>소재 표는 광고 ID별 실적입니다. 구매 전환은 Google의 구매 액션 기준이며 카페24 판매수량과 다릅니다. 영상 조회수·조회율은 TrueView 기준입니다. 한 광고의 여러 이미지·영상은 함께 표시하고 광고비는 한 번만 집계합니다.</p>
          <p>전일 값은 계정·광고그룹·광고 ID로 비교합니다. 전일 행이 없거나 수집이 미완료이면 ‘—’로 표시합니다. 상태와 소재 정보는 해당 실적을 수집할 때의 정보입니다.</p>
          {group.sales.warningCodes.length ? <p>{googleReasons(group.sales.warningCodes)}</p> : null}
        </details>
        <div className="daily-product-table-wrap"><table className="daily-product-table"><thead><tr>{columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>
          {!group.creatives.length ? <tr><td className="daily-product-table-empty" colSpan={columns.length}>해당 날짜에 연결된 Google 소재이 없습니다.</td></tr> : group.creatives.map(row => <tr key={googleCreativeKey(row)}>{columns.map(column => <td key={column.key}>
            {column.key === "creative" ? <div className="daily-creative-name"><strong>{row.adName}</strong><span>{row.campaignName} · {row.status === "ENABLED" ? "활성" : row.status === "PAUSED" ? "중지" : row.status === "REMOVED" ? "삭제" : "상태 미확인"}</span>
              <span>광고 ID {row.adId}</span>
              {row.assets.map(asset => asset.videoId ? <a key={asset.id} href={`https://www.youtube.com/watch?v=${asset.videoId}`} target="_blank" rel="noreferrer">{asset.name || "영상 보기"}</a>
                : asset.imageUrl ? <a key={asset.id} href={asset.imageUrl} target="_blank" rel="noreferrer">{asset.name || "이미지 보기"}</a> : null)}
              {row.warningCodes.length ? <span>{googleReasons(row.warningCodes)}</span> : null}</div> :
              <span className="metric-with-previous"><strong>{formatGoogleDailyValue(googleDailyCreativeValue(row, column.key), column.key)}</strong><small>전일 {formatGoogleDailyValue(googleDailyCreativeValue(previousRows.get(googleCreativeKey(row)), column.key), column.key)}</small></span>}
          </td>)}</tr>)}
        </tbody></table></div>
        <section className="daily-sales-margin"><h3>카페24 [유튜브] 판매 기반 마진</h3><div className="daily-sales-table-wrap"><table className="daily-sales-table"><thead><tr><th>제품</th>{googleDailySalesMetrics(group.sales).map(metric => <th key={metric.label}>{metric.label}</th>)}</tr></thead><tbody><tr>
          <td><span className="daily-sales-product-cell"><strong>{group.productName}</strong><small>판매 행 {group.sales.lineCount} · {googleSaleUnit(group.sales)}</small></span></td>
          {googleDailySalesMetrics(group.sales).map(metric => <td key={metric.label}>{metric.kind === "number" ? googleNumber(metric.value) : metric.kind === "percent" ? googleRatio(metric.value, true) : googleMoney(metric.value)}</td>)}
        </tr></tbody></table></div></section>
      </article>)}</div>
    </> : null}
  </section>;
}

function Tile({ label, value }: { label: string; value: string }) { return <div className="daily-summary-tile"><span>{label}</span><strong>{value}</strong></div>; }
function Stat({ label, value }: { label: string; value: string }) { return <div className="daily-product-stat"><span>{label}</span><strong>{value}</strong></div>; }
