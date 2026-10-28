// Optional stage-06 bridge. Persist compact public-safe aggregates, never adapter row payloads.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import type { AdapterBatch, AdapterRequest, Platform, SourceCoverage } from "../apps/api/src/unified-performance/types";
import type { ReportFact } from "../apps/api/src/unified-performance/report-contract";
import { ExactDecimal as D } from "../apps/api/src/unified-performance/domain/decimal";
import { prepareReportBatch } from "../apps/api/src/unified-performance/domain/report-calculation";
import { completeSourceCoverage } from "../apps/api/src/unified-performance/aggregation.worker";

export interface ReplayReconciliation {
  measure: string; sourceKnown: string | null; reportKnown: string | null; assignedKnown: string | null; unassignedKnown: string | null;
  unknownSourceRows: number; difference: string | null; balanceDifference: string | null;
}
export interface CompactReplayPartition { platform: Platform; scopeKey: string; date: string; facts: ReportFact[]; coverage: SourceCoverage[];
  sourceControlTotals: AdapterBatch["sourceControlTotals"]; reconciliation: ReplayReconciliation[] }
const sumKnown = (values: readonly (string | null)[]) => {
  const known = values.filter((value): value is string => value !== null);
  return known.length ? known.reduce((total, value) => total.plus(value), new D(0)).toFixed(6) : null;
};
/** Disabled unless invoked by the integrated offline replay; previous stage evidence output is untouched. */
export function captureReportReplay(request: AdapterRequest, batch: AdapterBatch): void {
  const target = process.env.UNIFIED_REPORT_REPLAY_OUTPUT;
  if (!target) return;
  batch = completeSourceCoverage({ platform: request.platforms[0], scopeKey: request.scopeKeys[0], date: request.from,
    runId: request.runId, token: "offline-replay", previousRunId: null }, batch);
  const facts = prepareReportBatch(request, batch, []), reconciliation: ReplayReconciliation[] = [];
  const control = (measure: string, source: Array<{ productName: string | null; amount: string | null }>, reports: Array<{ productName: string | null; amount: string | null }>) => {
    const sourceKnown = sumKnown(source.map(row => row.amount)), reportKnown = sumKnown(reports.map(row => row.amount));
    const assignedKnown = sumKnown(reports.filter(row => row.productName !== null).map(row => row.amount)),
      unassignedKnown = sumKnown(reports.filter(row => row.productName === null).map(row => row.amount));
    assert.equal(reportKnown, sourceKnown, `${measure} compact preservation`);
    const difference = sourceKnown === null || reportKnown === null ? null : new D(sourceKnown).minus(reportKnown).toFixed(6);
    const balanceDifference = reportKnown === null ? null : new D(reportKnown).minus(assignedKnown ?? "0").minus(unassignedKnown ?? "0").toFixed(6);
    if (balanceDifference !== null) assert.equal(balanceDifference, "0.000000", `${measure} assigned+unassigned conservation`);
    reconciliation.push({ measure, sourceKnown, reportKnown, assignedKnown, unassignedKnown, unknownSourceRows: source.filter(row => row.amount === null).length, difference, balanceDifference });
  };
  control("OPERATING_REVENUE", batch.sales.map(row => ({ productName: row.productName, amount: row.operatingRevenue })),
    facts.filter(row => row.component === "SALE").map(row => ({ productName: row.productName, amount: row.amountKrw })));
  control("PROFIT_BEFORE_ADS", batch.sales.map(row => ({ productName: row.productName, amount: row.profitBeforeAds })),
    facts.filter(row => row.component === "SALE").map(row => ({ productName: row.productName, amount: row.profitBeforeAds })));
  control("AD_SPEND_KRW", batch.adSpends.map(row => ({ productName: row.productName, amount: row.amountKrw })),
    facts.filter(row => row.component === "AD_SPEND").map(row => ({ productName: row.productName, amount: row.amountKrw })));
  for (const currency of new Set(batch.adSpends.map(row => row.currency))) control(`AD_SPEND_ORIGINAL_${currency}`,
    batch.adSpends.filter(row => row.currency === currency).map(row => ({ productName: row.productName, amount: row.originalAmount })),
    facts.filter(row => row.component === "AD_SPEND" && row.currency === currency).map(row => ({ productName: row.productName, amount: row.originalAmount })));
  for (const kind of new Set(batch.commonExpenses.map(row => row.kind))) control(kind,
    batch.commonExpenses.filter(row => row.kind === kind).map(row => ({ productName: row.productName, amount: row.amountKrw })),
    facts.filter(row => row.commonKind === kind).map(row => ({ productName: row.productName, amount: row.amountKrw })));
  const value: CompactReplayPartition = { platform: request.platforms[0], scopeKey: request.scopeKeys[0], date: request.from, facts,
    coverage: batch.coverage.map(row => ({ ...row, quality: { ...row.quality, issues: row.quality.issues.filter(issue => /^[A-Z][A-Z0-9_:.-]{0,127}$/.test(issue)) } })),
    sourceControlTotals: batch.sourceControlTotals, reconciliation };
  const json = JSON.stringify(value);
  // Key-bound privacy invariant: only compact report/coverage/control fields cross this boundary.
  assert.equal(/"(?:ref|name|originalName|originalOption|sourceRecordKey|payload|orderNo|externalProductOrderId)"\s*:/.test(json), false);
  appendFileSync(target, json + "\n", "utf8");
}
