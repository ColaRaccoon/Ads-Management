import { Injectable } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { Prisma, SourceDataKind } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { PrismaService } from "../common/prisma.service";
import { boundedProviderRequest, collectBoundedPages, ProviderFailure } from "./bounded-request";
import { cafe24RetryAfterMs } from "./cafe24-rate-limit";
import { Cafe24OauthService } from "./cafe24-oauth.service";
import { cafe24TestAllowed } from "./cafe24-test-connection.service";
import { cafe24ObservedRevision, cafe24ObservationHmac,
  cafe24ObservationKey } from "./cafe24-observed-revision";
import { cafe24ObservationEpochKey, type Cafe24ObservationEpochScope,
  type Cafe24ObservationEpochMetadata } from "./cafe24-observation-epoch";
import { assertCafe24AppVersionEvidence, assertCafe24SellerOptionsEvidence,
  assertCafe24TestReadEnabled, PAGE_ROW_LIMITS, parseIsoDate, syncError } from "./sync-contract";

export const CAFE24_PAGE_LIMIT = 100;
const CAFE24_ITEM_READ_CONCURRENCY = 4;
const CAFE24_OBSERVATION_ORDER_LIMIT = 1_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_HMAC_RESPONSE_BYTES = 192 * 1024;
const MAX_HMAC_DIGESTS = 2_500;
const SAFE_ERROR_CODES = new Set(["400", "401", "403", "404", "422", "429", "500", "503",
  "INVALID_REQUEST", "invalid_request"]);

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return value as Record<string, unknown>;
}
export function identifier(value: unknown) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(String(value)))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return String(value);
}
function money(value: unknown) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^(0|[1-9]\d{0,14})(?:\.\d{1,2})?$/.test(String(value)))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return new Prisma.Decimal(String(value));
}
function quantity(value: unknown) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^(0|[1-9]\d{0,9})(?:\.\d{1,4})?$/.test(String(value)))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return new Prisma.Decimal(String(value));
}
export function orderDay(value: unknown) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d\d-\d\d(?:T| )\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const normalized = value.replace(" ", "T");
  const instant = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(normalized)
    ? normalized : `${normalized}+09:00`);
  if (!Number.isFinite(instant.getTime())) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return formatInTimeZone(instant, "Asia/Seoul", "yyyy-MM-dd");
}
function statusBucket(value: unknown) {
  if (value === undefined) return "ABSENT";
  if (value === null) return "NULL";
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,15}$/.test(value)
    ? value : "UNSUPPORTED_SHAPE";
}
function incrementStatus(counts: Record<string, number>, value: unknown) {
  const bucket = statusBucket(value);
  counts[bucket] = (counts[bucket] ?? 0) + 1;
}
function diagnosticShape(value: unknown, sampled = true) {
  return !sampled ? "no_sample" : value === undefined ? "absent" : value === null ? "null" :
    Array.isArray(value) ? "array" : typeof value;
}
function incrementShape(counts: Record<string, number>, value: unknown) {
  const shape = diagnosticShape(value);
  counts[shape] = (counts[shape] ?? 0) + 1;
}
const timelineTimeBuckets = ["BEFORE_08", "FROM_08_TO_BEFORE_10", "AT_OR_AFTER_10",
  "UNREADABLE"] as const;
type TimelineTimeBucket = typeof timelineTimeBuckets[number];
function emptyTimelineTimeBuckets(): Record<TimelineTimeBucket, number> {
  return { BEFORE_08: 0, FROM_08_TO_BEFORE_10: 0, AT_OR_AFTER_10: 0, UNREADABLE: 0 };
}
function classifyTimelineCreatedTime(value: unknown): {
  bucket: TimelineTimeBucket; zone: "EXPLICIT_OFFSET" | "NAIVE_ASSUMED_MALL_KST" | "UNREADABLE";
} {
  const unreadable = { bucket: "UNREADABLE" as const, zone: "UNREADABLE" as const };
  if (typeof value !== "string" || value.length > 40) return unreadable;
  const match = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)?$/.exec(value);
  if (!match) return unreadable;
  const [, year, month, day, hour, minute, second, fraction, suffix] = match;
  const y = Number(year), mo = Number(month), d = Number(day), h = Number(hour);
  const mi = Number(minute), s = Number(second);
  const valid = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (valid.getUTCFullYear() !== y || valid.getUTCMonth() + 1 !== mo ||
      valid.getUTCDate() !== d || valid.getUTCHours() !== h ||
      valid.getUTCMinutes() !== mi || valid.getUTCSeconds() !== s) return unreadable;
  if (suffix && suffix !== "Z") {
    const offsetHours = Number(suffix.slice(1, 3));
    const offsetMinutes = Number(suffix.slice(4, 6));
    if (offsetHours > 14 || offsetMinutes > 59 || offsetHours === 14 && offsetMinutes !== 0)
      return unreadable;
  }
  const instant = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ? `.${fraction}` : ""}${suffix ?? "+09:00"}`);
  if (!Number.isFinite(instant)) return unreadable;
  const before08 = Date.parse("2026-10-01T08:00:00+09:00");
  const before10 = Date.parse("2026-10-01T10:00:00+09:00");
  return { bucket: instant < before08 ? "BEFORE_08" :
    instant < before10 ? "FROM_08_TO_BEFORE_10" : "AT_OR_AFTER_10",
  zone: suffix ? "EXPLICIT_OFFSET" : "NAIVE_ASSUMED_MALL_KST" };
}
export function safeCafe24ErrorCode(value: unknown): string | null {
  const code = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value) : typeof value === "string" && value.length <= 32 ? value : "";
  return SAFE_ERROR_CODES.has(code) ? code : null;
}

function hmacTuple(key: Buffer, domain: "order" | "item" | "paid" |
  "order-day" | "place-day" | "order-instant" | "place-instant" |
  "option-product" | "option-quantity" | "option-price" | "option-name" |
  "option-snapshot" | "order-total" | "coupon-flag" | "coupon-delta" | "amount-observation",
  ...parts: string[]) {
  const hmac = createHmac("sha256", key).update(`cafe24-06-hmac-v1/${domain}\0`, "utf8");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hmac.update(length).update(bytes);
    length.fill(0);
    bytes.fill(0);
  }
  return hmac.digest("hex");
}

function orderInstant(value: unknown): string {
  if (typeof value !== "string")
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const normalized = value.replace(" ", "T");
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)?$/.exec(normalized);
  if (!parts) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const checked = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() + 1 !== month ||
      checked.getUTCDate() !== day || checked.getUTCHours() !== hour ||
      checked.getUTCMinutes() !== minute || checked.getUTCSeconds() !== second)
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const zone = parts[8] ?? "+09:00";
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 14 ||
      Number(zone.slice(4, 6)) > 59 ||
      (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4, 6)) !== 0)))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const instant = new Date(`${normalized.slice(0, 19)}${zone}`);
  if (!Number.isFinite(instant.getTime()))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return `${instant.toISOString().slice(0, 19)}.${(parts[7] ?? "").padEnd(6, "0")}Z`;
}
function optionItem(raw: unknown) {
  const unsupported = (field: string): never => {
    throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null, field);
  };
  const safeIdentifier = (value: unknown, field: string): string => {
    try { return identifier(value); } catch { return unsupported(field); }
  };
  const safeText = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value.trim() || value.length > 512)
      return unsupported(field);
    return value.trim();
  };
  const safeMoney = (value: unknown, field: string): string => {
    try { return money(value).toFixed(2); } catch { return unsupported(field); }
  };
  const signedOptionMoney = (value: unknown) => {
    if (typeof value === "number" && !Number.isSafeInteger(value))
      return unsupported("OPTION_PRICE_UNSAFE_NUMBER");
    if (typeof value !== "string" && typeof value !== "number")
      return unsupported("OPTION_PRICE_TYPE");
    if (value === "") return unsupported("OPTION_PRICE_EMPTY");
    if (!/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,2})?$/.test(String(value)))
      return unsupported("OPTION_PRICE_FORMAT");
    const decimal = new Prisma.Decimal(String(value));
    return { value: decimal.toFixed(2), sign: decimal.isNegative() && !decimal.isZero()
      ? "NEGATIVE" as const : decimal.isZero() ? "ZERO" as const : "POSITIVE" as const };
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) unsupported("ITEM_SHAPE");
  const item = raw as Record<string, unknown>;
  const code = safeIdentifier(item.order_item_code, "ITEM_CODE");
  const productNo = safeIdentifier(item.product_no, "PRODUCT_NO");
  const productName = safeText(item.product_name, "PRODUCT_NAME");
  const optionValue = safeText(item.option_value, "OPTION_VALUE");
  const quantity = typeof item.quantity === "number" && Number.isSafeInteger(item.quantity)
    ? item.quantity : typeof item.quantity === "string" && /^\d{1,9}$/.test(item.quantity)
      ? Number(item.quantity) : NaN;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1_000_000)
    unsupported("QUANTITY");
  const optionPriceShape = !Object.prototype.hasOwnProperty.call(item, "option_price")
    ? "ABSENT" as const : item.option_price === null ? "NULL" as const : "VALUE" as const;
  const optionMoney = optionPriceShape === "VALUE"
    ? signedOptionMoney(item.option_price) : null;
  const optionPrice = optionMoney?.value ?? null;
  const optionPriceSign = optionMoney?.sign ?? null;
  const salePrice = safeMoney(item.product_price, "PRODUCT_PRICE");
  return { code, productNo, productName, optionValue,
    quantity: String(quantity), salePrice, optionPrice, optionPriceShape,
    optionPriceSign };
}
function optionItemsHash(key: Buffer, items: unknown) {
  if (!Array.isArray(items) || items.length === 0 || items.length >= CAFE24_PAGE_LIMIT)
    throw new ProviderFailure("PARTIAL_PAGE", false);
  const projected = items.map(optionItem).sort((a, b) => a.code.localeCompare(b.code));
  if (new Set(projected.map((item) => item.code)).size !== projected.length)
    throw new ProviderFailure("RECONCILIATION_FAILED", false);
  return hmacTuple(key, "option-snapshot", JSON.stringify(projected));
}
type DiagnosticResponse = {
  status: number | null;
  kind: "json" | "invalid_json" | "empty" | "http_error" | "too_large" |
    "transport_error" | "deadline" | "budget";
  providerCode?: string | null;
  body?: unknown;
};

/** One bounded group settles before the next starts. Promise results retain
 * input order, and any failed sibling prevents a partial aggregate. */
async function* itemReadGroups<T, R>(rows: readonly T[], read: (row: T) => Promise<R>) {
  for (let offset = 0; offset < rows.length; offset += CAFE24_ITEM_READ_CONCURRENCY) {
    const settled = await Promise.allSettled(rows.slice(offset,
      offset + CAFE24_ITEM_READ_CONCURRENCY).map(read));
    const failed = settled.find((result): result is PromiseRejectedResult =>
      result.status === "rejected");
    if (failed) throw failed.reason;
    yield settled.map((result) => (result as PromiseFulfilledResult<R>).value);
  }
}

@Injectable()
export class Cafe24OrderPreflightClient {
  constructor(protected readonly prisma: PrismaService, protected readonly oauth: Cafe24OauthService,
    protected readonly request: typeof fetch = fetch) {}

  /** Read-only preflight. Returns aggregates only; raw orders never leave this scope. */
  async readDaySummary(connectionId: string, day: string) {
    return this.readDayObservation(connectionId, day);
  }

  /** Nonpublishing observation; hashes are internal and never certify cache freshness. */
  async readDayObservedRevision(connectionId: string, day: string, epochScope?: Cafe24ObservationEpochScope): Promise<{
    day: string; startedAt: Date; keyVersion: number;
    rows: Array<{ orderKeyHash: string; contentHash: string }>; snapshotHash: string;
    epoch?: Cafe24ObservationEpochMetadata; orderCount: number; itemCount: number;
    readComplete: true; snapshotComplete: false;
  }> {
    assertCafe24AppVersionEvidence();
    assertCafe24SellerOptionsEvidence();
    const startedAt = new Date();
    const rows: Array<{ orderKeyHash: string; contentHash: string }> = [];
    const material: { version: number; key: Buffer; metadata?: Cafe24ObservationEpochMetadata } = epochScope
      ? cafe24ObservationEpochKey(connectionId, day, epochScope) : cafe24ObservationKey();
    const { version: keyVersion, key } = material;
    try {
      // A new key never silently compares against or replaces the V1 baseline.
      if (!epochScope && keyVersion !== 1) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
      const result = await this.readDayObservation(connectionId, day,
        (orderId, _paid, _items, _dates, contentHash) => {
          if (!contentHash) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
          if (rows.length >= 1_000) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
          rows.push({ orderKeyHash: cafe24ObservationHmac(key, "ORDER_KEY_V1",
            `${connectionId}\0${orderId}`), contentHash });
        }, undefined, true, true, key);
      rows.sort((left, right) => left.orderKeyHash.localeCompare(right.orderKeyHash));
      const snapshotHash = cafe24ObservationHmac(key, "SNAPSHOT_V1", JSON.stringify(rows));
      return { day, startedAt, keyVersion, rows, snapshotHash,
        epoch: material.metadata,
        orderCount: result.orderCount, itemCount: result.itemCount,
        readComplete: true as const, snapshotComplete: false as const };
    } finally { key.fill(0); }
  }

  /** Operator-only one-request comparison; only keyed digests leave this method. */
  async readDayHmac(connectionId: string, day: string, key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length !== 32)
      throw new ProviderFailure("FIELD_UNSUPPORTED", false);
    const ephemeralKey = Buffer.from(key);
    const orderHmacs: string[] = [];
    const orderItemHmacs: string[] = [];
    const orderPaidHmacs: string[] = [];
    try {
      await this.readDayObservation(connectionId, day, (orderId, paidKrw, itemCodes) => {
        if (orderHmacs.length * 2 + orderItemHmacs.length + itemCodes.length + 2 >
            MAX_HMAC_DIGESTS) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
        orderHmacs.push(hmacTuple(ephemeralKey, "order", orderId));
        orderPaidHmacs.push(hmacTuple(ephemeralKey, "paid", orderId, paidKrw));
        for (const itemCode of itemCodes)
          orderItemHmacs.push(hmacTuple(ephemeralKey, "item", orderId, itemCode));
      });
      const result = { orderHmacs: orderHmacs.sort(),
        orderItemHmacs: orderItemHmacs.sort(), orderPaidHmacs: orderPaidHmacs.sort() };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_HMAC_RESPONSE_BYTES)
        throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
      return result;
    } finally { ephemeralKey.fill(0); }
  }

  /** Ephemeral keyed date comparison. No order ID or timestamp leaves the method. */
  async readDayDateHmac(connectionId: string, day: string, key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length !== 32)
      throw new ProviderFailure("FIELD_UNSUPPORTED", false);
    const ephemeralKey = Buffer.from(key);
    // Compact tuples keep a complete 500-order comparison under the response cap:
    // identity, order day, order instant, place day, place instant.
    const rows: Array<[string, string, string, string | null, string | null]> = [];
    let naiveOrderDateCount = 0;
    let naivePlaceDateCount = 0;
    try {
      await this.readDayObservation(connectionId, day, (orderId, _paid, _items, dates) => {
        if (rows.length * 5 + 5 > MAX_HMAC_DIGESTS)
          throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
        const ordered = orderInstant(dates.orderDate);
        const placed = dates.placeDate === null ? null : orderInstant(dates.placeDate);
        if (!/(?:Z|[+-]\d\d:\d\d)$/.test(dates.orderDate)) naiveOrderDateCount += 1;
        if (dates.placeDate !== null &&
            !/(?:Z|[+-]\d\d:\d\d)$/.test(dates.placeDate)) naivePlaceDateCount += 1;
        rows.push([hmacTuple(ephemeralKey, "order", orderId),
          hmacTuple(ephemeralKey, "order-day", orderId,
            formatInTimeZone(new Date(ordered), "Asia/Seoul", "yyyy-MM-dd")),
          hmacTuple(ephemeralKey, "order-instant", orderId, ordered),
          placed === null ? null : hmacTuple(ephemeralKey, "place-day", orderId,
            formatInTimeZone(new Date(placed), "Asia/Seoul", "yyyy-MM-dd")),
          placed === null ? null : hmacTuple(ephemeralKey,
            "place-instant", orderId, placed)]);
      }, undefined, true);
      rows.sort((left, right) => left[0].localeCompare(right[0]));
      const result = { rows, orderCount: rows.length,
        placeDatePresentCount: rows.filter((row) => row[3] !== null).length,
        naiveOrderDateCount, naivePlaceDateCount,
        timeZoneInterpretation: "NAIVE_ASSUMED_MALL_KST" as const,
        readComplete: true, snapshotComplete: false };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_HMAC_RESPONSE_BYTES)
        throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
      return result;
    } finally { ephemeralKey.fill(0); }
  }

  /** Read-only, two-list comparison. Returns counts only; no order HMAC or amount leaves. */
  async compareDayOrderAmounts(connectionId: string, day: string, key: Buffer,
    csvRows: readonly string[]) {
    assertCafe24TestReadEnabled();
    parseIsoDate(day);
    if (!Buffer.isBuffer(key) || key.length !== 32 || csvRows.length < 10 ||
        csvRows.length > 500) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
    const expected = new Map<string, string[]>();
    for (const row of csvRows) {
      const parts = row.split(".");
      if (parts.length !== 5 || parts.some((part) => !/^[a-f0-9]{64}$/.test(part)) ||
          expected.has(parts[0])) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
      expected.set(parts[0], parts);
    }
    const ephemeralKey = Buffer.from(key);
    try {
      const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
      if (!connection || connection.provider !== "CAFE24" ||
          !/^[a-z0-9][a-z0-9-]{0,63}$/.test(connection.externalAccountId) ||
          connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul" ||
          !/^shop[1-9]\d*$/.test(connection.shopKey) ||
          !cafe24TestAllowed(connection.externalAccountId, connection.shopKey))
        syncError("ACCOUNT_SCOPE_MISMATCH");
      const mallId = connection.externalAccountId;
      const shopNo = connection.shopKey.slice(4);
      const access = await this.oauth.accessToken(connectionId, mallId, connection.shopKey);
      const deadlineAt = Date.now() + 10 * 60_000;
      const countBefore = await this.countOrders(mallId, shopNo, day, access, deadlineAt);
      const readList = async () => {
        let offset = 0;
        return collectBoundedPages(SourceDataKind.CAFE24_ORDER, async () => {
          if (offset > 8000) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
          const url = new URL(`https://${mallId}.cafe24api.com/api/v2/admin/orders`);
          url.searchParams.set("shop_no", shopNo);
          url.searchParams.set("start_date", day);
          url.searchParams.set("end_date", day);
          url.searchParams.set("date_type", "order_date");
          url.searchParams.set("limit", String(CAFE24_PAGE_LIMIT));
          url.searchParams.set("offset", String(offset));
          url.searchParams.set("fields", "order_id,shop_no,order_date,currency,payment_amount,payment_method,actual_order_amount,initial_order_amount");
          const { body, bytes } = await this.getJson(url, access, deadlineAt);
          const rows = record(body).orders;
          if (!Array.isArray(rows) || rows.length > CAFE24_PAGE_LIMIT)
            throw new ProviderFailure("PARTIAL_PAGE", false);
          offset += rows.length;
          return { rows, bytes, nextCursor: rows.length === CAFE24_PAGE_LIMIT ? String(offset) : null };
        });
      };
      const project = (raw: unknown) => {
        const order = record(raw);
        const id = identifier(order.order_id);
        if (String(order.shop_no) !== shopNo || orderDay(order.order_date) !== day ||
            order.currency !== "KRW") throw new ProviderFailure("RECONCILIATION_FAILED", false);
        const actual = record(order.actual_order_amount);
        const initial = record(order.initial_order_amount);
        const actualTotal = money(actual.order_price_amount).toFixed(2);
        const initialTotal = money(initial.order_price_amount).toFixed(2);
        const actualPaid = money(actual.payment_amount).toFixed(2);
        const initialPaid = money(initial.payment_amount).toFixed(2);
        // Cafe24 documents product subtotal, shipping fee, and shipping fee
        // discount separately. These are fixed diagnostic candidates only.
        // An absent component is never silently substituted with zero.
        const optionalMoney = (value: unknown) => value == null ? null : money(value);
        const amountCandidates = {
          ACTUAL_SUBTOTAL_PLUS_SHIPPING: optionalMoney(actual.shipping_fee)?.plus(actualTotal).toFixed(2) ?? null,
          ACTUAL_SUBTOTAL_PLUS_NET_SHIPPING: actual.shipping_fee == null ||
            actual.shipping_fee_discount_amount == null ? null :
            money(actualTotal).plus(money(actual.shipping_fee))
              .minus(money(actual.shipping_fee_discount_amount)).toFixed(2),
          INITIAL_SUBTOTAL_PLUS_SHIPPING: optionalMoney(initial.shipping_fee)?.plus(initialTotal).toFixed(2) ?? null,
          INITIAL_SUBTOTAL_PLUS_NET_SHIPPING: initial.shipping_fee == null ||
            initial.shipping_fee_discount_amount == null ? null :
            money(initialTotal).plus(money(initial.shipping_fee))
              .minus(money(initial.shipping_fee_discount_amount)).toFixed(2)
        };
        const topPaid = money(order.payment_amount).toFixed(2);
        const methods = order.payment_method;
        if (!Array.isArray(methods) || methods.length < 1 || methods.length > 16 ||
            methods.some((value) => typeof value !== "string" || !value.trim() ||
              value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)))
          throw new ProviderFailure("FIELD_UNSUPPORTED", false);
        const coupon = methods.some((value: string) => {
          const code = value.normalize("NFKC").trim().toLowerCase();
          return code === "coupon" || code === "쿠폰";
        });
        return { id, actualTotal, initialTotal, actualPaid, initialPaid, coupon,
          amountCandidates,
          signature: hmacTuple(ephemeralKey, "amount-observation", id,
            String(order.order_date), topPaid, actualTotal, initialTotal,
            actualPaid, initialPaid, JSON.stringify(amountCandidates), JSON.stringify(methods)) };
      };
      const first = await readList();
      if (first.rows.length !== countBefore || first.rows.length !== expected.size)
        throw new ProviderFailure("RECONCILIATION_FAILED", false);
      const revisions = new Map<string, string>();
      const matches = { actualOrderTotal: 0, initialOrderTotal: 0,
        actualPayment: 0, initialPayment: 0, couponFlag: 0, couponBoth: 0 };
      const orderTotalCandidateMatches = { ACTUAL_SUBTOTAL_PLUS_SHIPPING: 0,
        ACTUAL_SUBTOTAL_PLUS_NET_SHIPPING: 0, INITIAL_SUBTOTAL_PLUS_SHIPPING: 0,
        INITIAL_SUBTOTAL_PLUS_NET_SHIPPING: 0 };
      const orderTotalCandidateEvaluated = { ...orderTotalCandidateMatches };
      const couponInputMatches = { ACTUAL_ORDER_TOTAL: 0, INITIAL_ORDER_TOTAL: 0,
        ACTUAL_PAYMENT: 0, INITIAL_PAYMENT: 0, ACTUAL_SIGNED_DELTA: 0,
        INITIAL_SIGNED_DELTA: 0, BOTH_ACTUAL_SIGNED_DELTA: 0,
        BOTH_INITIAL_SIGNED_DELTA: 0 };
      let apiCouponOrders = 0;
      let csvCouponOrders = 0;
      for (const raw of first.rows) {
        const row = project(raw);
        if (revisions.has(row.id)) throw new ProviderFailure("RECONCILIATION_FAILED", false);
        revisions.set(row.id, row.signature);
        const csv = expected.get(hmacTuple(ephemeralKey, "order", row.id));
        if (!csv) throw new ProviderFailure("RECONCILIATION_FAILED", false);
        if (csv[1] === hmacTuple(ephemeralKey, "order-total", row.id, row.actualTotal))
          matches.actualOrderTotal++;
        if (csv[1] === hmacTuple(ephemeralKey, "order-total", row.id, row.initialTotal))
          matches.initialOrderTotal++;
        for (const name of Object.keys(orderTotalCandidateMatches) as
          Array<keyof typeof orderTotalCandidateMatches>) {
          const candidate = row.amountCandidates[name];
          if (candidate === null) continue;
          orderTotalCandidateEvaluated[name]++;
          if (csv[1] === hmacTuple(ephemeralKey, "order-total", row.id, candidate))
            orderTotalCandidateMatches[name]++;
        }
        if (csv[2] === hmacTuple(ephemeralKey, "paid", row.id, row.actualPaid))
          matches.actualPayment++;
        if (csv[2] === hmacTuple(ephemeralKey, "paid", row.id, row.initialPaid))
          matches.initialPayment++;
        if (csv[3] === hmacTuple(ephemeralKey, "coupon-flag", row.id,
          row.coupon ? "true" : "false")) matches.couponFlag++;
        const csvCoupon = csv[3] === hmacTuple(ephemeralKey,
          "coupon-flag", row.id, "true");
        if (csvCoupon) {
          csvCouponOrders++;
          if (csv[1] === hmacTuple(ephemeralKey, "order-total", row.id, row.actualTotal))
            couponInputMatches.ACTUAL_ORDER_TOTAL++;
          if (csv[1] === hmacTuple(ephemeralKey, "order-total", row.id, row.initialTotal))
            couponInputMatches.INITIAL_ORDER_TOTAL++;
          if (csv[2] === hmacTuple(ephemeralKey, "paid", row.id, row.actualPaid))
            couponInputMatches.ACTUAL_PAYMENT++;
          if (csv[2] === hmacTuple(ephemeralKey, "paid", row.id, row.initialPaid))
            couponInputMatches.INITIAL_PAYMENT++;
          const actualDelta = new Prisma.Decimal(row.actualTotal).minus(row.actualPaid).toFixed(2);
          const initialDelta = new Prisma.Decimal(row.initialTotal).minus(row.initialPaid).toFixed(2);
          if (csv[4] === hmacTuple(ephemeralKey, "coupon-delta", row.id, actualDelta)) {
            couponInputMatches.ACTUAL_SIGNED_DELTA++;
            if (row.coupon) couponInputMatches.BOTH_ACTUAL_SIGNED_DELTA++;
          }
          if (csv[4] === hmacTuple(ephemeralKey, "coupon-delta", row.id, initialDelta)) {
            couponInputMatches.INITIAL_SIGNED_DELTA++;
            if (row.coupon) couponInputMatches.BOTH_INITIAL_SIGNED_DELTA++;
          }
        }
        if (row.coupon) {
          apiCouponOrders++;
          if (csvCoupon)
            matches.couponBoth++;
        }
      }
      const second = await readList();
      const seen = new Set<string>();
      if (second.rows.length !== first.rows.length || second.rows.some((raw) => {
        const row = project(raw);
        if (seen.has(row.id)) return true;
        seen.add(row.id);
        return revisions.get(row.id) !== row.signature;
      })) throw new ProviderFailure("RECONCILIATION_FAILED", false);
      const countAfter = await this.countOrders(mallId, shopNo, day, access, deadlineAt);
      if (countAfter !== first.rows.length)
        throw new ProviderFailure("RECONCILIATION_FAILED", false);
      const safeCell = (count: number, cohort: number) =>
        count >= 10 && (cohort - count === 0 || cohort - count >= 10) ? count : null;
      const safeBoth = safeCell(matches.couponBoth, csvCouponOrders) !== null &&
        safeCell(matches.couponBoth, apiCouponOrders) !== null
        ? matches.couponBoth : null;
      const safeApiCoupon = apiCouponOrders >= 10 &&
        (Math.abs(apiCouponOrders - csvCouponOrders) === 0 ||
          Math.abs(apiCouponOrders - csvCouponOrders) >= 10) ? apiCouponOrders : null;
      return { day, orderCount: first.rows.length, ...matches,
        couponFlag: safeCell(matches.couponFlag, first.rows.length),
        couponBoth: safeBoth,
        apiCouponOrders: safeApiCoupon,
        orderTotalCandidateMatches, orderTotalCandidateEvaluated,
        // Suppress small cells and small complements so aggregate counts cannot
        // expose a one-order coupon-only or coupon-input mismatch.
        couponInputMatches: Object.fromEntries(Object.entries(couponInputMatches)
          .map(([name, count]) => [name,
            name.startsWith("BOTH_") && safeBoth === null ? null :
              safeCell(count, name.startsWith("BOTH_") ? matches.couponBoth : csvCouponOrders)])),
        readComplete: true, snapshotComplete: false, semanticVerified: false };
    } finally { ephemeralKey.fill(0); }
  }

  /** Compare CSV business-key candidates in memory; never return row digests or values. */
  async compareDayOptionKeys(connectionId: string, day: string, key: Buffer,
    csvRows: readonly string[]) {
    if (!Buffer.isBuffer(key) || key.length !== 32 || csvRows.length < 1 ||
        csvRows.length > 600) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
    const expected = new Map<string, string[]>();
    for (const row of csvRows) {
      const parts = row.split(".");
      if (parts.length !== 5 || parts.some((part) => !/^[a-f0-9]{64}$/.test(part)) ||
          expected.has(parts[0])) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
      expected.set(parts[0], parts);
    }
    const ephemeralKey = Buffer.from(key);
    const seen = new Set<string>();
    const candidates = { OPTION_VALUE: 0, PRODUCT_NAME: 0,
      PRODUCT_OPTION_PARENS: 0, PRODUCT_SPACE_OPTION_PARENS: 0,
      PRODUCT_SPACE_OPTION: 0 };
    let productNoMatches = 0;
    let quantityMatches = 0;
    let salePriceMatches = 0;
    let salePriceWithOptionMatches = 0;
    const optionPriceShapes = { ABSENT: 0, NULL: 0, VALUE: 0 };
    const optionPriceSigns = { NEGATIVE: 0, ZERO: 0, POSITIVE: 0 };
    try {
      const result = await this.readDayObservation(connectionId, day,
        (orderId, _paid, _codes, _dates, _hash, items) => {
          if (!items) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
          for (const item of items) {
            const projected = optionItem(item);
            const identity = hmacTuple(ephemeralKey, "item", orderId, projected.code);
            const csv = expected.get(identity);
            if (!csv || seen.has(identity))
              throw new ProviderFailure("RECONCILIATION_FAILED", false);
            seen.add(identity);
            const tuple = (domain: "option-product" | "option-quantity" |
              "option-price" | "option-name", value: string) =>
              hmacTuple(ephemeralKey, domain, orderId, projected.code, value);
            if (csv[1] === tuple("option-product", projected.productNo)) productNoMatches++;
            if (csv[2] === tuple("option-quantity", projected.quantity)) quantityMatches++;
            if (csv[3] === tuple("option-price", projected.salePrice)) salePriceMatches++;
            optionPriceShapes[projected.optionPriceShape]++;
            if (projected.optionPriceSign) optionPriceSigns[projected.optionPriceSign]++;
            if (projected.optionPrice !== null && csv[3] === tuple("option-price",
              new Prisma.Decimal(projected.salePrice).plus(projected.optionPrice).toFixed(2)))
              salePriceWithOptionMatches++;
            const names = {
              OPTION_VALUE: projected.optionValue,
              PRODUCT_NAME: projected.productName,
              PRODUCT_OPTION_PARENS: `${projected.productName}(${projected.optionValue})`,
              PRODUCT_SPACE_OPTION_PARENS: `${projected.productName} (${projected.optionValue})`,
              PRODUCT_SPACE_OPTION: `${projected.productName} ${projected.optionValue}`
            };
            for (const candidate of Object.keys(candidates) as Array<keyof typeof candidates>) {
              if (csv[4] === tuple("option-name", names[candidate])) candidates[candidate]++;
            }
          }
        }, undefined, false, false, ephemeralKey, true);
      if (seen.size !== expected.size || result.itemCount !== expected.size)
        throw new ProviderFailure("RECONCILIATION_FAILED", false);
      const candidateMismatches = Object.fromEntries(Object.entries(candidates)
        .map(([candidate, matches]) => [candidate, result.itemCount - matches]));
      return { orderCount: result.orderCount, itemCount: result.itemCount,
        productNoMatches, quantityMatches, salePriceMatches,
        productNoMismatches: result.itemCount - productNoMatches,
        quantityMismatches: result.itemCount - quantityMatches,
        salePriceMismatches: result.itemCount - salePriceMatches,
        salePriceWithOptionMatches,
        salePriceWithOptionMismatches: optionPriceShapes.VALUE - salePriceWithOptionMatches,
        optionPriceShapes,
        optionPriceSigns,
        optionNameCandidateMatches: candidates,
        optionNameCandidateMismatches: candidateMismatches, readComplete: true,
        snapshotComplete: false, canonicalMappingVerified: false };
    } catch (error) {
      if (error instanceof ProviderFailure && error.safeCode === "FIELD_UNSUPPORTED" &&
          !error.diagnosticCode)
        throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null,
          "ORDER_OR_SHARED_SHAPE");
      throw error;
    } finally { ephemeralKey.fill(0); expected.clear(); seen.clear(); }
  }

  /** Shape-only investigation for six locally identified payment differences. */
  async diagnosePaidDifferences(connectionId: string, day: string, key: Buffer,
    orderDigests: string[]) {
    if (day !== "2026-09-30" || !Buffer.isBuffer(key) || key.length !== 32 ||
        !Array.isArray(orderDigests) || orderDigests.length !== 6 ||
        new Set(orderDigests).size !== 6 ||
        !orderDigests.every((value) => /^[a-f0-9]{64}$/.test(value)))
      throw new ProviderFailure("FIELD_UNSUPPORTED", false);
    const ephemeralKey = Buffer.from(key);
    const selected: { orderId: string; paidKrw: string }[] = [];
    const wanted = new Set(orderDigests);
    const deadlineAt = Date.now() + 10 * 60_000;
    try {
      await this.readDayObservation(connectionId, day, (orderId, paidKrw) => {
        if (wanted.has(hmacTuple(ephemeralKey, "order", orderId)))
          selected.push({ orderId, paidKrw });
      }, deadlineAt);
      if (selected.length !== wanted.size)
        throw new ProviderFailure("RECONCILIATION_FAILED", false);
      const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
      if (!connection || connection.provider !== "CAFE24" ||
          !cafe24TestAllowed(connection.externalAccountId, connection.shopKey) ||
          connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul" ||
          !/^shop[1-9]\d*$/.test(connection.shopKey)) syncError("ACCOUNT_SCOPE_MISMATCH");
      const access = await this.oauth.accessToken(connectionId,
        connection.externalAccountId, connection.shopKey);
      const shopNo = connection.shopKey.slice(4);
      const detailShapes: Record<string, number> = {};
      const detailPaymentAmountShapes: Record<string, number> = {};
      const paymentMethodShapes: Record<string, number> = {};
      const actualOrderAmountShapes: Record<string, number> = {};
      const timelineShapes: Record<string, number> = {};
      const settleTypeCodes: Record<string, number> = {};
      const createdDatetimeShapes: Record<string, number> = {};
      const paidAmountShapes: Record<string, number> = {};
      const createdTimeBuckets = emptyTimelineTimeBuckets();
      const createdTimeBySettleType = Object.fromEntries(["O", "R", "P", "ABSENT", "OTHER"]
        .map((code) => [code, emptyTimelineTimeBuckets()])) as Record<string,
        Record<TimelineTimeBucket, number>>;
      const createdTimeZoneCounts = { EXPLICIT_OFFSET: 0, NAIVE_ASSUMED_MALL_KST: 0,
        UNREADABLE: 0 };
      let timelineRowCount = 0;
      let detailAmountMatchedListCount = 0;
      let unsupportedDetailCount = 0;
      let unsupportedTimelineRowCount = 0;
      let ordersWithCreatedAtOrAfter10 = 0;
      for (const { orderId, paidKrw } of selected) {
        const detailUrl = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders/${orderId}`);
        detailUrl.searchParams.set("shop_no", shopNo);
        detailUrl.searchParams.set("fields", "order_id,shop_no,order_date,currency,payment_amount,payment_method,actual_order_amount");
        const detailValue = record((await this.getJson(detailUrl, access, deadlineAt)).body).order;
        incrementShape(detailShapes, detailValue);
        if (detailValue && typeof detailValue === "object" && !Array.isArray(detailValue)) {
          const detail = detailValue as Record<string, unknown>;
          incrementShape(detailPaymentAmountShapes, detail.payment_amount);
          incrementShape(paymentMethodShapes, detail.payment_method);
          incrementShape(actualOrderAmountShapes, detail.actual_order_amount);
          if (detail.order_id === undefined || detail.shop_no === undefined ||
              detail.order_date === undefined || detail.currency === undefined ||
              detail.payment_amount === undefined) unsupportedDetailCount += 1;
          else {
            if (identifier(detail.order_id) !== orderId || String(detail.shop_no) !== shopNo ||
                orderDay(detail.order_date) !== day || detail.currency !== "KRW")
              throw new ProviderFailure("RECONCILIATION_FAILED", false);
            let detailPaid: string | null = null;
            try { detailPaid = money(detail.payment_amount).toFixed(2); }
            catch { unsupportedDetailCount += 1; }
            if (detailPaid !== null) {
              if (detailPaid !== paidKrw)
                throw new ProviderFailure("RECONCILIATION_FAILED", false);
              detailAmountMatchedListCount += 1;
            }
          }
        } else unsupportedDetailCount += 1;
        const timelineUrl = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders/${orderId}/paymenttimeline`);
        timelineUrl.searchParams.set("shop_no", shopNo);
        timelineUrl.searchParams.set("fields", "payment_settle_type,paid_amount,created_datetime");
        const timelineBody = record((await this.getJson(timelineUrl, access, deadlineAt)).body);
        const rows = timelineBody.paymenttimeline;
        incrementShape(timelineShapes, rows);
        if (!Array.isArray(rows)) continue;
        if (rows.length >= CAFE24_PAGE_LIMIT)
          throw new ProviderFailure("PARTIAL_PAGE", false);
        timelineRowCount += rows.length;
        let hasCreatedAtOrAfter10 = false;
        for (const raw of rows) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            unsupportedTimelineRowCount += 1;
            createdTimeBuckets.UNREADABLE += 1;
            createdTimeBySettleType.OTHER.UNREADABLE += 1;
            createdTimeZoneCounts.UNREADABLE += 1;
            continue;
          }
          const row = raw as Record<string, unknown>;
          const type = row.payment_settle_type;
          const code = type === "O" || type === "R" || type === "P" ? type :
            type === undefined ? "ABSENT" : "OTHER";
          settleTypeCodes[code] = (settleTypeCodes[code] ?? 0) + 1;
          incrementShape(createdDatetimeShapes, row.created_datetime);
          incrementShape(paidAmountShapes, row.paid_amount);
          const created = classifyTimelineCreatedTime(row.created_datetime);
          createdTimeBuckets[created.bucket] += 1;
          createdTimeBySettleType[code][created.bucket] += 1;
          createdTimeZoneCounts[created.zone] += 1;
          if (created.bucket === "AT_OR_AFTER_10") hasCreatedAtOrAfter10 = true;
        }
        if (hasCreatedAtOrAfter10) ordersWithCreatedAtOrAfter10 += 1;
      }
      return { selectedOrderCount: selected.length, detailAmountMatchedListCount,
        unsupportedDetailCount, detailShapes, detailPaymentAmountShapes,
        paymentMethodShapes, actualOrderAmountShapes, timelineShapes,
        timelineRowCount, unsupportedTimelineRowCount,
        settleTypeCodes, createdDatetimeShapes, paidAmountShapes,
        createdTimeBuckets, createdTimeBySettleType, createdTimeZoneCounts,
        ordersWithCreatedAtOrAfter10,
        cacheFreshness: "UNVERIFIED_PROVIDER_CACHE",
        localFileMtimeComparison: "NOT_ASSESSED_CACHE_UNVERIFIED_AND_MTIME_NOT_EXPORT_TIME",
        shapeReadComplete: detailAmountMatchedListCount === selected.length &&
          timelineShapes.array === selected.length && unsupportedTimelineRowCount === 0,
        semanticVerified: false, snapshotComplete: false };
    } finally { ephemeralKey.fill(0); }
  }

  /** Read-only business totals. These are observations, never net sales or publish proof. */
  async readDayBusinessAggregate(connectionId: string, day: string) {
    assertCafe24AppVersionEvidence();
    assertCafe24SellerOptionsEvidence();
    const { key } = cafe24ObservationKey();
    let orderPriceTotal = new Prisma.Decimal(0);
    let paidTotal = new Prisma.Decimal(0);
    let itemPriceTimesQuantityTotal = new Prisma.Decimal(0);
    let orderPricePresent = 0;
    let orderPriceAbsent = 0;
    let orderPriceBelowPaid = 0;
    let orderPriceEqualPaid = 0;
    let orderPriceAbovePaid = 0;
    let cPrefixStatusItems = 0;
    let rPrefixStatusItems = 0;
    let otherItems = 0;
    let methodCouponExactOrders = 0;
    let methodCouponLikeOrders = 0;
    let methodMalformedOrders = 0;
    const observedItemStatusCodes=new Set<string>();
    const paymentMethodArrayLengths: Record<string, number> = {};
    try {
      const result = await this.readDayObservation(connectionId, day,
        (_orderId, paidKrw, _itemCodes, _dates, _contentHash, items, rawOrder) => {
          const order = record(rawOrder);
          const paid = money(paidKrw);
          paidTotal = paidTotal.plus(paid);
          const orderPrice = order.order_price_amount;
          if (orderPrice === undefined || orderPrice === null) orderPriceAbsent += 1;
          else {
            const parsed = money(orderPrice);
            orderPricePresent += 1;
            orderPriceTotal = orderPriceTotal.plus(parsed);
            if (parsed.lessThan(paid)) orderPriceBelowPaid += 1;
            else if (parsed.equals(paid)) orderPriceEqualPaid += 1;
            else orderPriceAbovePaid += 1;
          }
          const methods = order.payment_method;
          const bucket = methods === undefined ? "ABSENT" : methods === null ? "NULL" :
            Array.isArray(methods) && methods.length <= 16 ? `ARRAY_${methods.length}` : "OTHER";
          paymentMethodArrayLengths[bucket] = (paymentMethodArrayLengths[bucket] ?? 0) + 1;
          if (Array.isArray(methods)) {
            if (methods.length > 16 || !methods.every((method) =>
              typeof method === "string" && !!method.trim() && method.length <= 64 &&
              !/[\u0000-\u001f\u007f]/.test(method)))
              methodMalformedOrders += 1;
            else {
              const normalized = methods.map((method: string) => method.normalize("NFKC").trim().toLowerCase());
              if (normalized.some((method) => method === "coupon" || method === "쿠폰"))
                methodCouponExactOrders += 1;
              if (normalized.some((method) => method.includes("coupon") || method.includes("쿠폰")))
                methodCouponLikeOrders += 1;
            }
          }
          if (!Array.isArray(items)) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
          for (const raw of items) {
            const item = record(raw);
            itemPriceTimesQuantityTotal = itemPriceTimesQuantityTotal.plus(
              money(item.product_price).times(quantity(item.quantity)));
            const status = statusBucket(item.order_status);
            // Observation accepts public code shapes. Publication approval is
            // a separate reviewed allowset; observing E/U never approves it.
            if (!/^[A-Z][0-9]{2}$/.test(status)) throw new ProviderFailure("FIELD_UNSUPPORTED",false);
            observedItemStatusCodes.add(status);
            if (observedItemStatusCodes.size>32) throw new ProviderFailure("FIELD_UNSUPPORTED",false);
            if (status.startsWith("C")) cPrefixStatusItems += 1;
            else if (status.startsWith("R")) rPrefixStatusItems += 1;
            else otherItems += 1;
          }
        }, undefined, false, true, key);
      // Aggregate amounts for a small day could reveal a single order.
      if (result.orderCount > 0 && result.orderCount < 10)
        throw new ProviderFailure("FIELD_UNSUPPORTED", false);
      return { day, orderCount: result.orderCount, itemCount: result.itemCount,
        observedItemStatusCodes:[...observedItemStatusCodes].sort(),
        orderPricePresent, orderPriceAbsent, orderPriceTotalKrw: orderPriceTotal.toFixed(2),
        paidTotalKrw: paidTotal.toFixed(2), orderPriceBelowPaid, orderPriceEqualPaid,
        orderPriceAbovePaid, itemPriceTimesQuantityTotalKrw: itemPriceTimesQuantityTotal.toFixed(2),
        cPrefixStatusItems, rPrefixStatusItems, otherItems, paymentMethodArrayLengths,
        methodCouponExactOrders, methodCouponLikeOrders, methodMalformedOrders,
        discountCouponShippingRefundMeaning: "UNVERIFIED", readComplete: true,
        cacheFreshness: "UNVERIFIED_PROVIDER_CACHE", snapshotComplete: false,
        semanticVerified: false };
    } finally { key.fill(0); }
  }

  private async readDayObservation(connectionId: string, day: string,
    onOrder?: (orderId: string, paidKrw: string, itemCodes: string[],
      dates: { orderDate: string; placeDate: string | null }, contentHash?: string,
      items?: unknown[], order?: Record<string, unknown>) => void,
    runDeadlineAt?: number, includePlaceDate = false, includeContent = false,
    observationKey?: Buffer, includeOptionFields = false) {
    assertCafe24TestReadEnabled();
    parseIsoDate(day);
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "CAFE24" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(connection.externalAccountId) ||
        connection.currencyCode !== "KRW" ||
        connection.timeZone !== "Asia/Seoul" || !/^shop[1-9]\d*$/.test(connection.shopKey) ||
        !cafe24TestAllowed(connection.externalAccountId, connection.shopKey))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    const access = await this.oauth.accessToken(connectionId, connection.externalAccountId, connection.shopKey);
    const deadlineAt = Math.min(Date.now() + 10 * 60_000,
      runDeadlineAt ?? Number.POSITIVE_INFINITY);
    let nextItemStartAt = Date.now();
    const paceItem = async () => {
      const now = Date.now();
      const scheduled = Math.max(now, nextItemStartAt);
      nextItemStartAt = scheduled + 500; // Cafe24 bucket drains two calls per second.
      if (scheduled >= deadlineAt) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
      if (scheduled > now) await new Promise<void>((resolve) => setTimeout(resolve, scheduled - now));
    };
    const shopNo = connection.shopKey.slice(4);
    const countBefore = await this.countOrders(connection.externalAccountId, shopNo, day, access, deadlineAt);
    let offset = 0;
    const orders = await collectBoundedPages(SourceDataKind.CAFE24_ORDER, async () => {
      if (offset > 8000) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
      const url = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders`);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("start_date", day);
      url.searchParams.set("end_date", day);
      url.searchParams.set("date_type", "order_date");
      url.searchParams.set("fields", `order_id,shop_no,order_date,payment_amount,currency${
        includePlaceDate ? ",place_date" : ""}${includeContent
        ? ",order_price_amount,payment_method,order_status" : ""}`);
      url.searchParams.set("limit", String(CAFE24_PAGE_LIMIT));
      url.searchParams.set("offset", String(offset));
      const { body, bytes } = await this.getJson(url, access, deadlineAt);
      const rows = record(body).orders;
      if (!Array.isArray(rows)) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
      if (rows.length > CAFE24_PAGE_LIMIT) throw new ProviderFailure("PARTIAL_PAGE", false);
      offset += rows.length;
      return { rows, bytes, nextCursor: rows.length === CAFE24_PAGE_LIMIT ? String(offset) : null };
    });
    const observations = new Map<string, { orderDate: string; placeDate: string | null;
      paidKrw: string; contentHash: string | null; optionHash: string | null }>();
    let itemCount = 0;
    let totalPaid = new Prisma.Decimal(0);
    if (orders.rows.length > (includeContent ? 500 : CAFE24_OBSERVATION_ORDER_LIMIT))
      throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
    const listedIds = new Set<string>();
    const listed = orders.rows.map((raw) => {
      const order = record(raw);
      const orderId = identifier(order.order_id);
      if (listedIds.has(orderId) || String(order.shop_no) !== shopNo ||
          orderDay(order.order_date) !== day || order.currency !== "KRW")
        throw new ProviderFailure("RECONCILIATION_FAILED", false);
      listedIds.add(orderId);
      const paidKrw = money(order.payment_amount).toFixed(2);
      const placeDate = includePlaceDate ? order.place_date == null ? null :
        String(order.place_date) : null;
      const normalizedPlaceDate = placeDate === null ? null : orderInstant(placeDate);
      return { order, orderId, paidKrw, placeDate, normalizedPlaceDate };
    });
    for await (const group of itemReadGroups(listed, async (entry) => {
      const url = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders/${entry.orderId}/items`);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("fields", `order_item_code,product_no,product_name${includeContent || includeOptionFields
        ? ",option_value,quantity,product_price,order_status" : ""}${includeOptionFields
        ? ",option_price" : ""}`);
      await paceItem();
      let body: unknown;
      try { ({ body } = await this.getJson(url, access, deadlineAt)); }
      catch (error) {
        if (includeOptionFields && error instanceof ProviderFailure &&
            error.safeCode === "FIELD_UNSUPPORTED")
          throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null,
            "ITEM_REQUEST_OR_JSON");
        throw error;
      }
      return { entry, items: record(body).items };
    })) {
      for (const { entry, items } of group) {
        // The item resource documents at most 100 items per response and no
        // verified item cursor. Exactly 100 could hide additional siblings.
        if (!Array.isArray(items) || items.length === 0 || items.length >= CAFE24_PAGE_LIMIT)
          throw new ProviderFailure("PARTIAL_PAGE", false);
        if (itemCount + items.length > PAGE_ROW_LIMITS.CAFE24_ORDER)
          throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
        const itemKeys = new Set<string>();
        for (const rawItem of items) {
          if (includeOptionFields) {
            const projected = optionItem(rawItem);
            if (itemKeys.has(projected.code))
              throw new ProviderFailure("RECONCILIATION_FAILED", false);
            itemKeys.add(projected.code);
            continue;
          }
          const item = record(rawItem);
          const key = identifier(item.order_item_code);
          if (itemKeys.has(key)) throw new ProviderFailure("RECONCILIATION_FAILED", false);
          itemKeys.add(key);
          identifier(item.product_no);
          if (typeof item.product_name !== "string" || !item.product_name.trim())
            throw new ProviderFailure("FIELD_UNSUPPORTED", false);
        }
        const contentHash = includeContent
          ? cafe24ObservedRevision(entry.order, items, true,
            observationKey as Buffer).contentHash : null;
        const optionHash = includeOptionFields
          ? optionItemsHash(observationKey as Buffer, items) : null;
        observations.set(entry.orderId, { orderDate: entry.order.order_date as string,
          placeDate: entry.normalizedPlaceDate, paidKrw: entry.paidKrw,
          contentHash, optionHash });
        totalPaid = totalPaid.plus(entry.paidKrw);
        itemCount += items.length;
        onOrder?.(entry.orderId, entry.paidKrw, [...itemKeys],
          { orderDate: entry.order.order_date as string, placeDate: entry.placeDate },
          contentHash ?? undefined, includeContent || includeOptionFields ? items : undefined,
          entry.order);
      }
    }
    const countAfter = await this.countOrders(connection.externalAccountId, shopNo, day, access, deadlineAt);
    if (countBefore !== countAfter || countAfter !== orders.rows.length)
      throw new ProviderFailure("RECONCILIATION_FAILED", false);
    let verifyOffset = 0;
    const verified = await collectBoundedPages(SourceDataKind.CAFE24_ORDER, async () => {
      const url = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders`);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("start_date", day);
      url.searchParams.set("end_date", day);
      url.searchParams.set("date_type", "order_date");
      url.searchParams.set("fields", `order_id,shop_no,order_date,payment_amount,currency${
        includePlaceDate ? ",place_date" : ""}${includeContent
        ? ",order_price_amount,payment_method,order_status" : ""}`);
      url.searchParams.set("limit", String(CAFE24_PAGE_LIMIT));
      url.searchParams.set("offset", String(verifyOffset));
      const { body, bytes } = await this.getJson(url, access, deadlineAt);
      const rows = record(body).orders;
      if (!Array.isArray(rows) || rows.length > CAFE24_PAGE_LIMIT)
        throw new ProviderFailure("PARTIAL_PAGE", false);
      verifyOffset += rows.length;
      return { rows, bytes, nextCursor: rows.length === CAFE24_PAGE_LIMIT ? String(verifyOffset) : null };
    });
    const verifiedIds = new Set<string>();
    if (verified.rows.length !== orders.rows.length || verified.rows.some((raw) => {
      const row = record(raw);
      const key = identifier(row.order_id);
      if (verifiedIds.has(key)) return true;
      verifiedIds.add(key);
      const first = observations.get(key);
      return row.currency !== "KRW" || String(row.shop_no) !== shopNo ||
        orderDay(row.order_date) !== day || !first || first.orderDate !== row.order_date ||
        (includePlaceDate && first.placeDate !== (row.place_date == null ? null :
          orderInstant(row.place_date))) ||
        first.paidKrw !== money(row.payment_amount).toFixed(2);
    })) throw new ProviderFailure("RECONCILIATION_FAILED", false);
    if (includeContent || includeOptionFields) {
      for await (const group of itemReadGroups(verified.rows, async (raw) => {
        const order = record(raw);
        const orderId = identifier(order.order_id);
        const itemUrl = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders/${orderId}/items`);
        itemUrl.searchParams.set("shop_no", shopNo);
        itemUrl.searchParams.set("fields", `order_item_code,product_no,product_name,option_value,quantity,product_price,order_status${includeOptionFields ? ",option_price" : ""}`);
        await paceItem();
        let body: unknown;
        try { ({ body } = await this.getJson(itemUrl, access, deadlineAt)); }
        catch (error) {
          if (includeOptionFields && error instanceof ProviderFailure &&
              error.safeCode === "FIELD_UNSUPPORTED")
            throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null,
              "ITEM_REQUEST_OR_JSON");
          throw error;
        }
        return { order, orderId, items: record(body).items };
      })) {
        for (const { order, orderId, items } of group) {
          if (includeContent) {
            const revision = cafe24ObservedRevision(order, items, true, observationKey as Buffer);
            if (observations.get(orderId)?.contentHash !== revision.contentHash)
              throw new ProviderFailure("RECONCILIATION_FAILED", false);
          }
          if (includeOptionFields && observations.get(orderId)?.optionHash !==
              optionItemsHash(observationKey as Buffer, items))
            throw new ProviderFailure("RECONCILIATION_FAILED", false);
        }
      }
    }
    return { day, currency: "KRW", orderCount: orders.rows.length, itemCount,
      paidTotalKrw: totalPaid.toFixed(2), orderPageCount: orders.pageCount + verified.pageCount,
      readComplete: true, snapshotComplete: false };
  }

  protected async countOrders(mallId: string, shopNo: string, day: string,
    access: string, deadlineAt: number) {
    const url = new URL(`https://${mallId}.cafe24api.com/api/v2/admin/orders/count`);
    url.searchParams.set("shop_no", shopNo);
    url.searchParams.set("start_date", day);
    url.searchParams.set("end_date", day);
    url.searchParams.set("date_type", "order_date");
    const { body } = await this.getJson(url, access, deadlineAt);
    const value = record(body).count;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new ProviderFailure("FIELD_UNSUPPORTED", false);
    return value;
  }

  async probeDayShape(connectionId: string, day: string) {
    assertCafe24TestReadEnabled();
    parseIsoDate(day);
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "CAFE24" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(connection.externalAccountId) ||
        !/^shop[1-9]\d*$/.test(connection.shopKey) ||
        !cafe24TestAllowed(connection.externalAccountId, connection.shopKey))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    const access = await this.oauth.accessToken(connectionId, connection.externalAccountId, connection.shopKey);
    const deadlineAt = Date.now() + 30_000;
    const url = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders`);
    url.searchParams.set("shop_no", connection.shopKey.slice(4));
    url.searchParams.set("start_date", day);
    url.searchParams.set("end_date", day);
    url.searchParams.set("date_type", "order_date");
    url.searchParams.set("limit", "1");
    url.searchParams.set("fields", "order_id,shop_no,order_date,updated_date,payment_amount,payed_amount,payment_method,order_status,order_price_amount,actual_order_amount,initial_order_amount,currency");
    const { body } = await this.getJson(url, access, deadlineAt);
    const rows = record(body).orders;
    if (!Array.isArray(rows) || rows.length > 1) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
    const order = rows.length ? record(rows[0]) : null;
    let item: Record<string, unknown> | null = null;
    if (order) {
      const orderId = identifier(order.order_id);
      const itemUrl = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders/${orderId}/items`);
      itemUrl.searchParams.set("shop_no", connection.shopKey.slice(4));
      itemUrl.searchParams.set("fields", "order_item_code,product_no,product_name,option_value,quantity,product_price,order_status");
      const result = record((await this.getJson(itemUrl, access, deadlineAt)).body).items;
      if (!Array.isArray(result)) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
      if (result.length) item = record(result[0]);
    }
    const shape = (data: Record<string, unknown> | null, names: string[]) =>
      Object.fromEntries(names.map((name) => [name, data ? data[name] === undefined ? "absent" :
        data[name] === null ? "null" : Array.isArray(data[name]) ? "array" : typeof data[name] : "no_sample"]));
    const amountNames = ["order_price_amount", "payment_amount", "total_amount_due",
      "coupon_discount_price", "coupon_shipping_fee_amount", "shipping_fee",
      "shipping_fee_discount_amount", "membership_discount_amount", "points_spent_amount",
      "credits_spent_amount", "set_product_discount_amount", "app_discount_amount",
      "market_other_discount_amount"];
    const nestedAmountShape = (value: unknown) => shape(value && typeof value === "object" &&
      !Array.isArray(value) ? value as Record<string, unknown> : null, amountNames);
    return { day, sampledOrder: !!order, sampledItem: !!item,
      orderFields: shape(order, ["order_id", "shop_no", "order_date", "updated_date",
        "payment_amount", "payed_amount", "payment_method", "order_status",
        "order_price_amount", "actual_order_amount", "initial_order_amount", "currency"]),
      actualOrderAmountFields: nestedAmountShape(order?.actual_order_amount),
      initialOrderAmountFields: nestedAmountShape(order?.initial_order_amount),
      itemFields: shape(item, ["order_item_code", "product_no", "product_name", "option_value",
        "quantity", "product_price", "order_status"]) };
  }

  /** One allowlisted order only; detail field shapes are diagnostic, never revision evidence. */
  async diagnoseDetailFields(connectionId: string, day: string) {
    assertCafe24TestReadEnabled();
    parseIsoDate(day);
    if (day !== "2026-09-21" && day !== "2026-09-30")
      throw new ProviderFailure("FIELD_UNSUPPORTED", false);
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "CAFE24" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(connection.externalAccountId) ||
        !/^shop[1-9]\d*$/.test(connection.shopKey) ||
        connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul" ||
        !cafe24TestAllowed(connection.externalAccountId, connection.shopKey))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    const mallId = connection.externalAccountId;
    const shopNo = connection.shopKey.slice(4);
    const access = await this.oauth.accessToken(connectionId, mallId, connection.shopKey);
    const deadlineAt = Date.now() + 30_000;
    const stages: Array<Record<string, unknown>> = [];
    const observed = (stage: string, result: DiagnosticResponse) => ({ stage,
      httpStatus: result.status, responseKind: result.kind,
      providerCode: result.providerCode ?? null });
    const finish = (sampledOrder: boolean) => ({ day, sampledOrder, stages,
      semanticVerified: false, snapshotComplete: false });
    const listUrl = new URL(`https://${mallId}.cafe24api.com/api/v2/admin/orders`);
    listUrl.searchParams.set("shop_no", shopNo);
    listUrl.searchParams.set("start_date", day);
    listUrl.searchParams.set("end_date", day);
    listUrl.searchParams.set("date_type", "order_date");
    listUrl.searchParams.set("limit", "1");
    listUrl.searchParams.set("fields", "order_id,shop_no");
    const listed = await this.diagnosticJson(listUrl, access, deadlineAt, "baseline");
    const listBody = listed.status === 200 && listed.kind === "json" && listed.body &&
      typeof listed.body === "object" && !Array.isArray(listed.body)
      ? listed.body as Record<string, unknown> : null;
    const rows = listBody?.orders;
    const listStage = { ...observed("orders_sample", listed),
      orders: diagnosticShape(rows) };
    stages.push(listStage);
    if (listed.status !== 200 || listed.kind !== "json") return finish(false);
    if (!Array.isArray(rows) || rows.length > 1) return finish(false);
    if (rows.length === 0) return finish(false);
    const first = rows[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return finish(false);
    const sampled = first as Record<string, unknown>;
    let orderId: string;
    try { orderId = identifier(sampled.order_id); }
    catch { return finish(false); }
    if (String(sampled.shop_no) !== shopNo) return finish(false);
    const detailBase = `https://${mallId}.cafe24api.com/api/v2/admin/orders/${orderId}`;
    const fields = ["updated_date", "order_status"] as const;
    const detail = async (stage: string, selected: readonly string[]) => {
      const url = new URL(detailBase);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("fields", ["order_id", "shop_no", ...selected].join(","));
      const result = await this.diagnosticJson(url, access, deadlineAt, "baseline");
      const detailBody = result.status === 200 && result.kind === "json" && result.body &&
        typeof result.body === "object" && !Array.isArray(result.body)
        ? result.body as Record<string, unknown> : null;
      const value = detailBody?.order;
      const row = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
      const identity = !row ? "UNVERIFIED" : row.order_id === undefined ||
        row.shop_no === undefined ? "MISSING" :
        row.order_id === orderId && String(row.shop_no) === shopNo ? "MATCH" : "MISMATCH";
      stages.push({ ...observed(stage, result), order: diagnosticShape(value), identity,
        fields: Object.fromEntries(selected.map((field) => [field,
          identity === "MATCH" ? diagnosticShape(row?.[field]) : "not_checked"])) });
      return { status: result.status, kind: result.kind, identity };
    };
    const combined = await detail("detail_combined", fields);
    if (combined.status === 400 || combined.status === 422) {
      for (const field of fields) {
        const single = await detail(`detail_${field}`, [field]);
        if (single.status !== 400 && single.status !== 422 &&
            (single.status !== 200 || single.kind !== "json" || single.identity !== "MATCH"))
          break;
      }
    }
    return finish(true);
  }

  /** One sampled row only. The result contains fixed request stages, HTTP statuses and types. */
  async diagnoseDayContract(connectionId: string, day: string) {
    assertCafe24TestReadEnabled();
    parseIsoDate(day);
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "CAFE24" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(connection.externalAccountId) ||
        !/^shop[1-9]\d*$/.test(connection.shopKey) ||
        !cafe24TestAllowed(connection.externalAccountId, connection.shopKey))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    const mallId = connection.externalAccountId;
    const shopNo = connection.shopKey.slice(4);
    const access = await this.oauth.accessToken(connectionId, mallId, connection.shopKey);
    const deadlineAt = Date.now() + 45_000;
    let calls = 0;
    const diagnose = (url: URL, variant: "baseline" | "content_type" = "baseline") => {
      if (++calls > 16) return Promise.resolve({ status: null, kind: "budget" } as const);
      return this.diagnosticJson(url, access, deadlineAt, variant);
    };
    const observed = (result: DiagnosticResponse) => ({ httpStatus: result.status,
      responseKind: result.kind, providerCode: result.providerCode ?? null });
    const base = `https://${mallId}.cafe24api.com/api/v2/admin/orders`;
    const stages: Array<Record<string, unknown>> = [];
    const stopAfter = (status: number | null) => status === null || status === 401 ||
      status === 403 || status === 429 || status >= 500;
    const dated = (path: string) => {
      const url = new URL(path);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("start_date", day);
      url.searchParams.set("end_date", day);
      url.searchParams.set("date_type", "order_date");
      return url;
    };
    const count = await diagnose(dated(`${base}/count`));
    stages.push({ stage: "count", ...observed(count),
      count: diagnosticShape(count.status === 200 && count.body &&
        typeof count.body === "object" && !Array.isArray(count.body)
        ? (count.body as Record<string, unknown>).count : undefined) });
    if (stopAfter(count.status)) return { day, stages };
    if (count.status === 400 || count.status === 422) {
      const withTime = dated(`${base}/count`);
      withTime.searchParams.set("start_date", `${day} 00:00:00`);
      withTime.searchParams.set("end_date", `${day} 23:59:59`);
      const timed = await diagnose(withTime);
      stages.push({ stage: "count_datetime", ...observed(timed) });
      if (stopAfter(timed.status)) return { day, stages };
      const withoutDateType = dated(`${base}/count`);
      withoutDateType.searchParams.delete("date_type");
      const defaultType = await diagnose(withoutDateType);
      stages.push({ stage: "count_without_date_type", ...observed(defaultType) });
      if (stopAfter(defaultType.status)) return { day, stages };
      const noDates = new URL(`${base}/count`);
      noDates.searchParams.set("shop_no", shopNo);
      const withoutDates = await diagnose(noDates);
      stages.push({ stage: "count_without_dates", ...observed(withoutDates) });
      if (stopAfter(withoutDates.status)) return { day, stages };
      const contentType = await diagnose(dated(`${base}/count`), "content_type");
      stages.push({ stage: "count_content_type", ...observed(contentType) });
      if (stopAfter(contentType.status)) return { day, stages };
    }

    const minimal = dated(base);
    minimal.searchParams.set("limit", "1");
    minimal.searchParams.set("fields", "order_id");
    const listed = await diagnose(minimal);
    const orders = listed.status === 200 && listed.body &&
      typeof listed.body === "object" && !Array.isArray(listed.body)
      ? (listed.body as Record<string, unknown>).orders : undefined;
    const first = Array.isArray(orders) && orders.length === 1 && orders[0] &&
      typeof orders[0] === "object" && !Array.isArray(orders[0])
      ? orders[0] as Record<string, unknown> : null;
    stages.push({ stage: "orders_minimal", ...observed(listed), orders: diagnosticShape(orders),
      orderId: diagnosticShape(first?.order_id, !!first) });
    if (listed.status !== 200) {
      if (listed.status === 400 || listed.status === 422) {
        const withTime = dated(base);
        withTime.searchParams.set("start_date", `${day} 00:00:00`);
        withTime.searchParams.set("end_date", `${day} 23:59:59`);
        withTime.searchParams.set("limit", "1");
        withTime.searchParams.set("fields", "order_id");
        const timed = await diagnose(withTime);
        stages.push({ stage: "orders_minimal_datetime", ...observed(timed) });
        if (stopAfter(timed.status)) return { day, stages };
        const withoutDateType = dated(base);
        withoutDateType.searchParams.delete("date_type");
        withoutDateType.searchParams.set("limit", "1");
        withoutDateType.searchParams.set("fields", "order_id");
        const defaultType = await diagnose(withoutDateType);
        stages.push({ stage: "orders_minimal_without_date_type", ...observed(defaultType) });
        if (stopAfter(defaultType.status)) return { day, stages };
        const noDates = new URL(base);
        noDates.searchParams.set("shop_no", shopNo);
        noDates.searchParams.set("limit", "1");
        noDates.searchParams.set("fields", "order_id");
        const withoutDates = await diagnose(noDates);
        stages.push({ stage: "orders_minimal_without_dates", ...observed(withoutDates) });
        if (stopAfter(withoutDates.status)) return { day, stages };
        const contentType = await diagnose(minimal, "content_type");
        stages.push({ stage: "orders_minimal_content_type", ...observed(contentType) });
        if (stopAfter(contentType.status)) return { day, stages };
      }
      return { day, stages };
    }

    const projected = dated(base);
    projected.searchParams.set("limit", "1");
    const fields = ["shop_no", "order_date", "updated_date", "payment_amount", "currency",
      "order_status", "payed_amount", "order_price_amount"] as const;
    projected.searchParams.set("fields", `order_id,${fields.join(",")}`);
    const projection = await diagnose(projected);
    const projectedOrders = projection.status === 200 && projection.body &&
      typeof projection.body === "object" && !Array.isArray(projection.body)
      ? (projection.body as Record<string, unknown>).orders : undefined;
    const projectedFirst = Array.isArray(projectedOrders) && projectedOrders.length === 1 &&
      projectedOrders[0] && typeof projectedOrders[0] === "object" && !Array.isArray(projectedOrders[0])
      ? projectedOrders[0] as Record<string, unknown> : null;
    stages.push({ stage: "orders_projection", ...observed(projection), orders: diagnosticShape(projectedOrders),
      fields: Object.fromEntries(fields.map((field) =>
        [field, diagnosticShape(projectedFirst?.[field], !!projectedFirst)])) });
    if (stopAfter(projection.status)) return { day, stages };
    if (projection.status === 400 || projection.status === 422) {
      for (const field of fields) {
        const single = dated(base);
        single.searchParams.set("limit", "1");
        single.searchParams.set("fields", `order_id,${field}`);
        const result = await diagnose(single);
        const rows = result.status === 200 && result.body &&
          typeof result.body === "object" && !Array.isArray(result.body)
          ? (result.body as Record<string, unknown>).orders : undefined;
        const row = Array.isArray(rows) && rows.length === 1 && rows[0] &&
          typeof rows[0] === "object" && !Array.isArray(rows[0])
          ? rows[0] as Record<string, unknown> : null;
        stages.push({ stage: `orders_field_${field}`, ...observed(result),
          field: diagnosticShape(row?.[field], !!row) });
        if (stopAfter(result.status)) return { day, stages };
      }
    }
    if (first && typeof first.order_id === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(first.order_id)) {
      const itemsUrl = new URL(`${base}/${first.order_id}/items`);
      itemsUrl.searchParams.set("shop_no", shopNo);
      const itemFields = ["order_item_code", "product_no", "product_name", "option_value",
        "quantity", "product_price", "order_status"] as const;
      itemsUrl.searchParams.set("fields", itemFields.join(","));
      const result = await diagnose(itemsUrl);
      const items = result.status === 200 && result.body &&
        typeof result.body === "object" && !Array.isArray(result.body)
        ? (result.body as Record<string, unknown>).items : undefined;
      const item = Array.isArray(items) && items.length > 0 && items[0] &&
        typeof items[0] === "object" && !Array.isArray(items[0])
        ? items[0] as Record<string, unknown> : null;
      stages.push({ stage: "items", ...observed(result), items: diagnosticShape(items),
        fields: Object.fromEntries(itemFields.map((field) =>
          [field, diagnosticShape(item?.[field], !!item)])) });
    }
    return { day, stages };
  }

  private async diagnosticJson(url: URL, token: string, deadlineAt: number,
    variant: "baseline" | "content_type"): Promise<DiagnosticResponse> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return { status: null, kind: "deadline" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(10_000, remainingMs));
    let status: number | null = null;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`,
        Accept: "application/json" };
      if (variant === "content_type") headers["Content-Type"] = "application/json";
      const response = await this.request(url, { method: "GET", signal: controller.signal,
        cache: "no-store", headers });
      status = response.status;
      if (!response.ok) {
        let providerCode: string | null = null;
        if (response.body && (status === 400 || status === 422)) {
          const reader = response.body.getReader();
          const chunks: Buffer[] = [];
          let bytes = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 4_096) { void reader.cancel().catch(() => undefined); break; }
              chunks.push(Buffer.from(part.value));
            }
            if (bytes <= 4_096) {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                const error = (parsed as Record<string, unknown>).error;
                if (error && typeof error === "object" && !Array.isArray(error))
                  providerCode = safeCafe24ErrorCode((error as Record<string, unknown>).code);
              }
            }
          } catch { /* Error bodies are never returned or logged. */ }
          finally { reader.releaseLock(); }
        } else void response.body?.cancel().catch(() => undefined);
        return { status, kind: "http_error", providerCode };
      }
      if (!response.body) return { status, kind: "empty" };
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_BYTES) {
            void reader.cancel().catch(() => undefined);
            return { status, kind: "too_large" };
          }
          chunks.push(Buffer.from(part.value));
        }
      } finally { reader.releaseLock(); }
      try { return { status, kind: "json",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }; }
      catch { return { status, kind: "invalid_json" }; }
    } catch { return { status, kind: Date.now() >= deadlineAt ? "deadline" : "transport_error" }; }
    finally { clearTimeout(timer); }
  }

  /** Aggregate only non-personal provider status codes across a bounded day. */
  async probeDayStatuses(connectionId: string, day: string) {
    assertCafe24TestReadEnabled();
    parseIsoDate(day);
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "CAFE24" ||
        !cafe24TestAllowed(connection.externalAccountId, connection.shopKey) ||
        connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul" ||
        !/^shop[1-9]\d*$/.test(connection.shopKey)) syncError("ACCOUNT_SCOPE_MISMATCH");
    const mallId = connection.externalAccountId;
    const shopNo = connection.shopKey.slice(4);
    const access = await this.oauth.accessToken(connectionId, mallId, connection.shopKey);
    const deadlineAt = Date.now() + 10 * 60_000;
    const countBefore = await this.countOrders(mallId, shopNo, day, access, deadlineAt);
    let offset = 0;
    const orders = await collectBoundedPages(SourceDataKind.CAFE24_ORDER, async () => {
      const url = new URL(`https://${mallId}.cafe24api.com/api/v2/admin/orders`);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("start_date", day);
      url.searchParams.set("end_date", day);
      url.searchParams.set("date_type", "order_date");
      url.searchParams.set("fields", "order_id,shop_no,order_date,order_status,currency");
      url.searchParams.set("limit", String(CAFE24_PAGE_LIMIT));
      url.searchParams.set("offset", String(offset));
      const { body, bytes } = await this.getJson(url, access, deadlineAt);
      const rows = record(body).orders;
      if (!Array.isArray(rows) || rows.length > CAFE24_PAGE_LIMIT)
        throw new ProviderFailure("PARTIAL_PAGE", false);
      offset += rows.length;
      return { rows, bytes, nextCursor: rows.length === CAFE24_PAGE_LIMIT ? String(offset) : null };
    });
    const seen = new Set<string>();
    const orderStatuses: Record<string, number> = {};
    const itemStatuses: Record<string, number> = {};
    const optionValueShapes = { absent: 0, null: 0, empty: 0, nonempty: 0,
      unsupported: 0 };
    let itemCount = 0;
    for (const raw of orders.rows) {
      const order = record(raw);
      const orderId = identifier(order.order_id);
      if (seen.has(orderId) || String(order.shop_no) !== shopNo ||
          orderDay(order.order_date) !== day || order.currency !== "KRW")
        throw new ProviderFailure("RECONCILIATION_FAILED", false);
      seen.add(orderId);
      incrementStatus(orderStatuses, order.order_status);
      const url = new URL(`https://${mallId}.cafe24api.com/api/v2/admin/orders/${orderId}/items`);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("fields", "order_item_code,order_status,option_value");
      const { body } = await this.getJson(url, access, deadlineAt);
      const items = record(body).items;
      if (!Array.isArray(items) || items.length === 0 || items.length >= CAFE24_PAGE_LIMIT)
        throw new ProviderFailure("PARTIAL_PAGE", false);
      if (itemCount + items.length > PAGE_ROW_LIMITS.CAFE24_ORDER)
        throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
      const itemKeys = new Set<string>();
      for (const rawItem of items) {
        const item = record(rawItem);
        const key = identifier(item.order_item_code);
        if (itemKeys.has(key)) throw new ProviderFailure("RECONCILIATION_FAILED", false);
        itemKeys.add(key);
        incrementStatus(itemStatuses, item.order_status);
        if (!Object.prototype.hasOwnProperty.call(item, "option_value"))
          optionValueShapes.absent += 1;
        else if (item.option_value === null) optionValueShapes.null += 1;
        else if (item.option_value === "") optionValueShapes.empty += 1;
        else if (typeof item.option_value === "string") optionValueShapes.nonempty += 1;
        else optionValueShapes.unsupported += 1;
        itemCount += 1;
      }
    }
    if (Object.keys(orderStatuses).length > 32 || Object.keys(itemStatuses).length > 32)
      throw new ProviderFailure("FIELD_UNSUPPORTED", false);
    const countAfter = await this.countOrders(mallId, shopNo, day, access, deadlineAt);
    if (countBefore !== countAfter || countAfter !== orders.rows.length)
      throw new ProviderFailure("RECONCILIATION_FAILED", false);
    return { day, orderCount: orders.rows.length, itemCount,
      orderStatusCounts: orderStatuses, itemStatusCounts: itemStatuses,
      optionValueShapes,
      snapshotComplete: false };
  }

  protected async getJson(url: URL, token: string, deadlineAt: number) {
    return boundedProviderRequest(async (signal) => {
      let response: Response;
      try { response = await this.request(url, { method: "GET", signal, cache: "no-store", headers: {
        Authorization: `Bearer ${token}`, Accept: "application/json"
      } }); } catch { throw new ProviderFailure("PROVIDER_UNAVAILABLE", true); }
      if (!response.ok) throw new ProviderFailure(response.status === 429 ? "PROVIDER_RATE_LIMITED" :
        response.status === 401 || response.status === 403 ? "PROVIDER_AUTH_REQUIRED" :
          response.status === 400 || response.status === 404 || response.status === 422
            ? "FIELD_UNSUPPORTED" : "PROVIDER_UNAVAILABLE",
      response.status === 429 || response.status >= 500,
      response.status === 429 ? cafe24RetryAfterMs(response.headers) : null, null,
      response.status === 400 ? "CAFE24_RESPONSE_HTTP_400" :
        response.status === 404 ? "CAFE24_RESPONSE_HTTP_404" :
          response.status === 422 ? "CAFE24_RESPONSE_HTTP_422" : null);
      if (!response.body) throw new ProviderFailure("PARTIAL_PAGE", false);
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_BYTES) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
          chunks.push(Buffer.from(part.value));
        }
      } finally { reader.releaseLock(); }
      try { return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, bytes }; }
      catch { throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null,
        "CAFE24_RESPONSE_INVALID_JSON"); }
    }, deadlineAt);
  }
}



