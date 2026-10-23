import { cafe24Chunk, Cafe24ChunkState } from "./cafe24-scheduled-chunk";
import { Injectable } from "@nestjs/common";
import { SourceDataKind } from "@prisma/client";
import { normalizeCafe24Order } from "./cafe24-order-adapter";
import { collectBoundedPages, ProviderFailure } from "./bounded-request";
import { accountAllowlist, accountKey } from "./source-connections.service";
import { assertCafe24AppVersionEvidence, assertEnabled, PAGE_ROW_LIMITS,
  assertCafe24SellerOptionsEvidence, assertCafe24RawAllItemsV1Evidence,
  cafe24PaymentMethodCsvMap, verifiedCafe24V1Statuses,
  requiresCafe24RawAllItemsEvidence,
  parseIsoDate, syncError } from "./sync-contract";
import { Cafe24OrderPreflightClient, CAFE24_PAGE_LIMIT, identifier, orderDay, record } from "./cafe24-order-preflight.client";
import { withCafe24Diagnostic } from "./cafe24-failure-diagnostic";
export { withCafe24Diagnostic } from "./cafe24-failure-diagnostic";

@Injectable()
export class Cafe24OrdersClient extends Cafe24OrderPreflightClient {
  async fetchScheduledChunk(connectionId: string, day: string, deadlineAt: number, state: Cafe24ChunkState | null) {
    assertEnabled();
    withCafe24Diagnostic("CAFE24_EVIDENCE_APP_VERSION", () => assertCafe24AppVersionEvidence());
    withCafe24Diagnostic("CAFE24_EVIDENCE_SELLER_OPTIONS", () => assertCafe24SellerOptionsEvidence());
    parseIsoDate(day);
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "CAFE24" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(connection.externalAccountId) ||
        !/^shop[1-9]\d*$/.test(connection.shopKey) || connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul" ||
        !accountAllowlist().has(accountKey("CAFE24", connection.externalAccountId, connection.shopKey))) syncError("ACCOUNT_SCOPE_MISMATCH");
    const access = await this.oauth.accessToken(connectionId, connection.externalAccountId, connection.shopKey);
    const shopNo = connection.shopKey.slice(4);
    return cafe24Chunk({ connectionId, mallId: connection.externalAccountId, shopKey: connection.shopKey, day, deadlineAt, state,
      count: () => this.countOrders(connection.externalAccountId, shopNo, day, access, deadlineAt),
      listing: async (offset) => {
        const url = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders`);
        for (const [key, value] of Object.entries({ shop_no: shopNo, start_date: day, end_date: day,
          date_type: "order_date", limit: String(CAFE24_PAGE_LIMIT), offset: String(offset),
          fields: "order_id,shop_no,order_date,updated_date,payment_amount,order_price_amount,actual_order_amount,initial_order_amount,payment_method,order_status,currency" })) url.searchParams.set(key, value);
        const rows = record((await this.getJson(url, access, deadlineAt)).body).orders;
        if (!Array.isArray(rows)) throw new ProviderFailure("PARTIAL_PAGE", false);
        return rows;
      }, items: async (orderId) => {
        const url = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders/${orderId}/items`);
        url.searchParams.set("shop_no", shopNo);
        url.searchParams.set("fields", "order_item_code,product_no,product_name,option_value,quantity,product_price,order_status");
        const items = record((await this.getJson(url, access, deadlineAt)).body).items;
        if (!Array.isArray(items)) throw new ProviderFailure("PARTIAL_PAGE", false);
        return items;
      } });
  }

  /** Strict complete day snapshot for the canonical writer; no raw response is returned. */
  async fetchDaySnapshot(connectionId: string, day: string, runDeadlineAt?: number) {
    assertEnabled();
    withCafe24Diagnostic("CAFE24_EVIDENCE_APP_VERSION", () => assertCafe24AppVersionEvidence());
    withCafe24Diagnostic("CAFE24_EVIDENCE_SELLER_OPTIONS", () => assertCafe24SellerOptionsEvidence());
    parseIsoDate(day);
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "CAFE24" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(connection.externalAccountId) ||
        connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul" ||
        !/^shop[1-9]\d*$/.test(connection.shopKey) ||
        !accountAllowlist().has(accountKey("CAFE24", connection.externalAccountId, connection.shopKey)))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    const access = await this.oauth.accessToken(connectionId, connection.externalAccountId, connection.shopKey);
    const startedAt = new Date();
    const deadlineAt = Math.min(startedAt.getTime() + 10 * 60_000,
      runDeadlineAt ?? Number.POSITIVE_INFINITY);
    const shopNo = connection.shopKey.slice(4);
    const countBefore = await this.countOrders(connection.externalAccountId, shopNo, day, access, deadlineAt);
    let offset = 0;
    const pages = await collectBoundedPages(SourceDataKind.CAFE24_ORDER, async () => {
      if (offset > 8000) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
      const url = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders`);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("start_date", day);
      url.searchParams.set("end_date", day);
      url.searchParams.set("date_type", "order_date");
      url.searchParams.set("limit", String(CAFE24_PAGE_LIMIT));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("fields", "order_id,shop_no,order_date,updated_date,payment_amount,order_price_amount,actual_order_amount,initial_order_amount,payment_method,order_status,currency");
      const { body, bytes } = await this.getJson(url, access, deadlineAt);
      const rows = record(body).orders;
      if (!Array.isArray(rows) || rows.length > CAFE24_PAGE_LIMIT)
        throw new ProviderFailure("PARTIAL_PAGE", false);
      offset += rows.length;
      return { rows, bytes, nextCursor: rows.length === CAFE24_PAGE_LIMIT ? String(offset) : null };
    });
    const seen = new Set<string>();
    const compositionOrigins = new Map<string, string>();
    const paymentMethodCsvLabels = withCafe24Diagnostic("CAFE24_EVIDENCE_PAYMENT_MAP",
      () => cafe24PaymentMethodCsvMap());
    const firstItemViews = new Map<string, string>();
    const approvedStatuses = withCafe24Diagnostic("CAFE24_EVIDENCE_STATUS_SET",
      () => verifiedCafe24V1Statuses());
    let nextItemStartAt = Date.now();
    const paceItem = async () => {
      const now = Date.now();
      const scheduled = Math.max(now, nextItemStartAt);
      nextItemStartAt = scheduled + 500;
      if (scheduled >= deadlineAt) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
      if (scheduled > now) await new Promise<void>((resolve) => setTimeout(resolve, scheduled - now));
    };
    for (const raw of pages.rows) {
      const order = withCafe24Diagnostic("CAFE24_FIELD_ORDER_SHAPE", () => record(raw));
      const orderId = withCafe24Diagnostic("CAFE24_FIELD_ORDER_ID", () => identifier(order.order_id));
      if (seen.has(orderId) || String(order.shop_no) !== shopNo ||
          withCafe24Diagnostic("CAFE24_FIELD_ORDER_DATE", () => orderDay(order.order_date)) !== day ||
          order.currency !== "KRW")
        throw new ProviderFailure("RECONCILIATION_FAILED", false);
      seen.add(orderId);
    }
    const firstLines = await mapBoundedInOrder(pages.rows, 4, async (raw) => {
      const order = withCafe24Diagnostic("CAFE24_FIELD_ORDER_SHAPE", () => record(raw));
      const orderId = withCafe24Diagnostic("CAFE24_FIELD_ORDER_ID", () => identifier(order.order_id));
      const url = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders/${orderId}/items`);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("fields", "order_item_code,product_no,product_name,option_value,quantity,product_price,order_status");
      await paceItem();
      const { body } = await this.getJson(url, access, deadlineAt);
      const items = withCafe24Diagnostic("CAFE24_FIELD_ITEM_SHAPE", () => record(body)).items;
      if (!Array.isArray(items) || items.length === 0 || items.length >= CAFE24_PAGE_LIMIT)
        throw new ProviderFailure("PARTIAL_PAGE", false);
      const lines = normalizeCafe24Order(order, items, {
        verifiedSellerDropdown: true,
        csvOptionEvidence: { mallId: connection.externalAccountId, shopKey: connection.shopKey },
        compositionOrigins, paymentMethodCsvLabels
      });
      if (lines.some((line) => [line.orderStatus, line.lineStatus]
        .some(requiresCafe24RawAllItemsEvidence)))
        withCafe24Diagnostic("CAFE24_EVIDENCE_RAW_ALL_ITEMS",
          () => assertCafe24RawAllItemsV1Evidence(day));
      if (lines.some((line) => line.providerUpdatedAt !== null && line.providerUpdatedAt > startedAt))
        throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null,
          "CAFE24_PROVIDER_TIME_FUTURE");
      if (lines.some((line) =>
          (line.orderStatus != null && !approvedStatuses.has(line.orderStatus)) ||
          !approvedStatuses.has(line.lineStatus ?? "")))
        throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null,
          "CAFE24_STATUS_APPROVAL_MISMATCH");
      firstItemViews.set(orderId, lineView(lines));
      return lines;
    });
    const normalized = firstLines.flat();
    if (normalized.length > PAGE_ROW_LIMITS.CAFE24_ORDER)
      throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
    const countAfter = await this.countOrders(connection.externalAccountId, shopNo, day, access, deadlineAt);
    if (countBefore !== countAfter || countAfter !== pages.rows.length)
      throw new ProviderFailure("RECONCILIATION_FAILED", false);
    // A stable count alone cannot detect a same-size replacement while offsets
    // are traversed. Re-read the ID/revision set before certifying a snapshot.
    let verifyOffset = 0;
    const verified = await collectBoundedPages(SourceDataKind.CAFE24_ORDER, async () => {
      const url = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders`);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("start_date", day);
      url.searchParams.set("end_date", day);
      url.searchParams.set("date_type", "order_date");
      url.searchParams.set("limit", String(CAFE24_PAGE_LIMIT));
      url.searchParams.set("offset", String(verifyOffset));
      url.searchParams.set("fields", "order_id,shop_no,order_date,updated_date,payment_amount,order_price_amount,actual_order_amount,initial_order_amount,payment_method,order_status,currency");
      const { body, bytes } = await this.getJson(url, access, deadlineAt);
      const rows = record(body).orders;
      if (!Array.isArray(rows) || rows.length > CAFE24_PAGE_LIMIT)
        throw new ProviderFailure("PARTIAL_PAGE", false);
      verifyOffset += rows.length;
      return { rows, bytes, nextCursor: rows.length === CAFE24_PAGE_LIMIT ? String(verifyOffset) : null };
    });
    const revisions = new Map<string, string>();
    for (const raw of pages.rows) {
      const row = withCafe24Diagnostic("CAFE24_FIELD_ORDER_SHAPE", () => record(raw));
      revisions.set(withCafe24Diagnostic("CAFE24_FIELD_ORDER_ID", () => identifier(row.order_id)),
        listingSignature(row));
    }
    const seenVerify = new Set<string>();
    if (verified.rows.length !== pages.rows.length || verified.rows.some((raw) => {
      const row = withCafe24Diagnostic("CAFE24_FIELD_ORDER_SHAPE", () => record(raw));
      const orderId = withCafe24Diagnostic("CAFE24_FIELD_ORDER_ID", () => identifier(row.order_id));
      if (seenVerify.has(orderId)) return true;
      seenVerify.add(orderId);
      return row.currency !== "KRW" || String(row.shop_no) !== shopNo ||
        withCafe24Diagnostic("CAFE24_FIELD_ORDER_DATE", () => orderDay(row.order_date)) !== day ||
        revisions.get(orderId) !== listingSignature(row);
    })) throw new ProviderFailure("RECONCILIATION_FAILED", false);
    // Re-read every sibling set. A stable list/count can hide a changed item
    // or same-size replacement while offsets are traversed.
    await mapBoundedInOrder(verified.rows, 4, async (raw) => {
      const order = withCafe24Diagnostic("CAFE24_FIELD_ORDER_SHAPE", () => record(raw));
      const orderId = withCafe24Diagnostic("CAFE24_FIELD_ORDER_ID", () => identifier(order.order_id));
      const url = new URL(`https://${connection.externalAccountId}.cafe24api.com/api/v2/admin/orders/${orderId}/items`);
      url.searchParams.set("shop_no", shopNo);
      url.searchParams.set("fields", "order_item_code,product_no,product_name,option_value,quantity,product_price,order_status");
      await paceItem();
      const { body } = await this.getJson(url, access, deadlineAt);
      const items = withCafe24Diagnostic("CAFE24_FIELD_ITEM_SHAPE", () => record(body)).items;
      if (!Array.isArray(items) || items.length === 0 || items.length >= CAFE24_PAGE_LIMIT)
        throw new ProviderFailure("PARTIAL_PAGE", false);
      const lines = normalizeCafe24Order(order, items, {
        verifiedSellerDropdown: true,
        csvOptionEvidence: { mallId: connection.externalAccountId, shopKey: connection.shopKey },
        compositionOrigins, paymentMethodCsvLabels
      });
      if (lineView(lines) !== firstItemViews.get(orderId))
        throw new ProviderFailure("RECONCILIATION_FAILED", false);
      return null;
    });
    return { orders: normalized, orderCount: pages.rows.length,
      pageCount: pages.pageCount + verified.pageCount,
      fetchedAt: new Date(), checkpointValue: null };
  }

}

async function mapBoundedInOrder<T, U>(rows: readonly T[], concurrency: number,
  visit: (row: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(rows.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (!failed && cursor < rows.length) {
      const index = cursor++;
      try { results[index] = await visit(rows[index]); }
      catch (error) { failed = true; failure = error; }
    }
  }));
  if (failed) throw failure;
  return results;
}

/** Checks listing stability only. It cannot establish provider cache freshness or item stability. */
function listingSignature(row: Record<string, unknown>) {
  return JSON.stringify([
    row.order_id, row.shop_no, row.order_date, row.updated_date ?? null,
    row.payment_amount, row.order_price_amount ?? null,
    row.actual_order_amount ?? null, row.initial_order_amount ?? null,
    row.payment_method ?? null, row.order_status ?? null, row.currency
  ]);
}

function lineView(lines: ReturnType<typeof normalizeCafe24Order>) {
  return JSON.stringify([...lines].sort((a, b) => a.lineOrderNo.localeCompare(b.lineOrderNo)));
}


