"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet, apiErrorMessage } from "@/lib/api";
import { GoogleCampaignTable } from "./google-campaign-table";
import { downloadCsv } from "@/lib/csv";
import { storefrontLabel, storefrontTime } from "@/lib/storefront-display";
import { googleCampaignColumns, googleMoney, googleNumber, googleProfitColumns, googleRatio, googleReasons, googleSaleUnit } from "@/lib/google-display";
import type { GoogleOptions, GoogleProfitRow, GoogleReportResponse } from "@/types/google";

export function GoogleDiagnostics({ data, options, productName, query, productPager }: { data: GoogleReportResponse; options: GoogleOptions; productName: (id: string | null) => string; query: string; productPager: ReactNode }) {
  const [dailyPage, setDailyPage] = useState(1);
  const [coveragePage, setCoveragePage] = useState(1);
  const [unmappedPage, setUnmappedPage] = useState(1);
  const [campaignsOpen, setCampaignsOpen] = useState(false);
  const [campaignPage, setCampaignPage] = useState(1);
  const campaigns = useQuery({ queryKey: ["google", "campaigns", query, campaignPage], queryFn: () => apiGet<GoogleReportResponse>(`/google/campaigns?${query}&page=${campaignPage}&pageSize=50`), enabled: campaignsOpen, retry: false, refetchOnWindowFocus: false });
  return <>
      <details className="panel" open><summary>매출·비용 계산 기준 및 상세 합계</summary><h2>{data.range.from} ~ {data.range.to} · {data.completeness.complete ? "확정" : "잠정 / 미확정"}</h2>
        <p>클릭률 = 클릭수 ÷ 노출수 · 클릭당 비용 = 광고비 ÷ 클릭수. 판매 1개당 광고비는 카페24 [유튜브] 판매수량 기준이며 1+1은 1세트로 계산합니다. Google Ads의 전환당 비용(CPA)과 다릅니다. 페이지 ROAS = 설정가 매출 ÷ 광고비.</p>
        <p>Google Ads 전환수·전환당 비용·전환가치는 현재 미수집입니다. 설정가 매출을 Google Ads 전환가치로 표시하지 않습니다.</p>
        <p>합계에는 미연결 판매·미배분 광고비도 포함합니다. 화면은 정수로 반올림하고 CSV는 원래 정밀도를 유지하므로 표시값의 합이 소폭 다를 수 있습니다.</p>
        <p>아래 합계는 선택한 기간·필터 전체 기준입니다. 표와 CSV는 명시된 페이지 또는 일별 범위를 사용합니다.</p>
        {data.completeness.warningCodes.length || data.summary.warningCodes.length ? <p className="warning-strip">{googleReasons([...new Set([...data.completeness.warningCodes, ...data.summary.warningCodes])])}</p> : null}
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
      </details>
      <details className="panel" open><summary>수집 완료 및 누락</summary>
        <p>두 소스 수집 완료: {data.completeness.completeDates.length}일 · 성공한 0원 수집과 미수집은 구분합니다. 수집이 끝나도 원가·쿠폰·상품 연결에 따라 마진은 미확정일 수 있습니다.</p>
        <details><summary>공통 완료 일자</summary><p>{data.completeness.completeDates.join(", ") || "없음"}</p></details>
        <p>Google 누락: {data.completeness.missingGoogleDates.join(", ") || "없음"}</p>
        <p>카페24 누락: {data.completeness.missingCafe24Dates.join(", ") || "없음"}</p>
        <details><summary>계정·일자별 수집 상태 및 최근 성공 시각</summary><div className="table-wrap"><table><thead><tr><th>일자</th><th>소스 / 계정</th><th>선택 원천</th><th>수집 상태</th><th>행 수</th><th>최근 성공 (한국)</th><th>최근 시도 (한국)</th><th>확인 사유</th></tr></thead><tbody>{data.coverage.slice((coveragePage - 1) * 100, coveragePage * 100).map((item) => <tr key={`${item.connectionId}:${item.date}`}><td>{item.date}</td><td>{item.provider} · {options.connections.find((connection) => connection.id === item.connectionId)?.displayName ?? item.connectionId}</td><td>{item.selectedSource ?? "미선택"}</td><td>{item.complete ? storefrontLabel(item.state) : `미완료 · ${storefrontLabel(item.state)}`}</td><td>{googleNumber(item.rowCount)}</td><td>{storefrontTime(item.lastSuccessAt)}</td><td>{storefrontTime(item.lastAttemptAt)}</td><td>{googleReasons(item.warningCodes) || "—"}</td></tr>)}</tbody></table></div><LocalPager page={coveragePage} setPage={setCoveragePage} total={data.coverage.length} /></details>
      </details>
      <details className="panel" open><summary>광고비 배분 대사</summary>
        <p>상품별 배분 {googleMoney(data.reconciliation.allocatedAdSpendKrwExact)} + 미배분 {googleMoney(data.reconciliation.unallocatedAdSpendKrwExact)} = 수집 광고비 {googleMoney(data.reconciliation.collectedAdSpendKrwExact)}</p>
        <p>{data.reconciliation.balanced ? "원본 광고비 배분 합계 일치" : "광고비 배분 합계 확인 필요"}. 환율 누락 시 원화 값은 미확정이며, 미수집 기간의 전체 광고비는 확정하지 않습니다.</p>
        <details><summary>통화별 원본 micros 대사</summary>{data.reconciliation.byCurrency.map((item) => <p key={item.currencyCode}>{item.currencyCode}: 배분 {item.allocatedCostMicros} + 미배분 {item.unallocatedCostMicros} = 수집 {item.collectedCostMicros} micros · {item.balanced ? "일치" : "불일치"}</p>)}</details>
      </details>
      <details className="panel"><summary>상품·일자별 상세 {data.daily.length}건</summary><p>선택한 기간·필터 전체의 일별 데이터입니다. 미연결 판매와 미배분 광고비는 별도 행으로 남습니다.</p><button className="button" onClick={() => downloadCsv(`google-daily-${data.range.from}-${data.range.to}.csv`, googleProfitColumns(productName), data.daily)}>동일 기준 일별 전체 CSV</button><ProfitTable rows={data.daily.slice((dailyPage - 1) * 100, dailyPage * 100)} productName={productName} daily /><LocalPager page={dailyPage} setPage={setDailyPage} total={data.daily.length} /></details>
      <details className="panel" open={data.unmappedSales.length > 0}><summary>미연결 유튜브 판매 {data.summary.unmappedSalesCount}건</summary><p>미연결 판매는 전체 마진 확정을 제한합니다. 아래 금액은 수집 판매가 기준이며 설정가 매출·결제액과 다를 수 있습니다.</p><div className="table-wrap"><table><thead><tr><th>일자</th><th>쇼핑몰</th><th>주문번호</th><th>상품번호 / 옵션</th><th>판매 당시 상품명</th><th>수량</th><th>수집 판매가 금액</th></tr></thead><tbody>{data.unmappedSales.slice((unmappedPage - 1) * 100, unmappedPage * 100).map((item) => <tr key={item.id}><td>{item.date}</td><td>{options.connections.find((connection) => connection.id === item.connectionId)?.displayName ?? item.connectionId ?? "연결 정보 없음"}</td><td>{item.orderNo}</td><td>{item.productNo ?? "상품번호 없음"} / {item.optionName || "옵션 없음"}</td><td>{item.productName ?? "이름 없음"}</td><td>{item.quantity}</td><td>{googleMoney(item.collectedRevenueKrw)}</td></tr>)}</tbody></table></div><LocalPager page={unmappedPage} setPage={setUnmappedPage} total={data.unmappedSales.length} /></details>
    <details className="panel"><summary>상품별 상세 합계</summary><button className="button" onClick={() => downloadCsv(`google-profit-${data.range.from}-${data.range.to}-page${data.pagination.page}.csv`, googleProfitColumns(productName), data.products)}>상품 현재 페이지 CSV</button><ProfitTable rows={data.products} productName={productName} />{productPager}</details>
    <details className="panel" onToggle={(event) => setCampaignsOpen(event.currentTarget.open)}><summary>캠페인 원본 및 연결 사유</summary>
      {campaigns.isLoading ? <p role="status">캠페인을 읽고 있습니다.</p> : null}
      {campaigns.isError ? <p role="alert">{apiErrorMessage(campaigns.error, "캠페인을 읽지 못했습니다.")}</p> : null}
      {campaigns.data ? <>
        <button className="button" onClick={() => downloadCsv(`google-campaigns-${campaigns.data!.range.from}-${campaigns.data!.range.to}-page${campaignPage}.csv`, googleCampaignColumns(productName), campaigns.data!.campaigns)}>캠페인 현재 페이지 CSV</button>
        <GoogleCampaignTable rows={campaigns.data.campaigns} productName={productName} options={options} detailed />
        <div className="toolbar"><button className="button" disabled={campaignPage <= 1 || campaigns.isFetching} onClick={() => setCampaignPage(campaignPage - 1)}>이전 캠페인</button><span>{campaignPage} / {Math.max(1, Math.ceil(campaigns.data.pagination.total / campaigns.data.pagination.pageSize))} 페이지 · {campaigns.data.pagination.total}건</span><button className="button" disabled={campaignPage * campaigns.data.pagination.pageSize >= campaigns.data.pagination.total || campaigns.isFetching} onClick={() => setCampaignPage(campaignPage + 1)}>다음 캠페인</button></div>
      </> : null}
    </details>
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
