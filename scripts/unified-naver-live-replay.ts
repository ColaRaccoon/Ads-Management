import "reflect-metadata";
import assert from "node:assert/strict";
import { captureReportReplay } from "./unified-report-replay-capture";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { normalizeNaverDay } from "../apps/api/src/unified-performance/adapters/naver.adapter";
import { naverQueries, naverTimestamp } from "../apps/api/src/unified-performance/adapters/naver-reader";
import { CONTRACT_VERSION, type AdapterRequest } from "../apps/api/src/unified-performance/types";
import { ExactDecimal as D } from "../apps/api/src/unified-performance/domain/decimal";

type Raw = Record<string, any>;
const stem = resolve("docs/product-performance/research/05-live-result-20261028.json");
const secondCapture = resolve("docs/product-performance/research/05-live-result-20261028-v2.json");
const bytes = existsSync(secondCapture) ? readFileSync(secondCapture) : existsSync(stem + ".gz") ? gunzipSync(readFileSync(stem + ".gz")) : readFileSync(stem);
const capture = JSON.parse(bytes.toString("utf8"));
assert.equal(capture.rowsChanged, 0); assert.equal(capture.queries.length, 32);
assert(capture.queries.every((q: Raw) => q.status === "SUCCESS"));
const receipt = (name: string): Raw => { const q = capture.queries.find((q: Raw) => q.name === name); assert(q, name); return q; };
assert.equal(receipt("identity").rows.read_only, "on");
const sum = (values: Array<string | number | null | undefined>) => values.reduce<InstanceType<typeof D>>((total, value) => total.plus(String(value ?? "0")), new D(0));
const require = createRequire(import.meta.url);
// Verification only. The production adapter never imports this repository or its full snapshot.
const referenceRoot = process.env.NAVER_REFERENCE_REPO ?? "C:/Users/seong/Desktop/workspace/patima-naver-ss";
const helperPath = resolve(referenceRoot, "apps/backend/src/helpers.ts");
const legacy = require(helperPath);
const reference = { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: referenceRoot, encoding: "utf8", windowsHide: true }).trim(),
  helperSha256: createHash("sha256").update(readFileSync(helperPath)).digest("hex") };
const numeric = new Set(["quantity", "productPaymentAmount", "deliveryFeeAmount", "paymentCommission", "knowledgeShoppingSellingInterlockCommission", "saleCommission", "channelCommission", "unitCost", "feeRate", "otherCost", "totalCost", "deliveryUnitCost"]);
const oldNumbers = (rows: Raw[]) => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, numeric.has(key) && value != null ? Number(value) : value])));
const results: Raw[] = [];
for (const label of ["infinity", "patima"]) {
  const date = "2026-10-26";
  const raw = Object.fromEntries(Object.keys(naverQueries("unused", date)).map(key => {
    const q = receipt(`${label}:${date}:${key}`), rows = q.rows.rows;
    assert(Array.isArray(rows)); assert.equal(String(rows.length), q.rows.row_count);
    return [key, rows.map((r: Raw) => ({ ...r, updatedAt: naverTimestamp(r.updatedAt) ?? naverTimestamp(r.rowUpdatedAt) }))];
  })) as Parameters<typeof normalizeNaverDay>[1];
  const scopeKey = raw.stores[0].id;
  const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: "live-replay", readSnapshotId: "captured-readonly-inputs", from: date, to: date,
    scopeKeys: [scopeKey], platforms: ["NAVER"], scopePolicyVersion: "capture", nameRuleVersion: "catalog-and-source-names-v1", saleUnitRuleVersion: "capture",
    allocationRuleVersion: "UNALLOCATED-v1", calculationVersion: "naver-profit-v2-preserved", fxVersion: "KRW", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 10000 };
  const errors = Object.fromEntries(Object.keys(raw).map(key => [key, []])) as Parameters<typeof normalizeNaverDay>[2];
  const observedAt = naverTimestamp(receipt(`${label}:${date}:order_items`).observedAt)!;
  const batch = normalizeNaverDay(request, raw, errors, { products: receipt("catalog").rows, nameRules: [] }, observedAt);
  captureReportReplay(request, batch);
  const sourceSales = raw.order_items.filter(row => row.saleStatus === "SALE");
  assert.equal(sum(batch.sales.map(f => f.operatingRevenue)).toFixed(6), sum(sourceSales.map(r => r.productPaymentAmount as string)).toFixed(6));
  assert.equal(batch.sales.length, sourceSales.length);
  assert(batch.sourceControlTotals.every(c => c.difference === null || new D(c.difference).isZero()));
  const active = raw.ad_excel_uploads.filter(row => row.isActive === true && row.state === "CONFIRMED" && row.weekdayValidationStatus === "PASSED" && row.sourceType === "NAVER_DA_XLSX");
  const activeIds = new Set(active.map(row => row.id));
  const sourceAds = raw.ad_campaign_daily_costs.filter(row => activeIds.has(String(row.sourceUploadId)));
  assert.equal(sum(batch.adSpends.map(f => f.amountKrw)).toFixed(6), sum(sourceAds.map(r => r.totalCost as string)).toFixed(6));
  const db = legacy.createEmptyDatabase();
  db.stores = oldNumbers(raw.stores); db.canonicalSalesUnits = oldNumbers(raw.canonical_sales_units);
  db.orderItems = oldNumbers(raw.order_items); db.salesUnitCostSettings = oldNumbers(raw.sales_unit_cost_settings);
  db.salesUnitCostSnapshots = oldNumbers(raw.sales_unit_cost_snapshots); db.salesUnitCostSnapshotEntries = oldNumbers(raw.sales_unit_cost_snapshot_entries);
  // Source legacy IDs are used solely for this comparator; no ad costs are re-subtracted from unified sales.
  const oldRows: Raw[] = legacy.calculateDailyProfitRows(db, scopeKey, date, date);
  const legacyDelivery = legacy.calculateStoreDeliverySummary(db, scopeKey, date, date);
  const legacyTotals = Object.fromEntries(["totalProductRevenue", "totalUnitCost", "totalFeeCost", "totalOtherCost", "vatAmount"].map(key => [key, sum(oldRows.map(row => row[key])).toFixed(6)]));
  const units = new Set(raw.canonical_sales_units.map(row => row.id));
  const mappedKeys = new Set(sourceSales.filter(row => units.has(String(row.canonicalSalesUnitId))).map(row => String(row.externalProductOrderId)));
  const comparable = batch.sales.filter(row => mappedKeys.has(row.ref.sourceRecordKey));
  const costDifferences = comparable.filter(f => f.productCost !== null).flatMap(f => {
    const original = db.orderItems.find((o: Raw) => o.externalProductOrderId === f.ref.sourceRecordKey);
    const originalRows = legacy.calculateDailyProfitRows({ ...db, orderItems: [original] }, scopeKey, date, date);
    const expected = sum(originalRows.map((r: Raw) => r.totalUnitCost));
    return expected.eq(f.productCost!) ? [] : [{ rawName: f.name.originalName, option: f.name.originalOption, unit: f.saleUnitName,
      sourceUnitName: db.canonicalSalesUnits.find((u: Raw) => u.id === original.canonicalSalesUnitId)?.displayName,
      expectedCost: expected.toFixed(6), unifiedCost: f.productCost, quantity: f.calculationQuantity }];
  });
  const comparison = [ ["operatingRevenue", "totalProductRevenue"], ["productCost", "totalUnitCost"], ["platformFee", "totalFeeCost"], ["otherDirectCost", "totalOtherCost"], ["vatExpense", "vatAmount"] ].map(([field, oldField]) => ({
    field, legacy: legacyTotals[oldField], unifiedKnown: sum(comparable.map(row => (row as any)[field])).toFixed(6),
    missingRows: comparable.filter(row => (row as any)[field] === null).length,
    difference: sum(comparable.map(row => (row as any)[field])).minus(legacyTotals[oldField]).toFixed(6)
  }));
  // This frozen sample's source-mapped rows have complete legacy components. Missing values are a regression here.
  for (const check of comparison) { assert.equal(check.missingRows, 0, `${label}:${check.field}`); assert.equal(check.difference, "0.000000", `${label}:${check.field}`); }
  assert.equal(costDifferences.length, 0, `${label}:per-order-cost-parity`);
  const shipping = Object.fromEntries(batch.commonExpenses.filter(e => e.kind.startsWith("SHIPPING_")).map(e => [e.kind, e.amountKrw]));
  assert.equal(sum([shipping.SHIPPING_INCOME]).toFixed(6), new D(legacyDelivery.customerPaidDeliveryFee).toFixed(6));
  assert.equal(sum([shipping.SHIPPING_COST]).toFixed(6), new D(legacyDelivery.estimatedDeliveryBaseCost).toFixed(6));
  assert.equal(sum(batch.commonExpenses.filter(e => e.kind === "FAKE_PURCHASE").map(e => e.amountKrw)).toFixed(6), sum(raw.daily_fake_purchases.map(r => r.amount as string)).toFixed(6));
  results.push({ store: label, date, sourceOrders: raw.order_items.length, saleRows: batch.sales.length, mappedProductRows: batch.sales.filter(s => s.productName).length,
    sourceRevenue: sum(sourceSales.map(r => r.productPaymentAmount as string)).toFixed(6), unifiedRevenue: sum(batch.sales.map(f => f.operatingRevenue)).toFixed(6),
    acceptedAds: sourceAds.length, sourceAdSpend: sum(sourceAds.map(r => r.totalCost as string)).toFixed(6), unifiedAdSpend: sum(batch.adSpends.map(f => f.amountKrw)).toFixed(6),
    unallocatedAdSpend: sum(batch.adSpends.filter(f => !f.productName).map(f => f.amountKrw)).toFixed(6), fakeRows: raw.daily_fake_purchases.length,
    shipping, comparableRows: comparable.length, comparison, costDifferences, coverage: batch.coverage.map(c => ({ component: c.component, state: c.collectionState, missingCostRows: c.missingCostRows, issues: c.quality.issues })),
    unresolvedCostSample: batch.sales.filter(f => f.productCost === null).slice(0, 10).map(f => ({ name: f.name.originalName, option: f.name.originalOption, unit: f.saleUnitName, product: f.productName, issues: f.quality.issues })) });
}
const evidence = { status: "PASS_INPUT_CONSERVATION", realBusinessData: true, period: "2026-10-26", stores: 2, sourceRowsChanged: 0,
  runtimePermissionProof: false, captureSnapshot: "Separate READ ONLY requests; no atomic remote snapshot is claimed", reference,
  queryElapsedMs: { min: Math.min(...capture.queries.map((q: Raw) => q.elapsedMs)), max: Math.max(...capture.queries.map((q: Raw) => q.elapsedMs)) }, results };
writeFileSync(process.env.UNIFIED_REPLAY_EVIDENCE_OUTPUT ?? "docs/product-performance/research/05-live-replay-20261028.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
