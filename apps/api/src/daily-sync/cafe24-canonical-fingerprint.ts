import type { Cafe24ApiOrder } from "./cafe24-api-order";
import { cafe24ObservationHmac } from "./cafe24-observed-revision";

/** HMAC the complete normalized line; a bare hash could reveal low-entropy amounts/statuses. */
export function cafe24CanonicalFingerprint(key: Buffer, connectionId: string,
  row: Cafe24ApiOrder, productNo: string) {
  return cafe24ObservationHmac(key, "CANONICAL_LINE_V2", JSON.stringify([
    connectionId, row.orderNo.trim(), row.lineOrderNo.trim(), productNo, row.productName,
    row.optionName.trim(), row.orderedAt.toISOString(), row.orderDate.toISOString(),
    row.providerUpdatedAt?.toISOString() ?? null, row.quantity, row.salePriceKrw,
    row.totalOrderKrw, row.totalPaidKrw, row.totalPaidInputSource ?? null,
    row.paymentMethod,
    row.providerPaymentCodes ?? null, row.providerCouponSignal ?? null,
    row.actualOrderPriceKrw ?? null, row.actualPaymentKrw ?? null,
    row.actualShippingFeeKrw ?? null, row.initialOrderPriceKrw ?? null,
    row.initialPaymentKrw ?? null, row.initialShippingFeeKrw ?? null,
    row.orderStatus ?? null,
    row.lineStatus ?? null, row.cancelledAt?.toISOString() ?? null,
    row.cancelAmountKrw ?? null, row.refundedAt?.toISOString() ?? null,
    row.refundAmountKrw ?? null, row.discountAmountKrw ?? null, row.couponAmountKrw ?? null
  ]));
}
