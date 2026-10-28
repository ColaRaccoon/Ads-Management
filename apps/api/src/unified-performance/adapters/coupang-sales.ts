import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { assertAdapterBatch, assertAdapterRequest } from "../adapter-contract";
import { ExactDecimal as D, money, quantity, quantizeMoney, ratio } from "../domain/decimal";
import { assertBusinessDate, normalizeProductName, resolveProductName, type CatalogProduct, type NameRule } from "../domain/product-name-resolver";
import { normalizeCoupangFulfillmentMethod } from "../../domain/coupang-profit-calculator";
import type { AdapterBatch, AdapterRequest, ControlTotal, SaleFact, SourceCoverage } from "../types";

export interface CoupangSaleRow {
  id: string; saleLineKey: string; productName: string; optionName: string; saleMethod: string | null;
  salesKrw: string; cancelAmountKrw: string; netSalesKrw: string; salesQuantity: string; orderCount: number;
  uploadBatchId: string; sourceVersion: string; observedAt: string; updatedAt?: string | null;
}
export interface CoupangSaleCostRule {
  id: string; productName: string; saleUnitName: string; from: string; to: string | null;
  /** Settings history lineage only; never compared to a source row's product/option ID. */
  historyKey?: string;
  optionExact?: string | null; optionInclude?: string[]; nameInclude?: string[];
  unitsPerSaleUnit: string | null; productCostKrw: string | null; sellerShippingFeeKrw: string | null;
  hanaroShippingFeeKrw: string | null; growthInboundFeeKrw: string | null; growthShippingFeeKrw: string | null;
  returnRate: string | null; returnCostPerUnitKrw: string | null; extraCostKrw: string | null;
  salePriceKrw?: string | null;
}
export interface CoupangSalesFeeRule { id: string; from: string; to: string | null; rate: string | null }
export interface CoupangManualRow {
  id: string; productName: string; optionName?: string | null; saleUnitName?: string | null; quantity: string;
  salesAmountKrw: string | null; baseSalePriceKrw: string | null;
  vendorFeeTotalKrw: string | null; totalCostKrw: string | null;
  saleMethod?: string | null; updatedAt?: string | null;
}
export interface CoupangSalesDayInput {
  scopeKey: string; date: string; observedAt: string; collectedAt: string | null; sourceVersion: string;
  complete: boolean; sourceIssues: readonly string[]; excludedByPolicyRows: number;
  rows: readonly CoupangSaleRow[]; costRules: readonly CoupangSaleCostRule[];
  salesFeeRules: readonly CoupangSalesFeeRule[]; manualPurchases: readonly CoupangManualRow[];
  configuration: { products: readonly CatalogProduct[]; nameRules: readonly NameRule[] };
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const amount = (value: Prisma.Decimal) => quantizeMoney(value);
const sum = (values: readonly string[]) => values.reduce((total, value) => total.plus(value), new D(0));
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const active = (date: string, rule: { from: string; to: string | null }) => rule.from <= date && (!rule.to || date <= rule.to);
const key = (product: string | null, unit: string | null) => JSON.stringify([product, unit]);
const optional = (value: string | null | undefined, kind: "money" | "ratio" = "money") => {
  if (value == null) return null;
  const result = kind === "ratio" ? ratio(value) : money(value);
  return result.isNegative() ? null : result;
};
type ResolvedRow = { row: CoupangSaleRow; name: ReturnType<typeof resolveProductName>; rule: CoupangSaleCostRule | null;
  issues: string[]; normalQuantity: Prisma.Decimal; normalSales: Prisma.Decimal | null; normalNet: Prisma.Decimal | null;
  excludedQuantity: Prisma.Decimal; excludedSales: Prisma.Decimal; invalidManual: boolean };

/** Pure day transform. The reader must supply only selected current, valid, completed source rows. */
export function normalizeCoupangSalesDay(request: AdapterRequest, input: CoupangSalesDayInput): AdapterBatch {
  assertAdapterRequest(request, "COUPANG"); assertBusinessDate(input.date);
  if (input.scopeKey !== "LEGACY_COUPANG_SINGLE_UPLOAD" || request.scopeKeys[0] !== input.scopeKey || input.date < request.from || input.date > request.to)
    throw new Error("Coupang sales escaped the confirmed single-upload scope/day.");
  if (input.rows.length + input.manualPurchases.length > request.limit) throw new Error("Coupang sales day exceeds page limit.");
  if (new Set(input.rows.map(row => row.saleLineKey)).size !== input.rows.length) throw new Error("Duplicate selected sale_line_key.");
  if (new Set(input.manualPurchases.map(row => row.id)).size !== input.manualPurchases.length) throw new Error("Duplicate manual purchase source.");
  for (const rule of [...input.costRules, ...input.salesFeeRules]) {
    assertBusinessDate(rule.from); if (rule.to) assertBusinessDate(rule.to);
    if (rule.to && rule.to < rule.from) throw new Error("Reversed Coupang cost interval.");
  }
  const fees = input.salesFeeRules.filter(rule => active(input.date, rule)).sort((a, b) => b.from.localeCompare(a.from));
  const feeCandidates = fees.filter(rule => rule.from === fees[0]?.from);
  const fee = feeCandidates.length === 1 ? optional(feeCandidates[0].rate, "ratio") : null;
  const resolve = (productName: string, optionName: string | null | undefined, saleUnitName?: string | null) => resolveProductName({
    originalName: productName, originalOption: optionName, saleUnitName, nameField: "product_name", platform: "COUPANG",
    scopeKey: input.scopeKey, businessDate: input.date
  }, input.configuration.products, input.configuration.nameRules, request.nameRuleVersion);
  const rows: ResolvedRow[] = [...input.rows].sort((a, b) => a.saleLineKey.localeCompare(b.saleLineKey)).map(row => {
    money(row.salesKrw); money(row.cancelAmountKrw); money(row.netSalesKrw);
    const q = quantity(row.salesQuantity);
    const name = resolve(row.productName, row.optionName), issues = [...input.sourceIssues];
    if (name.matchStatus !== "MATCHED") issues.push(`NAME_${name.matchStatus}`);
    const candidates = name.matchStatus === "MATCHED" ? input.costRules.filter(rule =>
      normalizeProductName(rule.productName) === normalizeProductName(name.canonicalProductName) && active(input.date, rule) &&
      (!name.saleUnitName || normalizeProductName(rule.saleUnitName) === normalizeProductName(name.saleUnitName)) &&
      (rule.optionExact == null || normalizeProductName(rule.optionExact) === normalizeProductName(row.optionName)) &&
      (rule.optionInclude ?? []).every(term => normalizeProductName(row.optionName).includes(normalizeProductName(term))) &&
      (rule.nameInclude ?? []).every(term => normalizeProductName(row.productName).includes(normalizeProductName(term)))) : [];
    const units = unique(candidates.map(rule => rule.saleUnitName));
    const histories = new Map<string, CoupangSaleCostRule[]>();
    for (const rule of units.length === 1 ? candidates : []) {
      const lineage = rule.historyKey ?? key(rule.productName, rule.saleUnitName);
      histories.set(lineage, [...histories.get(lineage) ?? [], rule]);
    }
    const current = [...histories.values()].flatMap(history => {
      const latest = [...history].sort((a, b) => b.from.localeCompare(a.from));
      return latest.filter(rule => rule.from === latest[0]?.from);
    });
    const rule = current.length === 1 ? current[0] : null;
    if (rule) name.saleUnitName = rule.saleUnitName;
    else {
      issues.push(candidates.length ? "SALE_UNIT_COST_AMBIGUOUS" : "NORMAL_COST_RULE_MISSING");
      if (candidates.length) name.matchStatus = "UNIT_REQUIRED";
    }
    return { row, name, rule, issues, normalQuantity: q, normalSales: money(row.salesKrw), normalNet: money(row.netSalesKrw),
      excludedQuantity: new D(0), excludedSales: new D(0), invalidManual: false };
  });
  const manualFacts: SaleFact[] = [];
  const groups = new Map<string, ResolvedRow[]>();
  for (const row of rows) {
    const groupKey = key(row.name.canonicalProductName, row.name.saleUnitName);
    groups.set(groupKey, [...groups.get(groupKey) ?? [], row]);
  }
  const manualResolved = [...input.manualPurchases].sort((a, b) => a.id.localeCompare(b.id)).map(manual => {
    const name = resolve(manual.productName, manual.optionName, manual.saleUnitName);
    const productRows = rows.filter(row => name.canonicalProductName != null && row.name.canonicalProductName === name.canonicalProductName);
    const units = unique(productRows.map(row => row.name.saleUnitName).filter((unit): unit is string => unit != null));
    if (!name.saleUnitName && units.length === 1) name.saleUnitName = units[0];
    const ambiguousUnit = !name.saleUnitName && units.length > 1;
    const ambiguousProducts = name.matchStatus === "AMBIGUOUS" ? rows.filter(row =>
      row.name.canonicalProductName !== null && name.candidateNames.includes(row.name.canonicalProductName) ||
      row.name.candidateNames.some(candidate => name.candidateNames.includes(candidate))) : [];
    return { manual, name, ambiguousUnit, targets: name.canonicalProductName === null ? ambiguousProducts :
      ambiguousUnit ? productRows : groups.get(key(name.canonicalProductName, name.saleUnitName)) ?? [] };
  });
  const manualGroupCounts = new Map<string, number>();
  for (const item of manualResolved) {
    const groupKey = key(item.name.canonicalProductName, item.name.saleUnitName);
    manualGroupCounts.set(groupKey, (manualGroupCounts.get(groupKey) ?? 0) + 1);
  }
  for (const { manual, name, targets, ambiguousUnit } of manualResolved) {
    const issues = [...input.sourceIssues];
    const q = quantity(manual.quantity);
    const invalidQuantity = q.isNegative() || !q.isInteger();
    if (invalidQuantity) issues.push("MANUAL_PURCHASE_INVALID_QUANTITY");
    if (name.matchStatus !== "MATCHED") issues.push(`NAME_${name.matchStatus}`);
    if (ambiguousUnit) issues.push("MANUAL_PURCHASE_SALE_UNIT_AMBIGUOUS");
    const storedSales = optional(manual.salesAmountKrw), basePrice = optional(manual.baseSalePriceKrw);
    const manualSales = q.isZero() ? new D(0) : storedSales?.gt(0) ? storedSales : basePrice?.gt(0) && !invalidQuantity ? basePrice.mul(q) : null;
    if (q.gt(0) && !storedSales?.gt(0) && manualSales) issues.push("MANUAL_PURCHASE_SALES_AMOUNT_LEGACY_FALLBACK");
    if (manualSales === null) issues.push("MANUAL_PURCHASE_SALES_AMOUNT_MISSING");
    const vendor = optional(manual.vendorFeeTotalKrw), total = optional(manual.totalCostKrw);
    if (q.gt(0) && (vendor === null || total === null)) issues.push("MANUAL_PURCHASE_COST_SNAPSHOT_INCOMPLETE");
    if (q.gt(0) && vendor !== null && total !== null && !vendor.toDecimalPlaces(2).eq(total.toDecimalPlaces(2))) issues.push("MANUAL_PURCHASE_TOTAL_COST_MISMATCH");
    const duplicate = (manualGroupCounts.get(key(name.canonicalProductName, name.saleUnitName)) ?? 0) > 1;
    if (duplicate) issues.push("DUPLICATE_MANUAL_PURCHASE_ROWS");
    const noReported = targets.length === 0;
    if (q.gt(0) && noReported) issues.push("MANUAL_PURCHASE_WITHOUT_REPORTED_SALES");
    const targetQ = sum(targets.map(row => row.row.salesQuantity));
    const targetSales = sum(targets.map(row => row.row.salesKrw));
    const targetNet = sum(targets.map(row => row.row.netSalesKrw));
    if (q.gt(targetQ) && !noReported) issues.push("MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED");
    if (manualSales && manualSales.gt(targetSales) && !noReported) issues.push("MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED");
    if (manualSales && targetNet.minus(manualSales).lt(0) && !noReported) issues.push("MANUAL_PURCHASE_ADJUSTED_NET_SALES_NEGATIVE");
    const salesBlocked = invalidQuantity || ambiguousUnit || name.matchStatus !== "MATCHED" || duplicate ||
      manualSales === null || !noReported && (q.gt(targetQ) || manualSales.gt(targetSales) || targetNet.minus(manualSales).lt(0));
    if (!q.isZero() && salesBlocked) {
      for (const row of targets) {
        row.invalidManual = true; row.normalSales = null; row.normalNet = null; row.issues.push(...issues);
      }
    } else if (q.gt(0) && !noReported) {
      // The legacy pipeline ignores a saved manual saleMethod: deduct SELLER first, then GROWTH.
      const ordered = [...targets].sort((a, b) => normalizeCoupangFulfillmentMethod(a.row.saleMethod).localeCompare(normalizeCoupangFulfillmentMethod(b.row.saleMethod)) * -1 || a.row.saleLineKey.localeCompare(b.row.saleLineKey));
      const segments = (["SELLER", "GROWTH"] as const).map(method => ({ method,
        rows: ordered.filter(row => normalizeCoupangFulfillmentMethod(row.row.saleMethod) === method), deducted: new D(0) })).filter(segment => segment.rows.length);
      let remaining = q;
      for (const segment of segments) {
        let segmentDeduction = D.min(D.max(0, sum(segment.rows.map(row => row.normalQuantity.toFixed()))), remaining);
        segment.deducted = segmentDeduction; remaining = remaining.minus(segmentDeduction);
        for (const row of segment.rows) {
          const deduction = D.min(D.max(0, row.normalQuantity), segmentDeduction);
          row.excludedQuantity = deduction; row.normalQuantity = row.normalQuantity.minus(deduction); segmentDeduction = segmentDeduction.minus(deduction);
        }
      }
      const deducted = segments.filter(segment => segment.deducted.gt(0));
      for (const field of ["normalSales", "normalNet"] as const) {
        let left = manualSales!;
        const desired = deducted.map((segment, index) => {
          const value = index === deducted.length - 1 ? left : manualSales!.mul(segment.deducted).div(q);
          left = left.minus(value); return value;
        });
        let shortfall = new D(0);
        deducted.forEach((segment, index) => {
          const available = D.max(0, sum(segment.rows.map(row => row[field]!.toFixed())));
          if (desired[index].gt(available)) { shortfall = shortfall.plus(desired[index].minus(available)); desired[index] = available; }
        });
        deducted.forEach((segment, index) => {
          const available = sum(segment.rows.map(row => row[field]!.toFixed()));
          const extra = D.min(D.max(0, available.minus(desired[index])), shortfall);
          desired[index] = desired[index].plus(extra); shortfall = shortfall.minus(extra);
        });
        if (shortfall.gt(0)) desired[desired.length - 1] = desired[desired.length - 1].plus(shortfall);
        deducted.forEach((segment, index) => {
          const targets = segment.rows.filter(row => row.excludedQuantity.gt(0));
          let residual = desired[index];
          targets.forEach((row, rowIndex) => {
            const deduction = rowIndex === targets.length - 1 ? residual : desired[index].mul(row.excludedQuantity).div(segment.deducted);
            residual = residual.minus(deduction); row[field] = row[field]!.minus(deduction);
            if (field === "normalNet") row.excludedSales = deduction;
          });
        });
      }
    }
    const vendorAmount = q.isZero() ? "0.000000" : vendor === null ? null : amount(vendor);
    const vendorComplete = q.isZero() || !salesBlocked && total !== null && vendor !== null && total.toDecimalPlaces(2).eq(vendor.toDecimalPlaces(2));
    const productName = name.matchStatus === "MATCHED" && !ambiguousUnit ? name.canonicalProductName : null;
    manualFacts.push({ ref: { sourceSystem: "COUPANG_SALES", platform: "COUPANG", schema: "meta_ads", table: "coupang_manual_purchases",
      scopeKey: input.scopeKey, recordKind: "MANUAL_PURCHASE_ADJUSTMENT", sourceRecordKey: manual.id, selectedSource: "REGISTERED_MANUAL_PURCHASE",
      sourceVersion: hash([input.sourceVersion, manual]), uploadOrRunId: null, payloadHash: hash(manual), providerUpdatedAt: manual.updatedAt ?? null,
      observedAt: input.observedAt, businessDate: input.date, dateBasis: "purchase_date", sourceTimeZone: "Asia/Seoul" }, name, productName,
      marketplace: "COUPANG", saleUnitName: name.saleUnitName, optionName: manual.optionName ?? null,
      orderedQuantity: q.toFixed(), calculationQuantity: "0", unitsPerSaleUnit: null, physicalQuantity: null,
      quantityBasis: "MANUAL_PURCHASE_VENDOR_FEE_ONLY", operatingRevenue: "0.000000", revenueBasis: "NET_SALES_REPORTED",
      collectedPaymentAmount: null, paymentGrain: "NOT_ORDER_GRAIN", paymentAllocationStatus: "NOT_APPLICABLE",
      discountTreatment: "NOT_APPLICABLE", refundTreatment: "MANUAL_SALES_EXCLUDED_FROM_REPORTED_ROWS",
      productCost: "0.000000", platformFee: "0.000000", directShippingCost: "0.000000", returnCost: "0.000000", otherDirectCost: "0.000000",
      vatExpense: "0.000000", discountNotYetIncluded: "0.000000", manualVendorFee: vendorAmount,
      costRuleRef: manual.id, costEffectiveFrom: input.date, costEffectiveTo: input.date, costBasisVersion: "coupang-normal-v1",
      taxPolicyVersion: "coupang-net-div11-v1", feeBasis: "MANUAL_VENDOR_SNAPSHOT_TOTAL", feePresenceMask: vendorComplete ? "COMPLETE" : "INCOMPLETE",
      shippingBasis: "EXCLUDED_FROM_NORMAL_QUANTITY_NO_SECOND_COST", dateBasis: "purchase_date",
      costComponents: [{ kind: "MANUAL_VENDOR_FEE", sourceExpenseKey: `manual:${manual.id}:vendor`, amount: vendorAmount, includedInRevenue: false, applied: true },
        { kind: "MANUAL_SALES_EXCLUSION", sourceExpenseKey: `manual:${manual.id}:sales`, amount: manualSales === null ? null : amount(manualSales), includedInRevenue: true, applied: false }],
      profitBeforeAds: vendorComplete && vendorAmount !== null ? amount(money(vendorAmount).negated()) : null,
      quality: { isEstimate: true, confidence: "ESTIMATED", issues: unique(issues) } });
  }
  const facts = rows.map(({ row, name, rule, issues, normalQuantity: q, normalNet: net, excludedQuantity, excludedSales, invalidManual }): SaleFact => {
    const activity = !q.isZero() || net !== null && !net.isZero();
    const component = (value: string | null | undefined) => !activity || q.isZero() ? "0.000000" : optional(value) === null ? null : amount(optional(value)!.mul(q));
    const productCost = component(rule?.productCostKrw), other = component(rule?.extraCostKrw);
    const method = normalizeCoupangFulfillmentMethod(row.saleMethod);
    const seller = method === "SELLER" ? component(rule?.sellerShippingFeeKrw) : "0.000000";
    const hanaro = method === "GROWTH" ? component(rule?.hanaroShippingFeeKrw) : "0.000000";
    const inbound = method === "GROWTH" ? component(rule?.growthInboundFeeKrw) : "0.000000";
    const growth = method === "GROWTH" ? component(rule?.growthShippingFeeKrw) : "0.000000";
    const shipping = [seller, hanaro, inbound, growth].some(value => value === null) ? null : amount(sum([seller!, hanaro!, inbound!, growth!]));
    const returnRate = optional(rule?.returnRate, "ratio"), returnUnit = optional(rule?.returnCostPerUnitKrw);
    const returns = q.isZero() ? "0.000000" : returnRate === null || returnUnit === null ? null : amount(q.mul(returnRate).mul(returnUnit));
    const platformFee = net === null || fee === null ? null : amount(net.mul(fee));
    const vat = net === null ? null : amount(net.div(11));
    if (fee === null) issues.push(feeCandidates.length > 1 ? "COUPANG_GLOBAL_SALES_FEE_RATE_AMBIGUOUS" : "COUPANG_GLOBAL_SALES_FEE_RATE_MISSING");
    if (productCost === null) issues.push("PRODUCT_COST_MISSING");
    if (shipping === null) issues.push(method === "SELLER" ? "SELLER_SHIPPING_FEE_MISSING" : "GROWTH_LOGISTICS_COST_MISSING");
    if (returns === null) issues.push("RETURN_COST_MISSING");
    if (other === null) issues.push("OTHER_DIRECT_COST_MISSING");
    const costs = [productCost, platformFee, shipping, returns, other, vat];
    const profit = invalidManual || net === null || costs.some(value => value === null) ? null : amount(net.minus(sum(costs as string[])));
    const physical = rule?.unitsPerSaleUnit == null ? null : quantity(rule.unitsPerSaleUnit).mul(q);
    return { ref: { sourceSystem: "COUPANG_SALES", platform: "COUPANG", schema: "meta_ads", table: "coupang_sale_lines", scopeKey: input.scopeKey,
      recordKind: "SALE", sourceRecordKey: row.saleLineKey, selectedSource: "LEGACY_COUPANG_SINGLE_UPLOAD", sourceVersion: row.sourceVersion,
      uploadOrRunId: row.uploadBatchId, payloadHash: hash(row), providerUpdatedAt: row.updatedAt ?? null,
      observedAt: row.observedAt, businessDate: input.date, dateBasis: "sale_date", sourceTimeZone: "Asia/Seoul" }, name,
      productName: name.matchStatus === "MATCHED" ? name.canonicalProductName : null, marketplace: "COUPANG", saleUnitName: name.saleUnitName,
      optionName: row.optionName, orderedQuantity: row.salesQuantity, calculationQuantity: invalidManual ? row.salesQuantity : q.toFixed(),
      unitsPerSaleUnit: rule?.unitsPerSaleUnit ?? null, physicalQuantity: physical?.toFixed() ?? null,
      quantityBasis: `DAILY_AGGREGATE_SALE_UNITS:${method}:orders=${row.orderCount}`, operatingRevenue: net === null ? null : amount(net),
      revenueBasis: "NET_SALES_REPORTED", collectedPaymentAmount: null, paymentGrain: "NOT_ORDER_GRAIN", paymentAllocationStatus: "NOT_APPLICABLE",
      discountTreatment: "ALREADY_INCLUDED_IN_REPORTED_NET", refundTreatment: "CANCELLATION_ALREADY_INCLUDED_NO_SECOND_DEDUCTION",
      productCost, platformFee, directShippingCost: shipping, returnCost: returns, otherDirectCost: other, vatExpense: vat,
      discountNotYetIncluded: "0.000000", manualVendorFee: "0.000000", costRuleRef: rule?.id ?? null,
      costEffectiveFrom: rule?.from ?? null, costEffectiveTo: rule?.to ?? null, costBasisVersion: "coupang-normal-v1",
      taxPolicyVersion: "coupang-net-div11-v1", feeBasis: `NORMAL_NET_TIMES_GLOBAL_RATE:${feeCandidates.length === 1 ? feeCandidates[0].id : "MISSING"}`,
      feePresenceMask: fee === null ? "MISSING" : "GLOBAL_RATE", shippingBasis: `${method}:${row.saleMethod ?? "DEFAULT_SELLER"}`, dateBasis: "sale_date",
      costComponents: [
        { kind: "REPORTED_SALES", sourceExpenseKey: `${row.saleLineKey}:reported`, amount: amount(money(row.salesKrw)), includedInRevenue: true, applied: false },
        { kind: "REPORTED_NET_SALES", sourceExpenseKey: `${row.saleLineKey}:reported-net`, amount: amount(money(row.netSalesKrw)), includedInRevenue: true, applied: false },
        { kind: "CANCELLATION_ALREADY_INCLUDED", sourceExpenseKey: `${row.saleLineKey}:cancel`, amount: amount(money(row.cancelAmountKrw)), includedInRevenue: true, applied: false },
        { kind: "MANUAL_SALES_EXCLUSION", sourceExpenseKey: `${row.saleLineKey}:manual`, amount: invalidManual ? null : amount(excludedSales), includedInRevenue: true, applied: false },
        { kind: "MANUAL_QUANTITY_EXCLUSION", sourceExpenseKey: `${row.saleLineKey}:manual-quantity`, amount: invalidManual ? null : amount(excludedQuantity), includedInRevenue: true, applied: false },
        ...([["PRODUCT_COST", productCost], ["PLATFORM_FEE", platformFee], ["SELLER_SHIPPING", seller], ["HANARO_SHIPPING", hanaro],
          ["GROWTH_INBOUND", inbound], ["GROWTH_SHIPPING", growth], ["RETURN_COST", returns], ["OTHER_DIRECT_COST", other], ["VAT_EXPENSE", vat]] as const)
          .map(([kind, value]) => ({ kind, sourceExpenseKey: `${row.saleLineKey}:${kind}`, amount: value, includedInRevenue: false, applied: true }))
      ], profitBeforeAds: profit, quality: { isEstimate: true, confidence: "ESTIMATED", issues: unique(issues) } };
  });
  // Six-place storage is reconciled at the product/unit/day accounting grain used by
  // the old pipeline. Row rounding must not change a product's preserved total.
  const rounding = new Map<string, Prisma.Decimal>();
  const factsByKey = new Map(facts.map(fact => [fact.ref.sourceRecordKey, fact]));
  for (const group of groups.values()) {
    const groupedFacts = group.map(row => factsByKey.get(row.row.saleLineKey)!);
    const exact = (state: ResolvedRow, field: "productCost" | "platformFee" | "directShippingCost" | "returnCost" | "otherDirectCost" | "vatExpense") => {
      const q = state.normalQuantity, rule = state.rule;
      const c = (value: string | null | undefined) => q.isZero() ? new D(0) : optional(value)?.mul(q) ?? null;
      if (field === "vatExpense") return state.normalNet?.div(11) ?? null;
      if (field === "platformFee") return state.normalNet !== null && fee !== null ? state.normalNet.mul(fee) : null;
      if (field === "productCost") return c(rule?.productCostKrw);
      if (field === "otherDirectCost") return c(rule?.extraCostKrw);
      if (field === "returnCost") {
        const rate = optional(rule?.returnRate, "ratio"), unit = optional(rule?.returnCostPerUnitKrw);
        return q.isZero() ? new D(0) : rate === null || unit === null ? null : rate.mul(unit).mul(q);
      }
      if (normalizeCoupangFulfillmentMethod(state.row.saleMethod) === "SELLER") return c(rule?.sellerShippingFeeKrw);
      const logistics = [c(rule?.hanaroShippingFeeKrw), c(rule?.growthInboundFeeKrw), c(rule?.growthShippingFeeKrw)];
      return logistics.some(value => value === null) ? null : logistics.reduce<Prisma.Decimal>((acc, value) => acc.plus(value!), new D(0));
    };
    for (const field of ["productCost", "platformFee", "directShippingCost", "returnCost", "otherDirectCost", "vatExpense"] as const) {
      const known = group.map((state, index) => ({ fact: groupedFacts[index], value: exact(state, field) }))
        .filter((item): item is { fact: SaleFact; value: Prisma.Decimal } => item.fact[field] !== null && item.value !== null && item.value.isFinite());
      if (!known.length) continue;
      const exactTotal = known.reduce((acc, item) => acc.plus(item.value), new D(0));
      let residual = money(amount(exactTotal)).minus(sum(known.map(item => item.fact[field]!)));
      rounding.set(field, (rounding.get(field) ?? new D(0)).plus(residual));
      known.sort((a, b) => (residual.isNegative() ? a.value.minus(a.fact[field]!).cmp(b.value.minus(b.fact[field]!)) :
        b.value.minus(b.fact[field]!).cmp(a.value.minus(a.fact[field]!))) || a.fact.ref.sourceRecordKey.localeCompare(b.fact.ref.sourceRecordKey));
      for (const { fact } of known) {
        if (residual.isZero()) break;
        const change = residual.isNegative() ? "-0.000001" : "0.000001";
        fact[field] = amount(money(fact[field]!).plus(change)); residual = residual.minus(change);
        const kind = field === "productCost" ? "PRODUCT_COST" : field === "platformFee" ? "PLATFORM_FEE" : field === "returnCost" ? "RETURN_COST" :
          field === "otherDirectCost" ? "OTHER_DIRECT_COST" : field === "vatExpense" ? "VAT_EXPENSE" :
            fact.shippingBasis.startsWith("SELLER:") ? "SELLER_SHIPPING" : "GROWTH_SHIPPING";
        const component = fact.costComponents.find(component => component.kind === kind);
        if (component?.amount !== null && component) component.amount = amount(money(component.amount).plus(change));
      }
      if (!residual.isZero()) throw new Error("Unresolved Coupang component rounding residual.");
    }
  }
  for (const fact of facts) if (fact.profitBeforeAds !== null) fact.profitBeforeAds = amount(money(fact.operatingRevenue!).minus(
    sum([fact.productCost!, fact.platformFee!, fact.directShippingCost!, fact.returnCost!, fact.otherDirectCost!, fact.vatExpense!])));
  const sales = [...facts, ...manualFacts];
  const fingerprint = hash([input.scopeKey, input.date, input.sourceVersion, request.nameRuleVersion, request.saleUnitRuleVersion,
    request.calculationVersion, input.complete, input.collectedAt, input.excludedByPolicyRows, [...input.sourceIssues].sort(), rows.map(row => row.row),
    [...input.configuration.products].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)),
    [...input.configuration.nameRules].sort((a, b) => a.id.localeCompare(b.id)),
    [...input.costRules].sort((a, b) => a.id.localeCompare(b.id)), [...input.salesFeeRules].sort((a, b) => a.id.localeCompare(b.id)),
    [...input.manualPurchases].sort((a, b) => a.id.localeCompare(b.id))]);
  const controls: ControlTotal[] = [];
  for (const [measure, field] of [["OPERATING_REVENUE", "operatingRevenue"], ["PRODUCT_COST", "productCost"], ["DIRECT_SHIPPING_COST", "directShippingCost"],
    ["OTHER_DIRECT_COST", "otherDirectCost"], ["VAT_EXPENSE", "vatExpense"], ["PLATFORM_FEE", "platformFee"], ["RETURN_COST", "returnCost"],
    ["MANUAL_VENDOR_FEE", "manualVendorFee"]] as const) {
    const known = sales.filter(sale => sale[field] !== null);
    const available = known.length > 0 || input.complete && sales.length === 0;
    const selected = available ? amount(sum(known.map(sale => sale[field]!))) : null;
    const assigned = available ? amount(sum(known.filter(sale => sale.productName !== null).map(sale => sale[field]!))) : null;
    const unmatched = available ? amount(sum(known.filter(sale => sale.productName === null).map(sale => sale[field]!))) : null;
    controls.push({ measure, sourceSystem: "COUPANG_SALES", platform: "COUPANG", scopeKey: input.scopeKey, date: input.date, currency: "KRW",
      selectedRows: sales.length, selectedAmount: selected, assignedAmount: assigned, unmatchedAmount: unmatched, unallocatedAmount: available ? "0.000000" : null,
      excludedNonSaleAmount: measure === "OPERATING_REVENUE" ? amount(sum(facts.flatMap(sale => sale.costComponents.filter(c => c.kind === "MANUAL_SALES_EXCLUSION" && c.amount !== null).map(c => c.amount!)))) : "0.000000",
      excludedByPolicyRows: input.excludedByPolicyRows, roundingAdjustment: amount(rounding.get(field) ?? new D(0)), difference: available ? amount(money(selected!).minus(assigned!).minus(unmatched!)) : null });
  }
  const unmatchedRevenue = controls[0].unmatchedAmount;
  const missing = sales.filter(sale => sale.profitBeforeAds === null).length;
  const baseCoverage: SourceCoverage = { sourceSystem: "COUPANG_SALES", platform: "COUPANG", component: "SALE", scopeKey: input.scopeKey,
    date: input.date, participation: "INCLUDED", collectionState: input.complete ? "COMPLETE" : input.rows.length || input.manualPurchases.length ? "PARTIAL" : "NOT_COLLECTED",
    rowsPresent: sales.length, zeroConfirmed: input.complete && sales.length === 0, selectedSource: "LEGACY_COUPANG_SINGLE_UPLOAD",
    selectedUploadId: input.rows.length && unique(input.rows.map(row => row.uploadBatchId)).length === 1 ? input.rows[0].uploadBatchId : null,
    sourceVersion: input.sourceVersion, collectedAt: input.collectedAt, sourceAsOf: input.collectedAt, calculatedAt: input.observedAt,
    lastSuccessAt: input.collectedAt, sourceFingerprint: fingerprint, nameRuleVersion: request.nameRuleVersion,
    costRuleVersion: request.saleUnitRuleVersion, mappedRows: sales.filter(sale => sale.productName !== null).length,
    unmappedRows: sales.filter(sale => sale.productName === null).length, unmatchedAmount: unmatchedRevenue, missingCostRows: missing,
    missingFxAmount: null, unallocatedAmount: "0.000000", quality: { isEstimate: true, confidence: "ESTIMATED",
      issues: unique([...input.sourceIssues, ...sales.flatMap(sale => sale.quality.issues)]) } };
  const batch: AdapterBatch = { sales, adSpends: [], commonExpenses: [], coverage: [baseCoverage, { ...baseCoverage, component: "DIRECT_COST" }],
    sourceControlTotals: controls, sourceFingerprint: fingerprint, nextCursor: null };
  assertAdapterBatch(request, "COUPANG", batch); return batch;
}
