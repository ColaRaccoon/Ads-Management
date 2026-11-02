import { createHash, randomUUID } from "node:crypto";
import type { UnifiedAggregationRepository } from "./aggregation.repository";
import { aggregationAdapterRequest, assertSourceExecutionSucceeded, completeSourceCoverage, type UnifiedAggregationWorker } from "./aggregation.worker";
import { scopePolicyComponents } from "./domain/report-calculation";
import { PLATFORM_COMPONENTS } from "./domain/platform-selection";
import type { UnifiedManagementRepository } from "./management.repository";
import type { ReportScope } from "./report.repository";
import type { ReconciliationCandidate, ReconciliationRepository } from "./reconciliation.repository";
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
  const numeric = batch.sales.some(row => row.operatingRevenue !== null || row.profitBeforeAds !== null) || batch.adSpends.some(row => row.amountKrw !== null);
  return numeric || batch.coverage.some(row => row.participation === "INCLUDED" && ["SALE", "AD_SPEND"].includes(row.component) &&
    row.collectionState === "COMPLETE" && row.zeroConfirmed && row.rowsPresent === 0);
}
/** Keep an explicit catch-up quota so fresh dates cannot starve missing historical publications. */
export function reconciliationCandidates(candidates: ReconciliationCandidate[], scopes: ReportScope[], from: string, through: string, limit: number) {
  const allowed = new Set(scopes.map(scope => JSON.stringify([scope.platform, scope.scopeKey]))), unique = new Map<string, ReconciliationCandidate>();
  for (const row of candidates) {
    if (!allowed.has(JSON.stringify([row.platform, row.scopeKey])) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(row.date)) || shift(row.date, 0) !== row.date || row.date > through || row.date < from && row.published) continue;
    unique.set(JSON.stringify([row.platform, row.scopeKey, row.date]), row);
  }
  const recent = [...unique.values()].filter(row => row.date >= from).sort((a, b) => Number(a.published) - Number(b.published) || b.date.localeCompare(a.date));
  const catchup = [...unique.values()].filter(row => row.date < from && !row.published).sort((a, b) => b.date.localeCompare(a.date));
  const reserved = catchup.slice(0, Math.max(1, Math.floor(limit / 4)));
  return [...recent.slice(0, limit - reserved.length), ...reserved, ...recent.slice(limit - reserved.length), ...catchup.slice(reserved.length)].slice(0, limit);
}

export async function reconcilePublications(input: {
  scopes: ReportScope[]; options: ReconciliationOptions; repository: Pick<ReconciliationRepository, "discover" | "pending" | "published">;
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
    count(await input.worker.runOne(job.id)); result.drained++;
  }
  const budget = options.limit - result.drained;
  if (budget <= 0) { result.exhausted = true; return result; }
  const from = shift(options.through, -options.lookback), discovered = await input.repository.discover(input.scopes, from, options.through, options.limit, started + options.deadlineMs);
  result.discoveryFailures = [...new Set(discovered.failures)];
  const candidates = reconciliationCandidates(discovered.candidates, input.scopes, from, options.through, budget);
  const snapshot = await input.management.snapshot();
  for (const part of candidates) {
    if (now() - started >= options.deadlineMs) { result.exhausted = true; break; }
    result.examined++;
    try {
      const request = aggregationAdapterRequest({ ...part, runId: randomUUID(), token: randomUUID(), previousRunId: null }, snapshot.versions);
      request.sourcePolicySnapshot.participationOverrides = Object.fromEntries(snapshot.products.filter(product => snapshot.rules.some(rule =>
        rule.kind === "SCOPE_POLICY" && rule.active && rule.productId === product.id)).map(product => [product.canonicalName,
          scopePolicyComponents(snapshot.rules, product.id, part.platform, part.scopeKey, part.date, PLATFORM_COMPONENTS[part.platform])]));
      const batch = completeSourceCoverage({ ...part, runId: request.runId, token: "preflight", previousRunId: null }, await input.adapters[part.platform].read(request));
      assertSourceExecutionSucceeded(batch);
      if (!publicationEvidence(batch)) { result.unavailable++; continue; }
      const previous = await input.repository.published(part);
      const keys = ["scopePolicyVersion", "nameRuleVersion", "saleUnitRuleVersion", "allocationRuleVersion", "calculationVersion", "fxVersion"] as const;
      const versions = previous?.run.versions as Record<string, unknown> | undefined;
      if (batch.sourceFingerprint && previous?.run.sourceFingerprint === batch.sourceFingerprint && keys.every(key => versions?.[key] === request[key])) {
        result.unchanged++; continue;
      }
      const hash = createHash("sha256").update(JSON.stringify([part.platform, part.scopeKey, part.date, batch.sourceFingerprint,
        keys.map(key => request[key]), Math.floor(now() / 3600000)])).digest("hex");
      const queued = await input.aggregation.enqueue([part], null, "Automatic source publication reconciliation", `reconcile:${hash}`);
      result.enqueued++;
      for (const job of queued.jobs) {
        if (job.status === "FAILED") { result.failed++; continue; }
        count(await input.worker.runOne(job.jobId));
      }
    } catch { result.failed++; }
  }
  return result;
}
