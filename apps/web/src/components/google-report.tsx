"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet, apiErrorMessage } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { storefrontLabel, storefrontTime } from "@/lib/storefront-display";
import { googleCampaignColumns, googleMoney, googleNumber, googleProfitColumns, googleRatio, googleReasons, googleSaleUnit } from "@/lib/google-display";
import type { GoogleCampaignRow, GoogleOptions, GoogleProfitRow, GoogleReportResponse } from "@/types/google";
import type { GoogleView } from "./google-performance-page";

export function GoogleReport({ view, query, options }: { view: Exclude<GoogleView, "mappings">; query: string; options: GoogleOptions }) {
  const [page, setPage] = useState(1);
  const [dailyPage, setDailyPage] = useState(1);
  const [coveragePage, setCoveragePage] = useState(1);
  const [unmappedPage, setUnmappedPage] = useState(1);
  const endpoint = view === "dashboard" ? "summary" : view;
  const report = useQuery({ queryKey: ["google", endpoint, query, page], queryFn: () => apiGet<GoogleReportResponse>(`/google/${endpoint}?${query}&page=${page}&pageSize=50`), retry: false, refetchOnWindowFocus: false });
  const productName = (id: string | null) => id ? options.products.find((item) => item.id === id)?.displayName ?? id : "미연결 / 미배분";
  const data = report.data;
  return <>
    <div className="toolbar" style={{ margin: "16px 0" }}><button className="button" disabled={report.isFetching} onClick={() => void report.refetch()}>저장된 자료 새로고침</button><span>새 수집을 시작하지 않습니다.</span></div>
    {report.isLoading ? <div className="panel" role="status">Google 성과를 읽고 있습니다.</div> : null}
    {report.isError ? <div className="warning-strip" role="alert">{apiErrorMessage(report.error, "Google 성과를 읽지 못했습니다. 기간과 계정 선택을 확인하세요.")}</div> : null}
    {data ? <>
      <div className="panel"><h2>{data.range.from} ~ {data.range.to} · {data.completeness.complete ? "확정" : "잠정 / 미확정"}</h2>
        <p>아래 합계는 선택한 기간·필터 전체 기준입니다. 표와 CSV는 명시된 페이지 또는 일별 범위를 사용합니다.</p>
        {data.completeness.warningCodes.length ? <p className="warning-strip">{googleReasons(data.completeness.warningCodes)}</p> : null}
        {data.notices.map((notice) => <p className="field-help" key={notice}>{notice}</p>)}
        <div className="metric-strip">
          <Metric label="유튜브 설정가 매출" value={googleMoney(data.summary.revenueKrw)} />
          <Metric label={`판매수량 · ${googleSaleUnit(data.summary)}`} value={googleNumber(data.summary.quantity)} />
          <Metric label="Google 광고비" value={googleMoney(data.summary.adSpendKrwExact)} />
          <Metric label="전체 확정 상품마진" value={googleMoney(data.summary.marginKrw)} />
          <Metric label="마진율" value={googleRatio(data.summary.marginRate, true)} />
          <Metric label="페이지 기준 ROAS" value={googleRatio(data.summary.roas)} />
        </div>
        <p>계산 가능한 설정가 매출 부분합: {googleMoney(data.summary.knownRevenueKrw)} · 계산 가능한 상품의 잠정 마진 합계: {googleMoney(data.summary.calculatedProductsMarginKrw)} (전체 확정 마진과 다를 수 있음)</p>
        <p>수집 판매가 기준 금액: {googleMoney(data.summary.collectedRevenueKrw)} (실제 결제액 아님) · 판매비용: {googleMoney(data.summary.grossCostKrw)} · 유튜브 판매행 쿠폰 차감: {googleMoney(data.summary.couponDeductionKrw)}</p>
        <p>설정 판매가와 수집 판매가 차이: {googleNumber(data.summary.priceMismatchCount)}개 판매행</p>
        <p>Google 전용 구성을 지정한 판매는 수량 1을 완성 판매구성 1개로 계산합니다. 1+1 세트도 1세트이며, 서로 다른 판매단위의 수량 합계는 개별 구성 수량과 구분해서 확인하세요.</p>
        <button className="button" onClick={() => downloadCsv(`google-summary-${data.range.from}-${data.range.to}.csv`, googleProfitColumns(() => "선택 범위 합계"), [data.summary])}>동일 합계 CSV</button>
      </div>
      <div className="panel"><h2>수집 완료 및 누락</h2>
        <p>두 소스 수집 완료: {data.completeness.completeDates.length}일 · 성공한 0원 수집과 미수집은 구분합니다. 수집이 끝나도 원가·쿠폰·상품 연결에 따라 마진은 미확정일 수 있습니다.</p>
        <details><summary>공통 완료 일자</summary><p>{data.completeness.completeDates.join(", ") || "없음"}</p></details>
        <p>Google 누락: {data.completeness.missingGoogleDates.join(", ") || "없음"}</p>
        <p>카페24 누락: {data.completeness.missingCafe24Dates.join(", ") || "없음"}</p>
        <details><summary>계정·일자별 수집 상태 및 최근 성공 시각</summary><div className="table-wrap"><table><thead><tr><th>일자</th><th>소스 / 계정</th><th>선택 원천</th><th>수집 상태</th><th>행 수</th><th>최근 성공 (한국)</th><th>최근 시도 (한국)</th><th>확인 사유</th></tr></thead><tbody>{data.coverage.slice((coveragePage - 1) * 100, coveragePage * 100).map((item) => <tr key={`${item.connectionId}:${item.date}`}><td>{item.date}</td><td>{item.provider} · {options.connections.find((connection) => connection.id === item.connectionId)?.displayName ?? item.connectionId}</td><td>{item.selectedSource ?? "미선택"}</td><td>{item.complete ? storefrontLabel(item.state) : `미완료 · ${storefrontLabel(item.state)}`}</td><td>{googleNumber(item.rowCount)}</td><td>{storefrontTime(item.lastSuccessAt)}</td><td>{storefrontTime(item.lastAttemptAt)}</td><td>{googleReasons(item.warningCodes) || "—"}</td></tr>)}</tbody></table></div><LocalPager page={coveragePage} setPage={setCoveragePage} total={data.coverage.length} /></details>
      </div>
      <div className="panel"><h2>광고비 배분 대사</h2>
        <p>상품별 배분 {googleMoney(data.reconciliation.allocatedAdSpendKrwExact)} + 미배분 {googleMoney(data.reconciliation.unallocatedAdSpendKrwExact)} = 수집 광고비 {googleMoney(data.reconciliation.collectedAdSpendKrwExact)}</p>
        <p>{data.reconciliation.balanced ? "원본 광고비 배분 합계 일치" : "광고비 배분 합계 확인 필요"}. 환율 누락 시 원화 값은 미확정이며, 미수집 기간의 전체 광고비는 확정하지 않습니다.</p>
        <details><summary>통화별 원본 micros 대사</summary>{data.reconciliation.byCurrency.map((item) => <p key={item.currencyCode}>{item.currencyCode}: 배분 {item.allocatedCostMicros} + 미배분 {item.unallocatedCostMicros} = 수집 {item.collectedCostMicros} micros · {item.balanced ? "일치" : "불일치"}</p>)}</details>
      </div>
      {view === "campaigns" ? <div className="panel"><div className="page-title"><h2>캠페인별 광고 지표</h2><button className="button" onClick={() => downloadCsv(`google-campaigns-${data.range.from}-${data.range.to}-page${page}.csv`, googleCampaignColumns(productName), data.campaigns)}>현재 페이지 CSV</button></div>
        <p>같은 상품에 연결된 캠페인의 비용만 합산합니다. 상품 매출·ROAS·마진을 캠페인별로 반복 배정하지 않습니다.</p>
        <CampaignTable rows={data.campaigns} productName={productName} />
      </div> : <div className="panel"><div className="page-title"><h2>상품별 기간 합계</h2><button className="button" onClick={() => downloadCsv(`google-profit-${data.range.from}-${data.range.to}-page${page}.csv`, googleProfitColumns(productName), data.products)}>현재 페이지 CSV</button></div><ProfitTable rows={data.products} productName={productName} /></div>}
      <div className="toolbar"><button className="button" disabled={page <= 1 || report.isFetching} onClick={() => setPage(page - 1)}>이전</button><span>{page} / {Math.max(1, Math.ceil(data.pagination.total / data.pagination.pageSize))} 페이지 · {data.pagination.total}건</span><button className="button" disabled={page * data.pagination.pageSize >= data.pagination.total || report.isFetching} onClick={() => setPage(page + 1)}>다음</button></div>
      {view !== "campaigns" ? <details className="panel"><summary>상품·일자별 상세 {data.daily.length}건</summary><p>선택한 기간·필터 전체의 일별 데이터입니다. 미연결 판매와 미배분 광고비는 별도 행으로 남습니다.</p><button className="button" onClick={() => downloadCsv(`google-daily-${data.range.from}-${data.range.to}.csv`, googleProfitColumns(productName), data.daily)}>동일 기준 일별 전체 CSV</button><ProfitTable rows={data.daily.slice((dailyPage - 1) * 100, dailyPage * 100)} productName={productName} daily /><LocalPager page={dailyPage} setPage={setDailyPage} total={data.daily.length} /></details> : null}
      <details className="panel" open={data.unmappedSales.length > 0}><summary>미연결 유튜브 판매 {data.summary.unmappedSalesCount}건</summary><p>미연결 판매는 전체 마진 확정을 제한합니다. 아래 금액은 수집 판매가 기준이며 설정가 매출·결제액과 다를 수 있습니다.</p><div className="table-wrap"><table><thead><tr><th>일자</th><th>쇼핑몰</th><th>주문번호</th><th>상품번호 / 옵션</th><th>판매 당시 상품명</th><th>수량</th><th>수집 판매가 금액</th></tr></thead><tbody>{data.unmappedSales.slice((unmappedPage - 1) * 100, unmappedPage * 100).map((item) => <tr key={item.id}><td>{item.date}</td><td>{options.connections.find((connection) => connection.id === item.connectionId)?.displayName ?? item.connectionId ?? "연결 정보 없음"}</td><td>{item.orderNo}</td><td>{item.productNo ?? "상품번호 없음"} / {item.optionName || "옵션 없음"}</td><td>{item.productName ?? "이름 없음"}</td><td>{item.quantity}</td><td>{googleMoney(item.collectedRevenueKrw)}</td></tr>)}</tbody></table></div><LocalPager page={unmappedPage} setPage={setUnmappedPage} total={data.unmappedSales.length} /></details>
    </> : null}
  </>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric-cell"><span>{label}</span><strong>{value}</strong></div>; }
function LocalPager({ page, setPage, total }: { page: number; setPage: (page: number) => void; total: number }) {
  if (total <= 100) return null;
  return <div className="toolbar"><button className="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>이전</button><span>{page} / {Math.ceil(total / 100)} 페이지 · {total}건</span><button className="button" disabled={page * 100 >= total} onClick={() => setPage(page + 1)}>다음</button></div>;
}
function ProfitTable({ rows, productName, daily = false }: { rows: GoogleProfitRow[]; productName: (id: string | null) => string; daily?: boolean }) {
  return <div className="table-wrap"><table><thead><tr>{daily ? <th>일자</th> : null}<th>상품</th><th>수량 / 판매단위</th><th>설정가 매출</th><th>수집가 금액</th><th>판매비용</th><th>쿠폰</th><th>Google 광고비</th><th>확정 마진</th><th>계산 가능 잠정 마진</th><th>마진율</th><th>페이지 ROAS</th><th>완전성 / 확인 사유</th></tr></thead><tbody>
    {rows.map((item) => <tr key={`${item.productId ?? "unmapped"}:${item.date}`}>
      {daily ? <td>{item.date}</td> : null}<td>{productName(item.productId)}</td><td>{googleNumber(item.quantity)}<br />{googleSaleUnit(item)}</td><td>{googleMoney(item.revenueKrw)}</td><td>{googleMoney(item.collectedRevenueKrw)}</td><td>{googleMoney(item.grossCostKrw)}</td><td>{googleMoney(item.couponDeductionKrw)}</td><td>{googleMoney(item.adSpendKrwExact)}</td><td>{googleMoney(item.marginKrw)}</td><td>{googleMoney(item.calculatedMarginKrw)}</td><td>{googleRatio(item.marginRate, true)}</td><td>{googleRatio(item.roas)}</td><td>{item.complete ? "확정" : "미확정"}{item.warningCodes.length ? ` · ${googleReasons(item.warningCodes)}` : ""}</td>
    </tr>)}{!rows.length ? <tr><td colSpan={daily ? 14 : 13}>선택한 조건의 데이터가 없습니다. 수집 완료 여부를 함께 확인하세요.</td></tr> : null}
  </tbody></table></div>;
}
function CampaignTable({ rows, productName }: { rows: GoogleCampaignRow[]; productName: (id: string | null) => string }) {
  return <div className="table-wrap"><table><thead><tr><th>계정 / 캠페인 ID</th><th>캠페인</th><th>연결 상품</th><th>광고비</th><th>노출</th><th>클릭</th><th>CTR</th><th>CPC</th><th>확인 사유</th></tr></thead><tbody>{rows.map((item) => <tr key={`${item.connectionId}:${item.campaignId}:${item.currencyCode}`}><td>{item.customerId}<br />{item.campaignId}</td><td>{item.campaignName}</td><td>{item.productIds.map(productName).join(" / ") || "미배분"}{item.hasUnmapped && item.productIds.length ? " · 일부 미배분" : ""}</td><td>{googleMoney(item.adSpendKrwExact)}</td><td>{googleNumber(item.impressions)}</td><td>{googleNumber(item.clicks)}</td><td>{googleRatio(item.ctr, true)}</td><td>{googleMoney(item.cpcKrw)}</td><td>{googleReasons(item.warningCodes) || "—"}</td></tr>)}{!rows.length ? <tr><td colSpan={9}>캠페인 데이터가 없습니다. 수집 완료 여부를 함께 확인하세요.</td></tr> : null}</tbody></table></div>;
}
