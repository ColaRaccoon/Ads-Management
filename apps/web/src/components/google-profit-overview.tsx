import { googleMoney, googleNumber, googleRatio, googleSaleUnit } from "@/lib/google-display";
import type { GoogleProfitRow, GoogleReportResponse } from "@/types/google";

function Margin({ value }: { value: number | null }) {
  const tone = value === null ? "pending" : value < 0 ? "negative" : value > 0 ? "positive" : "neutral";
  return <strong className={`google-margin-value google-margin-${tone}`}>{value === null ? "미확정" : googleMoney(value)}</strong>;
}

export function GoogleProfitOverview({ data, productName, filtered }: {
  data: GoogleReportResponse;
  productName: (id: string | null) => string;
  filtered: boolean;
}) {
  const cells = (row: GoogleProfitRow) => <>
    <td className="google-profit-margin"><Margin value={row.marginKrw} /></td>
    <td>{googleRatio(row.marginRate, true)}</td>
    <td>{googleNumber(row.quantity)}<small>{googleSaleUnit(row)}</small></td>
    <td>{googleMoney(row.revenueKrw)}</td>
    <td>{googleMoney(row.grossCostKrw)}</td>
    <td>{googleMoney(row.couponDeductionKrw)}</td>
    <td>{googleMoney(row.adSpendKrwExact)}</td>
    <td>{googleNumber(row.impressions)}</td>
    <td>{googleNumber(row.clicks)}</td>
    <td>{googleRatio(row.ctr ?? null, true)}</td>
    <td>{googleMoney(row.cpcKrw)}</td>
    <td>{googleMoney(row.costPerSaleKrw)}</td>
    <td>{googleRatio(row.roas)}</td>
    <td><span className={`badge ${row.complete ? "scale" : "watch"}`}>{row.complete ? "확정" : "미확정"}</span></td>
  </>;
  return <>
    <p className="field-help">{data.range.from} ~ {data.range.to} · {data.pagination.total}개 상품</p>
    <div className="table-wrap google-profit-table"><table aria-label="Google 마진">
      <thead><tr><th scope="col">상품</th><th scope="col">최종 마진</th><th scope="col">마진율</th><th scope="col">판매수량</th><th scope="col">설정가 매출</th><th scope="col">판매비용</th><th scope="col">쿠폰 차감</th><th scope="col">Google 광고비</th><th scope="col">노출수</th><th scope="col">클릭수</th><th scope="col">클릭률</th><th scope="col">클릭당 비용</th><th scope="col">판매 1개당 광고비</th><th scope="col">페이지 ROAS</th><th scope="col">상태</th></tr></thead>
      <tbody>{data.products.map((row) => <tr key={row.productId ?? "unmapped"}><th scope="row">{productName(row.productId)}</th>{cells(row)}</tr>)}
        {!data.products.length ? <tr><td colSpan={15}>선택한 조건의 상품 데이터가 없습니다.</td></tr> : null}
      </tbody>
      <tfoot><tr><td>{filtered ? "선택 범위 합계" : "Google 전체 합계"}<small>모든 페이지 포함</small></td>{cells(data.summary)}</tr></tfoot>
    </table></div>
  </>;
}

export function GoogleProfitTotal({ data, filtered }: { data: GoogleReportResponse; filtered: boolean }) {
  const total = data.summary;
  return <section className="panel google-profit-total" aria-label="Google 전체 마진 요약">
    <div className="google-profit-total-heading"><div><h2>{filtered ? "Google 선택 범위 마진" : "Google 전체 마진"}</h2><p className="field-help">{data.range.from} ~ {data.range.to} · {filtered ? "선택한 계정·쇼핑몰·상품" : "전체 계정·쇼핑몰·상품"} · 모든 페이지 포함</p></div><span className={`badge ${total.complete ? "scale" : "watch"}`}>{total.complete ? "확정" : "미확정"}</span></div>
    <div className="google-profit-total-amount"><span>최종 마진</span><Margin value={total.marginKrw} /><span>마진율 {googleRatio(total.marginRate, true)}</span></div>
    <div className="metric-strip">
      <div className="metric-cell"><span>설정가 매출</span><strong>{googleMoney(total.revenueKrw)}</strong></div>
      <div className="metric-cell"><span>판매비용</span><strong>{googleMoney(total.grossCostKrw)}</strong></div>
      <div className="metric-cell"><span>쿠폰 차감</span><strong>{googleMoney(total.couponDeductionKrw)}</strong></div>
      <div className="metric-cell"><span>Google 광고비</span><strong>{googleMoney(total.adSpendKrwExact)}</strong></div>
      <div className="metric-cell"><span>노출수 / 클릭수</span><strong>{googleNumber(total.impressions)} / {googleNumber(total.clicks)}</strong></div>
      <div className="metric-cell"><span>클릭률</span><strong>{googleRatio(total.ctr ?? null, true)}</strong></div>
      <div className="metric-cell"><span>클릭당 비용</span><strong>{googleMoney(total.cpcKrw)}</strong></div>
      <div className="metric-cell"><span>판매 1개당 광고비</span><strong>{googleMoney(total.costPerSaleKrw)}</strong></div>
      <div className="metric-cell"><span>페이지 ROAS</span><strong>{googleRatio(total.roas)}</strong></div>
    </div>
  </section>;
}
