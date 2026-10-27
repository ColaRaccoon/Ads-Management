// Replays already captured, non-PII Google rows. This is not a new operational source read.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CONTRACT_VERSION, type AdapterRequest } from "../apps/api/src/unified-performance/types";
import { normalizeAdDay, sum } from "../apps/api/src/unified-performance/adapters/ad-source";
import type { CatalogProduct, NameRule } from "../apps/api/src/unified-performance/domain/product-name-resolver";

const directory = "docs/product-performance/research";
const detailText = readFileSync(`${directory}/01-detail-result.json`, "utf8");
const previewText = readFileSync(`${directory}/02-name-migration-preview.json`, "utf8");
const detail = JSON.parse(detailText) as { queries: { name: string; status: string; observedAt: string; rows: { metric_date: string; campaign_name: string; cost_micros: string }[] }[] };
const preview = JSON.parse(previewText) as { canonicalProducts: CatalogProduct[]; proposedRules: NameRule[] };
const captured = detail.queries.find(q => q.name === "google_campaign_names")!;
assert.equal(captured.status, "SUCCESS"); assert.equal(captured.rows.length, 20);
const scope = preview.proposedRules.find(r => r.platform === "GOOGLE")?.scopeKey ?? "CAPTURED_GOOGLE_SCOPE";
const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: "local-evidence-replay", readSnapshotId: "01-captured-evidence",
  from: "2026-10-20", to: "2026-10-26", scopeKeys: [scope], platforms: ["GOOGLE"], scopePolicyVersion: "CAPTURED_POLICY_NOT_REVALIDATED",
  nameRuleVersion: "02-evidence-preview-v1", saleUnitRuleVersion: "02-evidence-preview-v1", allocationRuleVersion: "UNALLOCATED-v1",
  calculationVersion: "03-google-normalization-v1", fxVersion: "KRW-IDENTITY-v1", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 };
const days = [...new Set(captured.rows.map(r => r.metric_date))].sort();
const batches = days.map(date => normalizeAdDay(request, {
  platform: "GOOGLE", date, scopeKey: scope, currency: "KRW", timeZone: "Asia/Seoul", selectedSource: "API", complete: false,
  sourceIssues: ["CAPTURED_EVIDENCE_ONLY_LINEAGE_NOT_REVALIDATED", "NAME_MIGRATION_PREVIEW_NOT_APPLIED"], storedCoverage: null,
  fx: null, excludedRows: 0, configuration: { products: preview.canonicalProducts, nameRules: preview.proposedRules },
  rows: captured.rows.filter(r => r.metric_date === date).map((r, i) => ({
    id: `captured-row-${date}-${i}`, entityKey: `evidence-position-${i}`, originalName: r.campaign_name, source: "API", sourceVersion: "CAPTURED_UNVERSIONED",
    runOrUploadId: null, observedAt: captured.observedAt, updatedAt: captured.observedAt, amount: r.cost_micros, conversionRevenue: null
  }))
}));
const comparisons = [{ from: "2026-10-26", to: "2026-10-26", expected: "243012.033468" }, { from: "2026-10-20", to: "2026-10-26", expected: "962763.487744" }].map(period => {
  const facts = batches.flatMap(b => b.adSpends).filter(f => f.ref.businessDate >= period.from && f.ref.businessDate <= period.to);
  const amount = sum(facts.map(f => f.amountKrw!)).toFixed(6);
  assert.equal(amount, period.expected);
  const assigned = sum(facts.filter(f => f.productName !== null).map(f => f.amountKrw!));
  const unmatched = sum(facts.filter(f => f.productName === null).map(f => f.amountKrw!));
  assert.equal(assigned.plus(unmatched).toFixed(6), amount);
  return { ...period, rows: facts.length, normalized: amount, assigned: assigned.toFixed(6), unmatched: unmatched.toFixed(6), difference: "0.000000" };
});
const result = { status: "PASS_LIMITED_REPLAY", databaseAccess: false, networkAccess: false, operationalWrites: 0,
  sourceEvidenceSha256: createHash("sha256").update(detailText).digest("hex"), rulePreviewSha256: createHash("sha256").update(previewText).digest("hex"),
  comparisons, daily: batches.map(b => ({ date: b.coverage[0].date, rows: b.adSpends.length, controls: b.sourceControlTotals })),
  limitations: ["01 captured Google names/micros only; no new source selection, runtime permission or lineage verification.",
    "Rule migration preview remains unapplied; unresolved historical names preserve their spend.",
    "10/21,22,24 have no captured Google rows and are not confirmed zero days.",
    "Meta/Cafe24 row inputs and 30-day real-source replay are not supplied by this capture."] };
writeFileSync(`${directory}/03-storefront-evidence-replay.json`, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, comparisons, limitations: result.limitations }, null, 2));
