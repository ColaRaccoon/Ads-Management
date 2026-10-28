import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertAdapterBatch, assertAdapterRequest } from "../adapter-contract";
import { assertBusinessDate } from "../domain/product-name-resolver";
import { assertUnifiedEnabled } from "../management.service";
import { UnifiedManagementRepository } from "../management.repository";
import type { AdapterBatch, AdapterRequest, SourceAdapter } from "../types";
import { COUPANG_UPLOAD_SCOPE, normalizeCoupangAdsDay } from "./coupang-ads";
import { normalizeCoupangSalesDay } from "./coupang-sales";
import { coupangConfiguration } from "./coupang-configuration";

const MAX_ROWS = 10000;
const day = (value: Date) => value.toISOString().slice(0, 10);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bound = (rows: readonly unknown[]) => { if (rows.length > MAX_ROWS) throw new Error("COUPANG_DAY_TOO_LARGE"); };
export function coupangPageDate(request: AdapterRequest) {
  assertAdapterRequest(request, "COUPANG");
  if (request.scopeKeys[0] !== COUPANG_UPLOAD_SCOPE) throw new Error("COUPANG_SCOPE_FORBIDDEN");
  const date = request.cursor ?? request.from; assertBusinessDate(date);
  if (date < request.from || date > request.to) throw new Error("COUPANG_CURSOR_OUT_OF_RANGE");
  return date;
}
const saleFields = { id: true, saleLineKey: true, uploadBatchId: true, productName: true, optionName: true,
  saleMethod: true, salesKrw: true, cancelAmountKrw: true, netSalesKrw: true, salesQuantity: true,
  orderCount: true, importVersion: true, validationStatus: true, sourceRowHash: true, createdAt: true,
  batch: { select: { status: true, sourceType: true, importedAt: true } } } satisfies Prisma.CoupangSaleLineSelect;
const adFields = { id: true, adMetricKey: true, uploadBatchId: true, adExecutionProductName: true,
  campaignName: true, adGroupName: true, adName: true, adSpendKrw: true, totalConversionSales1dKrw: true,
  importVersion: true, validationStatus: true, sourceRowHash: true, createdAt: true,
  batch: { select: { status: true, sourceType: true, importedAt: true } } } satisfies Prisma.CoupangAdMetricSelect;

/** One complete business day is a page. Configuration and both source components share READ ONLY RR. */
export async function readCoupangDay(tx: Prisma.TransactionClient, management: UnifiedManagementRepository,
  request: AdapterRequest): Promise<AdapterBatch> {
  const date = coupangPageDate(request), at = new Date(`${date}T00:00:00.000Z`);
  const saleIssues: string[] = [], adIssues: string[] = [];
  // A denied source SELECT must not poison the transaction used by its sibling.
  const readPart = async <T>(part: "sales" | "ads", work: () => Promise<T>): Promise<T | null> => {
    const point = part === "sales" ? "coupang_sales_read" : "coupang_ads_read";
    await tx.$executeRawUnsafe(`SAVEPOINT ${point}`);
    try { const value = await work(); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${point}`); return value; }
    catch {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${point}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${point}`);
      (part === "sales" ? saleIssues : adIssues).push(`COUPANG_${part.toUpperCase()}_READ_FAILED`);
      return null;
    }
  };
  const [snapshot, products, rules] = await Promise.all([
    management.snapshot(tx),
    tx.coupangProduct.findMany({ select: { id: true, standardName: true, displayName: true, isActive: true }, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
    tx.coupangProductRule.findMany({ where: { isActive: true, validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gte: at } }] },
      select: { id: true, coupangProductId: true, displayName: true, includeKeywords: true, excludeKeywords: true, adEnabled: true, isActive: true, validFrom: true, validTo: true }, orderBy: { id: "asc" }, take: MAX_ROWS + 1 })
  ]);
  const saleRead = await readPart("sales", async () => { const result = await Promise.all([
    tx.coupangSaleLine.findMany({ where: { isCurrent: true, saleDate: at }, select: saleFields, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
    tx.coupangCostRule.findMany({ where: { effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] },
      select: { id: true, coupangProductId: true, effectiveFrom: true, effectiveTo: true, salePriceKrw: true, productCostKrw: true,
        sellerShippingFeeKrw: true, hanaroShippingFeeKrw: true, growthInboundFeeKrw: true, growthShippingFeeKrw: true, returnRate: true,
        returnCostPerUnitKrw: true, extraCostKrw: true }, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
    tx.coupangSalesFeeRule.findMany({ where: { effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] },
      select: { id: true, effectiveFrom: true, effectiveTo: true, salesFeeRate: true }, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
    tx.coupangManualPurchase.findMany({ where: { purchaseDate: at }, select: { id: true, productDisplayName: true, ruleDisplayName: true,
      quantity: true, salesAmountKrw: true, baseSalePriceKrw: true, vendorFeeTotalKrw: true, totalCostKrw: true, saleMethod: true, updatedAt: true },
      orderBy: { id: "asc" }, take: MAX_ROWS + 1 })
  ]); result.forEach(bound); return result; });
  const [saleCandidates, costs, fees, manual] = saleRead ?? [[], [], [], []];
  const adCandidates = await readPart("ads", async () => {
    const result = await tx.coupangAdMetric.findMany({ where: { isCurrent: true, metricDate: at }, select: adFields, orderBy: { id: "asc" }, take: MAX_ROWS + 1 });
    bound(result); return result;
  }) ?? [];
  bound(products); bound(rules);
  for (const field of ["scopePolicyVersion", "nameRuleVersion", "saleUnitRuleVersion", "allocationRuleVersion"] as const)
    if (request[field] !== snapshot.versions[field]) throw new Error(`STALE_CONFIGURATION:${field}`);
  const sales = saleCandidates.filter(row => row.validationStatus !== "ERROR" && row.batch.status === "IMPORTED" && row.batch.sourceType === "SALES");
  const ads = adCandidates.filter(row => row.validationStatus !== "ERROR" && row.batch.status === "IMPORTED" && row.batch.sourceType === "ADS");
  const configuration = coupangConfiguration({ date, scopeKey: COUPANG_UPLOAD_SCOPE, products,
    rules: rules.map(rule => ({ ...rule, productId: rule.coupangProductId })),
    costs: costs.map(cost => ({ ...cost, productId: cost.coupangProductId, from: day(cost.effectiveFrom), to: cost.effectiveTo ? day(cost.effectiveTo) : null,
      salePriceKrw: cost.salePriceKrw.toFixed(), productCostKrw: cost.productCostKrw.toFixed(), sellerShippingFeeKrw: cost.sellerShippingFeeKrw?.toFixed() ?? null,
      hanaroShippingFeeKrw: cost.hanaroShippingFeeKrw?.toFixed() ?? null, growthInboundFeeKrw: cost.growthInboundFeeKrw.toFixed(),
      growthShippingFeeKrw: cost.growthShippingFeeKrw.toFixed(), returnRate: cost.returnRate.toFixed(), returnCostPerUnitKrw: cost.returnCostPerUnitKrw.toFixed(), extraCostKrw: cost.extraCostKrw.toFixed() })),
    observedSales: [...sales, ...manual.map(row => ({ productName: row.productDisplayName, optionName: row.ruleDisplayName ?? "" }))],
    observedAds: ads, unified: snapshot });
  const observedAt = new Date().toISOString();
  const latest = (rows: Array<{ batch: { importedAt: Date | null } }>) => rows.map(row => row.batch.importedAt?.toISOString()).filter((v): v is string => !!v).sort().at(-1) ?? null;
  if (saleCandidates.length > sales.length) saleIssues.push("COUPANG_CURRENT_SALES_WITHHELD");
  if (adCandidates.length > ads.length) adIssues.push("COUPANG_CURRENT_ADS_WITHHELD");
  const sourceVersion = hash([saleCandidates, manual, products, rules, costs, fees, snapshot.versions]);
  let saleBatch: AdapterBatch;
  try { saleBatch = normalizeCoupangSalesDay(request, { date, scopeKey: COUPANG_UPLOAD_SCOPE, observedAt, collectedAt: latest(sales), sourceVersion,
    complete: sales.length > 0 && !saleIssues.length, sourceIssues: saleIssues, excludedByPolicyRows: saleCandidates.length - sales.length,
    rows: sales.map(row => ({ ...row, salesKrw: row.salesKrw.toFixed(), cancelAmountKrw: row.cancelAmountKrw.toFixed(), netSalesKrw: row.netSalesKrw.toFixed(),
      salesQuantity: row.salesQuantity.toFixed(), sourceVersion: String(row.importVersion), observedAt: row.createdAt.toISOString() })),
    costRules: configuration.costRules, configuration,
    salesFeeRules: fees.map(row => ({ id: row.id, from: day(row.effectiveFrom), to: row.effectiveTo ? day(row.effectiveTo) : null, rate: row.salesFeeRate.toFixed() })),
    manualPurchases: manual.map(row => ({ id: row.id, productName: row.productDisplayName, optionName: row.ruleDisplayName,
      quantity: String(row.quantity), salesAmountKrw: row.salesAmountKrw?.toFixed() ?? null, baseSalePriceKrw: row.baseSalePriceKrw?.toFixed() ?? null,
      vendorFeeTotalKrw: row.vendorFeeTotalKrw.toFixed(), totalCostKrw: row.totalCostKrw.toFixed(), saleMethod: row.saleMethod, updatedAt: row.updatedAt.toISOString() })) }); }
  catch {
    saleIssues.push("COUPANG_SALES_NORMALIZATION_FAILED");
    saleBatch = normalizeCoupangSalesDay(request, { date, scopeKey: COUPANG_UPLOAD_SCOPE, observedAt, collectedAt: latest(sales), sourceVersion,
      complete: false, sourceIssues: saleIssues, excludedByPolicyRows: saleCandidates.length, rows: [], manualPurchases: [], costRules: [], salesFeeRules: [], configuration });
  }
  let adBatch: AdapterBatch;
  try { adBatch = normalizeCoupangAdsDay(request, { date, scopeKey: COUPANG_UPLOAD_SCOPE, complete: ads.length > 0 && !adIssues.length,
    collectedAt: latest(ads), selectedSource: "CSV", sourceIssues: adIssues, excludedRows: adCandidates.length - ads.length,
    unverifiedRows: adCandidates.length - ads.length, selectionEvidence: hash([adCandidates, products, rules]), configuration,
    rows: ads.map(row => ({ ...row, adSpendKrw: row.adSpendKrw.toFixed(), totalConversionSales1dKrw: row.totalConversionSales1dKrw.toFixed(),
      sourceVersion: String(row.importVersion), observedAt: row.createdAt.toISOString(), updatedAt: null })) }); }
  catch {
    adIssues.push("COUPANG_ADS_NORMALIZATION_FAILED");
    adBatch = normalizeCoupangAdsDay(request, { date, scopeKey: COUPANG_UPLOAD_SCOPE, complete: false, sourceIssues: adIssues, rows: [], configuration,
      collectedAt: latest(ads), unverifiedRows: adCandidates.length, excludedRows: adCandidates.length, selectionEvidence: hash(adCandidates) });
  }
  // Empty days without a daily CSV completion receipt remain NOT_COLLECTED.
  if (saleIssues.length) for (const coverage of saleBatch.coverage) {
    coverage.collectionState = "PARTIAL"; coverage.rowsPresent = saleCandidates.length + manual.length;
  }
  if (adIssues.length) for (const coverage of adBatch.coverage) coverage.collectionState = "PARTIAL";
  const next = new Date(at.getTime() + 86400000).toISOString().slice(0, 10);
  const batch: AdapterBatch = { sales: saleBatch.sales, adSpends: adBatch.adSpends, commonExpenses: saleBatch.commonExpenses,
    coverage: [...saleBatch.coverage, ...adBatch.coverage], sourceControlTotals: [...saleBatch.sourceControlTotals, ...adBatch.sourceControlTotals],
    sourceFingerprint: hash([saleBatch.sourceFingerprint, adBatch.sourceFingerprint, request.sourceWatermarks, request.sourcePolicySnapshot]), nextCursor: next <= request.to ? next : null };
  assertAdapterBatch(request, "COUPANG", batch); return batch;
}

@Injectable()
export class CoupangPerformanceAdapter implements SourceAdapter {
  readonly platform = "COUPANG" as const;
  constructor(private readonly management: UnifiedManagementRepository) {}
  read(request: AdapterRequest): Promise<AdapterBatch> {
    assertUnifiedEnabled(); coupangPageDate(request);
    return this.management.read(tx => readCoupangDay(tx, this.management, request));
  }
}
