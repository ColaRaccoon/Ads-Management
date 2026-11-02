import { createHash } from "node:crypto";
import { assertAdapterBatch, assertOffsetTimestamp } from "../adapter-contract";
import { money, quantity, quantizeMoney, ExactDecimal as D } from "../domain/decimal";
import { resolveProductName } from "../domain/product-name-resolver";
import type { AdapterBatch, AdapterRequest, ControlTotal, Quality, SaleFact, SourceCoverage, SourceRef } from "../types";
import type { AdConfiguration } from "./ad-source";
import { naverPageDate, naverTimestamp, type NaverProjectedRow, type NaverStoredRaw, type NaverStoredErrors } from "./naver-reader";

const VERSION = "NAVER_STORED_NATIVE_V1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const amount = (value: unknown): string | null => { try { return quantizeMoney(money(value)); } catch { return null; } };
const sum = (values: readonly string[]) => quantizeMoney(values.reduce((total, value) => total.plus(value), new D(0)));
const plus = (a: string | null, b: string | null) => a === null || b === null ? null : quantizeMoney(money(a).plus(b));
const quality = (issues: readonly string[]): Quality => ({ isEstimate: true, confidence: "ESTIMATED", issues: unique(["NAVER_STORED_NATIVE_SOURCE", ...issues]) });

/** Native profit-v2 already includes its ads, VAT, fees and costs. Never recost it. */
export function normalizeNaverStoredDay(request: AdapterRequest, raw: NaverStoredRaw, errors: NaverStoredErrors,
  configuration: AdConfiguration, observedAt: string): AdapterBatch {
  const date = naverPageDate(request), scopeKey = request.scopeKeys[0]; assertOffsetTimestamp(observedAt);
  const summary = raw.daily_store_summaries.length === 1 ? raw.daily_store_summaries[0] : undefined;
  const topRows = raw.daily_sales_unit_profits.filter(row => !row.parentSalesUnitId);
  const sorted = (rows: NaverProjectedRow[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id, "en"));
  const fingerprint = hash([VERSION, date, scopeKey, sorted(raw.daily_store_summaries), sorted(raw.daily_sales_unit_profits),
    sorted(raw.daily_fake_purchases), errors, request.nameRuleVersion, request.scopePolicyVersion, request.saleUnitRuleVersion,
    request.allocationRuleVersion, request.calculationVersion]);
  const fatal = Object.values(errors).flat();
  if (!summary) fatal.push(raw.daily_store_summaries.length ? "NAVER_STORED_SUMMARY_DUPLICATE" : "NAVER_STORED_SUMMARY_MISSING");
  if (summary && summary.calculationVersion !== "profit-v2" || topRows.some(row => row.calculationVersion !== "profit-v2")) fatal.push("NAVER_STORED_VERSION_MISMATCH");
  for (const row of [...raw.daily_store_summaries, ...raw.daily_sales_unit_profits, ...raw.daily_fake_purchases])
    if (row.storeId !== scopeKey || row.date !== date) fatal.push("NAVER_STORED_SCOPE_DATE_MISMATCH");
  if (raw.daily_fake_purchases.length > 1 || new Set(topRows.map(row => row.canonicalSalesUnitId ?? row.id)).size !== topRows.length ||
    new Set(raw.daily_sales_unit_profits.map(row => row.id)).size !== raw.daily_sales_unit_profits.length) fatal.push("NAVER_STORED_ROW_DUPLICATE");
  if ([raw.daily_store_summaries, raw.daily_sales_unit_profits, raw.daily_fake_purchases].some(rows => rows.length > request.limit)) fatal.push("NAVER_STORED_DAY_TOO_LARGE");
  if (summary && !topRows.length && ![summary.totalProductRevenue, summary.totalAdCost, summary.estimatedNetProfit, summary.totalVatAmount]
    .every(value => amount(value) !== null && money(amount(value)!).isZero())) fatal.push("NAVER_STORED_FINANCIAL_ROWS_MISSING");
  const check = (key: string, target: unknown, values: unknown[]) => {
    const expected = amount(target), amounts = values.map(amount);
    if (expected !== null && amounts.every((value): value is string => value !== null) && sum(amounts) !== expected) fatal.push(`NAVER_STORED_${key}_MISMATCH`);
  };
  if (summary) {
    check("REVENUE", summary.totalProductRevenue, topRows.map(row => row.totalProductRevenue));
    check("ADS", summary.totalAdCost, topRows.map(row => row.totalAdCost));
    check("VAT", summary.totalVatAmount, topRows.map(row => row.vatAmount));
    const income = amount(summary.customerPaidDeliveryFee), cost = amount(summary.estimatedDeliveryBaseCost);
    const delivery = income === null || cost === null ? null : quantizeMoney(money(income).minus(cost));
    if (delivery !== null && amount(summary.deliveryMargin) !== null && delivery !== amount(summary.deliveryMargin)) fatal.push("NAVER_STORED_DELIVERY_MISMATCH");
    if (amount(summary.estimatedNetProfit) === null && topRows.every(row => amount(row.estimatedNetProfit) !== null)) fatal.push("NAVER_STORED_NET_MISMATCH");
    if (delivery !== null) check("NET", summary.estimatedNetProfit, [...topRows.map(row => row.estimatedNetProfit), delivery]);
  }
  const sourceIssues = unique(fatal);
  const calculatedAt = naverTimestamp(summary?.calculatedAt) ?? naverTimestamp(summary?.updatedAt) ?? observedAt;
  const coverage = (component: SourceCoverage["component"], rows: number, available: boolean, issues: string[], missingCostRows = 0): SourceCoverage => ({
    sourceSystem: "NAVER_SMARTSTORE", platform: "NAVER", component, scopeKey, date, participation: "INCLUDED",
    collectionState: available ? "COMPLETE" : rows ? "PARTIAL" : "NOT_COLLECTED", rowsPresent: rows,
    zeroConfirmed: available && rows === 0, selectedSource: "NAVER_STORED_PROFIT_V2", selectedUploadId: null,
    sourceVersion: fingerprint, sourceFingerprint: fingerprint, collectedAt: calculatedAt, sourceAsOf: calculatedAt,
    calculatedAt, lastSuccessAt: calculatedAt, nameRuleVersion: request.nameRuleVersion, costRuleVersion: request.saleUnitRuleVersion,
    mappedRows: 0, unmappedRows: 0, unmatchedAmount: null, missingCostRows, missingFxAmount: "0.000000", unallocatedAmount: null, quality: quality(issues) });
  const next = new Date(Date.parse(date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  const batch: AdapterBatch = { sales: [], adSpends: [], commonExpenses: [], coverage: [], sourceControlTotals: [], sourceFingerprint: fingerprint, nextCursor: next <= request.to ? next : null };
  if (sourceIssues.length) {
    batch.coverage = ["SALE", "AD_SPEND", "COMMON_EXPENSE"].map(component => coverage(component as SourceCoverage["component"], 0, false, [...sourceIssues, "NAVER_STORED_NORMALIZATION_FAILED"]));
    assertAdapterBatch(request, "NAVER", batch); return batch;
  }
  const commonIssues: string[] = [], saleIssues: string[] = [], adIssues: string[] = [];
  if (!naverTimestamp(summary!.calculatedAt)) saleIssues.push("NAVER_STORED_CALCULATION_TIME_FALLBACK");
  if (topRows.length !== raw.daily_sales_unit_profits.length) saleIssues.push("NAVER_STORED_CHILD_ROW_EXCLUDED");
  const ref = (row: NaverProjectedRow, table: string, kind: string): SourceRef => ({ sourceSystem: "NAVER_SMARTSTORE", platform: "NAVER", schema: "public", table,
    scopeKey, recordKind: kind, sourceRecordKey: `${row.id}:${kind}`, selectedSource: "NAVER_STORED_PROFIT_V2", sourceVersion: fingerprint, uploadOrRunId: null,
    payloadHash: hash(row), providerUpdatedAt: naverTimestamp(row.updatedAt), observedAt, businessDate: date, dateBasis: "stored_date", sourceTimeZone: "Asia/Seoul" });
  for (const row of topRows) {
    const nativeName = typeof row.displayName === "string" ? row.displayName : null;
    let name = resolveProductName({ originalName: nativeName, nameField: "displayName", restorationPath: "public.daily_sales_unit_profits.displayName",
      platform: "NAVER", scopeKey, businessDate: date }, configuration.products, configuration.nameRules, request.nameRuleVersion);
    if (name.matchStatus === "UNMATCHED" && nativeName?.trim()) name = { ...name, canonicalProductName: nativeName, candidateNames: [nativeName], matchStatus: "MATCHED", reasons: ["NAVER_NATIVE_STORED_NAME_VERIFIED"] };
    name = { ...name, nameInputHash: hash([VERSION, name.nameInputHash]), reasons: [...name.reasons, "NAVER_NATIVE_STORED_NAME_VERIFIED"] };
    const revenue = amount(row.totalProductRevenue), ad = amount(row.totalAdCost), net = amount(row.estimatedNetProfit);
    const beforeAds = plus(net, ad), rowIssues = [...saleIssues, ...(name.matchStatus === "MATCHED" ? [] : [`NAME_${name.matchStatus}`])];
    if (beforeAds === null) rowIssues.push("NAVER_STORED_PROFIT_UNAVAILABLE");
    let q = "0"; try { q = quantity(row.totalQuantity).toFixed(); } catch { rowIssues.push("NAVER_STORED_QUANTITY_UNAVAILABLE"); }
    const sale: SaleFact = { ref: ref(row, "daily_sales_unit_profits", "STORED_PRODUCT_PROFIT"), name, productName: row.isStoreLevel === true ? null : name.matchStatus === "MATCHED" ? name.canonicalProductName : null,
      marketplace: "NAVER_SMARTSTORE", saleUnitName: nativeName, optionName: null, orderedQuantity: q, calculationQuantity: q, unitsPerSaleUnit: null,
      physicalQuantity: null, quantityBasis: "NATIVE_STORED_SALES_UNIT_QUANTITY", operatingRevenue: revenue, collectedPaymentAmount: revenue,
      revenueBasis: "PRODUCT_PAYMENT_AMOUNT", paymentGrain: "STORED_SALES_UNIT_DAY", paymentAllocationStatus: "NATIVE_STORED_AMOUNT",
      discountTreatment: "NATIVE_STORED_RESULT", refundTreatment: "NATIVE_STORED_RESULT", productCost: amount(row.totalUnitCost), platformFee: amount(row.totalFeeCost),
      directShippingCost: "0.000000", returnCost: "0.000000", otherDirectCost: amount(row.totalOtherCost), vatExpense: amount(row.vatAmount),
      discountNotYetIncluded: "0.000000", manualVendorFee: "0.000000", costRuleRef: null, costEffectiveFrom: null, costEffectiveTo: null,
      costBasisVersion: "NAVER_STORED_PROFIT_V2", taxPolicyVersion: "NATIVE_STORED_VAT", feeBasis: "NATIVE_STORED_FEE", feePresenceMask: "STORED",
      shippingBasis: "STORE_SUMMARY_ONCE", dateBasis: "stored_date", costComponents: [], profitBeforeAds: beforeAds, quality: quality(rowIssues) };
    sale.costComponents = [["PRODUCT_COST", sale.productCost], ["PLATFORM_FEE", sale.platformFee], ["OTHER_DIRECT_COST", sale.otherDirectCost], ["VAT_EXPENSE", sale.vatExpense]]
      .map(([kind, value]) => ({ kind: kind!, amount: value, sourceExpenseKey: `${scopeKey}:${row.id}:${kind}`, includedInRevenue: false, applied: value !== null }));
    batch.sales.push(sale);
    if (ad === null) adIssues.push("NAVER_AD_AMOUNT_INVALID", "NAVER_STORED_AD_UNAVAILABLE");
    else batch.adSpends.push({ ref: ref(row, "daily_sales_unit_profits", "AD_SPEND"), name, productName: sale.productName, medium: "NAVER_DA", originalAmount: ad,
      currency: "KRW", amountKrw: ad, fx: { baseCurrency: "KRW", quoteCurrency: "KRW", requestedDate: date, sourceDate: date, rate: "1", provider: "IDENTITY", fallbackType: "IDENTITY", fxVersion: request.fxVersion },
      roundingAdjustment: "0.000000", preQuantizationFingerprint: hash([VERSION, ad]), attribution: sale.productName ? "DIRECT" : "UNALLOCATED", allocationRuleVersion: request.allocationRuleVersion,
      referenceConversionRevenue: null, quality: quality(rowIssues) });
  }
  const addCommon = (row: NaverProjectedRow, table: string, kind: "SHIPPING_INCOME" | "SHIPPING_COST" | "FAKE_PURCHASE", value: unknown) => {
    const normalized = amount(value);
    if (normalized === null) { commonIssues.push(kind === "SHIPPING_INCOME" ? "NAVER_DELIVERY_INCOME_MISSING" : kind === "SHIPPING_COST" ? "NAVER_DELIVERY_COST_MISSING" : "NAVER_FAKE_PURCHASE_AMOUNT_INVALID"); return; }
    const expenseKey = `${scopeKey}:${date}:${row.id}:${kind}`;
    batch.commonExpenses.push({ ref: ref(row, table, kind), expenseKey, kind, amountKrw: normalized, scopeKey, productName: null,
      allocationStatus: "UNALLOCATED", allocationRuleVersion: request.allocationRuleVersion, originalAmount: normalized, unallocatedAmount: normalized, quality: quality([]) });
  };
  addCommon(summary!, "daily_store_summaries", "SHIPPING_INCOME", summary!.customerPaidDeliveryFee);
  addCommon(summary!, "daily_store_summaries", "SHIPPING_COST", summary!.estimatedDeliveryBaseCost);
  for (const fake of raw.daily_fake_purchases) addCommon(fake, "daily_fake_purchases", "FAKE_PURCHASE", fake.amount);
  const missingCosts = batch.sales.filter(row => row.profitBeforeAds === null).length;
  batch.coverage = [coverage("SALE", batch.sales.length, true, saleIssues, missingCosts), coverage("AD_SPEND", batch.adSpends.length, !adIssues.length, adIssues),
    coverage("COMMON_EXPENSE", batch.commonExpenses.length, !commonIssues.length, commonIssues)];
  const saleCoverage = batch.coverage[0]; saleCoverage.mappedRows = batch.sales.filter(row => row.productName !== null).length;
  saleCoverage.unmappedRows = batch.sales.length - saleCoverage.mappedRows;
  const control = (measure: ControlTotal["measure"], selected: unknown, values: Array<{ productName: string | null; value: string | null }>): ControlTotal => {
    const known = values.filter((row): row is { productName: string | null; value: string } => row.value !== null), assigned = sum(known.filter(row => row.productName !== null).map(row => row.value)), unmatched = sum(known.filter(row => row.productName === null).map(row => row.value));
    const selectedAmount = amount(selected);
    return { measure, sourceSystem: "NAVER_SMARTSTORE", platform: "NAVER", scopeKey, date, currency: "KRW", selectedRows: values.length, selectedAmount,
      assignedAmount: assigned, unmatchedAmount: unmatched, unallocatedAmount: "0.000000", excludedNonSaleAmount: "0.000000", excludedByPolicyRows: 0,
      roundingAdjustment: "0.000000", difference: selectedAmount === null || known.length !== values.length ? null : quantizeMoney(money(selectedAmount).minus(assigned).minus(unmatched)) };
  };
  batch.sourceControlTotals = [control("OPERATING_REVENUE", summary!.totalProductRevenue, batch.sales.map(row => ({ productName: row.productName, value: row.operatingRevenue }))),
    control("AD_SPEND", summary!.totalAdCost, batch.sales.map((row, index) => ({ productName: row.productName, value: amount(topRows[index].totalAdCost) }))),
    control("VAT_EXPENSE", summary!.totalVatAmount, batch.sales.map(row => ({ productName: row.productName, value: row.vatExpense })))];
  assertAdapterBatch(request, "NAVER", batch); return batch;
}
