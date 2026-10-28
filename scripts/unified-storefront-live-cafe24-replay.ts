// Offline replay of a bounded, pseudonymized READ ONLY capture. No DB/network calls.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Prisma } from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import { Cafe24PerformanceAdapter, type Cafe24SelectedLine } from "../apps/api/src/unified-performance/adapters/cafe24.adapter";
import { Cafe24SalesCalculator } from "../apps/api/src/domain/cafe24-sales-calculator";
import { resolveCafe24CouponOrder } from "../apps/api/src/domain/cafe24-coupon-matcher";
import { managementVersions, type UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { CONTRACT_VERSION, type AdapterBatch, type AdapterRequest } from "../apps/api/src/unified-performance/types";

type Row = Record<string, any>;
type Capture = { projectRef?: string; connectionMode?: string; rowsChanged?: number; queries: { name: string; status: string; observedAt: string; rows: Row | Row[] | null }[] };
const directory = "docs/product-performance/research";
const defaultInput = `${directory}/03-live-cafe24-result-20261028.json`;
const inputPath = process.argv[2] ?? (existsSync(defaultInput) ? defaultInput : `${defaultInput}.gz`);
const outputPath = process.argv[3] ?? `${directory}/03-live-cafe24-replay-20261028.json`;
const input = readFileSync(inputPath);
const text = inputPath.endsWith(".gz") ? gunzipSync(input).toString("utf8") : input.toString("utf8"), capture: Capture = JSON.parse(text);
assert.equal(capture.projectRef, "iygjmosbelbosfxidqxv");
assert.equal(capture.connectionMode, "MANAGEMENT_READ_ONLY_NOT_RUNTIME_PROOF");
assert.equal(capture.rowsChanged, 0);
const previewText = readFileSync(`${directory}/02-name-migration-preview.json`, "utf8");
const preview = JSON.parse(previewText) as { proposedRules: Row[] };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const date = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
const timestamp = (value: string | null) => {
  if (value === null) return null;
  let iso = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) iso += "Z";
  const result = new Date(iso);
  assert(Number.isFinite(result.getTime()), "Invalid captured timestamp");
  return result;
};
const decimal = (value: string) => new Prisma.Decimal(value);
const nullableDecimal = (value: string | null) => value === null ? null : decimal(value);
const sum = (values: (string | null)[]) => values.reduce((s, v) => s.plus(v ?? "0"), decimal("0")).toFixed(6);
const rows = (name: string): Row[] => {
  const query = capture.queries.find(q => q.name === name);
  assert(query, `Missing captured query: ${name}`);
  assert.equal(query.status, "SUCCESS", `Capture query did not succeed: ${name}`);
  const result = query.rows === null ? [] : Array.isArray(query.rows) ? query.rows : [query.rows];
  assert(result.length < 10001, `Capture bound reached: ${name}`);
  return result;
};
const catalog = rows("cafe24_products"), connections = rows("cafe24_connections");
assert(catalog.length < 1001 && connections.length < 51, "Configuration bound reached");
const policies = rows("cafe24_policies"), coverage = rows("cafe24_coverage"), batches = rows("cafe24_batches");
assert([policies, coverage, batches].every(values => values.length < 1001), "Capture metadata bound reached");
const costRows = rows("cafe24_cost_rules"), overrideRows = rows("cafe24_product_rules"), googleRows = rows("cafe24_google_sale"), couponRows = rows("cafe24_coupon_rules");
const controls = rows("cafe24_daily_controls");
const baselineSummary = JSON.parse(readFileSync(`${directory}/01-evidence-summary.json`, "utf8")) as { sourceComparison: Row[] };
const missingNameProducts = new Set<string>();
const products = catalog.map(p => ({ id: p.id, canonicalName: p.name, normalizedName: p.name.toLowerCase(), active: p.is_active,
  version: 1, createdAt: date("2026-10-28"), updatedAt: date("2026-10-28") }));
// Proposed rules retain their original dates/scopes. They are never imported or backdated.
const rules = preview.proposedRules.filter(r => r.platform === "CAFE24").flatMap(r => {
  const product = products.find(p => p.canonicalName === r.canonicalProductName);
  if (!product) { missingNameProducts.add(r.canonicalProductName); return []; }
  return [{ id: r.id, kind: "NAME", productId: product.id, platform: r.platform, scopeKey: r.scopeKey ?? null, active: r.active !== false,
    version: 1, validFrom: date(r.validFrom), validTo: r.validTo ? date(r.validTo) : null, identityKey: hash(r.id), payload: r,
    createdAt: date("2026-10-28"), updatedAt: date("2026-10-28") }];
});
const typedProducts = products as Parameters<typeof managementVersions>[0], typedRules = rules as unknown as Parameters<typeof managementVersions>[1];
const configuration = { products: typedProducts, rules: typedRules, versions: managementVersions(typedProducts, typedRules) };
const effective = (r: Row, from: string, to: string, day: string) => r[from] <= day && (!r[to] || r[to] >= day);
const moneyFields = (r: Row) => Object.fromEntries(["sale_price_krw_override", "product_cost_krw_override", "shipping_krw_override", "extra_cost_krw_override"]
  .map(key => [key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()), nullableDecimal(r[key])]));
const cost = (r: Row) => ({ id: r.id, effectiveFrom: date(r.effective_from), effectiveTo: r.effective_to ? date(r.effective_to) : null,
  product: { displayName: r.product_name }, salePriceKrw: decimal(r.sale_price_krw), productCostKrw: decimal(r.product_cost_krw),
  shippingKrw: decimal(r.shipping_krw), extraCostKrw: decimal(r.extra_cost_krw) });
const override = (r: Row) => ({ id: r.id, product: { displayName: r.product_name }, displayName: r.display_name, isActive: r.is_active,
  validFrom: r.valid_from ? date(r.valid_from) : null, validTo: r.valid_to ? date(r.valid_to) : null, matchTarget: r.match_target,
  productNameAliases: r.product_name_aliases, productNameIncludeKeywords: r.product_name_include_keywords ?? [], productNameExcludeKeywords: r.product_name_exclude_keywords ?? [],
  optionIncludeKeywords: r.option_include_keywords, optionExcludeKeywords: r.option_exclude_keywords, ...moneyFields(r) });
async function main() {
const allCaptured: Row[] = [];
const outputs: { scope: string; date: string; batch: AdapterBatch; selected: Cafe24SelectedLine[]; candidates: Row[] }[] = [];
const failures: { scope: string; date: string; code: string }[] = [];
const withheld = { productNames: 0, optionNames: 0 };
const previous = process.env.DAILY_SYNC_FEATURE_ENABLED;
process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
try {
  for (let offset = 0; offset < 30; offset++) {
    const day = new Date(Date.UTC(2026, 8, 27 + offset)).toISOString().slice(0, 10);
    const captured = rows(`cafe24_lines_${day}`), proofs = rows(`cafe24_api_proof_${day}`);
    allCaptured.push(...captured);
    assert(captured.every(r => Number(r.query_row_count) === captured.length), `Truncated capture: ${day}`);
    withheld.productNames += captured.filter(r => r.product_name === null).length;
    withheld.optionNames += captured.filter(r => r.option_name === null).length;
    const scopes = [...new Set(["LEGACY_UNBOUND", ...connections.map(c => c.id), ...captured.map(r => r.connection_id ?? "LEGACY_UNBOUND")])].sort();
    for (const scope of scopes) {
      const sourceRows = captured.filter(r => (r.connection_id ?? "LEGACY_UNBOUND") === scope);
      const currentPolicies = policies.filter(p => p.from_date <= day && (!p.to_date || day < p.to_date));
      // Owner handover follows the existing source selector. Empty scopes outside
      // their policy interval are not missing collection days for that account.
      if (scope === "LEGACY_UNBOUND" && currentPolicies.length && !sourceRows.length ||
          scope !== "LEGACY_UNBOUND" && !currentPolicies.some(p => p.connection_id === scope) && !sourceRows.length) continue;
      const eligible = sourceRows.filter(r => r.source === "API" && r.upload_batch_id === null || r.source === "CSV" && batches.some(b =>
        b.id === r.upload_batch_id && ["IMPORTED", "PARTIAL"].includes(b.status) && Number(b.row_count) === Number(b.actual_rows) &&
        (!b.order_start || !b.order_end || b.order_start <= day && b.order_end >= day)));
      const selectedLines: Cafe24SelectedLine[] = eligible.map(r => ({ id: r.id, connectionId: r.connection_id, source: r.source,
        syncRunId: r.sync_run_id, uploadBatchId: r.upload_batch_id, orderLineKey: r.order_line_key, orderNo: r.order_no, productNo: r.product_no,
        productName: r.product_name ?? "", optionName: r.option_name ?? "", optionValue: r.option_value, quantity: decimal(r.quantity),
        salePriceKrw: decimal(r.sale_price_krw), totalOrderKrw: nullableDecimal(r.total_order_krw), totalPaidKrw: decimal(r.total_paid_krw),
        paymentMethod: r.payment_method, providerCouponSignal: r.provider_coupon_signal, actualOrderPriceKrw: nullableDecimal(r.actual_order_price_krw),
        actualShippingFeeKrw: nullableDecimal(r.actual_shipping_fee_krw), orderDate: date(day), importVersion: Number(r.import_version),
        validationStatus: r.validation_status, createdAt: timestamp(r.created_at)!, providerUpdatedAt: timestamp(r.provider_updated_at), sourceRowHash: r.source_row_hash }));
      const scopedCoverage = coverage.filter(r => r.connection_id === scope && r.metric_date === day).map(r => ({ connectionId: r.connection_id,
        dataKind: "CAFE24_ORDER", metricDate: date(day), source: r.source, state: r.state, lastSuccessRunId: r.last_success_run_id,
        lastSuccessAt: timestamp(r.last_success_at), rowCount: r.row_count === null ? null : Number(r.row_count), totalAmount: nullableDecimal(r.total_amount),
        reconciliationStatus: r.reconciliation_status, warningCodes: r.warning_codes }));
      const tx = { $executeRaw: async () => 0, sourceConnection: { findUnique: async () => {
        const c = connections.find(c => c.id === scope); return c && { provider: c.provider, currencyCode: c.currency_code, timeZone: c.time_zone }; } },
        sourcePolicy: { findMany: async () => policies.filter(r => r.from_date <= day && (!r.to_date || r.to_date > day)).map(r => ({ id: r.id,
          connectionId: r.connection_id, dataKind: r.data_kind, fromDate: date(r.from_date), toDate: r.to_date ? date(r.to_date) : null,
          primarySource: r.primary_source, couponInputSource: r.coupon_input_source, version: r.version })) },
        sourceCoverage: { findMany: async () => scopedCoverage },
        cafe24UploadBatch: { findMany: async () => batches.filter(b => ["IMPORTED", "PARTIAL"].includes(b.status) && (!b.order_start || !b.order_end || b.order_start <= day && b.order_end >= day))
          .map(b => ({ id: b.id, rowCount: Number(b.row_count), _count: { rows: Number(b.actual_rows) }, importedAt: timestamp(b.imported_at) })) },
        productCostRule: { findMany: async () => costRows.filter(r => effective(r, "effective_from", "effective_to", day)).map(cost) },
        cafe24ProductRule: { findMany: async () => overrideRows.filter(r => r.is_active && r.valid_from && effective(r, "valid_from", "valid_to", day)).map(override) },
        googlePerformanceMapping: { findMany: async () => googleRows.filter(r => r.connection_id === scope && effective(r, "start_date", "end_date", day)).map(r => ({ id: r.id,
          product: r.product_name ? { displayName: r.product_name } : null, startDate: date(r.start_date), endDate: r.end_date ? date(r.end_date) : null,
          optionName: r.option_name, optionScope: r.option_scope, saleUnitLabel: r.sale_unit_label, ...moneyFields(r) })) },
        cafe24CouponRule: { findMany: async () => couponRows.filter(r => effective(r, "valid_from", "valid_to", day)).map(r => ({ id: r.id,
          product: r.product_name ? { displayName: r.product_name } : null, scope: r.scope, discountKrw: decimal(r.discount_krw),
          validFrom: date(r.valid_from), validTo: r.valid_to ? date(r.valid_to) : null, priority: Number(r.priority), createdAt: timestamp(r.created_at) })) },
        cafe24OrderLine: { findMany: async () => selectedLines },
        $queryRaw: async () => proofs.filter(r => r.connection_id === scope).map(r => ({ connectionId: r.connection_id, orderDate: date(r.order_date),
          rowCount: Number(r.row_count), linkedCount: Number(r.linked_count), validLinkedCount: Number(r.valid_linked_count),
          validVersionCount: Number(r.valid_version_count), validMappingCount: Number(r.valid_mapping_count) })) };
      const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: "offline-live-cafe24", readSnapshotId: hash(text), from: day, to: day,
        platforms: ["CAFE24"], scopeKeys: [scope], ...configuration.versions, calculationVersion: "03-cafe24-live-replay-v1", fxVersion: "KRW-IDENTITY",
        sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 10000 };
      const adapter = new Cafe24PerformanceAdapter({ $transaction: async (work: (client: unknown) => unknown) => work(tx) } as never,
        { snapshot: async () => configuration } as unknown as UnifiedManagementRepository);
      try {
        const batch = await adapter.read(request);
        assert(batch.sourceControlTotals.every(c => c.difference === null || decimal(c.difference).isZero()), `Source control mismatch: ${scope}/${day}`);
        outputs.push({ scope, date: day, batch, selected: selectedLines, candidates: sourceRows });
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        failures.push({ scope, date: day, code: "CAPTURED_SOURCE_SELECTION_UNRESOLVED" });
      }
    }
  }
} finally { if (previous === undefined) delete process.env.DAILY_SYNC_FEATURE_ENABLED; else process.env.DAILY_SYNC_FEATURE_ENABLED = previous; }

const calculator = new Cafe24SalesCalculator();
const formula = { comparedRows: 0, excludedUncertainRows: 0, registeredGross: decimal("0"), grossCost: decimal("0"), differences: 0 };
const formulaRows: { date: string; gross: string; cost: string }[] = [];
for (const output of outputs) for (const sale of output.batch.sales) {
  const row = output.candidates.find(r => `${r.source}:${r.order_line_key}` === sale.ref.sourceRecordKey)!;
  const sourceCost = costRows.filter(c => c.product_id === row.legacy_product_id && effective(c, "effective_from", "effective_to", output.date))
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.created_at.localeCompare(a.created_at))[0];
  const sourceOverride = overrideRows.find(r => r.id === row.legacy_match_rule_id);
  const sourceUnitKey = sourceCost ? sourceOverride ? `${sourceCost.id}:${sourceOverride.id}` : sourceCost.id : null;
  if (!sourceCost || sale.costRuleRef !== sourceUnitKey || sale.productCost === null || sale.vatExpense === null) { formula.excludedUncertainRows++; continue; }
  const resolved = calculator.resolveCost({ salePriceKrw: Number(sourceCost.sale_price_krw), vatKrw: Number(sourceCost.vat_krw),
    productCostKrw: Number(sourceCost.product_cost_krw), shippingKrw: Number(sourceCost.shipping_krw), extraCostKrw: Number(sourceCost.extra_cost_krw) },
    sourceOverride ? { salePriceKrwOverride: sourceOverride.sale_price_krw_override === null ? null : Number(sourceOverride.sale_price_krw_override),
      productCostKrwOverride: sourceOverride.product_cost_krw_override === null ? null : Number(sourceOverride.product_cost_krw_override),
      shippingKrwOverride: sourceOverride.shipping_krw_override === null ? null : Number(sourceOverride.shipping_krw_override),
      extraCostKrwOverride: sourceOverride.extra_cost_krw_override === null ? null : Number(sourceOverride.extra_cost_krw_override) } : null);
  const baseline = calculator.calculate({ quantity: Number(row.quantity), adSpendUsd: 0, exchangeRateKrwPerUsd: 0, cost: resolved });
  const gross = sale.costComponents.find(c => c.kind === "REGISTERED_GROSS_BEFORE_COUPON")?.amount;
  const factCost = sum([sale.productCost, sale.directShippingCost, sale.otherDirectCost, sale.vatExpense]);
  if (gross === null || gross === undefined || decimal(gross).minus(baseline.revenueKrw).abs().gt("0.000001") || decimal(factCost).minus(baseline.grossCostKrw).abs().gt("0.000001")) formula.differences++;
  formula.comparedRows++; formula.registeredGross = formula.registeredGross.plus(baseline.revenueKrw); formula.grossCost = formula.grossCost.plus(baseline.grossCostKrw);
  formulaRows.push({ date: output.date, gross: String(baseline.revenueKrw), cost: String(baseline.grossCostKrw) });
}
assert.equal(formula.differences, 0, "Legacy calculator mismatch on equivalent dated configurations");
const couponComparison = { comparedOrders: 0, appliedOrders: 0, couponAmount: decimal("0"), excludedProductMappingOrders: 0,
  excludedUnresolvedCouponOrders: 0, productRoundingDifferences: 0, totalDifferences: 0 };
for (const output of outputs) {
  const source = output.batch.coverage[0].selectedSource === "LEGACY_UNBOUND" ? "CSV" : output.batch.coverage[0].selectedSource;
  const groups = new Map<string, Cafe24SelectedLine[]>();
  for (const line of output.selected.filter(line => line.source === source)) {
    const key = JSON.stringify([line.source, line.connectionId, !line.connectionId ? line.uploadBatchId : null, line.orderNo]);
    groups.set(key, [...groups.get(key) ?? [], line]);
  }
  for (const lines of groups.values()) {
    const pairs = lines.map(line => ({ line, raw: output.candidates.find(r => r.id === line.id)!,
      fact: output.batch.sales.find(f => f.ref.sourceRecordKey === `${line.source}:${line.orderLineKey}`) }));
    if (pairs.some(({ raw, fact }) => !fact || fact.name.matchStatus !== "MATCHED" ||
        !catalog.some(p => p.id === raw.legacy_product_id && p.is_active && p.name === fact.productName))) {
      couponComparison.excludedProductMappingOrders++; continue;
    }
    const factCoupons = pairs.map(({ fact }) => fact!.costComponents.find(c => c.kind === "COUPON")!.amount);
    if (factCoupons.some(value => value === null)) { couponComparison.excludedUnresolvedCouponOrders++; continue; }
    const policy = policies.find(p => p.connection_id === output.scope && p.from_date <= output.date && (!p.to_date || output.date < p.to_date));
    const old = resolveCafe24CouponOrder({ orderNo: "PSEUDONYMIZED_ORDER", lines: pairs.map(({ line, raw }) => ({
      orderDate: line.orderDate, paymentMethod: line.paymentMethod, source: line.source, providerCouponSignal: line.providerCouponSignal,
      totalOrderKrw: line.source === "CSV" ? line.totalOrderKrw?.toNumber() ?? null : policy?.coupon_input_source === "API_ACTUAL_PRODUCT_PLUS_SHIPPING" &&
        line.actualOrderPriceKrw !== null && line.actualShippingFeeKrw !== null ? line.actualOrderPriceKrw.plus(line.actualShippingFeeKrw).toNumber() : null,
      totalOrderInputSource: line.source === "CSV" ? "CSV_TOTAL_ORDER" : policy?.coupon_input_source === "API_ACTUAL_PRODUCT_PLUS_SHIPPING" ? "API_ACTUAL_PRODUCT_PLUS_SHIPPING" : "UNKNOWN",
      totalPaidKrw: line.totalPaidKrw.toNumber(), productId: raw.legacy_product_id, salePriceKrw: line.salePriceKrw.toNumber(),
      quantity: line.quantity.toNumber(), isValid: line.validationStatus !== "ERROR" })),
      rules: couponRows.map(r => ({ id: r.id, name: "CAPTURED_RULE", scope: r.scope, productId: r.product_id, discountKrw: Number(r.discount_krw),
        priority: Number(r.priority), validFrom: date(r.valid_from), validTo: r.valid_to ? date(r.valid_to) : null, isActive: true, createdAt: timestamp(r.created_at)! })) });
    if (old.couponDeductionKrw === null) { couponComparison.excludedUnresolvedCouponOrders++; continue; }
    const newTotal = sum(factCoupons);
    if (!decimal(newTotal).eq(old.couponDeductionKrw)) couponComparison.totalDifferences++;
    couponComparison.comparedOrders++;
    if (old.status === "APPLIED") { couponComparison.appliedOrders++; couponComparison.couponAmount = couponComparison.couponAmount.plus(newTotal); }
    for (const productId of new Set(pairs.map(({ raw }) => raw.legacy_product_id))) {
      const assigned = sum(pairs.filter(({ raw }) => raw.legacy_product_id === productId).map(({ fact }) => fact!.costComponents.find(c => c.kind === "COUPON")!.amount));
      if (!decimal(assigned).eq(old.allocationsByProductId.get(productId) ?? "0")) couponComparison.productRoundingDifferences++;
    }
  }
}
assert.equal(couponComparison.totalDifferences, 0, "Whole-order coupon total differs from the existing resolver");
const periods = [[1, "2026-10-26"], [7, "2026-10-20"], [30, "2026-09-27"]].map(([days, from]) => {
  const selected = outputs.filter(o => o.date >= String(from));
  const facts = selected.flatMap(o => o.batch.sales), sourceRows = allCaptured.filter(r => r.order_date >= String(from));
  const rawCaptured = sum(sourceRows.map(r => r.sale_price_krw));
  const factRows = selected.flatMap(o => o.batch.sales.map(sale => o.candidates.find(r => `${r.source}:${r.order_line_key}` === sale.ref.sourceRecordKey)!));
  const selectedFactRaw = sum(factRows.map(r => r.sale_price_krw));
  const matchingControls = controls.filter(c => c.order_date >= String(from));
  assert.equal(sourceRows.length, matchingControls.reduce((count, c) => count + Number(c.candidate_rows), 0), "Captured row count mismatch");
  assert.equal(sum(sourceRows.map(r => decimal(r.sale_price_krw).mul(r.quantity).toFixed())), sum(matchingControls.map(c => c.source_list_gross)), "Captured source gross mismatch");
  const baseline = JSON.parse(readFileSync(`${directory}/01-coverage-result.json`, "utf8")) as Capture;
  const oldQuery = baseline.queries.find(q => q.name === "cafe24_recent_daily");
  const oldRows = oldQuery?.status === "SUCCESS" ? Array.isArray(oldQuery.rows) ? oldQuery.rows : oldQuery.rows ? [oldQuery.rows] : [] : [];
  const baselineRows = oldRows.filter(r => r.date >= String(from));
  const baselineRaw = Number(days) <= 7 ? sum(baselineRows.map(r => r.raw_amount)) : null;
  const selectedBaseline = baselineSummary.sourceComparison.find(r => r.source === "cafe24" && r.period === (Number(days) === 1 ? "2026-10-26" : Number(days) === 7 ? "2026-10-20..26" : "NO_30_DAY_BASELINE"));
  const selectedBaselineRaw = selectedBaseline ? decimal(selectedBaseline.rawAmount).toFixed(6) : null;
  if (selectedBaselineRaw !== null) { assert.equal(selectedFactRaw, selectedBaselineRaw, "Selected raw amount differs from the 01 selected-source baseline"); assert.equal(facts.length, Number(selectedBaseline.rows)); }
  const expectedDates = Array.from({ length: Number(days) }, (_, offset) => new Date(Date.parse(String(from)) + offset * 86400000).toISOString().slice(0, 10));
  const byProduct = [...new Set(facts.map(s => s.name.matchStatus === "MATCHED" ? s.productName! : "UNCLASSIFIED"))].sort().map(productName => {
    const group = facts.filter(s => (s.name.matchStatus === "MATCHED" ? s.productName! : "UNCLASSIFIED") === productName);
    return { productName, rows: group.length, operatingRevenueKnown: sum(group.map(s => s.operatingRevenue)),
      operatingRevenueUnknownRows: group.filter(s => s.operatingRevenue === null).length, productCostKnown: sum(group.map(s => s.productCost)),
      directShippingKnown: sum(group.map(s => s.directShippingCost)), otherDirectCostKnown: sum(group.map(s => s.otherDirectCost)), vatKnown: sum(group.map(s => s.vatExpense)),
      couponKnown: sum(group.map(s => s.costComponents.find(c => c.kind === "COUPON")?.amount ?? null)),
      profitBeforeAdsKnown: sum(group.map(s => s.profitBeforeAds)), missingProfitRows: group.filter(s => s.profitBeforeAds === null).length };
  });
  assert.equal(byProduct.reduce((total, row) => total + row.rows, 0), facts.length);
  assert.equal(sum(byProduct.map(row => row.operatingRevenueKnown)), sum(facts.map(s => s.operatingRevenue)));
  assert.equal(sum(byProduct.map(row => row.productCostKnown)), sum(facts.map(s => s.productCost)));
  assert.equal(sum(byProduct.map(row => row.couponKnown)), sum(facts.map(s => s.costComponents.find(c => c.kind === "COUPON")?.amount ?? null)));
  const sourcePairs = selected.flatMap(o => o.batch.sales.map(fact => {
    const raw = o.candidates.find(r => `${r.source}:${r.order_line_key}` === fact.ref.sourceRecordKey)!;
    return { fact, raw, sourceProductName: catalog.find(p => p.id === raw.legacy_product_id)?.name ?? "SOURCE_PRODUCT_UNASSIGNED" };
  }));
  // Source product FKs are reference-only evidence for the 01 samples. They never
  // enter the resolver or repair the new name classification.
  const sourceNameReference = [...new Set(sourcePairs.map(pair => pair.sourceProductName))].sort().map(sourceProductName => {
    const group = sourcePairs.filter(pair => pair.sourceProductName === sourceProductName);
    return { sourceProductName, referenceOnlyNotNewClassification: true, selectedRows: group.length,
      selectedSalePriceColumn: sum(group.map(pair => pair.raw.sale_price_krw)),
      newNameMatchedRows: group.filter(pair => pair.fact.name.matchStatus === "MATCHED").length,
      newNameUnclassifiedRows: group.filter(pair => pair.fact.name.matchStatus !== "MATCHED").length,
      operatingRevenueKnown: sum(group.map(pair => pair.fact.operatingRevenue)),
      operatingRevenueUnknownRows: group.filter(pair => pair.fact.operatingRevenue === null).length };
  });
  assert.equal(sum(sourceNameReference.map(row => row.selectedSalePriceColumn)), selectedFactRaw);
  return { days, from, to: "2026-10-26", candidateRows: sourceRows.length, saleFacts: facts.length, capturedSalePriceColumn: rawCaptured,
    selectedFactSalePriceColumn: selectedFactRaw, excludedCandidateSalePriceColumn: decimal(rawCaptured).minus(selectedFactRaw).toFixed(6),
    baseline01SalePriceColumn: baselineRaw, baseline01CandidateRawDifference: baselineRaw === null ? null : decimal(rawCaptured).minus(baselineRaw).toFixed(6),
    baseline01SelectedRawDifference: baselineRaw === null ? null : decimal(selectedFactRaw).minus(baselineRaw).toFixed(6),
    baseline01SelectedSourceRaw: selectedBaselineRaw, baseline01SelectedSourceDifference: selectedBaselineRaw === null ? null : decimal(selectedFactRaw).minus(selectedBaselineRaw).toFixed(6),
    candidateListPriceTimesQuantity: sum(sourceRows.map(r => decimal(r.sale_price_krw).mul(r.quantity).toFixed())),
    operatingRevenueKnown: sum(facts.map(s => s.operatingRevenue)), operatingRevenueUnknownRows: facts.filter(s => s.operatingRevenue === null).length,
    assignedRevenueKnown: sum(facts.filter(s => s.name.matchStatus === "MATCHED").map(s => s.operatingRevenue)),
    unmatchedRevenueKnown: sum(facts.filter(s => s.name.matchStatus !== "MATCHED").map(s => s.operatingRevenue)),
    productCostKnown: sum(facts.map(s => s.productCost)), vatKnown: sum(facts.map(s => s.vatExpense)),
    couponKnown: sum(facts.map(s => s.costComponents.find(c => c.kind === "COUPON")?.amount ?? null)),
    profitBeforeAdsKnown: sum(facts.map(s => s.profitBeforeAds)), missingProfitRows: facts.filter(s => s.profitBeforeAds === null).length,
    collectionStates: Object.fromEntries(["COMPLETE", "PARTIAL", "NOT_COLLECTED", "STALE"].map(state => [state, selected.filter(o => o.batch.coverage[0].collectionState === state).length])),
    collectionCompleteDates: expectedDates.filter(day => !failures.some(f => f.date === day) && selected.some(o => o.date === day) && selected.filter(o => o.date === day).every(o => o.batch.coverage[0].collectionState === "COMPLETE")),
    collectionIncompleteDates: expectedDates.filter(day => failures.some(f => f.date === day) || !selected.some(o => o.date === day) || selected.some(o => o.date === day && o.batch.coverage[0].collectionState !== "COMPLETE")),
    revenueCompleteDates: expectedDates.filter(day => !failures.some(f => f.date === day) && selected.some(o => o.date === day) && selected.filter(o => o.date === day)
      .every(o => o.batch.sourceControlTotals.find(c => c.measure === "OPERATING_REVENUE")?.selectedAmount != null)),
    legacyCalculatorSameBasis: { comparedRows: formulaRows.filter(r => r.date >= String(from)).length,
      registeredGross: sum(formulaRows.filter(r => r.date >= String(from)).map(r => r.gross)),
      grossCost: sum(formulaRows.filter(r => r.date >= String(from)).map(r => r.cost)), difference: "0.000000" },
    byProduct,
    sourceNameReference,
    unresolvedSourceDays: failures.filter(f => f.date >= String(from)).length };
});
for (const period of periods) assert.equal(decimal(period.assignedRevenueKnown).plus(period.unmatchedRevenueKnown).toFixed(6), period.operatingRevenueKnown);
const result = { status: "PASS_CAPTURED_CAFE24_REPLAY_WITH_LIMITATIONS", sourceEvidenceSha256: hash(text), rulePreviewSha256: hash(previewText),
  databaseAccess: false, networkAccess: false, operationalWrites: 0, sourceConnectionMode: "MANAGEMENT_READ_ONLY_NOT_RUNTIME_PROOF",
  previewRulesAppliedToDatabase: false, previewRulesBackdated: false, periods,
  calculatorComparison: { ...formula, registeredGross: formula.registeredGross.toFixed(6), grossCost: formula.grossCost.toFixed(6) },
  couponComparison: { ...couponComparison, couponAmount: couponComparison.couponAmount.toFixed(6) },
  redactedText: withheld, failures, missingNameProducts: [...missingNameProducts],
  daily: outputs.map(o => ({ scope: o.scope, date: o.date, candidateRows: o.candidates.length, saleFacts: o.batch.sales.length,
    coverage: o.batch.coverage, controls: o.batch.sourceControlTotals })),
  limitations: ["Independent management READ ONLY queries are a bounded capture, not a single production RR transaction or runtime-role proof.",
    "Unified tables are absent; exact current catalog names and unapplied 02 name-rule previews retain their original validity. No historical backdating.",
    "Money totals ending Known preserve observed parts; missing names, sale units, coupon or collection inputs remain unresolved and are never zero-filled.",
    "Candidate raw sums include overlapping API/CSV rows. Selected fact raw sums apply source policy, completed-batch eligibility and invalid-row exclusion before comparison with the 01 raw-column baseline.",
    "Legacy calculator comparison includes only equivalent source-assigned dated rules; Google overrides, unmatched and changed classifications are counted separately.",
    "Identifiers are pseudonymized, and text that resembles personal customization/contact information is withheld before capture."] };
writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, periods: periods.map(({ byProduct, sourceNameReference, ...period }) => period), calculatorComparison: result.calculatorComparison,
  couponComparison: result.couponComparison, failures: failures.length, redactedText: withheld }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
