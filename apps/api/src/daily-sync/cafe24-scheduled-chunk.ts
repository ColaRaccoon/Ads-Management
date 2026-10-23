import { normalizeCafe24Order } from "./cafe24-order-adapter";
import { ProviderFailure } from "./bounded-request";
import { withCafe24Diagnostic } from "./cafe24-failure-diagnostic";
import { identifier, orderDay, record, CAFE24_PAGE_LIMIT } from "./cafe24-order-preflight.client";
import { assertCafe24RawAllItemsV1Evidence, cafe24PaymentMethodCsvMap,
  PAGE_ROW_LIMITS, requiresCafe24RawAllItemsEvidence, verifiedCafe24V1Statuses } from "./sync-contract";

const ORDER_FIELDS = ["order_id", "shop_no", "order_date", "updated_date", "payment_amount", "order_price_amount",
  "actual_order_amount", "initial_order_amount", "payment_method", "order_status", "currency"];
const ITEM_FIELDS = ["order_item_code", "product_no", "product_name", "option_value", "quantity", "product_price", "order_status"];
export type Cafe24ChunkState = { version: 1; connectionId: string; day: string; startedAt: string;
  stage: "LIST_FIRST" | "ITEMS_FIRST" | "LIST_VERIFY" | "ITEMS_VERIFY" | "READY";
  count: number; pages: number; first: Record<string, unknown>[]; second: Record<string, unknown>[];
  items: unknown[][]; cursor: number; verifiedItems: number };
const project = (row: unknown, keys: string[]) => {
  const source = record(row);
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key,
    (key === "actual_order_amount" || key === "initial_order_amount") && source[key] != null
      ? Object.fromEntries(["order_price_amount", "payment_amount", "shipping_fee"]
        .filter((field) => record(source[key])[field] !== undefined).map((field) => [field, record(source[key])[field]]))
      : source[key]]));
};
const signature = (row: Record<string, unknown>) => JSON.stringify(ORDER_FIELDS.map((key) => row[key] ?? null));
export async function cafe24Chunk(input: { connectionId: string; mallId: string; shopKey: string; day: string;
  deadlineAt: number; state: Cafe24ChunkState | null; count: () => Promise<number>;
  listing: (offset: number) => Promise<unknown[]>; items: (orderId: string) => Promise<unknown[]>;
  now?: () => number; wait?: (ms: number) => Promise<void> }) {
  const now = input.now ?? Date.now;
  const state: Cafe24ChunkState = input.state ?? { version: 1, connectionId: input.connectionId, day: input.day,
    startedAt: new Date(now()).toISOString(), stage: "LIST_FIRST", count: await input.count(),
    pages: 0, first: [], second: [], items: [], cursor: 0, verifiedItems: 0 };
  if (state.version !== 1 || state.connectionId !== input.connectionId || state.day !== input.day ||
      !Number.isInteger(state.count) || state.count < 0 || state.count > 8_000 ||
      !["LIST_FIRST", "ITEMS_FIRST", "LIST_VERIFY", "ITEMS_VERIFY", "READY"].includes(state.stage) ||
      !Array.isArray(state.first) || !Array.isArray(state.second) || !Array.isArray(state.items) ||
      state.first.length > state.count || state.second.length > state.count || state.items.length > state.count ||
      !Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor > state.count ||
      !Number.isInteger(state.verifiedItems) || state.verifiedItems < 0 || state.verifiedItems > state.count ||
      !Number.isInteger(state.pages) || state.pages < 0 || state.pages > 162 ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(state.startedAt) ||
      !Number.isFinite(Date.parse(state.startedAt)) || Date.parse(state.startedAt) > now() ||
      state.items.some((items) => !Array.isArray(items) || items.length === 0 || items.length >= CAFE24_PAGE_LIMIT))
    throw new ProviderFailure("RECONCILIATION_FAILED", false);
  const firstDone = state.first.length === state.count, itemsDone = state.items.length === state.count;
  const validStage = state.stage === "LIST_FIRST" ? state.second.length === 0 && state.items.length === 0 && state.cursor === 0 && state.verifiedItems === 0 :
    state.stage === "ITEMS_FIRST" ? firstDone && state.second.length === 0 && state.cursor === state.items.length && state.verifiedItems === 0 :
    state.stage === "LIST_VERIFY" ? firstDone && itemsDone && state.cursor === 0 && state.verifiedItems === 0 :
    state.stage === "ITEMS_VERIFY" ? firstDone && itemsDone && state.second.length === state.count && state.cursor === state.verifiedItems :
    firstDone && itemsDone && state.second.length === state.count && state.cursor === 0 && state.verifiedItems === state.count;
  if (!validStage) throw new ProviderFailure("RECONCILIATION_FAILED", false);
  const normalize = (row: Record<string, unknown>, items: unknown[], origins: Map<string, string>) => {
    const lines = normalizeCafe24Order(row, items, { verifiedSellerDropdown: true,
      csvOptionEvidence: { mallId: input.mallId, shopKey: input.shopKey },
      compositionOrigins: origins, paymentMethodCsvLabels: withCafe24Diagnostic("CAFE24_EVIDENCE_PAYMENT_MAP", () => cafe24PaymentMethodCsvMap()) });
    const approved = withCafe24Diagnostic("CAFE24_EVIDENCE_STATUS_SET", () => verifiedCafe24V1Statuses());
    if (lines.some((line) => [line.orderStatus, line.lineStatus].some(requiresCafe24RawAllItemsEvidence)))
      withCafe24Diagnostic("CAFE24_EVIDENCE_RAW_ALL_ITEMS", () => assertCafe24RawAllItemsV1Evidence(input.day));
    if (lines.some((line) => line.providerUpdatedAt !== null && line.providerUpdatedAt > new Date(state.startedAt)))
      throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null, "CAFE24_PROVIDER_TIME_FUTURE");
    if (lines.some((line) => line.orderStatus != null && !approved.has(line.orderStatus) || !approved.has(line.lineStatus ?? "")))
      throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null, "CAFE24_STATUS_APPROVAL_MISMATCH");
    return lines;
  };
  if (state.stage === "LIST_FIRST" || state.stage === "LIST_VERIFY") {
    const rows = state.stage === "LIST_FIRST" ? state.first : state.second;
    const page = await input.listing(rows.length);
    if (!Array.isArray(page) || page.length > CAFE24_PAGE_LIMIT || rows.length + page.length > 8_000)
      throw new ProviderFailure("PARTIAL_PAGE", false);
    const seen = new Set(rows.map((row) => identifier(row.order_id)));
    for (const value of page) {
      const row = withCafe24Diagnostic("CAFE24_FIELD_ORDER_SHAPE", () => project(value, ORDER_FIELDS));
      const id = withCafe24Diagnostic("CAFE24_FIELD_ORDER_ID", () => identifier(row.order_id));
      if (seen.has(id) || row.currency !== "KRW" || String(row.shop_no) !== input.shopKey.slice(4) || withCafe24Diagnostic("CAFE24_FIELD_ORDER_DATE", () => orderDay(row.order_date)) !== input.day)
        throw new ProviderFailure("RECONCILIATION_FAILED", false);
      // Validate the order projection before storing its encrypted intermediate
      // representation. This sentinel validates metadata only; it is never
      // stored and never counts as an observed provider item.
      const validated = normalizeCafe24Order(row, [{ order_item_code: "VALIDATION_ONLY", product_no: "0",
        product_name: "validation", option_value: "validation", quantity: "0", product_price: "0", order_status: "N00" }],
      { verifiedSellerDropdown: true, csvOptionEvidence: { mallId: input.mallId, shopKey: input.shopKey },
        paymentMethodCsvLabels: withCafe24Diagnostic("CAFE24_EVIDENCE_PAYMENT_MAP", () => cafe24PaymentMethodCsvMap()) })[0];
      if (validated.providerUpdatedAt && validated.providerUpdatedAt > new Date(state.startedAt))
        throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null, "CAFE24_PROVIDER_TIME_FUTURE");
      if (validated.orderStatus && !withCafe24Diagnostic("CAFE24_EVIDENCE_STATUS_SET", () => verifiedCafe24V1Statuses()).has(validated.orderStatus))
        throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, null, "CAFE24_STATUS_APPROVAL_MISMATCH");
      seen.add(id); rows.push(row);
    }
    state.pages++;
    if (page.length < CAFE24_PAGE_LIMIT) {
      if (rows.length !== state.count) throw new ProviderFailure("RECONCILIATION_FAILED", false);
      if (state.stage === "LIST_VERIFY") {
        if (await input.count() !== state.count) throw new ProviderFailure("RECONCILIATION_FAILED", false);
        const first = new Map(state.first.map((row) => [identifier(row.order_id), signature(row)]));
        if (state.second.some((row) => first.get(identifier(row.order_id)) !== signature(row)))
          throw new ProviderFailure("RECONCILIATION_FAILED", false);
      }
      state.stage = state.stage === "LIST_FIRST" ? "ITEMS_FIRST" : "ITEMS_VERIFY";
      state.cursor = 0;
    }
  } else if (state.stage === "ITEMS_FIRST" || state.stage === "ITEMS_VERIFY") {
    let reads = 0;
    while (state.cursor < state.first.length && reads < 20 && now() < input.deadlineAt - 25_000) {
      if (reads) await (input.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(500);
      const row = state.first[state.cursor], items = await input.items(identifier(row.order_id));
      if (!Array.isArray(items) || items.length === 0 || items.length >= CAFE24_PAGE_LIMIT)
        throw new ProviderFailure("PARTIAL_PAGE", false);
      const selected = items.map((item) => withCafe24Diagnostic("CAFE24_FIELD_ITEM_SHAPE", () => project(item, ITEM_FIELDS)));
      const current = normalize(row, selected, new Map());
      if (state.stage === "ITEMS_FIRST") state.items[state.cursor] = selected;
      else {
        const prior = normalize(row, state.items[state.cursor], new Map());
        const view = (lines: typeof current) => JSON.stringify([...lines].sort((a, b) => a.lineOrderNo.localeCompare(b.lineOrderNo)));
        if (view(prior) !== view(current)) throw new ProviderFailure("RECONCILIATION_FAILED", false);
        state.verifiedItems++;
      }
      state.cursor++; reads++;
    }
    if (state.cursor === state.first.length) {
      state.stage = state.stage === "ITEMS_FIRST" ? "LIST_VERIFY" : "READY";
      state.cursor = 0;
    } else if (reads === 0) throw new ProviderFailure("PROVIDER_UNAVAILABLE", true);
  }
  if (state.stage !== "READY") return { state, snapshot: null };
  if (state.verifiedItems !== state.count || state.items.length !== state.count || state.second.length !== state.count)
    throw new ProviderFailure("RECONCILIATION_FAILED", false);
  const origins = new Map<string, string>();
  const orders = state.first.flatMap((row, index) => normalize(row, state.items[index], origins));
  if (orders.length > PAGE_ROW_LIMITS.CAFE24_ORDER) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
  return { state, snapshot: { orders, orderCount: state.count, pageCount: state.pages,
    fetchedAt: new Date(now()), checkpointValue: null } };
}
