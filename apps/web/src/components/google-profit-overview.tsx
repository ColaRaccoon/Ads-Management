import { DataTable, type Column } from "@/components/data-table";
import { googleMoney, googleNumber, googleRatio, googleSaleUnit } from "@/lib/google-display";
import { googleProfitView } from "@/lib/google-profit-view";
import type { GoogleProfitRow, GoogleReportResponse } from "@/types/google";

function margin(value: number | null) {
  return value === null ? "미확정" : googleMoney(value);
}

function Status({ complete }: { complete: boolean }) {
  return <span className={`badge ${complete ? "scale" : "watch"}`}>{complete ? "확정" : "미확정"}</span>;
}

export function GoogleProfitOverview({ data, productName, filtered }: {
  data: GoogleReportResponse;
  productName: (id: string | null) => string;
  filtered: boolean;
}) {
  const columns: Column<GoogleProfitRow>[] = [
    { key: "product", header: "제품", render: (row) => productName(row.productId) },
    { key: "qty", header: "수량", render: (row) => <span title={googleSaleUnit(row)}>{googleNumber(row.quantity)}</span> },
    { key: "revenue", header: "매출", render: (row) => googleMoney(row.revenueKrw) },
    { key: "coupon", header: "쿠폰 차감", render: (row) => googleMoney(row.couponDeductionKrw) },
    { key: "ad", header: "광고비", render: (row) => googleMoney(row.adSpendKrwExact) },
    { key: "cost", header: "총비용", render: (row) => googleMoney(googleProfitView(row).totalCostKrw) },
    { key: "marginBeforeCoupon", header: "쿠폰 적용 전 마진", render: (row) => margin(googleProfitView(row).marginBeforeCouponKrw) },
    { key: "margin", header: "최종 순마진", render: (row) => margin(row.marginKrw) },
    { key: "roas", header: "광고수익률", render: (row) => googleRatio(row.roas) },
    { key: "costPerSale", header: "판매 1개당 광고비", render: (row) => googleMoney(row.costPerSaleKrw) },
    { key: "marginRate", header: "마진율", render: (row) => googleRatio(row.marginRate, true) },
    { key: "impressions", header: "노출수", render: (row) => googleNumber(row.impressions) },
    { key: "clicks", header: "클릭수", render: (row) => googleNumber(row.clicks) },
    { key: "ctr", header: "클릭률", render: (row) => googleRatio(row.ctr ?? null, true) },
    { key: "cpc", header: "클릭당 비용", render: (row) => googleMoney(row.cpcKrw) },
    { key: "status", header: "상태", render: (row) => <Status complete={row.complete} /> }
  ];
  return <section aria-label="Google 마진">
    <p className="field-help">{data.range.from} ~ {data.range.to} · {data.pagination.total}개 상품</p>
    <DataTable<GoogleProfitRow>
      rows={data.products}
      columns={columns}
      getRowKey={(row) => row.productId ?? "unmapped"}
      empty="선택한 조건의 상품 데이터가 없습니다."
      footer={<tr>
        <td>{filtered ? "선택 범위 합계" : "Google 전체 합계"}<small style={{ display: "block" }}>모든 페이지 포함</small></td>
        {columns.slice(1).map((column) => <td key={column.key}>{column.render(data.summary)}</td>)}
      </tr>}
    />
  </section>;
}

export function GoogleProfitTotal({ data, filtered }: { data: GoogleReportResponse; filtered: boolean }) {
  const total = data.summary;
  const view = googleProfitView(total);
  return <section className="panel" style={{ marginTop: 12 }} aria-label="Google 전체 마진 요약">
    <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
      <div>
        <h2>{filtered ? "Google 선택 범위 마진" : "Google 전체 마진"}</h2>
        <p className="field-help">{data.range.from} ~ {data.range.to} · {filtered ? "선택한 계정·쇼핑몰·상품" : "전체 계정·쇼핑몰·상품"} · 모든 페이지 포함</p>
      </div>
      <Status complete={total.complete} />
    </div>
    <div className="metric-strip">
      <div className="metric-cell"><span>최종 순마진</span><strong>{margin(total.marginKrw)}</strong></div>
      <div className="metric-cell"><span>마진율</span><strong>{googleRatio(total.marginRate, true)}</strong></div>
      <div className="metric-cell"><span>매출</span><strong>{googleMoney(total.revenueKrw)}</strong></div>
      <div className="metric-cell"><span>판매비용</span><strong>{googleMoney(total.grossCostKrw)}</strong></div>
      <div className="metric-cell"><span>쿠폰 차감</span><strong>{googleMoney(total.couponDeductionKrw)}</strong></div>
      <div className="metric-cell"><span>광고비</span><strong>{googleMoney(total.adSpendKrwExact)}</strong></div>
      <div className="metric-cell"><span>총비용</span><strong>{googleMoney(view.totalCostKrw)}</strong></div>
      <div className="metric-cell"><span>쿠폰 적용 전 마진</span><strong>{margin(view.marginBeforeCouponKrw)}</strong></div>
      <div className="metric-cell"><span>광고수익률</span><strong>{googleRatio(total.roas)}</strong></div>
      <div className="metric-cell"><span>판매 1개당 광고비</span><strong>{googleMoney(total.costPerSaleKrw)}</strong></div>
      <div className="metric-cell"><span>노출수 / 클릭수</span><strong>{googleNumber(total.impressions)} / {googleNumber(total.clicks)}</strong></div>
      <div className="metric-cell"><span>클릭률</span><strong>{googleRatio(total.ctr ?? null, true)}</strong></div>
      <div className="metric-cell"><span>클릭당 비용</span><strong>{googleMoney(total.cpcKrw)}</strong></div>
    </div>
  </section>;
}
