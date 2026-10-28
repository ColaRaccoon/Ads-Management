// Offline replay of reviewed, pseudonymized READ ONLY captures; never connects to a database.
import assert from "node:assert/strict";
import { captureReportReplay } from "./unified-report-replay-capture";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { CONTRACT_VERSION, type AdapterRequest } from "../apps/api/src/unified-performance/types";
import { normalizeAdDay, sum, type AdRow } from "../apps/api/src/unified-performance/adapters/ad-source";
import { decimal, microsToAmount, quantizeMoney } from "../apps/api/src/unified-performance/domain/decimal";
import type { CatalogProduct, NameRule } from "../apps/api/src/unified-performance/domain/product-name-resolver";

const directory = "docs/product-performance/research";
const defaultInput = `${directory}/03-live-ads-result-20261028.json`;
const inputPath = process.argv[2] ?? (existsSync(defaultInput) ? defaultInput : `${defaultInput}.gz`);
const outputPath = process.argv[3] ?? `${directory}/03-live-ads-replay-20261028.json`;
const inputBuffer = readFileSync(inputPath);
const inputText = (inputPath.endsWith(".gz") ? gunzipSync(inputBuffer) : inputBuffer).toString("utf8");
type Query = { name: string; status: string; observedAt: string; rows: unknown };
const capture = JSON.parse(inputText) as { connectionMode: string; rowsChanged: number; queries: Query[] };
assert.equal(capture.connectionMode, "MANAGEMENT_READ_ONLY_NOT_RUNTIME_PROOF");
assert.equal(capture.rowsChanged, 0);
const record = (name: string) => {
  const found = capture.queries.find(q => q.name === name);
  assert.ok(found, `Missing capture: ${name}`); assert.equal(found.status, "SUCCESS", name); return found;
};
const rows = <T>(name: string): T[] => {
  const result = record(name).rows;
  return (Array.isArray(result) ? result : result == null ? [] : [result]) as T[];
};
type CapturedRow = { id: string; scope: string; date: string; entity_key: string; original_name: string; source: "API" | "CSV";
  version: number; revision: string | null; run_or_upload: string | null; amount: string; conversion_revenue: string | null;
  observed_at: string; updated_at: string; link_count: number; valid_links: number };
const sourceRows = (name: string): CapturedRow[] => {
  const [packed] = rows<{ row_count: string; rows: CapturedRow[] }>(name);
  assert.ok(packed); assert.equal(packed.rows.length, Number(packed.row_count), `${name} was truncated`);
  return packed.rows;
};
const meta = sourceRows("meta_rows"), google = sourceRows("google_rows");
const connections = rows<{ id: string; provider: "META" | "GOOGLE"; currency_code: string; time_zone: string }>("ads_connections");
const policies = rows<{ connection_id: string; data_kind: string; from_date: string; to_date: string | null; primary_source: "API" | "CSV"; version: number }>("ads_policies");
const coverage = rows<{ connection_id: string; data_kind: string; date: string; source: string; state: string;
  last_success_run: string | null; last_success_at: string | null; row_count: number | null; total_amount: string | null;
  warning_codes: string[]; publish_unit_count: number; published_count: number | null }>("ads_coverage");
const rates = rows<{ rate_date: string; source_date: string; base_currency: string; quote_currency: string; rate: string; provider: string; fallback_type: string }>("ads_rates");
type LegacyName = { id: string; product_name: string; match_type: string; pattern: string; valid_from: string; valid_to: string | null; active: boolean };
type LegacyCost = { id: string; product_name: string; active: boolean; from: string; to: string | null; rate: string };
const [configuration] = rows<{ products: CatalogProduct[]; name_rules: LegacyName[]; cost_rules: LegacyCost[] }>("ads_name_cost_rules");
assert.ok(configuration);
const nameRules: NameRule[] = configuration.name_rules.filter(r => ["EXACT", "CONTAINS"].includes(r.match_type)).map(r => ({
  id: `captured-meta:${r.id}`, canonicalProductName: r.product_name, matchType: r.match_type as "EXACT" | "CONTAINS",
  terms: [r.pattern], platform: "META", validFrom: r.valid_from, validTo: r.valid_to, active: r.active
}));
const dateList = Array.from({ length: 30 }, (_, i) => new Date(Date.parse("2026-09-27") + i * 86400000).toISOString().slice(0, 10));
type ProductTotal = { productName: string | null; rows: number; originalAmount: string; knownKrw: string };
const daily: Array<{ platform: "META" | "GOOGLE"; scope: string; date: string; selectedSource: string | null; complete: boolean;
  candidateRows: number; selectedRows: number; withheldRows: number; originalSelected: string; normalizedOriginal: string;
  assignedOriginal: string; unmatchedOriginal: string; knownKrw: string; completeKrw: string | null; assignedKrw: string; unmatchedKrw: string; missingFxOriginal: string;
  fingerprint: string | null; issues: string[]; products: ProductTotal[] }> = [];
const iso = (value: string) => new Date(value).toISOString();
for (const platform of ["META", "GOOGLE"] as const) {
  const all = platform === "META" ? meta : google;
  const kind = platform === "META" ? "META_ADSET" : "GOOGLE_CAMPAIGN";
  const scopes = [...new Set([...all.map(r => r.scope), ...connections.filter(c => c.provider === platform).map(c => c.id)])].sort();
  for (const date of dateList) for (const scope of scopes) {
    const legacy = scope === "LEGACY_UNBOUND";
    const matching = policies.filter(p => p.data_kind === kind && p.from_date <= date && (!p.to_date || date < p.to_date));
    const candidates = all.filter(r => r.scope === scope && r.date === date);
    // Bound accounts begin at their explicit policy, while earlier CSV keeps its distinct owner.
    if (legacy && matching.length || !legacy && !matching.some(p => p.connection_id === scope) && !candidates.length) continue;
    const owned = matching.filter(p => p.connection_id === scope);
    const selectedSource = legacy ? "CSV" : owned.length === 1 ? owned[0].primary_source : null;
    const selected = candidates.filter(r => r.source === selectedSource);
    const stored = coverage.find(c => c.connection_id === scope && c.data_kind === kind && c.date === date && c.source === selectedSource);
    const rawAmount = (r: CapturedRow) => platform === "GOOGLE" ? microsToAmount(r.amount) : quantizeMoney(decimal(r.amount));
    const originalSelected = quantizeMoney(sum(selected.map(rawAmount)));
    const intact = !!stored?.last_success_run && !!stored.last_success_at && stored.row_count === selected.length &&
      stored.publish_unit_count === 1 && selected.every(r => r.link_count === 1 && r.valid_links === 1) &&
      (platform === "META" || stored.total_amount !== null && decimal(originalSelected).eq(stored.total_amount) && stored.published_count === selected.length);
    const complete = selectedSource === "CSV" ? selected.length > 0 : selectedSource === "API" && intact;
    const withheld = selectedSource === "API" && !intact;
    const connection = connections.find(c => c.id === scope);
    const currency = connection?.currency_code ?? "USD", timeZone = connection?.time_zone ?? "Asia/Seoul";
    const savedFx = rates.filter(r => r.rate_date === date && r.base_currency === currency);
    const legacyFx = new Map<string, { rate: string; sourceDate: string; ruleId: string }>();
    if (!savedFx.length) for (const product of configuration.products) {
      const costs = configuration.cost_rules.filter(c => c.product_name === product.canonicalName && c.active && c.from <= date && (!c.to || date <= c.to));
      const latestFrom = costs.map(c => c.from).sort().at(-1);
      const latest = costs.filter(c => c.from === latestFrom);
      if (latest.length === 1 && decimal(latest[0].rate).gt(0)) legacyFx.set(product.canonicalName, {
        rate: latest[0].rate, sourceDate: latest[0].from, ruleId: latest[0].id
      });
    }
    const sourceIssues = [...stored?.warning_codes ?? [], ...(withheld ? [`${platform}_CURRENT_LINEAGE_UNVERIFIED`] : []),
      ...(!selectedSource ? ["SOURCE_SELECTION_REQUIRED"] : []), "MANAGEMENT_CAPTURE_NOT_RUNTIME_PERMISSION_PROOF"];
    const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: "offline-live-capture-replay", readSnapshotId: "03-live-capture-20261028",
      from: "2026-09-27", to: "2026-10-26", scopeKeys: [scope], platforms: [platform], cursor: null, limit: 10000,
      scopePolicyVersion: "CAPTURED_POLICY_ENABLED_REPLAY", nameRuleVersion: "CAPTURED_DATED_META_NAMES_NO_GOOGLE_BACKDATE",
      saleUnitRuleVersion: "CAPTURED_LEGACY_FX_ONLY", allocationRuleVersion: "UNALLOCATED", calculationVersion: "stage03-ad-normalization",
      fxVersion: "CAPTURED_DATED_FX", sourcePolicySnapshot: {}, sourceWatermarks: {} };
    const normalizedRows: AdRow[] = (withheld ? [] : selected).map(r => ({ id: r.id, entityKey: r.entity_key, originalName: r.original_name,
      source: r.source, sourceVersion: `${r.version}:${r.revision ?? ""}`, runOrUploadId: r.run_or_upload,
      observedAt: iso(r.observed_at), updatedAt: iso(r.updated_at), amount: r.amount, conversionRevenue: r.conversion_revenue }));
    const rate = savedFx.length === 1 ? savedFx[0] : null;
    const batch = normalizeAdDay(request, { platform, date, scopeKey: scope, currency, timeZone, rows: normalizedRows,
      selectedSource, complete, sourceIssues, storedCoverage: null,
      fx: rate ? { rate: rate.rate, sourceDate: rate.source_date, provider: rate.provider, fallbackType: rate.fallback_type } : null,
      legacyFx, unverifiedRows: withheld ? selected.length : 0, excludedRows: candidates.length - selected.length,
      configuration: { products: configuration.products, nameRules }, sourceSelectionEvidence: { policies: owned, coverage: stored ?? null,
        capturedQueryHash: createHash("sha256").update(inputText).digest("hex"), independentlyReadStatements: true } });
    captureReportReplay({ ...request, from: date, to: date }, batch);
    const normalizedOriginal = quantizeMoney(sum(batch.adSpends.map(f => f.originalAmount)));
    if (!withheld) assert.equal(normalizedOriginal, originalSelected);
    const assignedOriginal = quantizeMoney(sum(batch.adSpends.filter(f => f.productName !== null).map(f => f.originalAmount)));
    const unmatchedOriginal = quantizeMoney(sum(batch.adSpends.filter(f => f.productName === null).map(f => f.originalAmount)));
    assert.equal(quantizeMoney(decimal(assignedOriginal).plus(unmatchedOriginal)), normalizedOriginal);
    const assignedKrw = quantizeMoney(sum(batch.adSpends.filter(f => f.productName !== null).flatMap(f => f.amountKrw === null ? [] : [f.amountKrw])));
    const unmatchedKrw = quantizeMoney(sum(batch.adSpends.filter(f => f.productName === null).flatMap(f => f.amountKrw === null ? [] : [f.amountKrw])));
    const knownKrw = quantizeMoney(sum(batch.adSpends.flatMap(f => f.amountKrw === null ? [] : [f.amountKrw])));
    assert.equal(quantizeMoney(decimal(assignedKrw).plus(unmatchedKrw)), knownKrw);
    const products = [...new Set(batch.adSpends.map(f => f.productName))].sort().map(productName => {
      const facts = batch.adSpends.filter(f => f.productName === productName);
      return { productName, rows: facts.length, originalAmount: quantizeMoney(sum(facts.map(f => f.originalAmount))),
        knownKrw: quantizeMoney(sum(facts.flatMap(f => f.amountKrw === null ? [] : [f.amountKrw]))) };
    });
    daily.push({ platform, scope, date, selectedSource, complete, candidateRows: candidates.length, selectedRows: selected.length,
      withheldRows: withheld ? selected.length : 0, originalSelected, normalizedOriginal, assignedOriginal, unmatchedOriginal, knownKrw,
      completeKrw: complete && batch.adSpends.every(f => f.amountKrw !== null) ? knownKrw : null,
      assignedKrw, unmatchedKrw, missingFxOriginal: quantizeMoney(sum(batch.adSpends.filter(f => f.amountKrw === null).map(f => f.originalAmount))),
      fingerprint: batch.sourceFingerprint, issues: batch.coverage[0].quality.issues, products });
  }
}
const comparisons = (["META", "GOOGLE"] as const).flatMap(platform => [1, 7, 30].map(days => {
  const from = dateList[30 - days], to = "2026-10-26";
  const selected = daily.filter(d => d.platform === platform && d.date >= from);
  const datesPresent = new Set(selected.map(d => d.date));
  const missingDates = dateList.filter(date => date >= from && !datesPresent.has(date));
  const amount = quantizeMoney(sum(selected.map(d => d.originalSelected)));
  const normalized = quantizeMoney(sum(selected.map(d => d.normalizedOriginal)));
  const products = [...new Set(selected.flatMap(d => d.products.map(p => p.productName)))].sort().map(productName => {
    const parts = selected.flatMap(d => d.products).filter(p => p.productName === productName);
    return { productName, rows: parts.reduce((s, p) => s + p.rows, 0), originalAmount: quantizeMoney(sum(parts.map(p => p.originalAmount))),
      knownKrw: quantizeMoney(sum(parts.map(p => p.knownKrw))) };
  });
  assert.equal(quantizeMoney(sum(products.map(p => p.originalAmount))), normalized);
  const prior = platform === "META" ? days === 1 ? "3836.400000" : days === 7 ? "22728.420000" : null
    : days === 1 ? "243012.033468" : days === 7 ? "962763.487744" : null;
  return { platform, days, from, to, sourceRows: selected.reduce((s, d) => s + d.selectedRows, 0),
    normalizedRows: selected.reduce((s, d) => s + d.selectedRows - d.withheldRows, 0), originalSelected: amount,
    normalizedOriginal: normalized, withheldOriginal: quantizeMoney(decimal(amount).minus(normalized)),
    assignedOriginal: quantizeMoney(sum(selected.map(d => d.assignedOriginal))), unmatchedOriginal: quantizeMoney(sum(selected.map(d => d.unmatchedOriginal))),
    prior01Original: prior, differenceFrom01: prior === null ? null : quantizeMoney(decimal(amount).minus(prior)),
    knownKrw: quantizeMoney(sum(selected.map(d => d.knownKrw))), assignedKrw: quantizeMoney(sum(selected.map(d => d.assignedKrw))),
    unmatchedKrw: quantizeMoney(sum(selected.map(d => d.unmatchedKrw))), missingFxOriginal: quantizeMoney(sum(selected.map(d => d.missingFxOriginal))),
    completeDays: [...datesPresent].filter(date => selected.filter(d => d.date === date).every(d => d.complete)).length,
    incompleteDates: [...new Set([...missingDates, ...selected.filter(d => !d.complete).map(d => d.date)])].sort(), products,
    observedQueryTimes: capture.queries.map(q => ({ name: q.name, observedAt: q.observedAt })) };
}));
const previousDetailPath = `${directory}/01-detail-result.json`;
const previousDetailText = readFileSync(previousDetailPath, "utf8");
const previousCapture = JSON.parse(previousDetailText) as { queries: Query[] };
const previousQuery = previousCapture.queries.find(q => q.name === "google_campaign_names");
assert.ok(previousQuery); assert.equal(previousQuery.status, "SUCCESS");
const previousGoogle = previousQuery.rows as Array<{ metric_date: string; campaign_name: string; cost_micros: string }>;
const googleBaselineDaily = [...new Set([...previousGoogle.map(r => r.metric_date), ...google.map(r => r.date)])].sort().map(date => {
  const previous = previousGoogle.filter(r => r.metric_date === date), current = google.filter(r => r.date === date);
  const previousAmount = quantizeMoney(sum(previous.map(r => microsToAmount(r.cost_micros))));
  const currentAmount = quantizeMoney(sum(current.map(r => microsToAmount(r.amount))));
  const priorByName = new Map<string, string[]>();
  for (const row of previous) priorByName.set(row.campaign_name, [...priorByName.get(row.campaign_name) ?? [], row.cost_micros]);
  const comparableNameDifferences = [...priorByName].map(([name, amounts]) => ({ name,
    difference: quantizeMoney(sum(current.filter(r => r.original_name === name).map(r => microsToAmount(r.amount)))
      .minus(sum(amounts.map(microsToAmount)))) }));
  assert.ok(comparableNameDifferences.every(r => r.difference === "0.000000"), "Previously captured campaign/day amounts changed; review source corrections.");
  return { date, previousRows: previous.length, currentRows: current.length, previousAmount, currentAmount,
    previousDateState: previous.length ? "CAPTURED_ROWS" : "NO_CAPTURE_NOT_CONFIRMED_ZERO",
    difference: quantizeMoney(decimal(currentAmount).minus(previousAmount)), comparableNameDifferences };
});
const result = { status: "PASS_REAL_CAPTURE_REPLAY", databaseAccessByReplay: false, networkAccessByReplay: false, operationalWrites: 0,
  captureMode: capture.connectionMode, inputPath, inputSha256: createHash("sha256").update(inputText).digest("hex"),
  capturedRows: { META: meta.length, GOOGLE: google.length }, comparisons, daily,
  previousGoogleEvidenceSha256: createHash("sha256").update(previousDetailText).digest("hex"), googleBaselineDaily,
  skippedUnsupportedMetaRules: configuration.name_rules.filter(r => !["EXACT", "CONTAINS"].includes(r.match_type)).map(r => r.id),
  limitations: ["Management READ ONLY capture proves source observation, not actual runtime reader permissions.",
    "Capture queries use independent READ ONLY statements; they do not establish a shared Repeatable Read snapshot.",
    "Policy-enabled selection is replayed explicitly; deployment environment flags are not read by this offline script.",
    "Google historical name rules were not inferred or backdated. Unclassified spend remains in unmatched amounts.",
    "Absent dates are not confirmed zero. A 30-day query range does not establish 30 complete collection days.",
    "Meta dated legacy name rules are projected without production migration; unsupported rule syntax remains unclassified."] };
writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, outputPath, capturedRows: result.capturedRows,
  comparisons: comparisons.map(({ observedQueryTimes, products, ...comparison }) => comparison) }, null, 2));
