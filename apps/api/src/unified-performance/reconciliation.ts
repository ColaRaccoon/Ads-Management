import { createHash, randomUUID } from "node:crypto";
import type { UnifiedAggregationRepository } from "./aggregation.repository";
import { aggregationAdapterRequest, assertSourceExecutionSucceeded, completeSourceCoverage, type UnifiedAggregationWorker } from "./aggregation.worker";
import { scopePolicyComponents } from "./domain/report-calculation";
import { PLATFORM_COMPONENTS } from "./domain/platform-selection";
import type { UnifiedManagementRepository } from "./management.repository";
import type { ReportScope } from "./report.repository";
import type { ReconciliationCandidate, ReconciliationCheckOutcome, ReconciliationRepository } from "./reconciliation.repository";
import type { AdapterBatch, Platform, SourceAdapter } from "./types";

export type ReconciliationOptions = { through: string; lookback: number; limit: number; deadlineMs: number };
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export function reconciliationOptions(args: string[], now = new Date()): ReconciliationOptions {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(through|lookback|limit|deadline-seconds)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error("INVALID_RECONCILIATION_ARGUMENTS");
    values.set(match[1], match[2]);
  }
  const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10), through = values.get("through") ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through) || !Number.isFinite(Date.parse(through)) || shift(through, 0) !== through || through > today)
    throw new Error("INVALID_RECONCILIATION_DATE");
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = values.get(key) ?? String(fallback), n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < min || n > max) throw new Error("INVALID_RECONCILIATION_BOUND"); return n;
  };
  return { through, lookback: integer("lookback", 7, 0, 31), limit: integer("limit", 100, 4, 500), deadlineMs: integer("deadline-seconds", 1200, 30, 2700) * 1000 };
}
export function publicationEvidence(batch: AdapterBatch): boolean {
  const native = batch.nativeResults?.some(row => row.kind === "SUMMARY" &&
    [row.revenue, row.adSpend, row.netProfit].some(value => value.known !== null));
  const numeric = batch.sales.some(row => row.operatingRevenue !== null || row.profitBeforeAds !== null) || batch.adSpends.some(row => row.amountKrw !== null);
  return !!native || numeric || batch.coverage.some(row => row.participation === "INCLUDED" && ["SALE", "AD_SPEND"].includes(row.component) &&
    row.collectionState === "COMPLETE" && row.zeroConfirmed && row.rowsPresent === 0);
}
/** Revisit old published dates too; publishing time cannot stand in for a check
 * time because unchanged results intentionally create no new publication. */
export function reconciliationCandidates(candidates: ReconciliationCandidate[], scopes: ReportScope[], from: string, through: string, limit: number, historicalFirst = false) {
  const allowed = new Set(scopes.map(scope => JSON.stringify([scope.platform, scope.scopeKey]))), unique = new Map<string, ReconciliationCandidate>();
  for (const row of candidates) {
    if (!allowed.has(JSON.stringify([row.platform, row.scopeKey])) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(row.date)) || shift(row.date, 0) !== row.date || row.date > through) continue;
    unique.set(JSON.stringify([row.platform, row.scopeKey, row.date]), row);
  }
  const checked = (row: ReconciliationCandidate) => row.lastCheckedAt && Number.isFinite(Date.parse(row.lastCheckedAt)) ? Date.parse(row.lastCheckedAt) : 0;
  const stable = (a: ReconciliationCandidate, b: ReconciliationCandidate) => a.platform.localeCompare(b.platform) || a.scopeKey.localeCompare(b.scopeKey);
  const recent = [...unique.values()].filter(row => row.date >= from).sort((a, b) => checked(a) - checked(b) || b.date.localeCompare(a.date) || stable(a, b));
  const catchup = [...unique.values()].filter(row => row.date < from).sort((a, b) => checked(a) - checked(b) || a.date.localeCompare(b.date) || stable(a, b));
  const reserved = catchup.slice(0, Math.max(1, Math.floor(limit / 4)));
  const selectedRecent = recent.slice(0, limit - reserved.length), planned: ReconciliationCandidate[] = [];
  // Most capacity is recent. Interleave historical work rather than leaving it
  // after a full recent batch that may consume the deadline every time.
  if (historicalFirst && reserved.length) planned.push(reserved.shift()!);
  while (selectedRecent.length || reserved.length) {
    if (selectedRecent.length) planned.push(...selectedRecent.splice(0, 3));
    if (reserved.length) planned.push(reserved.shift()!);
  }
  const chosen = new Set(planned);
  return [...planned, ...recent.filter(row => !chosen.has(row)), ...catchup.filter(row => !chosen.has(row))].slice(0, limit);
}

export async function reconcilePublications(input: {
  scopes: ReportScope[]; options: ReconciliationOptions; repository: Pick<ReconciliationRepository, "discover" | "pending" | "published" | "recordCheck">;
  aggregation: Pick<UnifiedAggregationRepository, "enqueue">; management: Pick<UnifiedManagementRepository, "snapshot">;
  worker: Pick<UnifiedAggregationWorker, "runOne">; adapters: Readonly<Record<Platform, SourceAdapter>>; now?: () => number;
}) {
  const now = input.now ?? Date.now, started = now(), { options } = input;
  const result = { examined: 0, unchanged: 0, unavailable: 0, enqueued: 0, published: 0, failed: 0, drained: 0, discoveryFailures: [] as string[], exhausted: false };
  const count = (outcome: Awaited<ReturnType<typeof input.worker.runOne>>) => {
    if (outcome?.status === "PUBLISHED") result.published++; else if (outcome) result.failed++;
  };
  if (!input.scopes.length) return result;
  for (const job of await input.repository.pending(input.scopes, Math.floor(options.limit / 2))) {
    if (now() - started >= options.deadlineMs) { result.exhausted = true; return result; }
    if (now() - started >= options.deadlineMs / 3) break;
    count(await input.worker.runOne(job.id)); result.drained++;
  }
  const budget = options.limit - result.drained;
  if (budget <= 0) { result.exhausted = true; return result; }
  const from = shift(options.through, -options.lookback), discovered = await input.repository.discover(input.scopes, from, options.through, options.limit, started + options.deadlineMs);
  result.discoveryFailures = [...new Set(discovered.failures)];
  // Every fourth five-minute slot begins with the oldest historical check so
  // even a small time budget cannot permanently starve old published revisions.
  const candidates = reconciliationCandidates(discovered.candidates, input.scopes, from, options.through, budget, Math.floor(started / 300000) % 4 === 0);
  const snapshot = await input.management.snapshot();
  for (const part of candidates) {
    if (now() - started >= options.deadlineMs) { result.exhausted = true; break; }
    result.examined++;
    let outcome: ReconciliationCheckOutcome = "FAILED";
    try {
      const request = aggregationAdapterRequest({ ...part, runId: randomUUID(), token: randomUUID(), previousRunId: null }, snapshot.versions);
      request.sourcePolicySnapshot.participationOverrides = Object.fromEntries(snapshot.products.filter(product => snapshot.rules.some(rule =>
        rule.kind === "SCOPE_POLICY" && rule.active && rule.productId === product.id)).map(product => [product.canonicalName,
          scopePolicyComponents(snapshot.rules, product.id, part.platform, part.scopeKey, part.date, PLATFORM_COMPONENTS[part.platform])]));
      const batch = completeSourceCoverage({ ...part, runId: request.runId, token: "preflight", previousRunId: null }, await input.adapters[part.platform].read(request));
      assertSourceExecutionSucceeded(batch);
      if (!publicationEvidence(batch)) { outcome = "UNAVAILABLE"; result.unavailable++; continue; }
      const previous = await input.repository.published(part);
      const keys = ["scopePolicyVersion", "nameRuleVersion", "saleUnitRuleVersion", "allocationRuleVersion", "calculationVersion", "fxVersion"] as const;
      const versions = previous?.run.versions as Record<string, unknown> | undefined;
      if (batch.sourceFingerprint && previous?.run.sourceFingerprint === batch.sourceFingerprint && keys.every(key => versions?.[key] === request[key])) {
        outcome = "UNCHANGED"; result.unchanged++; continue;
      }
      const hash = createHash("sha256").update(JSON.stringify([part.platform, part.scopeKey, part.date, batch.sourceFingerprint,
        keys.map(key => request[key]), Math.floor(now() / 300000)])).digest("hex");
      const queued = await input.aggregation.enqueue([part], null, "Automatic source publication reconciliation", `reconcile:${hash}`);
      result.enqueued++;
      outcome = "QUEUED";
      for (const job of queued.jobs) {
        if (job.status === "FAILED") { outcome = "FAILED"; result.failed++; continue; }
        const completed = await input.worker.runOne(job.jobId);
        count(completed);
        if (completed) outcome = completed.status === "PUBLISHED" ? "PUBLISHED" : "FAILED";
      }
    } catch { outcome = "FAILED"; result.failed++; }
    finally {
      try { await input.repository.recordCheck(part, new Date(now()), outcome); }
      catch { result.failed++; result.discoveryFailures.push("CHECK_RECORD_FAILED"); }
    }
  }
  return result;
}
