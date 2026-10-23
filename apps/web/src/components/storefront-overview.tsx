import Link from "next/link";
import { DataTable } from "./data-table";
import { KpiCard } from "./kpi-card";
import { storefrontDecimal, storefrontLabel, storefrontMoney, storefrontTime } from "@/lib/storefront-display";
import { StorefrontSummary } from "@/types/storefront";

export function StorefrontOverview({ data }: { data: StorefrontSummary }) {
  return <>
    <div className="warning-strip" role="status">
      <span>{data.complete ? "선택 기간 수집 완료" : "선택 기간 합계 미완전"}</span>
      <span>마지막 성공 자료 기준 {storefrontTime(data.asOf)} (한국시간)</span>
      {data.missingSources.length > 0 ? <span>확인 필요 채널: {data.missingSources.map(storefrontLabel).join(", ")}</span> : null}
      <span>통화·환율: {currencyLabel(data.currencyStatus)}</span>
    </div>
    <div className="grid kpi" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
      <KpiCard label="Cafe24 매출" value={storefrontMoney(data.totals.revenueKrw)} helper="매칭된 품목 · 기존 판매가 기준" />
      <KpiCard label="확인된 광고비" value={storefrontMoney(data.totals.knownSpendKrw)} helper="확인된 채널 금액만 · 전체 합계와 구분" />
      <KpiCard label="총 광고비" value={storefrontMoney(data.totals.totalSpendKrw)} helper={data.complete ? "선택 기간·통화 기준" : "누락·미연동·환율 확인 전 미확정"} />
      <KpiCard label="통합 광고비 대비 매출 (MER)" value={data.totals.mer === null ? "—" : `${storefrontDecimal(data.totals.mer)}배`} helper="Cafe24 매출 ÷ 총 광고비 · 0분모/미확인 시 —" />
    </div>
    <div className="grid two" style={{ marginTop: 12 }}>
      <div className="panel">
        <h2>채널별 수집·금액</h2>
        <DataTable rows={data.channels} getRowKey={(row) => row.provider} columns={[
          { key: "provider", header: "채널", render: (row) => storefrontLabel(row.provider) },
          { key: "amount", header: "원본 금액", render: (row) => row.provider === "KAKAO" ? "미연동" : storefrontMoney(row.amount, row.currency) },
          { key: "krw", header: "원화 광고비", render: (row) => row.provider === "CAFE24" || row.provider === "KAKAO" ? "—" : storefrontMoney(row.spendKrw) },
          { key: "state", header: "수집 상태", render: (row) => storefrontLabel(row.state) }
        ]} />
        <p>Cafe24만 자사몰 매출에 반영합니다. Meta·Google의 광고 기여 전환매출은 더하지 않습니다. Meta 비용은 기존 광고세트 수준 한 번만 반영합니다.</p>
      </div>
      <div className="panel">
        <h2>이 수치의 적용 범위</h2>
        <p>매출은 기존 판매가·매칭 규칙에 따른 금액입니다. 쿠폰은 내부 규칙으로 추정하며 실제 쿠폰 확정액이나 환불 반영 순매출이 아닙니다.</p>
        <p>기존 <Link href="/sales" prefetch={false}>상품별 마진</Link>은 검증된 Cafe24·Meta 계산을 유지합니다. Google 비용은 공통 미배분 비용이며 모든 상품에 반복 배분하지 않습니다.</p>
        <p>보고 광고비는 카드 청구액이나 세금 포함 정산액이 아닙니다. 다른 계정 통화·날짜 기준은 아래 원천별 자료에서 확인하세요.</p>
        <p><Link href="/uploads" prefetch={false}>CSV 업로드·이력</Link>은 계속 사용할 수 있습니다. 자동 연결과 충돌한 자료는 원천 선택을 먼저 검토해야 합니다.</p>
      </div>
    </div>
    {data.warningCodes.length > 0 ? <div className="panel" style={{ marginTop: 12 }}>
      <h2>확인할 사항</h2>
      <ul>{[...new Set(data.warningCodes.map(storefrontLabel))].map((warning) => <li key={warning}>{warning}</li>)}</ul>
    </div> : null}
    <div className="panel" style={{ marginTop: 12 }}>
      <h2>일별 매출·지출 추이</h2>
      <p>—는 정상 0원이 아닙니다. 확인된 합계만 있는 날짜는 전체 광고비를 확정하지 않습니다.</p>
      <DataTable rows={data.daily} getRowKey={(row) => row.date} columns={[
        { key: "date", header: "기준일", render: (row) => row.date },
        { key: "revenue", header: "Cafe24 매출", render: (row) => storefrontMoney(row.revenueKrw) },
        { key: "meta", header: "Meta (USD)", render: (row) => storefrontMoney(row.metaSpendUsd, "USD") },
        { key: "google", header: "Google (원화)", render: (row) => storefrontMoney(row.googleSpendKrw) },
        { key: "known", header: "확인된 광고비", render: (row) => storefrontMoney(row.knownSpendKrw) },
        { key: "total", header: "총 광고비", render: (row) => storefrontMoney(row.totalSpendKrw) },
        { key: "complete", header: "완전성", render: (row) => row.complete ? "완료" : "미완전" }
      ]} />
    </div>
    <div className="panel" style={{ marginTop: 12 }}>
      <h2>Google 캠페인별 비용</h2>
      <p>선택된 원천의 날짜별 캠페인입니다. 비용이 0이고 수집 완료인 날에는 캠페인 행이 없을 수 있습니다.</p>
      <DataTable rows={data.googleCampaigns} getRowKey={(row) => `${row.connectionId}:${row.date}:${row.campaignId}`} empty="선택 기간에 표시할 캠페인 행이 없습니다. 아래 수집 상태에서 정상 0과 미수집을 구분하세요." columns={[
        { key: "date", header: "기준일", render: (row) => row.date },
        { key: "campaign", header: "캠페인", render: (row) => row.campaignName },
        { key: "type", header: "유형", render: (row) => row.channelType },
        { key: "cost", header: "비용 (원본 통화)", render: (row) => storefrontMoney(row.amount, row.currency) },
        { key: "impressions", header: "노출", render: (row) => storefrontDecimal(row.impressions) },
        { key: "clicks", header: "클릭", render: (row) => storefrontDecimal(row.clicks) },
        { key: "asOf", header: "수집 시점", render: (row) => storefrontTime(row.fetchedAt) }
      ]} />
    </div>
    <div className="panel" style={{ marginTop: 12 }}>
      <h2>날짜·계정별 수집 상태</h2>
      {data.missingDates.length > 0 ? <p>누락·확인 필요 날짜: {data.missingDates.join(", ")}</p> : null}
      <DataTable rows={data.coverage} getRowKey={(row) => `${row.connectionId}:${row.dataKind}:${row.date}`} empty="등록된 연결의 수집 자료가 없습니다. 미설정 상태이며 정상 0원이 아닙니다." columns={[
        { key: "provider", header: "채널 / 계정", render: (row) => `${storefrontLabel(row.provider)} · ${row.account}` },
        { key: "day", header: "기준일 / 시간대", render: (row) => <>{row.date}<br /><small>{row.timeZone} · {row.currency}</small></> },
        { key: "kind", header: "자료 / 원천", render: (row) => <>{dataKindLabel(row.dataKind)}<br />{storefrontLabel(row.selectedSource)}</> },
        { key: "state", header: "수집 상태", render: (row) => <>{storefrontLabel(row.state)}{row.warningCodes.length > 0 ? <p>{[...new Set(row.warningCodes.map(storefrontLabel))].join(" ")}</p> : null}</> },
        { key: "attempt", header: "최근 시도", render: (row) => <>{storefrontTime(row.lastAttemptAt)}<br />{storefrontLabel(row.lastAttemptStatus)}</> },
        { key: "success", header: "최근 성공", render: (row) => storefrontTime(row.lastSuccessAt) }
      ]} />
    </div>
    <div className="panel" style={{ marginTop: 12 }}>
      <h2>적용 환율</h2>
      <p>계정의 현지 하루를 그대로 사용합니다. 시간대가 다른 자료를 날짜 문자열만 바꾸어 합산하지 않습니다. 환율 누락은 0원으로 채우지 않습니다.</p>
      <DataTable rows={data.exchangeRates} getRowKey={(row) => `${row.date}:${row.provider}:${row.productId ?? "common"}`} empty="적용 가능한 환율 기록이 없습니다. USD 비용이 있다면 원화 합계의 확인이 필요합니다." columns={[
        { key: "date", header: "적용일", render: (row) => row.date },
        { key: "rate", header: "1 USD당 KRW", render: (row) => storefrontDecimal(row.rate) },
        { key: "source", header: "환율 기준일 / 출처", render: (row) => `${row.sourceDate} · ${row.provider === "PRODUCT_COST_RULE" ? "상품 원가 설정" : row.provider === "KOREA_EXIM" ? "한국수출입은행" : "기록된 환율 출처"}` },
        { key: "scope", header: "적용 범위", render: (row) => row.productId ? <Link href="/settings/products" prefetch={false}>{row.productDisplayName ?? "상품별 원가 설정"} · {row.sourceDate} ~ {row.effectiveTo ?? "종료일 없음"}</Link> : "공통 환율" },
        { key: "fallback", header: "적용 방식", render: (row) => row.fallbackType === "LEGACY_PRODUCT_RULE" ? "기존 상품별 환율" : row.fallbackType === "NONE" || row.fallbackType === "EXACT" ? "해당일 환율" : "대체 기준일 환율 · 확인 필요" }
      ]} />
    </div>
  </>;
}

function dataKindLabel(kind: string) {
  return ({ CAFE24_ORDER: "주문", META_AD: "Meta 광고", META_ADSET: "Meta 광고세트", GOOGLE_CAMPAIGN: "Google 캠페인" } as Record<string, string>)[kind] ?? "수집 자료";
}

function currencyLabel(status: string) {
  return ({ COMPLETE: "확인됨", ALIGNED: "확인됨", MISSING_EXCHANGE_RATE: "환율 누락", INCOMPLETE: "미확인 / 환율 누락", MISMATCH: "통화·날짜 기준 확인 필요", INCOMPATIBLE_SCOPE: "통화・시간대 불일치" } as Record<string, string>)[status] ?? "확인 필요";
}
