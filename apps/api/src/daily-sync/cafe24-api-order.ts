/** Minimal normalized Cafe24 order-line input used by the day snapshot writer. */
export type Cafe24ApiOrder = {
  orderNo: string; lineOrderNo: string; productNo: string; productName: string; optionName: string;
  orderedAt: Date; orderDate: Date; providerUpdatedAt: Date | null;
  quantity: string; salePriceKrw: string; totalOrderKrw: string | null;
  totalPaidKrw: string; paymentMethod: string | null;
  totalPaidInputSource?: "ORDERS_PAYMENT_AMOUNT" | null;
  providerPaymentCodes?: string[] | null; providerCouponSignal?: boolean | null;
  actualOrderPriceKrw?: string | null; actualPaymentKrw?: string | null;
  actualShippingFeeKrw?: string | null;
  initialOrderPriceKrw?: string | null; initialPaymentKrw?: string | null;
  initialShippingFeeKrw?: string | null;
  orderStatus?: string | null; lineStatus?: string | null;
  cancelledAt?: Date | null; cancelAmountKrw?: string | null;
  refundedAt?: Date | null; refundAmountKrw?: string | null;
  discountAmountKrw?: string | null; couponAmountKrw?: string | null;
};

