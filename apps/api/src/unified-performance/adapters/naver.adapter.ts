import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { assertAdapterBatch } from "../adapter-contract";
import { money, quantizeMoney, ExactDecimal as D } from "../domain/decimal";
import { assertBusinessDate, normalizeProductName } from "../domain/product-name-resolver";
import { assertUnifiedEnabled } from "../management.service";
import { UnifiedManagementRepository } from "../management.repository";
import type { AdapterBatch, AdapterRequest, SourceAdapter } from "../types";
import { adConfiguration } from "./ad-source";
import { naverConfiguration } from "./naver-configuration";
import { normalizeNaverSalesDay, type NaverSalesDayInput, type NaverSalesUnit } from "./naver-sales";
import { normalizeNaverAdsCommonDay, naverStoredDiagnostics, naverSyncDiagnostics, type NaverAdsCommonDayInput,
  type NaverDeliveryEvidence, type NaverStoredSummary, type NaverOrderSyncState } from "./naver-ads-common";
import { naverPageDate, naverQueries, naverTimestamp, readNaverProjection, type NaverProjectedRow, type NaverTable } from "./naver-reader";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const amount = (value: unknown): string | null => { try { return money(value).toFixed(); } catch { return null; } };
const nonnegative = (value: unknown) => { const parsed = amount(value); return parsed !== null && !money(parsed).isNegative() ? parsed : null; };
const businessDate = (value: unknown): string | null => { try { if (typeof value !== "string") return null; assertBusinessDate(value); return value; } catch { return null; } };
const latest = (rows: readonly NaverProjectedRow[]) => rows.map(row => row.updatedAt).sort().at(-1) ?? null;
type RawDay = Record<NaverTable | "receipts", NaverProjectedRow[]>;
type ReadIssues = Record<NaverTable | "receipts", string[]>;

/** No fallback to arbitrary stores: provision this allowlist for the aggregation job, separately from web settings. */
export function assertNaverAllowedScope(scope: string, configured = process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS): void {
  const allowed = (configured ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!allowed.includes(scope)) throw new Error("NAVER_STORE_NOT_AUTHORIZED");
}
function storedRows(raw: RawDay, date: string, scopeKey: string): NaverStoredSummary[] {
  return [...raw.daily_store_summaries, ...raw.daily_sales_unit_profits].map(row => ({ id: row.id, storeId: scopeKey, date,
    calculationVersion: typeof row.calculationVersion === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(row.calculationVersion) ? row.calculationVersion : "INVALID", calculatedAt: naverTimestamp(row.calculatedAt) ?? row.updatedAt,
    updatedAt: row.updatedAt, costSnapshotId: text(row.costSnapshotId), mappingBasisHash: text(row.mappingBasisHash) }));
}
export function naverDelivery(date: string, raw: Pick<RawDay, "stores" | "order_items" | "daily_store_summaries">,
  orderComplete: boolean, orderReadFailed: boolean, storeReadFailed = false): NaverDeliveryEvidence | null {
  const stored = raw.daily_store_summaries.length === 1 ? raw.daily_store_summaries[0] : null;
  // Stored business estimates remain useful even without fingerprints or perfect collection history.
  if (stored && amount(stored.customerPaidDeliveryFee) !== null && nonnegative(stored.estimatedDeliveryBaseCost) !== null)
    return { sourceId: stored.id, basis: "STORED_SUMMARY", customerPaidDeliveryFee: amount(stored.customerPaidDeliveryFee),
      estimatedDeliveryBaseCost: nonnegative(stored.estimatedDeliveryBaseCost), deliveryUnitCost: nonnegative(stored.deliveryUnitCost),
      uniquePackageCount: nonnegative(stored.uniquePackageCount) !== null ? Number(stored.uniquePackageCount) : null,
      complete: true, fallbackUnitCost: false, calculatedAt: naverTimestamp(stored.calculatedAt) ?? stored.updatedAt };
  if (orderReadFailed || !raw.order_items.length && !orderComplete) return null;
  const selected = raw.order_items.filter(row => row.saleStatus === "SALE" && row.canonicalSalesUnitId);
  const unitCost = raw.stores[0]?.deliveryUnitCost;
  const cost = storeReadFailed ? null : unitCost === null || unitCost === undefined ? "3500" : nonnegative(unitCost);
  const packages = new Set<string>(); let income = new D(0), validIncome = true, validPackages = true;
  for (const row of selected) {
    const key = text(row.packageNumber)?.trim() || text(row.orderId);
    if (key) packages.add(key); else validPackages = false;
    if (row.deliveryFeeAmount !== null && row.deliveryFeeAmount !== undefined) {
      const fee = amount(row.deliveryFeeAmount); if (fee === null) validIncome = false; else income = income.plus(fee);
    }
  }
  return { sourceId: `store-day:${date}`, basis: "ORDER_RULE", customerPaidDeliveryFee: validIncome ? quantizeMoney(income) : null,
    estimatedDeliveryBaseCost: cost !== null && validPackages ? quantizeMoney(money(cost).mul(packages.size)) : null,
    deliveryUnitCost: cost, uniquePackageCount: validPackages ? packages.size : null,
    complete: orderComplete && validIncome && validPackages && cost !== null, fallbackUnitCost: !storeReadFailed && unitCost == null,
    calculatedAt: latest(raw.order_items) };
}

/** Shared by actual SQL reader and captured-input replay. No whole-database snapshot or source-repo import. */
export function normalizeNaverDay(request: AdapterRequest, raw: RawDay, errors: ReadIssues, unified: ReturnType<typeof adConfiguration>, observedAt: string): AdapterBatch {
  const date = naverPageDate(request), scopeKey = request.scopeKeys[0];
  const units = raw.canonical_sales_units.filter(row => typeof row.displayName === "string" && row.displayName.trim()) as unknown as NaverSalesUnit[];
  const configuration = naverConfiguration(request, date, units, unified);
  const stateRow = raw.order_sync_states.length === 1 ? raw.order_sync_states[0] : null;
  const state: NaverOrderSyncState | null = stateRow && businessDate(stateRow.initialCoverageFrom) ? {
    storeId: scopeKey, initialCoverageFrom: String(stateRow.initialCoverageFrom),
    lastSuccessfulChangedTo: naverTimestamp(stateRow.lastSuccessfulChangedTo), lastSuccessfulSyncAt: naverTimestamp(stateRow.lastSuccessfulSyncAt),
    changedCoverageBaselineAt: naverTimestamp(stateRow.changedCoverageBaselineAt) ?? undefined,
    historicalCoverageGap: text(stateRow.gapFrom) && text(stateRow.gapTo) ? { from: String(stateRow.gapFrom), to: String(stateRow.gapTo) } : undefined
  } : null;
  const candidate = raw.receipts.find(row => ["YESTERDAY", "MANUAL", "RECENT_30_DAYS"].includes(String(row.mode)));
  const receipt = candidate?.status === "SUCCEEDED" && businessDate(candidate.dateFrom) && businessDate(candidate.dateTo) && naverTimestamp(candidate.finishedAt) &&
    candidate.paymentDateMissingCount === "0" && candidate.unknownOrderStatusCount === "0" && !candidate.coverageGap && !candidate.historicalCoverageGap ? candidate : null;
  const orderErrors = [...errors.order_items, ...errors.order_source_signatures, ...errors.canonical_sales_units];
  const collectedAt = receipt ? naverTimestamp(receipt.finishedAt) : state?.lastSuccessfulSyncAt ?? latest(raw.order_items);
  const completeOrders = !!receipt && !orderErrors.length;
  const sourceVersion = hash([raw, errors, request.nameRuleVersion, request.saleUnitRuleVersion, request.sourcePolicySnapshot, request.sourceWatermarks]);
  const productNames = new Map(raw.products.map(row => [row.id, text(row.productName)]));
  const stored = storedRows(raw, date, scopeKey);
  const sourceAsOf = [...raw.order_items, ...raw.ad_excel_uploads, ...raw.sales_unit_cost_settings, ...raw.sales_unit_cost_snapshots, ...raw.sales_unit_cost_snapshot_entries, ...raw.canonical_sales_units];
  const diagnostics = [...naverSyncDiagnostics(date, state), ...naverStoredDiagnostics(stored, latest(sourceAsOf)).issues,
    ...errors.order_sync_states, ...errors.receipts, ...errors.daily_sales_unit_profits, ...errors.daily_store_summaries,
    ...(receipt ? [] : ["NAVER_PAYMENT_DATE_COMPLETION_UNPROVEN"]), ...(stateRow && !state ? ["NAVER_SYNC_METADATA_INVALID"] : []),
    ...(raw.order_sync_states.length > 1 ? ["NAVER_SYNC_STATE_AMBIGUOUS"] : [])];
  const saleInput: NaverSalesDayInput = { date, scopeKey, observedAt, collectedAt, sourceVersion, complete: completeOrders,
    sourceIssues: [...orderErrors, ...errors.products, ...errors.sales_unit_cost_settings, ...errors.sales_unit_cost_snapshots, ...errors.sales_unit_cost_snapshot_entries, ...diagnostics],
    rows: raw.order_items.map(row => ({ ...row, productNameFallback: productNames.get(String(row.productId)) ?? text(row.productNameFallback),
      externalProductOrderId: text(row.externalProductOrderId) || row.id, saleStatus: text(row.saleStatus) || "UNKNOWN" })) as unknown as NaverSalesDayInput["rows"],
    signatures: raw.order_source_signatures as unknown as NaverSalesDayInput["signatures"], salesUnits: units,
    costSettings: raw.sales_unit_cost_settings as unknown as NaverSalesDayInput["costSettings"],
    costSnapshots: raw.sales_unit_cost_snapshots as unknown as NaverSalesDayInput["costSnapshots"],
    costEntries: raw.sales_unit_cost_snapshot_entries as unknown as NaverSalesDayInput["costEntries"], configuration };
  let sales: AdapterBatch;
  try { sales = normalizeNaverSalesDay(request, saleInput); }
  catch { sales = normalizeNaverSalesDay(request, { ...saleInput, rows: [], costSettings: [], costSnapshots: [], costEntries: [], complete: false,
    sourceIssues: [...saleInput.sourceIssues, "NAVER_SALES_NORMALIZATION_FAILED"] }); }
  const delivery = naverDelivery(date, raw, completeOrders, !!errors.order_items.length, !!errors.stores.length);
  const adInput: NaverAdsCommonDayInput = { date, scopeKey, observedAt, sourceVersion, configuration,
    uploads: raw.ad_excel_uploads as unknown as NaverAdsCommonDayInput["uploads"],
    ads: raw.ad_campaign_daily_costs.map(row => {
      const groups = units.filter(unit => unit.isGroup).map(unit => ({ unit, alias: [unit.displayName, ...unit.matchAliases].find(alias =>
        normalizeProductName(alias) && normalizeProductName(text(row.campaignName)).includes(normalizeProductName(alias))) })).filter(group => group.alias);
      const children = units.filter(unit => groups.some(group => unit.parentSalesUnitId === group.unit.id)).map(unit => unit.displayName);
      return { ...row, ...(groups.length ? { groupName: groups[0].alias,
        groupChildNames: children.length ? children : [""] } : {}) };
    }) as unknown as NaverAdsCommonDayInput["ads"],
    fakePurchases: raw.daily_fake_purchases as unknown as NaverAdsCommonDayInput["fakePurchases"],
    delivery, storedSummaries: stored, syncState: state,
    adSourceIssues: [...errors.ad_excel_uploads, ...errors.ad_campaign_daily_costs, ...errors.canonical_sales_units],
    commonSourceIssues: [...errors.daily_fake_purchases, ...(delivery?.basis === "ORDER_RULE" ? [...orderErrors, ...errors.stores] : [])] };
  let adsCommon: AdapterBatch;
  try { adsCommon = normalizeNaverAdsCommonDay(request, adInput); }
  catch {
    const empty = { ...adInput, uploads: [], ads: [], fakePurchases: [], delivery: null, storedSummaries: [], syncState: null };
    let adsOnly: AdapterBatch, commonOnly: AdapterBatch;
    try { adsOnly = normalizeNaverAdsCommonDay(request, { ...adInput, fakePurchases: [], delivery: null, storedSummaries: [], syncState: null }); }
    catch { adsOnly = normalizeNaverAdsCommonDay(request, { ...empty, adSourceIssues: [...adInput.adSourceIssues ?? [], "NAVER_AD_NORMALIZATION_FAILED"] }); }
    try { commonOnly = normalizeNaverAdsCommonDay(request, { ...adInput, uploads: [], ads: [] }); }
    catch { commonOnly = normalizeNaverAdsCommonDay(request, { ...empty, commonSourceIssues: [...adInput.commonSourceIssues ?? [], "NAVER_COMMON_NORMALIZATION_FAILED"] }); }
    adsCommon = { ...adsOnly, commonExpenses: commonOnly.commonExpenses,
      coverage: [...adsOnly.coverage.filter(c => c.component === "AD_SPEND"), ...commonOnly.coverage.filter(c => c.component === "COMMON_EXPENSE")] };
  }
  const batch: AdapterBatch = { ...sales, adSpends: adsCommon.adSpends, commonExpenses: adsCommon.commonExpenses,
    coverage: [...sales.coverage, ...adsCommon.coverage], sourceControlTotals: [...sales.sourceControlTotals, ...adsCommon.sourceControlTotals],
    sourceFingerprint: hash([sourceVersion, request.allocationRuleVersion, request.calculationVersion, request.fxVersion]), nextCursor: adsCommon.nextCursor };
  for (const coverage of batch.coverage) {
    coverage.sourceFingerprint = batch.sourceFingerprint;
    if (coverage.quality.issues.some(issue => issue.endsWith("NORMALIZATION_FAILED"))) { coverage.collectionState = "PARTIAL"; coverage.zeroConfirmed = false; }
    if (coverage.component === "SALE") {
      coverage.quality.issues = [...new Set([...coverage.quality.issues, ...errors.stores])];
      if (coverage.quality.issues.some(issue => issue.endsWith("READ_FAILED") || issue.endsWith("NORMALIZATION_FAILED"))) coverage.collectionState = "PARTIAL";
    }
  }
  assertAdapterBatch(request, "NAVER", batch); return batch;
}

/** Job-only read boundary. Caller scopes must already satisfy existing workspace authorization. */
export async function readNaverDay(tx: Prisma.TransactionClient, management: UnifiedManagementRepository, request: AdapterRequest): Promise<AdapterBatch> {
  const date = naverPageDate(request), queries = naverQueries(request.scopeKeys[0], date);
  const unified = adConfiguration(await management.snapshot(tx), request);
  const raw = {} as RawDay, errors = {} as ReadIssues;
  for (const key of Object.keys(queries) as Array<keyof typeof queries>) {
    errors[key] = []; raw[key] = await readNaverProjection(tx, queries[key], key, errors[key]);
  }
  if (!errors.stores.length && (raw.stores.length !== 1 || raw.stores[0].platformType !== "NAVER_SMARTSTORE")) throw new Error("NAVER_STORE_NOT_FOUND");
  return normalizeNaverDay(request, raw, errors, unified, new Date().toISOString());
}

@Injectable()
export class NaverPerformanceAdapter implements SourceAdapter {
  readonly platform = "NAVER" as const;
  constructor(private readonly management: UnifiedManagementRepository) {}
  read(request: AdapterRequest): Promise<AdapterBatch> {
    assertUnifiedEnabled(); naverPageDate(request); assertNaverAllowedScope(request.scopeKeys[0]);
    return this.management.read(tx => readNaverDay(tx, this.management, request));
  }
}
