import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/prisma.service";
import { createSourceReadContext, selectCurrentSourceRows } from "../../common/source-read-policy";
import { hasCafe24CouponPaymentToken } from "../../domain/cafe24-coupon-matcher";
import { normalizeCafe24Text } from "../../domain/cafe24-matcher";
import { assertAdapterBatch, assertAdapterRequest } from "../adapter-contract";
import { ExactDecimal as D, money, quantizeMoney } from "../domain/decimal";
import { assertBusinessDate, normalizeProductName, resolveProductName, type NameRule } from "../domain/product-name-resolver";
import { calculateSaleUnitQuantities, validateSaleUnit, type SaleUnitDefinition } from "../domain/sale-unit-validation";
import { UnifiedManagementRepository } from "../management.repository";
import type { AdapterBatch, AdapterRequest, ControlTotal, SaleFact, SourceAdapter } from "../types";
import { cafe24OrderCoupon, type Cafe24CouponPolicy } from "./cafe24-coupon";

type Configuration = Awaited<ReturnType<UnifiedManagementRepository["snapshot"]>>;
const day = (v: Date) => v.toISOString().slice(0, 10);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const fields = { id: true, connectionId: true, source: true, syncRunId: true, uploadBatchId: true,
  orderLineKey: true, orderNo: true, productNo: true, productName: true, optionName: true, optionValue: true,
  quantity: true, salePriceKrw: true, totalOrderKrw: true, totalPaidKrw: true, paymentMethod: true,
  providerCouponSignal: true, actualOrderPriceKrw: true, actualShippingFeeKrw: true,
  orderDate: true, importVersion: true, validationStatus: true, createdAt: true, providerUpdatedAt: true,
  sourceRowHash: true } satisfies Prisma.Cafe24OrderLineSelect;
type SelectedLine = Prisma.Cafe24OrderLineGetPayload<{ select: typeof fields }>;
// Older non-PII snapshots predate the separate option projection.
export type Cafe24SelectedLine = Omit<SelectedLine, "optionValue"> & { optionValue?: string | null };
export interface Cafe24UnitRule {
  id: string; productName: string; from: string; to: string | null; source: "UNIFIED" | "GOOGLE_SALE" | "LEGACY";
  unit: SaleUnitDefinition;
  nameAliases?: string[]; optionExclude?: string[];
  matchTarget?: string; nameInclude?: string[]; nameExclude?: string[];
}
export interface Cafe24Snapshot {
  configuration: Configuration;
  scopeKey: string; currency: string; timeZone: string; date: string; observedAt: string;
  lines: Cafe24SelectedLine[];
  /** Error siblings participate in coupon context but cannot become sale facts. */
  contextLines?: Cafe24SelectedLine[];
  unitRules: Cafe24UnitRule[]; couponRules: Cafe24CouponPolicy[];
  selectedSource: string | null; complete: boolean; collectedAt: string | null;
  sourceVersion: string; couponInputSource: string | null; sourceIssues: string[];
  excludedByPolicyRows: number;
}

function checkVersions(request: AdapterRequest, config: Configuration) {
  for (const field of ["scopePolicyVersion", "nameRuleVersion", "saleUnitRuleVersion", "allocationRuleVersion"] as const)
    if (request[field] !== config.versions[field]) throw new Error(`Cafe24 configuration version changed: ${field}.`);
}
function nameRules(config: Configuration): NameRule[] {
  return config.rules.filter(r => r.kind === "NAME").map(r => {
    const product = config.products.find(p => p.id === r.productId);
    if (!product) throw new Error("Cafe24 name rule references missing product.");
    return { ...(r.payload as unknown as NameRule), id: r.id, canonicalProductName: product.canonicalName,
      platform: r.platform as NameRule["platform"], scopeKey: r.scopeKey,
      validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null, active: r.active };
  });
}
function unitsFor(request: AdapterRequest, config: Configuration): Cafe24UnitRule[] {
  return config.rules.filter(r => r.kind === "SALE_UNIT" && r.active && r.platform === "CAFE24" &&
    (!r.scopeKey || r.scopeKey === request.scopeKeys[0])).map(r => ({ id: r.id,
      productName: config.products.find(p => p.id === r.productId)!.canonicalName,
      from: day(r.validFrom), to: r.validTo ? day(r.validTo) : null, source: "UNIFIED" as const,
      unit: r.payload as unknown as SaleUnitDefinition }));
}
const orderKey = (l: Cafe24SelectedLine) => JSON.stringify([l.source, l.connectionId ?? "LEGACY_UNBOUND", l.source === "CSV" && !l.connectionId ? l.uploadBatchId : null, l.orderNo]);
function unitMatches(rule: Cafe24UnitRule, product: string, line: Cafe24SelectedLine, date: string, unitName: string | null) {
  const u = rule.unit;
  const separate = rule.matchTarget === "SEPARATE";
  if (rule.matchTarget && !["SEPARATE", "LEGACY_COMBINED"].includes(rule.matchTarget) || separate && line.optionValue == null) return false;
  const normalize = rule.source === "LEGACY" ? normalizeCafe24Text : normalizeProductName;
  const sourceName = normalize(line.productName);
  const option = normalize(rule.source === "GOOGLE_SALE" || rule.source === "LEGACY" && !separate
    ? line.optionName : line.optionValue ?? line.optionName);
  return normalizeProductName(rule.productName) === normalizeProductName(product) && rule.from <= date && (!rule.to || date <= rule.to) &&
    (!unitName || normalizeProductName(u.saleUnitName) === normalizeProductName(unitName)) &&
    (!rule.nameAliases?.length || rule.nameAliases.some(alias => sourceName.includes(normalize(alias)) ||
      rule.source === "LEGACY" && !separate && option.includes(normalize(alias)))) &&
    (rule.nameInclude ?? []).every(term => sourceName.includes(normalize(term))) &&
    !(rule.nameExclude ?? []).some(term => sourceName.includes(normalize(term))) &&
    !(rule.optionExclude ?? []).some(term => option.includes(normalize(term))) &&
    (u.optionExact == null || normalize(u.optionExact) === option) &&
    (u.optionInclude ?? []).every(t => option.includes(normalize(t)));
}

/** No report totals are inputs: sales have a single Cafe24 owner, independently of ad selection. */
export function normalizeCafe24Snapshot(request: AdapterRequest, snapshot: Cafe24Snapshot): AdapterBatch {
  assertAdapterRequest(request, "CAFE24"); checkVersions(request, snapshot.configuration);
  if (snapshot.scopeKey !== request.scopeKeys[0] || snapshot.date < request.from || snapshot.date > request.to)
    throw new Error("Cafe24 snapshot escaped requested scope/date.");
  if (snapshot.lines.length > request.limit) throw new Error("Cafe24 day exceeds adapter page limit; split upstream collection grain.");
  const config = snapshot.configuration, rules = nameRules(config), units = [...unitsFor(request, config), ...snapshot.unitRules];
  const catalog = config.products.map(p => ({ canonicalName: p.canonicalName, active: p.active }));
  const context = byId(snapshot.contextLines ?? snapshot.lines);
  const resolved = new Map(context.map(l => [l.id, resolveProductName({ originalName: l.productName, originalOption: l.optionValue ?? l.optionName,
    nameField: "product_name", platform: "CAFE24", scopeKey: snapshot.scopeKey, businessDate: snapshot.date }, catalog, rules, request.nameRuleVersion)]));
  const couponByLine = new Map<string, ReturnType<typeof cafe24OrderCoupon>>();
  const groups = new Map<string, Cafe24SelectedLine[]>();
  for (const l of context) {
    const key = orderKey(l), group = groups.get(key);
    if (group) group.push(l); else groups.set(key, [l]);
  }
  for (const lines of groups.values()) {
    const csvCouponSignal = lines.every(l => l.source === "CSV") ? lines.some(l => hasCafe24CouponPaymentToken(l.paymentMethod)) : null;
    const coupon = cafe24OrderCoupon(lines.map(l => ({ key: l.id, productName: resolved.get(l.id)!.canonicalProductName,
      date: l.orderDate ? day(l.orderDate) : "", signal: l.source === "CSV" ? csvCouponSignal : l.providerCouponSignal,
      total: l.source === "CSV" ? l.totalOrderKrw?.toFixed() ?? null : snapshot.couponInputSource === "API_ACTUAL_PRODUCT_PLUS_SHIPPING" &&
        l.actualOrderPriceKrw != null && l.actualShippingFeeKrw != null ? l.actualOrderPriceKrw.plus(l.actualShippingFeeKrw).toFixed() : null,
      paid: l.totalPaidKrw.toFixed(), weight: l.salePriceKrw.mul(l.quantity).toFixed(), valid: l.validationStatus !== "ERROR" })), snapshot.couponRules);
    lines.forEach(l => couponByLine.set(l.id, coupon));
  }
  const paymentOwners = new Map<string, string>();
  for (const l of [...snapshot.lines].sort((a, b) => a.id.localeCompare(b.id))) if (!paymentOwners.has(orderKey(l))) paymentOwners.set(orderKey(l), l.id);
  const sales: SaleFact[] = snapshot.lines.map(l => {
    if (l.orderDate == null || day(l.orderDate) !== snapshot.date || l.connectionId !== snapshot.scopeKey && !(snapshot.scopeKey === "LEGACY_UNBOUND" && l.connectionId === null))
      throw new Error("Cafe24 selected line escaped scope/day.");
    const resolution = resolved.get(l.id);
    if (!resolution) throw new Error("Cafe24 order context is missing selected line.");
    const name = { ...resolution };
    const issues = [...snapshot.sourceIssues];
    if (snapshot.currency !== "KRW") issues.push("CURRENCY_UNSUPPORTED");
    if (snapshot.timeZone !== "Asia/Seoul") issues.push("TIME_ZONE_MISMATCH");
    if (name.matchStatus !== "MATCHED") issues.push(`NAME_${name.matchStatus}`);
    let candidates = name.canonicalProductName && name.matchStatus === "MATCHED" ?
      units.filter(u => unitMatches(u, name.canonicalProductName!, l, snapshot.date, name.saleUnitName)) : [];
    let google = l.productName.includes("[유튜브]") ? candidates.filter(u => u.source === "GOOGLE_SALE") : [];
    if (google.some(u => u.unit.optionExact != null)) google = google.filter(u => u.unit.optionExact != null);
    const unified = candidates.filter(u => u.source === "UNIFIED");
    candidates = google.length ? google : unified.length ? unified : candidates.filter(u => u.source === "LEGACY");
    // Latest effective version within one definition may replace its own history;
    // distinct concurrent definitions remain a conflict, never a priority match.
    const unit = candidates.length === 1 ? candidates[0] : null;
    const incompleteGoogle = unit?.source === "GOOGLE_SALE" &&
      [unit.unit.salePrice, unit.unit.productCost, unit.unit.shippingCost, unit.unit.otherCost].some(v => v == null);
    if (incompleteGoogle) issues.push("GOOGLE_SALE_CONFIG_INCOMPLETE");
    if (candidates.length > 1) { name.matchStatus = "UNIT_REQUIRED"; issues.push("MULTIPLE_SALE_UNIT_CANDIDATES"); }
    if (!unit) issues.push("SALE_UNIT_RULE_MISSING");
    if (unit) { validateSaleUnit(unit.unit); name.saleUnitName = unit.unit.saleUnitName; }
    const q = unit ? calculateSaleUnitQuantities(l.quantity.toFixed(), unit.unit) : {
      orderedQuantity: l.quantity.toFixed(), calculationQuantity: l.quantity.toFixed(), unitsPerSaleUnit: null, physicalQuantity: null,
      quantityBasis: "ORDERED_SALE_UNITS_UNRESOLVED" };
    const component = (field: "salePrice" | "productCost" | "shippingCost" | "otherCost") => incompleteGoogle || unit?.unit[field] == null ? null :
      quantizeMoney(money(unit.unit[field]!).mul(q.calculationQuantity));
    // Collected row sale price is a known fallback revenue basis, never a missing cost fallback.
    const registeredGross = component("salePrice"), collectedGross = quantizeMoney(l.salePriceKrw.mul(q.calculationQuantity));
    const gross = snapshot.currency === "KRW" && !incompleteGoogle && candidates.length <= 1 ? registeredGross ?? collectedGross : null;
    if (gross !== null && registeredGross === null) issues.push("REVENUE_SOURCE_ROW_LIST_PRICE_FALLBACK");
    const coupon = couponByLine.get(l.id)!;
    const discount = coupon.allocations.get(l.id) ?? null;
    issues.push(...coupon.issues);
    if (discount === null) issues.push("COUPON_UNRESOLVED");
    const revenue = gross !== null && discount !== null ? quantizeMoney(money(gross).minus(discount)) : null;
    if (revenue === null) issues.push("REVENUE_INPUT_MISSING");
    const productCost = component("productCost"), shipping = component("shippingCost"), other = component("otherCost");
    const vat = registeredGross === null || unit?.unit.salePrice == null ? null :
      quantizeMoney(money(unit.unit.salePrice).mul(q.calculationQuantity).mul("0.1"));
    if ([productCost, shipping, other, vat].some(v => v === null)) issues.push("COST_INPUT_MISSING");
    const costKey = `CAFE24:${snapshot.scopeKey}:${l.source}:${l.orderLineKey}:${l.importVersion}`;
    const costs = [["PRODUCT_COST", productCost], ["DIRECT_SHIPPING", shipping], ["OTHER_DIRECT", other], ["VAT", vat]] as const;
    const completeCost = costs.every(([, v]) => v !== null);
    const profit = revenue !== null && completeCost ? quantizeMoney(costs.reduce((s, [, v]) => s.minus(v!), money(revenue))) : null;
    const group = groups.get(orderKey(l))!;
    const consistentPayment = group.every(s => s.totalPaidKrw.eq(l.totalPaidKrw));
    if (!consistentPayment) issues.push("ORDER_PAYMENT_INCONSISTENT");
    return {
      ref: { sourceSystem: "CAFE24", platform: "CAFE24", schema: "meta_ads", table: "cafe24_order_lines", scopeKey: snapshot.scopeKey,
        recordKind: "ORDER_LINE", sourceRecordKey: `${l.source}:${l.orderLineKey}`, selectedSource: l.connectionId === null ? "LEGACY_UNBOUND" : l.source,
        sourceVersion: String(l.importVersion), uploadOrRunId: l.syncRunId ?? l.uploadBatchId, payloadHash: l.sourceRowHash,
        providerUpdatedAt: l.providerUpdatedAt?.toISOString() ?? null, observedAt: snapshot.observedAt, businessDate: snapshot.date,
        dateBasis: "ORDER_DATE", sourceTimeZone: snapshot.timeZone },
      name, productName: name.canonicalProductName, marketplace: "CAFE24", ...q, saleUnitName: name.saleUnitName,
      optionName: l.optionValue ?? l.optionName, operatingRevenue: revenue, revenueBasis: "REGISTERED_SALE_PRICE",
      collectedPaymentAmount: consistentPayment && paymentOwners.get(orderKey(l)) === l.id ? l.totalPaidKrw.toFixed() : null,
      paymentGrain: "ORDER", paymentAllocationStatus: "ORDER_REFERENCE_ONCE_NOT_PRODUCT_ALLOCATION",
      discountTreatment: `ORDER_COUPON_${coupon.status}_ALREADY_IN_OPERATING_REVENUE`, refundTreatment: "REFUNDS_NOT_VERIFIED",
      productCost, platformFee: "0", directShippingCost: shipping, returnCost: "0", otherDirectCost: other, vatExpense: vat,
      discountNotYetIncluded: discount === null ? null : "0", manualVendorFee: "0", costRuleRef: unit?.id ?? null,
      costEffectiveFrom: unit?.from ?? null, costEffectiveTo: unit?.to ?? null, costBasisVersion: hash([request.saleUnitRuleVersion, unit]),
      taxPolicyVersion: "cafe24-registered-v1:SALE_PRICE_X_0.1", feeBasis: "CAFE24_REGISTERED_COST_CONTRACT",
      feePresenceMask: "NOT_APPLICABLE", shippingBasis: "SALE_UNIT_TOTAL", dateBasis: "ORDER_DATE",
      costComponents: [...costs.map(([kind, amount]) => ({ kind, amount, sourceExpenseKey: `${costKey}:${kind}`, includedInRevenue: false, applied: amount !== null })),
        { kind: "SOURCE_LIST_PRICE_GROSS_REFERENCE", amount: snapshot.currency === "KRW" ? collectedGross : null,
          sourceExpenseKey: `${costKey}:SOURCE_LIST_PRICE_REFERENCE`, includedInRevenue: false, applied: false },
        { kind: registeredGross === null ? "SOURCE_ROW_LIST_PRICE_GROSS_BEFORE_COUPON" : "REGISTERED_GROSS_BEFORE_COUPON", amount: gross,
          sourceExpenseKey: `${costKey}:GROSS_REVENUE_REFERENCE`, includedInRevenue: true, applied: false },
        { kind: "COUPON", amount: discount, sourceExpenseKey: `${costKey}:COUPON:${coupon.ruleId ?? coupon.status}`, includedInRevenue: true, applied: discount !== null }],
      profitBeforeAds: profit, quality: { isEstimate: true, confidence: "ESTIMATED", issues: [...new Set(issues)] }
    };
  });
  const sum = (rows: SaleFact[]) => quantizeMoney(rows.reduce((s, r) => s.plus(r.operatingRevenue ?? "0"), new D(0)));
  const known = sales.some(s => s.operatingRevenue !== null) || snapshot.complete && !sales.length;
  const revenueComplete = snapshot.complete && sales.every(s => s.operatingRevenue !== null);
  const mapped = sales.filter(s => s.name.matchStatus === "MATCHED");
  const unmapped = sales.filter(s => s.name.matchStatus !== "MATCHED");
  const missingCost = sales.filter(s => s.profitBeforeAds === null).length;
  const fingerprint = hash([snapshot.sourceVersion, snapshot.date, snapshot.scopeKey, snapshot.currency, snapshot.timeZone,
    byId(snapshot.lines), context, byId(snapshot.unitRules), byId(snapshot.couponRules), snapshot.couponInputSource, snapshot.selectedSource, snapshot.complete, snapshot.sourceIssues,
    request.scopePolicyVersion, request.nameRuleVersion, request.saleUnitRuleVersion, request.calculationVersion]);
  const coverage = { sourceSystem: "CAFE24", platform: "CAFE24" as const, scopeKey: snapshot.scopeKey, date: snapshot.date,
    participation: "INCLUDED" as const, collectionState: snapshot.complete ? snapshot.sourceIssues.includes("STALE_DATA") ? "STALE" as const : "COMPLETE" as const : context.length ? "PARTIAL" as const : "NOT_COLLECTED" as const,
    rowsPresent: context.length, zeroConfirmed: snapshot.complete && !context.length && !snapshot.sourceIssues.includes("STALE_DATA"), selectedSource: snapshot.selectedSource,
    selectedUploadId: null, sourceVersion: snapshot.sourceVersion, collectedAt: snapshot.collectedAt, sourceAsOf: snapshot.collectedAt,
    calculatedAt: snapshot.observedAt, lastSuccessAt: snapshot.collectedAt, sourceFingerprint: fingerprint,
    nameRuleVersion: request.nameRuleVersion, costRuleVersion: request.saleUnitRuleVersion, mappedRows: mapped.length, unmappedRows: unmapped.length,
    unmatchedAmount: unmapped.some(s => s.operatingRevenue !== null) ? sum(unmapped) : unmapped.length ? null : "0",
    missingCostRows: missingCost, missingFxAmount: null, unallocatedAmount: "0",
    quality: { isEstimate: true, confidence: "ESTIMATED" as const, issues: [...new Set([...snapshot.sourceIssues, ...sales.flatMap(s => s.quality.issues)])] } };
  const batch: AdapterBatch = { sales, adSpends: [], commonExpenses: [], coverage: [
    { ...coverage, component: "SALE" }, { ...coverage, component: "DIRECT_COST", collectionState: missingCost ? "PARTIAL" : coverage.collectionState }],
    sourceControlTotals: [{ sourceSystem: "CAFE24", platform: "CAFE24", scopeKey: snapshot.scopeKey, date: snapshot.date, currency: "KRW", measure: "OPERATING_REVENUE",
      // selectedAmount/difference are full control totals. Assigned/unmatched retain
      // known parts even while an unresolved coupon prevents a complete total.
      selectedRows: sales.length, selectedAmount: revenueComplete ? sum(sales) : null, assignedAmount: known ? sum(mapped) : null,
      unmatchedAmount: known ? sum(unmapped) : null, unallocatedAmount: "0", excludedNonSaleAmount: "0", excludedByPolicyRows: snapshot.excludedByPolicyRows,
      roundingAdjustment: "0", difference: revenueComplete ? quantizeMoney(money(sum(sales)).minus(sum(mapped)).minus(sum(unmapped))) : null }], nextCursor: null, sourceFingerprint: fingerprint };
  const zero = () => new D(0);
  const sourceByKey = new Map(snapshot.lines.map(row => [`${row.source}:${row.orderLineKey}`, row]));
  const unitById = new Map(units.map(rule => [rule.id, rule]));
  const component = (sale: SaleFact, kind: string) => sale.costComponents.find(c => c.kind === kind)?.amount ?? null;
  const valueFor = (sale: SaleFact, measure: ControlTotal["measure"]) => {
    if (measure === "REGISTERED_GROSS") return component(sale, "REGISTERED_GROSS_BEFORE_COUPON");
    if (measure === "SOURCE_LIST_PRICE_GROSS") return component(sale, "SOURCE_LIST_PRICE_GROSS_REFERENCE");
    if (measure === "PRODUCT_COST") return sale.productCost;
    if (measure === "DIRECT_SHIPPING_COST") return sale.directShippingCost;
    if (measure === "OTHER_DIRECT_COST") return sale.otherDirectCost;
    if (measure === "VAT_EXPENSE") return sale.vatExpense;
    if (measure === "COUPON") return component(sale, "COUPON");
    throw new Error("Unsupported Cafe24 control measure.");
  };
  // Source-side controls recompute one selected unit price/cost times the original
  // ordered quantity; fact-side assignments are independently summed below.
  const sourceValue = (sale: SaleFact, measure: ControlTotal["measure"]): string | null => {
    const sourceRow = sourceByKey.get(sale.ref.sourceRecordKey);
    if (!sourceRow || snapshot.currency !== "KRW") return null;
    if (measure === "SOURCE_LIST_PRICE_GROSS") return quantizeMoney(sourceRow.salePriceKrw.mul(sourceRow.quantity));
    if (measure === "COUPON") return couponByLine.get(sourceRow.id)?.allocations.get(sourceRow.id) ?? null;
    const rule = sale.costRuleRef === null ? null : unitById.get(sale.costRuleRef);
    if (!rule || sale.quality.issues.includes("GOOGLE_SALE_CONFIG_INCOMPLETE")) return null;
    const field = measure === "REGISTERED_GROSS" || measure === "VAT_EXPENSE" ? "salePrice" :
      measure === "PRODUCT_COST" ? "productCost" : measure === "DIRECT_SHIPPING_COST" ? "shippingCost" : "otherCost";
    const input = rule.unit[field];
    return input == null ? null : quantizeMoney(money(input).mul(sourceRow.quantity).mul(measure === "VAT_EXPENSE" ? "0.1" : "1"));
  };
  for (const measure of ["REGISTERED_GROSS", "SOURCE_LIST_PRICE_GROSS", "PRODUCT_COST", "DIRECT_SHIPPING_COST", "OTHER_DIRECT_COST", "VAT_EXPENSE", "COUPON"] as const) {
    const amounts = sales.map(s => sourceValue(s, measure));
    const knownValues = sales.map(s => valueFor(s, measure));
    const present = knownValues.some(v => v !== null) || snapshot.complete && !sales.length;
    const orderCoupons = [...new Set(snapshot.lines.map(row => couponByLine.get(row.id)!))];
    const selected = snapshot.complete && amounts.every(v => v !== null) ? measure === "COUPON"
      ? orderCoupons.every(coupon => coupon.amount !== null) ? quantizeMoney(orderCoupons.reduce((s, coupon) => s.plus(coupon.amount!), zero())) : null
      : quantizeMoney(amounts.reduce((s, v) => s.plus(v!), zero())) : null;
    const assigned = present ? quantizeMoney(mapped.reduce((s, row) => s.plus(valueFor(row, measure) ?? "0"), zero())) : null;
    const unmatched = present ? quantizeMoney(unmapped.reduce((s, row) => s.plus(valueFor(row, measure) ?? "0"), zero())) : null;
    const difference = selected !== null && assigned !== null && unmatched !== null ? quantizeMoney(money(selected).minus(assigned).minus(unmatched)) : null;
    if (difference !== null && !money(difference).isZero()) throw new Error(`Cafe24 ${measure} control failed to conserve source amount.`);
    batch.sourceControlTotals.push({ sourceSystem: "CAFE24", platform: "CAFE24", scopeKey: snapshot.scopeKey, date: snapshot.date, currency: "KRW", measure,
      selectedRows: sales.length, selectedAmount: selected, assignedAmount: assigned, unmatchedAmount: unmatched, unallocatedAmount: present ? "0" : null,
      excludedNonSaleAmount: "0", excludedByPolicyRows: snapshot.excludedByPolicyRows, roundingAdjustment: "0", difference });
  }
  assertAdapterBatch(request, "CAFE24", batch); return batch;
}

@Injectable()
export class Cafe24PerformanceAdapter implements SourceAdapter {
  readonly platform = "CAFE24" as const;
  constructor(private readonly prisma: PrismaService, private readonly management: UnifiedManagementRepository) {}
  async read(request: Readonly<AdapterRequest>): Promise<AdapterBatch> {
    assertAdapterRequest(request, this.platform);
    const date = request.cursor ?? request.from;
    assertBusinessDate(date);
    if (date < request.from || date > request.to) throw new Error("Invalid Cafe24 day cursor.");
    const batch = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
      const snapshot = await this.load(tx, request, date);
      return normalizeCafe24Snapshot(request, snapshot);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 });
    batch.nextCursor = date < request.to ? day(new Date(Date.parse(date) + 86400000)) : null;
    return batch;
  }

  private async load(tx: Prisma.TransactionClient, request: AdapterRequest, date: string): Promise<Cafe24Snapshot> {
    const scope = request.scopeKeys[0], legacy = scope === "LEGACY_UNBOUND";
    const connection = legacy ? null : await tx.sourceConnection.findUnique({ where: { id: scope }, select: { provider: true, currencyCode: true, timeZone: true } });
    if (!legacy && connection?.provider !== "CAFE24") throw new Error("Unauthorized Cafe24 connection scope.");
    const when = new Date(`${date}T00:00:00Z`);
    const configuration = await this.management.snapshot(tx); checkVersions(request, configuration);
    const [policies, coverage, batches, costs, overrides, mappings, couponRules] = await Promise.all([
      tx.sourcePolicy.findMany({ where: { dataKind: "CAFE24_ORDER", fromDate: { lte: when }, OR: [{ toDate: null }, { toDate: { gt: when } }] }, orderBy: { id: "asc" }, take: 10001 }),
      legacy ? [] : tx.sourceCoverage.findMany({ where: { connectionId: scope, dataKind: "CAFE24_ORDER", metricDate: when }, orderBy: [{ connectionId: "asc" }, { dataKind: "asc" }, { metricDate: "asc" }], take: 2 }),
      tx.cafe24UploadBatch.findMany({ where: { status: { in: ["IMPORTED", "PARTIAL"] }, OR: [{ orderStart: null }, { orderEnd: null }, { orderStart: { lte: when }, orderEnd: { gte: when } }] },
        select: { id: true, rowCount: true, _count: { select: { rows: true } }, importedAt: true }, orderBy: { id: "asc" }, take: 10001 }),
      tx.productCostRule.findMany({ where: { effectiveFrom: { lte: when }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: when } }] }, include: { product: { select: { displayName: true } } }, orderBy: { id: "asc" }, take: 10001 }),
      tx.cafe24ProductRule.findMany({ where: { isActive: true, validFrom: { lte: when }, OR: [{ validTo: null }, { validTo: { gte: when } }] }, include: { product: { select: { displayName: true } } }, orderBy: { id: "asc" }, take: 10001 }),
      legacy ? [] : tx.googlePerformanceMapping.findMany({ where: { kind: "SALE", connectionId: scope, startDate: { lte: when }, OR: [{ endDate: null }, { endDate: { gte: when } }] }, include: { product: { select: { displayName: true } } }, orderBy: { id: "asc" }, take: 10001 }),
      tx.cafe24CouponRule.findMany({ where: { isActive: true, validFrom: { lte: when }, OR: [{ validTo: null }, { validTo: { gte: when } }] }, include: { product: { select: { displayName: true } } }, orderBy: { id: "asc" }, take: 10001 })
    ]);
    if ([policies, batches, costs, overrides, mappings, couponRules].some(rows => rows.length > 10000)) throw new Error("Cafe24 configuration source bound exceeded.");
    const candidates = await tx.cafe24OrderLine.findMany({ where: { isCurrent: true, orderDate: when, connectionId: legacy ? null : scope,
      OR: [{ source: "CSV", uploadBatchId: { in: batches.filter(b => b.rowCount === b._count.rows).map(b => b.id) } }, { source: "API", uploadBatchId: null }] },
      select: fields, take: request.limit + 1, orderBy: { id: "asc" } });
    if (candidates.length > request.limit) throw new Error("Cafe24 day exceeds adapter page limit.");
    const context = createSourceReadContext(tx, when, when, policies, coverage);
    const selected = await selectCurrentSourceRows(tx, "CAFE24_ORDER", candidates, l => l.orderDate, context);
    const selectedPolicy = policies.filter(p => p.connectionId === scope);
    const source = legacy ? "CSV" : process.env.DAILY_SYNC_FEATURE_ENABLED === "true" ? selectedPolicy.length === 1 ? selectedPolicy[0].primarySource : null : "CSV";
    let complete = selected.length > 0 && source === "CSV";
    const stored = coverage.find(c => c.source === source);
    if (source === "API" && stored?.lastSuccessAt && stored.lastSuccessRunId && stored.rowCount === selected.length) {
      const probe = await selectCurrentSourceRows(tx, "CAFE24_ORDER", [{ connectionId: scope, source: "API" as const, orderDate: when }], l => l.orderDate, context);
      complete = probe.length === 1;
    }
    const unitRules: Cafe24UnitRule[] = [];
    // Projection only: external product IDs are never conditions for cost selection.
    const strings = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
    const productNames = new Set(costs.map(c => c.product.displayName));
    for (const name of productNames) {
      const effective = costs.filter(c => c.product.displayName === name);
      const latestFrom = effective.reduce((latest, c) => c.effectiveFrom > latest ? c.effectiveFrom : latest, effective[0].effectiveFrom);
      for (const c of effective.filter(c => c.effectiveFrom.getTime() === latestFrom.getTime())) {
        const matchedOverrides = overrides.filter(o => o.product.displayName === name);
        const defs = matchedOverrides.length ? matchedOverrides : [null];
        for (const o of defs) unitRules.push({ id: o ? `${c.id}:${o.id}` : c.id, productName: name,
          from: o && o.validFrom > c.effectiveFrom ? day(o.validFrom) : day(c.effectiveFrom),
          to: [c.effectiveTo, o?.validTo].filter((value): value is Date => value instanceof Date).map(day).sort()[0] ?? null, source: "LEGACY",
          nameAliases: o ? strings(o.productNameAliases) : [], optionExclude: o ? strings(o.optionExcludeKeywords) : [],
          matchTarget: o?.matchTarget, nameInclude: o ? strings(o.productNameIncludeKeywords) : [], nameExclude: o ? strings(o.productNameExcludeKeywords) : [],
          unit: { saleUnitName: o?.displayName ?? "단품", quantityBasis: "SALE_UNIT_TOTAL",
            optionInclude: o ? strings(o.optionIncludeKeywords) : [], unitsPerSaleUnit: o && [o.displayName, ...strings(o.optionIncludeKeywords)].some(v => v.includes("1+1")) ? "2" : "1",
            salePrice: (o?.salePriceKrwOverride ?? c.salePriceKrw).toFixed(), productCost: (o?.productCostKrwOverride ?? c.productCostKrw).toFixed(),
            shippingCost: (o?.shippingKrwOverride ?? c.shippingKrw).toFixed(), otherCost: (o?.extraCostKrwOverride ?? c.extraCostKrw).toFixed() } });
      }
    }
    for (const m of mappings) if (m.product && [m.salePriceKrwOverride, m.productCostKrwOverride, m.shippingKrwOverride, m.extraCostKrwOverride].some(v => v != null)) unitRules.push({ id: `GOOGLE_SALE:${m.id}`, productName: m.product.displayName,
      from: day(m.startDate), to: m.endDate ? day(m.endDate) : null, source: "GOOGLE_SALE",
      unit: { saleUnitName: m.saleUnitLabel ?? (m.optionName || "판매단위 미지정"), quantityBasis: "SALE_UNIT_TOTAL",
        unitsPerSaleUnit: /^1\+1(?:\s*세트)?$/.test((m.saleUnitLabel ?? "").trim()) ? "2" : null,
        optionExact: m.optionScope === "PRODUCT" ? null : m.optionName,
        salePrice: m.salePriceKrwOverride?.toFixed() ?? null, productCost: m.productCostKrwOverride?.toFixed() ?? null,
        shippingCost: m.shippingKrwOverride?.toFixed() ?? null, otherCost: m.extraCostKrwOverride?.toFixed() ?? null } });
    const issues = [...stored?.warningCodes ?? [], ...(selected.some(l => l.validationStatus === "ERROR") ? ["INVALID_ORDER_LINES_EXCLUDED"] : []),
      ...(stored?.state === "STALE" ? ["STALE_DATA"] : [])];
    if (!complete) issues.push("SOURCE_COLLECTION_INCOMPLETE");
    return { configuration, scopeKey: scope, currency: connection?.currencyCode ?? "KRW", timeZone: connection?.timeZone ?? "Asia/Seoul", date,
      observedAt: new Date().toISOString(), lines: selected.filter(l => l.validationStatus !== "ERROR"), contextLines: selected,
      unitRules, couponRules: couponRules.map(r => ({ id: r.id, productName: r.product?.displayName ?? null,
        scope: r.scope, amount: r.discountKrw.toFixed(), from: day(r.validFrom), to: r.validTo ? day(r.validTo) : null,
        priority: r.priority, createdAt: r.createdAt.toISOString() })), selectedSource: legacy ? "LEGACY_UNBOUND" : source,
      complete: complete && !selected.some(l => l.validationStatus === "ERROR"),
      collectedAt: stored?.lastSuccessAt?.toISOString() ?? batches.filter(b => selected.some(l => l.uploadBatchId === b.id)).map(b => b.importedAt?.toISOString()).filter((s): s is string => !!s).sort().at(-1) ?? null,
      sourceVersion: hash([selected, selectedPolicy, coverage, connection, batches.filter(b => selected.some(l => l.uploadBatchId === b.id)), costs, overrides, unitRules, couponRules]),
      couponInputSource: selectedPolicy.length === 1 ? selectedPolicy[0].couponInputSource : null, sourceIssues: issues,
      excludedByPolicyRows: candidates.length - selected.filter(l => l.validationStatus !== "ERROR").length };
  }
}
