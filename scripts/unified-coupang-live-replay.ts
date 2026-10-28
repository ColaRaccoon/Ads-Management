import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { ExactDecimal as D, quantizeMoney } from "../apps/api/src/unified-performance/domain/decimal";
import { normalizeCoupangAdsDay, COUPANG_UPLOAD_SCOPE } from "../apps/api/src/unified-performance/adapters/coupang-ads";
import { normalizeCoupangSalesDay } from "../apps/api/src/unified-performance/adapters/coupang-sales";
import { coupangConfiguration, coupangProductIdentity } from "../apps/api/src/unified-performance/adapters/coupang-configuration";
import { CONTRACT_VERSION, type AdapterRequest, type AdapterBatch, type SaleFact } from "../apps/api/src/unified-performance/types";
import { normalizeCoupangFulfillmentMethod } from "../apps/api/src/domain/coupang-profit-calculator";
import { aggregateReportedSalesByProductDate, aggregateManualPurchasesByProductDate, adjustReportedSalesForManualPurchase,
  calculateNormalCoupangProfit } from "../apps/api/src/domain/coupang-profit-pipeline";

type Raw = Record<string, any>;
type Receipt = { name: string; status: string; observedAt: string; rows: Raw };
const root = resolve("docs/product-performance/research");
const stem = resolve(root, "04-live-result-20261028.json");
const bytes = existsSync(`${stem}.gz`) ? gunzipSync(readFileSync(`${stem}.gz`)) : readFileSync(stem);
const capture = JSON.parse(bytes.toString("utf8")) as { rowsChanged: number; queries: Receipt[]; connectionMode: string };
assert.equal(capture.rowsChanged, 0); assert.equal(capture.queries.length, 68);
assert.equal(new Set(capture.queries.map(query => query.name)).size, 68);
for (const query of capture.queries) assert.equal(query.status, "SUCCESS", query.name);
const receipt = (name: string) => { const item = capture.queries.find(query => query.name === name); assert.ok(item, `Missing receipt ${name}`); return item; };
const rows = (name: string): Raw[] => { const value = receipt(name).rows; assert.ok(Array.isArray(value.rows));
  assert.equal(String(value.rows.length), value.row_count, `Envelope row count ${name}`); return value.rows; };
assert.equal(receipt("identity").rows.read_only, "on"); assert.equal(receipt("identity").rows.db, "postgres");
const products = rows("products"), rules = rows("rules"), costs = rows("costs"), fees = rows("fees"), manual = rows("manual"), batches = rows("batches");
rows("catalog");
const upload = new Map(batches.map(batch => [batch.id, batch]));
const sum = (values: readonly string[]) => values.reduce((total, value) => total.plus(value), new D(0));
const total = (values: readonly string[]) => quantizeMoney(sum(values));
const iso = (value: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`).toISOString();
const fields = ["operatingRevenue", "productCost", "platformFee", "directShippingCost", "returnCost", "otherDirectCost", "vatExpense", "manualVendorFee", "profitBeforeAds"] as const;
const req = (date: string): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: `replay:${date}`, readSnapshotId: "04-live-capture",
  from: date, to: date, scopeKeys: [COUPANG_UPLOAD_SCOPE], platforms: ["COUPANG"], sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null,
  limit: 10000, scopePolicyVersion: "legacy-single-upload-v1", nameRuleVersion: "legacy-name-observation-v1", saleUnitRuleVersion: "legacy-sale-unit-v1",
  allocationRuleVersion: "UNALLOCATED-v1", calculationVersion: "coupang-normal-v1", fxVersion: "KRW-IDENTITY" });
const days: Array<{ date: string; rawSales: Raw[]; rawAds: Raw[]; sales: Raw[]; ads: Raw[]; manual: Raw[]; batch: AdapterBatch;
  comparison: Raw; selectedSalesAmount: string; selectedCancelAmount: string; selectedNet: string; selectedQuantity: string }> = [];
const comparisons: Raw[] = [];
const skipped: Raw[] = [];

for (let date = "2026-09-27"; date <= "2026-10-26"; date = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10)) {
  const saleReceipt = receipt(`sales:${date}`), adReceipt = receipt(`ads:${date}`);
  const rawSales = rows(saleReceipt.name), rawAds = rows(adReceipt.name);
  const selected = (raw: Raw[], sourceType: string) => raw.filter(row => row.isCurrent && row.validationStatus !== "ERROR" &&
    upload.get(row.uploadBatchId)?.status === "IMPORTED" && upload.get(row.uploadBatchId)?.sourceType === sourceType);
  const sales = selected(rawSales, "SALES"), ads = selected(rawAds, "ADS"), manualDay = manual.filter(row => row.date === date);
  const config = coupangConfiguration({ date, scopeKey: COUPANG_UPLOAD_SCOPE, products: products as any, rules: rules as any, costs: costs as any,
    observedSales: [...sales, ...manualDay.map(row => ({ productName: row.productName ?? row.productDisplayName, optionName: row.optionName ?? row.ruleDisplayName ?? "" }))] as any,
    observedAds: ads as any });
  const saleCandidates = rawSales.filter(row => row.isCurrent), adCandidates = rawAds.filter(row => row.isCurrent);
  const latest = (selected: Raw[]) => selected.map(row => upload.get(row.uploadBatchId)?.importedAt).filter(Boolean).sort().at(-1);
  const saleBatch = normalizeCoupangSalesDay(req(date), { date, scopeKey: COUPANG_UPLOAD_SCOPE, observedAt: iso(saleReceipt.observedAt),
    collectedAt: latest(sales) ? iso(latest(sales)) : null, sourceVersion: createHash("sha256").update(JSON.stringify([rawSales, manualDay, config, fees])).digest("hex"),
    complete: sales.length > 0 && sales.length === saleCandidates.length, sourceIssues: saleCandidates.length !== sales.length ? ["COUPANG_CURRENT_SALES_WITHHELD"] : [],
    excludedByPolicyRows: rawSales.length - sales.length, rows: sales.map(row => ({ ...row, observedAt: iso(row.observedAt) })) as any,
    configuration: config, costRules: config.costRules, salesFeeRules: fees as any,
    manualPurchases: manualDay.map(row => ({ ...row, productName: row.productName ?? row.productDisplayName,
      optionName: row.optionName ?? row.ruleDisplayName, quantity: String(row.quantity), updatedAt: row.updatedAt ? iso(row.updatedAt) : null })) as any });
  const adBatch = normalizeCoupangAdsDay(req(date), { date, scopeKey: COUPANG_UPLOAD_SCOPE,
    complete: ads.length > 0 && ads.length === adCandidates.length, collectedAt: latest(ads) ? iso(latest(ads)) : null,
    excludedRows: rawAds.length - ads.length, unverifiedRows: adCandidates.length - ads.length, configuration: config,
    rows: ads.map(row => ({ ...row, observedAt: iso(row.observedAt), updatedAt: null })) as any });
  const normalizedSales = saleBatch.sales.filter(fact => fact.ref.recordKind === "SALE");
  const selectedNet = total(sales.map(row => row.netSalesKrw));
  const exclusion = total(normalizedSales.flatMap(fact => fact.costComponents.filter(component => component.kind === "MANUAL_SALES_EXCLUSION" && component.amount !== null).map(component => component.amount!)));
  if (normalizedSales.every(fact => fact.operatingRevenue !== null)) assert.equal(sum(normalizedSales.map(fact => fact.operatingRevenue!)).plus(exclusion).toFixed(6), selectedNet);
  assert.equal(total(ads.map(row => row.adSpendKrw)), total(adBatch.adSpends.map(fact => fact.amountKrw!)));
  for (const control of [...saleBatch.sourceControlTotals, ...adBatch.sourceControlTotals]) if (control.difference !== null) assert.equal(control.difference, "0.000000");

  // The legacy report groups by its stored mapping. Use those IDs solely as a comparator, never for adapter classification.
  const reports = aggregateReportedSalesByProductDate(sales.filter(row => row.legacyProductId).map(row => ({ productId: row.legacyProductId,
    productName: products.find(product => product.id === row.legacyProductId)?.standardName, date, salesKrw: Number(row.salesKrw),
    cancelAmountKrw: Number(row.cancelAmountKrw), netSalesKrw: Number(row.netSalesKrw), salesQuantity: Number(row.salesQuantity),
    orderCount: row.orderCount, saleMethod: row.saleMethod })));
  const manualReports = aggregateManualPurchasesByProductDate(manualDay.map(row => ({ productId: row.legacyProductId ?? row.productId, date, quantity: Number(row.quantity),
    salesAmountKrw: row.salesAmountKrw === null ? null : Number(row.salesAmountKrw), baseSalePriceKrw: row.baseSalePriceKrw === null ? null : Number(row.baseSalePriceKrw),
    vendorFeeKrw: row.vendorFeeTotalKrw === null ? null : Number(row.vendorFeeTotalKrw), totalCostKrw: row.totalCostKrw === null ? null : Number(row.totalCostKrw) })));
  let matchedGroups = 0, matchedRows = 0;
  const dateComparisons: Raw[] = [];
  for (const [legacyKey, report] of reports) {
    const legacyProduct = products.find(product => product.id === report.productId)!;
    const identity = coupangProductIdentity(legacyProduct.standardName);
    const legacyRows = sales.filter(row => row.legacyProductId === report.productId);
    const facts = normalizedSales.filter(fact => legacyRows.some(row => row.saleLineKey === fact.ref.sourceRecordKey));
    const costHistory = costs.filter(cost => cost.productId === report.productId && cost.from <= date && (!cost.to || date <= cost.to)).sort((a, b) => b.from.localeCompare(a.from));
    const feeHistory = fees.filter(fee => fee.from <= date && (!fee.to || date <= fee.to)).sort((a, b) => b.from.localeCompare(a.from));
    const cost = costHistory[0], fee = feeHistory[0];
    let reason: string | null = null;
    if (facts.some(fact => fact.productName !== identity.productName || fact.saleUnitName !== identity.saleUnitName)) reason = "NAME_OR_SALE_UNIT_DIFFERS_FROM_LEGACY";
    else if (!cost || facts.some(fact => fact.costRuleRef !== cost.id)) reason = "COST_SELECTION_DIFFERS_OR_MISSING";
    else if (facts.some(fact => fact.profitBeforeAds === null)) reason = "INCOMPLETE_COMPONENTS";
    if (reason) { skipped.push({ date, productName: identity.productName, saleUnitName: identity.saleUnitName, rows: facts.length, reason,
      reportedNet: total(legacyRows.map(row => row.netSalesKrw)), adapterStates: facts.map(fact => ({ productName: fact.productName,
        saleUnitName: fact.saleUnitName, matchStatus: fact.name.matchStatus, candidateNames: fact.name.candidateNames,
        ruleIds: fact.name.ruleIds, operatingRevenue: fact.operatingRevenue, issues: fact.quality.issues })) }); continue; }
    const actual = adjustReportedSalesForManualPurchase(report, manualReports.get(legacyKey) ?? null);
    const calculated = calculateNormalCoupangProfit({ actual, cost: Object.fromEntries(Object.entries(cost!).filter(([key]) =>
      ["salePriceKrw", "productCostKrw", "sellerShippingFeeKrw", "hanaroShippingFeeKrw", "growthInboundFeeKrw", "growthShippingFeeKrw", "returnRate", "returnCostPerUnitKrw", "extraCostKrw"].includes(key))
      .map(([key, value]) => [key, value === null ? null : Number(value)])) as any,
      salesFeeRate: fee ? Number(fee.rate) : null, ads: { adSpendKrw: 0, adGeneratedSalesKrw: 0, attributedConversionSalesKrw: 0 } });
    if (!calculated.calculated) { skipped.push({ date, productName: identity.productName, rows: facts.length, reason: "LEGACY_CALCULATION_INCOMPLETE" }); continue; }
    const legacy = calculated.calculated;
    const fieldMap = { operatingRevenue: "netSalesKrw", productCost: "productCostKrw", platformFee: "salesFeeKrw", directShippingCost: "shippingCostKrw",
      returnCost: "returnCostKrw", otherDirectCost: "extraCostKrw", vatExpense: "vatKrw", profitBeforeAds: "marginKrw" } as const;
    const differences: Record<string, string> = {};
    for (const [field, oldField] of Object.entries(fieldMap)) {
      const adapted = sum(facts.map(fact => fact[field as keyof SaleFact] as string));
      const old = new D(String(legacy[oldField as keyof typeof legacy]));
      const difference = adapted.minus(old);
      // Existing Number calculations and storage at six decimals may differ below two micro-won.
      assert.ok(difference.abs().lte("0.000002"), `${date} ${identity.productName} ${field} ${difference.toFixed()}`);
      differences[field] = difference.toFixed(9);
    }
    const item = { date, productName: identity.productName, saleUnitName: identity.saleUnitName, rows: facts.length,
      operatingRevenue: total(facts.map(fact => fact.operatingRevenue!)), profitBeforeAds: total(facts.map(fact => fact.profitBeforeAds!)), differences };
    comparisons.push(item); dateComparisons.push(item); matchedGroups++; matchedRows += facts.length;
  }
  const batch: AdapterBatch = { sales: saleBatch.sales, adSpends: adBatch.adSpends, commonExpenses: [],
    coverage: [...saleBatch.coverage, ...adBatch.coverage], sourceControlTotals: [...saleBatch.sourceControlTotals, ...adBatch.sourceControlTotals],
    nextCursor: null, sourceFingerprint: null };
  days.push({ date, rawSales, rawAds, sales, ads, manual: manualDay, batch, comparison: { matchedGroups, matchedRows },
    selectedSalesAmount: total(sales.map(row => row.salesKrw)), selectedCancelAmount: total(sales.map(row => row.cancelAmountKrw)), selectedNet,
    selectedQuantity: total(sales.map(row => row.salesQuantity)) });
}

const periods = [1, 7, 30].map(count => {
  const selected = days.slice(-count), sales = selected.flatMap(day => day.batch.sales), ads = selected.flatMap(day => day.batch.adSpends);
  const byProduct = [...new Set([...sales.map(fact => fact.productName), ...ads.map(fact => fact.productName)])].sort((a, b) => String(a).localeCompare(String(b))).map(productName => ({ productName,
    knownRevenue: total(sales.filter(fact => fact.productName === productName).flatMap(fact => fact.operatingRevenue === null ? [] : [fact.operatingRevenue])),
    adSpend: total(ads.filter(fact => fact.productName === productName).map(fact => fact.amountKrw!)),
    knownProfitBeforeAds: total(sales.filter(fact => fact.productName === productName).flatMap(fact => fact.profitBeforeAds === null ? [] : [fact.profitBeforeAds])) }));
  assert.equal(total(byProduct.map(product => product.adSpend)), total(ads.map(fact => fact.amountKrw!)));
  assert.equal(total(byProduct.map(product => product.knownRevenue)), total(sales.flatMap(fact => fact.operatingRevenue === null ? [] : [fact.operatingRevenue])));
  return { days: count, from: selected[0].date, to: selected.at(-1)!.date, candidateSalesRows: selected.reduce((n, day) => n + day.rawSales.length, 0),
    selectedSalesRows: selected.reduce((n, day) => n + day.sales.length, 0), candidateAdRows: selected.reduce((n, day) => n + day.rawAds.length, 0),
    selectedAdRows: ads.length, reportedSales: total(selected.map(day => day.selectedSalesAmount)), cancellation: total(selected.map(day => day.selectedCancelAmount)),
    reportedNet: total(selected.map(day => day.selectedNet)), reportedQuantity: total(selected.map(day => day.selectedQuantity)),
    manualRows: selected.reduce((n, day) => n + day.manual.length, 0), adSpend: total(ads.map(fact => fact.amountKrw!)),
    assignedAdSpend: total(ads.filter(fact => fact.productName !== null).map(fact => fact.amountKrw!)),
    unmatchedAdSpend: total(ads.filter(fact => fact.productName === null).map(fact => fact.amountKrw!)),
    amounts: Object.fromEntries(fields.map(field => [field, { knownAmount: total(sales.flatMap(fact => fact[field] === null ? [] : [fact[field]!])),
      unknownRows: sales.filter(fact => fact[field] === null).length }])),
    mappedSalesRows: sales.filter(fact => fact.productName !== null).length, unmatchedSalesRows: sales.filter(fact => fact.productName === null).length,
    originalLegacyUnmappedSalesRows: selected.flatMap(day => day.sales).filter(row => !row.legacyProductId).length,
    signedCorrectionRows: selected.flatMap(day => day.sales).filter(row => new D(row.salesQuantity).lt(0)).length,
    fulfillment: (["SELLER", "GROWTH"] as const).map(method => {
      const raw = selected.flatMap(day => day.sales).filter(row => normalizeCoupangFulfillmentMethod(row.saleMethod) === method);
      const facts = sales.filter(fact => fact.ref.recordKind === "SALE" && fact.quantityBasis.includes(`:${method}:`));
      return { method, rows: raw.length, quantity: total(raw.map(row => row.salesQuantity)), reportedNet: total(raw.map(row => row.netSalesKrw)),
        knownShippingCost: total(facts.flatMap(fact => fact.directShippingCost === null ? [] : [fact.directShippingCost])), unknownShippingRows: facts.filter(fact => fact.directShippingCost === null).length };
    }),
    comparableLegacyGroups: comparisons.filter(item => item.date >= selected[0].date).length,
    comparableLegacyRows: comparisons.filter(item => item.date >= selected[0].date).reduce((n, item) => n + item.rows, 0),
    byProduct };
});
const baseline = JSON.parse(readFileSync(resolve(root, "01-evidence-summary.json"), "utf8"));
const baselineComparison = periods.filter(period => period.days !== 30).flatMap(period => (["coupang_sales", "coupang_ads"] as const).map(source => {
  const previous = baseline.sourceComparison.find((item: Raw) => item.source === source && item.period === (period.days === 1 ? "2026-10-26" : "2026-10-20..26"));
  assert.ok(previous);
  const amount = source === "coupang_sales" ? period.reportedNet : period.adSpend;
  const count = source === "coupang_sales" ? period.selectedSalesRows : period.selectedAdRows;
  assert.equal(new D(previous.rawAmount).toFixed(6), amount); assert.equal(Number(previous.rows), count);
  return { source, days: period.days, sourceAmount: amount, selectedRows: count, amountDifference: "0.000000", rowDifference: 0 };
}));
const result = { status: "PASS", captureSha256: createHash("sha256").update(bytes).digest("hex"), queryReceipts: capture.queries.length,
  comparisonPolicy: "Exact input conservation; legacy Number comparator tolerance <=0.000002 KRW per product/day component, recorded below. Partial known values are not complete totals.",
  limitations: ["Read-only management capture does not prove runtime reader grants.", "No database connection is made by this replay.",
    "No manual purchases exist in captured 30-day period; manual formulas are covered by synthetic tests.",
    "Legacy mapping IDs are used only for comparator grouping; name/unit differences are explicitly skipped.",
    "Daily CSV rows do not prove completion of an absent day; missing-day zero is not inferred.",
    "Reported sales already equal reported net; the signed cancellation column is informational and is not deducted a second time."], periods, baselineComparison,
  daily: days.map(day => ({ date: day.date, candidateSalesRows: day.rawSales.length, selectedSalesRows: day.sales.length, selectedAdRows: day.ads.length,
    reportedNet: day.selectedNet, reportedQuantity: day.selectedQuantity, comparison: day.comparison,
    coverage: day.batch.coverage, controls: day.batch.sourceControlTotals })), legacyComparisons: comparisons, legacySkipped: skipped,
  skippedSummary: [...new Set(skipped.map(item => item.reason))].map(reason => ({ reason,
    groups: skipped.filter(item => item.reason === reason).length, rows: skipped.filter(item => item.reason === reason).reduce((n, item) => n + item.rows, 0),
    byProduct: [...new Set(skipped.filter(item => item.reason === reason).map(item => item.productName))].sort().map(productName => ({ productName,
      groups: skipped.filter(item => item.reason === reason && item.productName === productName).length,
      rows: skipped.filter(item => item.reason === reason && item.productName === productName).reduce((n, item) => n + item.rows, 0),
      matchStatuses: [...new Set(skipped.filter(item => item.reason === reason && item.productName === productName).flatMap(item => item.adapterStates?.map((state: Raw) => state.matchStatus) ?? []))],
      issues: [...new Set(skipped.filter(item => item.reason === reason && item.productName === productName).flatMap(item => item.adapterStates?.flatMap((state: Raw) => state.issues) ?? []))].sort() })) })) };
const output = resolve(root, "04-live-replay-20261028.json"); writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ status: result.status, queryReceipts: result.queryReceipts, periods: periods.map(({ byProduct, ...item }) => item),
  comparableGroups: comparisons.length, skippedGroups: skipped.length, output }, null, 2));
