import { money, numberFmt } from "@/lib/date-range";
import { formatMarginRate } from "../daily-report-value";
import { salesProductLabel } from "../report-model";
import type { SalesProductRow } from "../types";

export function ProductSalesMarginSection({
  isError,
  isLoading,
  row
}: {
  isError: boolean;
  isLoading: boolean;
  row: SalesProductRow | null;
}) {
  return (
    <section className="daily-sales-margin">
      <h3>카페24 실매출 기반 마진</h3>
      {isLoading ? (
        <p className="daily-sales-empty">카페24 실매출 데이터를 불러오는 중입니다.</p>
      ) : isError ? (
        <p className="daily-sales-empty">카페24 실매출 데이터를 불러오지 못했습니다.</p>
      ) : !row ? (
        <p className="daily-sales-empty">매칭되는 카페24 실매출 데이터가 없습니다.</p>
      ) : (
        <>
          <div className="daily-sales-table-wrap">
            <table className="daily-sales-table">
              <thead>
                <tr>
                  <th>제품</th>
                  <th>판매수량</th>
                  <th>실매출</th>
                  <th>실결제액</th>
                  <th>상품 비용</th>
                  <th>광고비</th>
                  <th>쿠폰 차감</th>
                  <th>총비용</th>
                  <th>쿠폰 적용 전 마진</th>
                  <th>최종 순마진</th>
                  <th>마진율</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <span className="daily-sales-product-cell">
                      <strong>{salesProductLabel(row)}</strong>
                      <small>판매 행 {numberFmt(row.matchedSalesLineCount)}</small>
                    </span>
                  </td>
                  <td>{numberFmt(row.quantity)}</td>
                  <td>{money(row.revenueKrw, "KRW")}</td>
                  <td>{money(row.totalPaidKrw, "KRW")}</td>
                  <td>{money(row.grossCostKrw, "KRW")}</td>
                  <td>{money(row.adSpendKrw, "KRW")}</td>
                  <td>{money(row.couponDeductionKrw, "KRW")}</td>
                  <td>{money(row.totalCostKrw, "KRW")}</td>
                  <td>{money(row.marginBeforeCouponKrw, "KRW")}</td>
                  <td>{money(row.marginKrw, "KRW")}</td>
                  <td>{formatMarginRate(row.marginRate)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {row.couponOrderCount > 0 || row.couponIgnoredResidualKrw > 0 ? (
            <p className="daily-sales-note">
              쿠폰 적용 {numberFmt(row.couponOrderCount)}건 · 정확 {numberFmt(row.couponExactOrderCount)}건 ·
              추정 {numberFmt(row.couponEstimatedOrderCount)}건 · 무시 잔여 {money(row.couponIgnoredResidualKrw, "KRW")}
            </p>
          ) : null}
          {row.couponUnmatchedOrderCount > 0 ? (
            <p className="daily-sales-note">
              쿠폰 기록이 있으나 금액을 찾지 못한 주문 {numberFmt(row.couponUnmatchedOrderCount)}건
            </p>
          ) : null}
          {row.matchedSalesLineCount === 0 ? (
            <p className="daily-sales-note">해당 기준일에 매칭된 카페24 판매 행이 없어 0 기준으로 표시합니다.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
