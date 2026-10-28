import { Prisma } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import type { Cafe24ApiOrder } from "./cafe24-api-order";
import { ProviderFailure } from "./bounded-request";
import type { Cafe24FailureDiagnosticCode } from "./cafe24-failure-diagnostic";
import { CAFE24_OPTION_COMPONENT_LIMIT, cafe24OptionCompositionFits } from "./cafe24-option-projection";

function unsupported(code: Cafe24FailureDiagnosticCode): never {
  throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null, code);
}
function object(value: unknown, code: Cafe24FailureDiagnosticCode): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    unsupported(code);
  return value as Record<string, unknown>;
}
function id(value: unknown, code: Cafe24FailureDiagnosticCode) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    unsupported(code);
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(String(value)))
    unsupported(code);
  return String(value);
}
function requiredText(value: unknown, code: Cafe24FailureDiagnosticCode, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    unsupported(code);
  return value.trim();
}
function decimal(value: unknown, code: Cafe24FailureDiagnosticCode, precision = 18, scale = 2) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    unsupported(code);
  if ((typeof value !== "string" && typeof value !== "number") ||
      !new RegExp(`^(?:0|[1-9]\\d{0,${precision - scale - 1}})(?:\\.\\d{1,${scale}})?$`).test(String(value)))
    unsupported(code);
  return new Prisma.Decimal(String(value)).toFixed(scale);
}
function providerAmount(value: unknown, code: Cafe24FailureDiagnosticCode) {
  if (value == null) return { orderPriceKrw: null, paymentKrw: null, shippingFeeKrw: null };
  const amount = object(value, code);
  const typedMoney = (field: unknown) => {
    if (field == null) return null;
    if (typeof field !== "string") unsupported(code);
    return decimal(field, code);
  };
  return {
    // Admin Orders describes order_price_amount as the product subtotal. It
    // is not the legacy CSV total order amount, which also has other inputs.
    orderPriceKrw: typedMoney(amount.order_price_amount),
    paymentKrw: typedMoney(amount.payment_amount),
    shippingFeeKrw: typedMoney(amount.shipping_fee)
  };
}
function timestamp(value: unknown, code: Cafe24FailureDiagnosticCode) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d\d-\d\d(?:T| )\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value))
    unsupported(code);
  const normalized = value.replace(" ", "T");
  const result = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(normalized)
    ? normalized : `${normalized}+09:00`);
  if (!Number.isFinite(result.getTime())) unsupported(code);
  return result;
}

type CsvOptionEvidence = { mallId: string; shopKey: string };
// Cafe24 Admin Orders payment_method enum (2026-09-01). Codes are retained as
// provider data; only the exact coupon member is a coupon-use indication.
const KNOWN_PAYMENT_CODES = new Set(["cash", "card", "cell", "tcash", "icash",
  "prepaid", "credit", "point", "pointfy", "cvs", "cod", "coupon",
  "market_discount", "giftcard", "pointcard", "etc"]);

export function cafe24ProviderCouponSignal(codes: readonly string[] | null): boolean | null {
  return codes?.includes("coupon") ? true :
    codes && codes.length > 0 && codes.every((code) => KNOWN_PAYMENT_CODES.has(code))
      ? false : null;
}

/** Project only approved order/item fields. Personal fields never enter canonical rows. */
export function normalizeCafe24Order(rawOrder: unknown, rawItems: unknown,
  options: { verifiedSellerDropdown?: boolean; csvOptionEvidence?: CsvOptionEvidence;
    compositionOrigins?: Map<string, string>;
    paymentMethodCsvLabels?: Readonly<Record<string, string>> | null } = {}): Cafe24ApiOrder[] {
  const order = object(rawOrder, "CAFE24_FIELD_ORDER_SHAPE");
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 1_000)
    throw new ProviderFailure("PARTIAL_PAGE", false);
  const orderNo = id(order.order_id, "CAFE24_FIELD_ORDER_ID");
  if (order.currency !== "KRW") throw new ProviderFailure("CURRENCY_MISMATCH", false);
  const orderedAt = timestamp(order.order_date, "CAFE24_FIELD_ORDER_DATE");
  // The live Orders response does not expose a revision timestamp. Absence is
  // distinct from order_date and from the time at which we observed a response.
  const providerUpdatedAt = order.updated_date == null ? null :
    timestamp(order.updated_date, "CAFE24_FIELD_UPDATED_DATE");
  const localDay = formatInTimeZone(orderedAt, "Asia/Seoul", "yyyy-MM-dd");
  const orderDate = new Date(`${localDay}T00:00:00.000Z`);
  // The seller confirmed controlled dropdown options for this mall. Each new
  // completed day still needs complete sibling checks and source comparison.
  if (!options.verifiedSellerDropdown || options.csvOptionEvidence?.mallId !== "didadi0729" ||
      options.csvOptionEvidence.shopKey !== "shop1" || String(order.shop_no) !== "1")
    unsupported("CAFE24_FIELD_PROJECTION");
  const totalPaidKrw = decimal(order.payment_amount, "CAFE24_FIELD_PAYMENT_AMOUNT");
  // No verified Orders field currently projects to CSV `총 주문금액`.
  // Keep the provider's nested current/initial amounts under their own names.
  if (order.order_price_amount != null) unsupported("CAFE24_FIELD_TOP_ORDER_PRICE");
  const totalOrderKrw = null;
  const actualAmount = providerAmount(order.actual_order_amount, "CAFE24_FIELD_ACTUAL_AMOUNT");
  const initialAmount = providerAmount(order.initial_order_amount, "CAFE24_FIELD_INITIAL_AMOUNT");
  // Live Orders uses an array of provider codes. Until each code has a proven
  // CSV label, preserve the unknown state; a blank string would mean no coupon.
  if (order.payment_method != null && typeof order.payment_method !== "string" &&
      (!Array.isArray(order.payment_method) || order.payment_method.length > 16 ||
       !order.payment_method.every((value) => typeof value === "string" &&
         value.length > 0 && value.length <= 64 &&
         !/[\u0000-\u001f\u007f]/.test(value))))
    unsupported("CAFE24_FIELD_PAYMENT_METHOD");
  const codes = Array.isArray(order.payment_method) ? order.payment_method :
    typeof order.payment_method === "string" ? [order.payment_method] : null;
  if (codes?.some((code) => typeof code !== "string" || !code || code.length > 64 ||
      /[\u0000-\u001f\u007f]/.test(code)))
    unsupported("CAFE24_FIELD_PAYMENT_METHOD");
  const labels = options.paymentMethodCsvLabels;
  const mapped = labels && codes && codes.length > 0 &&
    codes.every((code) => Object.prototype.hasOwnProperty.call(labels, code))
    ? codes.map((code) => labels[String(code)]) : null;
  if (mapped && mapped.some((label) => typeof label !== "string" || !label ||
      label.length > 64 || label !== label.trim() || /[,\u0000-\u001f\u007f]/.test(label)))
    unsupported("CAFE24_FIELD_PAYMENT_METHOD");
  const paymentMethod = mapped && mapped.length === new Set(mapped).size
    ? mapped.join(",") : null;
  const providerCouponSignal = cafe24ProviderCouponSignal(codes);
  const orderStatus = order.order_status == null ? null :
    requiredText(order.order_status, "CAFE24_FIELD_ORDER_STATUS", 64);
  const seen = new Set<string>();
  const compositionOrigins = options.compositionOrigins ?? new Map<string, string>();
  return rawItems.map((rawItem) => {
    const item = object(rawItem, "CAFE24_FIELD_ITEM_SHAPE");
    const lineOrderNo = id(item.order_item_code, "CAFE24_FIELD_ITEM_ID");
    if (seen.has(lineOrderNo)) throw new ProviderFailure("RECONCILIATION_FAILED", false);
    seen.add(lineOrderNo);
    if (!Object.prototype.hasOwnProperty.call(item, "option_value"))
      unsupported("CAFE24_FIELD_OPTION_VALUE");
    // Null/empty options were not represented in either complete CSV/API sample.
    if (typeof item.option_value !== "string" || !item.option_value.trim())
      unsupported("CAFE24_FIELD_OPTION_VALUE");
    const option = requiredText(item.option_value, "CAFE24_FIELD_OPTION_VALUE",
      CAFE24_OPTION_COMPONENT_LIMIT);
    const productName = requiredText(item.product_name, "CAFE24_FIELD_PRODUCT_NAME",
      CAFE24_OPTION_COMPONENT_LIMIT);
    if (option !== item.option_value || /[\u0000-\u001f\u007f]/.test(option))
      unsupported("CAFE24_FIELD_OPTION_VALUE");
    if (productName !== item.product_name || /[\u0000-\u001f\u007f]/.test(productName))
      unsupported("CAFE24_FIELD_PRODUCT_NAME");
    const optionName = `${productName}(${option})`;
    if (!cafe24OptionCompositionFits(optionName)) unsupported("CAFE24_FIELD_OPTION_COMPOSITION");
    const productNo = id(item.product_no, "CAFE24_FIELD_PRODUCT_NO");
    // The display composition is not intrinsically injective. Detect any
    // conflicting origin pair across the complete day snapshot in memory.
    const composedKey = JSON.stringify([productNo, optionName]);
    const origin = JSON.stringify([productName, option]);
    const prior = compositionOrigins.get(composedKey);
    if (prior !== undefined && prior !== origin)
      throw new ProviderFailure("RECONCILIATION_FAILED", false);
    compositionOrigins.set(composedKey, origin);
    const lineStatus = requiredText(item.order_status, "CAFE24_FIELD_ITEM_STATUS", 64);
    return {
      orderNo, lineOrderNo, productNo, productName,
      optionName, optionValue: option, orderedAt, orderDate, providerUpdatedAt,
      quantity: decimal(item.quantity, "CAFE24_FIELD_QUANTITY", 14, 4),
      salePriceKrw: decimal(item.product_price, "CAFE24_FIELD_PRODUCT_PRICE"),
      // The order-level values remain repeated in the v1 legacy line projection;
      // coverage and v2 reconciliation must count each order only once.
      totalOrderKrw, totalPaidKrw, totalPaidInputSource: "ORDERS_PAYMENT_AMOUNT" as const,
      paymentMethod,
      providerPaymentCodes: codes, providerCouponSignal,
      actualOrderPriceKrw: actualAmount.orderPriceKrw,
      actualPaymentKrw: actualAmount.paymentKrw,
      actualShippingFeeKrw: actualAmount.shippingFeeKrw,
      initialOrderPriceKrw: initialAmount.orderPriceKrw,
      initialPaymentKrw: initialAmount.paymentKrw,
      initialShippingFeeKrw: initialAmount.shippingFeeKrw,
      orderStatus, lineStatus,
      cancelledAt: null, cancelAmountKrw: null, refundedAt: null,
      refundAmountKrw: null, discountAmountKrw: null, couponAmountKrw: null
    };
  });
}
