import type { GoogleProfitRow } from "../types/google";

function finite(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Meta's display columns: total cost includes coupons; pre-coupon margin does not. */
export function googleProfitView(row: GoogleProfitRow) {
  const cost = finite(row.grossCostKrw);
  const ad = finite(row.adSpendKrwExact);
  const coupon = finite(row.couponDeductionKrw);
  const revenue = finite(row.revenueKrw);
  const baseCost = cost === null || ad === null ? null : finite(cost + ad);
  return {
    totalCostKrw: baseCost === null || coupon === null ? null : finite(baseCost + coupon),
    marginBeforeCouponKrw: revenue === null || baseCost === null ? null : finite(revenue - baseCost)
  };
}
