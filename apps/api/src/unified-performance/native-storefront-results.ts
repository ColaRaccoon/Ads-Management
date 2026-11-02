import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../common/prisma.service";
import { SalesMetricsService } from "../sales/sales-metrics.service";
import { GoogleReadService } from "../google/google-read.service";
import { assertBusinessDate } from "./domain/product-name-resolver";
import type { NativeStorefrontResult, NativeStorefrontSnapshot } from "./types";

export const NATIVE_STOREFRONT_CALCULATION_VERSION = "native-storefront-v1";
const amount = (value: number | null) => value === null ? null : new Prisma.Decimal(value).toFixed(6);
const issueSet = (values: readonly string[]) => [...new Set(values)].sort();

function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return value.toFixed();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stable(item)]));
  return value;
}

/** Hash dependencies observed by the actual native readers, not a second hand-maintained list.
 * Only deterministic DB results are retained; query completion order, run IDs and clocks are absent.
 * Traces are never persisted or returned. Native readers cannot mutate through this facade. */
function trackedReader(tx: Prisma.TransactionClient) {
  const traces: unknown[] = [];
  const reads = new Set(["findMany", "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy"]);
  const wrap = (object: object, namespace: string) => new Proxy(object, { get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== "function") return value;
    if (!reads.has(String(property)) && !["$queryRaw", "$queryRawUnsafe"].includes(String(property)))
      return () => { throw new Error("NATIVE_STOREFRONT_READ_ONLY"); };
    return async (...args: unknown[]) => {
      const result: unknown = await value.apply(target, args);
      traces.push([namespace, String(property), stable(result)]);
      return result;
    };
  } });
  const facade = new Proxy(tx, { get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value === "function") return Reflect.get(wrap(target, "transaction"), property);
    if (value && typeof value === "object" && !String(property).startsWith("$")) return wrap(value, String(property));
    return value;
  } }) as unknown as PrismaService;
  return { facade, fingerprint: (identity: unknown) => createHash("sha256")
    .update(JSON.stringify(stable([NATIVE_STOREFRONT_CALCULATION_VERSION, identity, traces]))).digest("hex") };
}

/** Caller authorizes the scope and supplies an existing repeatable-read, read-only transaction.
 * sourceComplete is the Cafe24 adapter's selected-source evidence, including confirmed empty days;
 * it must not be the old unified cost-rule completeness flag. */
export async function readNativeStorefrontResults(tx: Prisma.TransactionClient,
  options: { date: string; scopeKey: string; sourceComplete: boolean }): Promise<NativeStorefrontSnapshot> {
  assertBusinessDate(options.date);
  if (!options.scopeKey) throw new Error("NATIVE_STOREFRONT_SCOPE_REQUIRED");
  const reader = trackedReader(tx), prisma = reader.facade;
  const shops = await prisma.sourceConnection.findMany({ where: { provider: "CAFE24" }, select: { id: true }, take: 101 });
  if (shops.length > 100 || options.scopeKey !== "LEGACY_UNBOUND" && !shops.some(shop => shop.id === options.scopeKey))
    throw new Error("NATIVE_STOREFRONT_SCOPE_FORBIDDEN");
  // No existing configuration attributes the same advertising account to several shops.
  // A legacy unbound partition cannot claim a configured shop's account ownership.
  const ownsAds = shops.length === 1 && shops[0].id === options.scopeKey || shops.length === 0 && options.scopeKey === "LEGACY_UNBOUND";
  const commonIssues = ownsAds ? [] : ["ATTRIBUTION_UNKNOWN"];
  const google = await new GoogleReadService(prisma).nativeStorefrontDay(prisma as unknown as Prisma.TransactionClient, options.date, options.scopeKey);
  const meta = await new SalesMetricsService(prisma).nativeMetaStorefrontDay(options.date, options.scopeKey, ownsAds,
    new Map((google.nativeFinancialCouponLines ?? []).map(row => [row.id, row.amount])));
  const rows: NativeStorefrontResult[] = meta.map(row => ({ channel: "META", productName: row.productName,
    revenue: !options.sourceComplete && row.salesRows === 0 ? null : amount(row.revenue),
    grossCost: !options.sourceComplete && row.salesRows === 0 ? null : amount(row.grossCost),
    coupon: !options.sourceComplete && row.salesRows === 0 ? null : amount(row.coupon),
    adSpend: ownsAds ? amount(row.adSpend) : null,
    profitBeforeAds: !options.sourceComplete && row.salesRows === 0 ? null : amount(row.profitBeforeAds),
    estimatedProfit: ownsAds && (options.sourceComplete || row.salesRows > 0) ? amount(row.estimatedProfit) : null, quantity: amount(row.quantity),
    complete: options.sourceComplete && row.revenue !== null && row.profitBeforeAds !== null,
    issues: issueSet([...row.issues, ...commonIssues, ...(!options.sourceComplete ? ["SOURCE_COLLECTION_INCOMPLETE"] : [])]) }));
  rows.push(...(google.nativeFinancialRows ?? []).map(row => ({ channel: "YOUTUBE" as const, productName: row.productName,
    revenue: !options.sourceComplete && row.salesRows === 0 ? null : amount(row.revenueKrw),
    grossCost: !options.sourceComplete && row.salesRows === 0 ? null : amount(row.grossCostKrw),
    coupon: !options.sourceComplete && row.salesRows === 0 ? null : amount(row.couponDeductionKrw),
    adSpend: ownsAds ? amount(row.adSpendKrw) : null,
    profitBeforeAds: !options.sourceComplete && row.salesRows === 0 ? null : amount(row.profitBeforeAdsKrw),
    estimatedProfit: ownsAds && (options.sourceComplete || row.salesRows > 0) ? amount(row.marginKrw) : null, quantity: amount(row.quantity),
    complete: options.sourceComplete && row.complete,
    issues: issueSet([...row.warningCodes.map(issue => issue === "SOURCE_SELECTION_REQUIRED" && !google.nativeSalesSelectionFailed
      ? "GOOGLE_AD_AUDIT_UNAVAILABLE" : issue), ...commonIssues, ...(!options.sourceComplete ? ["SOURCE_COLLECTION_INCOMPLETE"] : [])]) })));
  // Structural adoption markers are written by storage, with no money. Only an
  // actually empty and verified source/channel earns a numeric zero here.
  for (const channel of ["META", "YOUTUBE"] as const) if (!rows.some(row => row.channel === channel)) {
    const confirmed = options.sourceComplete && !(channel === "YOUTUBE" && google.nativeSalesSelectionFailed);
    rows.push({ channel, productName: null, revenue: confirmed ? "0.000000" : null, grossCost: confirmed ? "0.000000" : null,
      coupon: confirmed ? "0.000000" : null, adSpend: null, profitBeforeAds: confirmed ? "0.000000" : null,
      estimatedProfit: null, quantity: confirmed ? "0.000000" : null, complete: confirmed,
      issues: confirmed ? ["CONFIRMED_EMPTY_CHANNEL"] : ["SOURCE_COLLECTION_INCOMPLETE"] });
  }
  return { calculationVersion: NATIVE_STOREFRONT_CALCULATION_VERSION,
    sourceFingerprint: reader.fingerprint([options, process.env.DAILY_SYNC_FEATURE_ENABLED === "true", rows]),
    rows, issues: issueSet([...commonIssues, ...(!options.sourceComplete ? ["SOURCE_COLLECTION_INCOMPLETE"] : [])]) };
}
