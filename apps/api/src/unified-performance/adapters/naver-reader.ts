import { Prisma } from "@prisma/client";
import { assertAdapterRequest } from "../adapter-contract";
import { assertBusinessDate } from "../domain/product-name-resolver";
import type { AdapterRequest } from "../types";

/** Fixed projection allowlist. Never select payload, rawPayload, credentials or upload filenames. */
const projection = {
  stores: { text: ["platformType"], number: ["deliveryUnitCost"], boolean: [] },
  order_items: { text: ["storeId", "externalProductOrderId", "orderSourceSignatureId", "canonicalSalesUnitId", "productId", "rawProductName", "rawOptionInfo", "paymentDate", "saleStatus", "packageNumber", "orderId"],
    number: ["quantity", "productPaymentAmount", "deliveryFeeAmount", "paymentCommission", "knowledgeShoppingSellingInterlockCommission", "saleCommission", "channelCommission"], boolean: [] },
  order_source_signatures: { text: ["storeId", "rawProductNameSnapshot", "rawOptionInfoSnapshot", "normalizedProductName", "normalizedOptionInfo"], number: [], boolean: [] },
  products: { text: ["storeId", "productName"], number: [], boolean: [] },
  canonical_sales_units: { text: ["storeId", "displayName", "parentSalesUnitId", "deactivatedAt"], number: [], boolean: ["isGroup", "isStoreLevel", "isActive"], array: ["matchAliases"] },
  sales_unit_cost_settings: { text: ["storeId", "canonicalSalesUnitId", "effectiveFrom", "effectiveTo", "costValuesUpdatedAt"], number: ["unitCost", "feeRate", "otherCost"], boolean: ["isActive"] },
  sales_unit_cost_snapshots: { text: ["storeId", "effectiveFrom"], number: [], boolean: [] },
  sales_unit_cost_snapshot_entries: { text: ["storeId", "snapshotId", "canonicalSalesUnitId"], number: ["unitCost", "feeRate", "otherCost"], boolean: [] },
  ad_excel_uploads: { text: ["storeId", "reportDate", "sourceType", "state", "weekdayValidationStatus", "replacedUploadId"], number: [], boolean: ["isActive"] },
  ad_campaign_daily_costs: { text: ["storeId", "reportDate", "sourceUploadId", "campaignId", "campaignName"], number: ["totalCost", "totalConversionSales"], boolean: [] },
  daily_fake_purchases: { text: ["storeId", "date"], number: ["amount"], boolean: [] },
  daily_store_summaries: { text: ["storeId", "date", "calculationVersion", "calculatedAt"], number: ["customerPaidDeliveryFee", "estimatedDeliveryBaseCost", "deliveryUnitCost", "uniquePackageCount"], boolean: [] },
  daily_sales_unit_profits: { text: ["storeId", "date", "canonicalSalesUnitId", "calculationVersion", "calculatedAt", "costSnapshotId", "mappingBasisHash"], number: [], boolean: [] },
  order_sync_states: { text: ["storeId", "initialCoverageFrom", "lastSuccessfulChangedTo", "lastSuccessfulSyncAt", "changedCoverageBaselineAt"], number: [], boolean: [] }
} as const;
export type NaverTable = keyof typeof projection;
export type NaverProjectedRow = Record<string, unknown> & { id: string; updatedAt: string };
export const NAVER_READ_TABLES = [...Object.keys(projection), "operations", "order_sync_batch_items", "order_sync_batches"] as const;
const MAX_ROWS = 10000;
const fragment = (value: string) => Prisma.raw(value); // Only fixed identifiers from this module.
const jsonText = (key: string) => `CASE WHEN jsonb_typeof(t.payload->'${key}')='string' THEN t.payload->>'${key}' END AS "${key}"`;
function columns(table: NaverTable): string {
  const fields = projection[table];
  const array = "array" in fields ? fields.array : [];
  return ["t.id", "t.updated_at::text AS \"rowUpdatedAt\"", jsonText("updatedAt"),
    ...fields.text.map(jsonText),
    ...fields.number.map(key => `CASE WHEN jsonb_typeof(t.payload->'${key}') IN ('number','string') THEN t.payload->>'${key}' END AS "${key}"`),
    ...fields.boolean.map(key => `CASE WHEN jsonb_typeof(t.payload->'${key}')='boolean' THEN (t.payload->>'${key}')::boolean END AS "${key}"`),
    ...array.map(key => `CASE WHEN jsonb_typeof(t.payload->'${key}')='array' THEN (SELECT coalesce(jsonb_agg(a.value),'[]'::jsonb) FROM jsonb_array_elements(t.payload->'${key}') a WHERE jsonb_typeof(a.value)='string') ELSE '[]'::jsonb END AS "${key}"`),
    ...(table === "order_sync_states" ? ["t.payload#>>'{historicalCoverageGap,from}' AS \"gapFrom\"", "t.payload#>>'{historicalCoverageGap,to}' AS \"gapTo\""] : [])
  ].join(",");
}
export function naverPageDate(request: AdapterRequest): string {
  assertAdapterRequest(request, "NAVER");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.scopeKeys[0])) throw new Error("NAVER_INVALID_STORE_SCOPE");
  const date = request.cursor ?? request.from; assertBusinessDate(date);
  if (date < request.from || date > request.to) throw new Error("NAVER_CURSOR_OUT_OF_RANGE");
  return date;
}
/** Parameters remain bound, including store/day. JSON expressions match source-owned indexes. */
export function naverQueries(scope: string, date: string): Record<NaverTable | "receipts", Prisma.Sql> {
  const select = (table: NaverTable, where: Prisma.Sql, order = "t.id") => Prisma.sql`SELECT ${fragment(columns(table))} FROM public.${fragment(table)} t WHERE ${where} ORDER BY ${fragment(order)} LIMIT ${MAX_ROWS + 1}`;
  const store = Prisma.sql`t.payload->>'storeId'=${scope}`;
  const daily = (key: "date" | "reportDate" | "paymentDate") => Prisma.sql`${store} AND ${fragment(`t.payload->>'${key}'`)}=${date}`;
  const snapshot = Prisma.sql`SELECT s.id FROM public.sales_unit_cost_snapshots s WHERE s.payload->>'storeId'=${scope} AND s.payload->>'effectiveFrom'=(SELECT max(h.payload->>'effectiveFrom') FROM public.sales_unit_cost_snapshots h WHERE h.payload->>'storeId'=${scope} AND h.payload->>'effectiveFrom'<=${date})`;
  return {
    stores: select("stores", Prisma.sql`t.id=${scope}`),
    order_items: select("order_items", daily("paymentDate")),
    order_source_signatures: select("order_source_signatures", Prisma.sql`${store} AND t.id IN (SELECT o.payload->>'orderSourceSignatureId' FROM public.order_items o WHERE o.payload->>'storeId'=${scope} AND o.payload->>'paymentDate'=${date})`),
    products: select("products", Prisma.sql`${store} AND t.id IN (SELECT o.payload->>'productId' FROM public.order_items o WHERE o.payload->>'storeId'=${scope} AND o.payload->>'paymentDate'=${date})`),
    canonical_sales_units: select("canonical_sales_units", store),
    sales_unit_cost_settings: select("sales_unit_cost_settings", Prisma.sql`${store} AND t.payload->>'effectiveFrom'<=${date}`),
    sales_unit_cost_snapshots: select("sales_unit_cost_snapshots", Prisma.sql`${store} AND t.id IN (${snapshot})`),
    sales_unit_cost_snapshot_entries: select("sales_unit_cost_snapshot_entries", Prisma.sql`${store} AND t.payload->>'snapshotId' IN (${snapshot})`),
    ad_excel_uploads: select("ad_excel_uploads", daily("reportDate")),
    ad_campaign_daily_costs: select("ad_campaign_daily_costs", daily("reportDate")),
    daily_fake_purchases: select("daily_fake_purchases", daily("date")),
    daily_store_summaries: select("daily_store_summaries", daily("date")),
    daily_sales_unit_profits: select("daily_sales_unit_profits", daily("date")),
    order_sync_states: select("order_sync_states", store),
    receipts: Prisma.sql`SELECT o.id,o.payload->>'status' AS status,o.payload->>'finishedAt' AS "finishedAt",o.payload->>'startedAt' AS "startedAt",o.payload->>'createdAt' AS "createdAt",b.payload->>'mode' AS mode,
      b.payload#>>'{requestedRange,dateFrom}' AS "dateFrom",b.payload#>>'{requestedRange,dateTo}' AS "dateTo",
      o.payload#>>'{resultJson,paymentDateMissingCount}' AS "paymentDateMissingCount",o.payload#>>'{resultJson,unknownOrderStatusCount}' AS "unknownOrderStatusCount",
      o.payload#>>'{resultJson,coverageGap,code}' AS "coverageGap",o.payload#>>'{resultJson,historicalCoverageGap,code}' AS "historicalCoverageGap"
      FROM public.order_sync_batch_items i JOIN public.order_sync_batches b ON b.id=i.payload->>'batchId'
      JOIN public.operations o ON o.id=i.payload->>'operationId' AND o.payload->>'storeId'=${scope}
      WHERE i.payload->>'storeId'=${scope} AND i.payload->>'eligibility'='ELIGIBLE' AND o.payload->>'operationType'='ORDER_SYNC'
      AND b.payload#>>'{requestedRange,dateFrom}'<=${date} AND b.payload#>>'{requestedRange,dateTo}'>=${date}
      ORDER BY coalesce(o.payload->>'finishedAt',o.payload->>'startedAt',o.payload->>'createdAt') DESC NULLS LAST,o.id LIMIT ${MAX_ROWS + 1}`
  };
}
export function naverTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/(Z|[+-]\d\d(?::?\d\d)?)$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
/** A failed SELECT is rolled back to its savepoint so independent components remain readable. */
export async function readNaverProjection(tx: Prisma.TransactionClient, query: Prisma.Sql, key: string, issues: string[]): Promise<NaverProjectedRow[]> {
  await tx.$executeRawUnsafe("SAVEPOINT naver_component_read");
  try {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(query);
    if (rows.length > MAX_ROWS) throw new Error("NAVER_SOURCE_TOO_LARGE");
    const projected = rows.map(row => ({ ...row, id: String(row.id), updatedAt: naverTimestamp(row.updatedAt) ?? naverTimestamp(row.rowUpdatedAt) ?? "1970-01-01T00:00:00.000Z" }));
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT naver_component_read");
    return projected;
  } catch {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT naver_component_read");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT naver_component_read");
    issues.push(`NAVER_${key.toUpperCase()}_READ_FAILED`); return [];
  }
}
