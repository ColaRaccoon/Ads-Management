import { randomUUID } from "node:crypto";
import type { UnifiedRule } from "@prisma/client";
import { UnifiedAggregationRepository, type AggregationClaim } from "./aggregation.repository";
import { prepareReportBatch, scopePolicyComponents } from "./domain/report-calculation";
import { PLATFORM_COMPONENTS } from "./domain/platform-selection";
import { assertUnifiedEnabled } from "./management.service";
import { UnifiedManagementRepository } from "./management.repository";
import { REPORT_CALCULATION_VERSION, type ReportFact } from "./report-contract";
import { CONTRACT_VERSION, type AdapterBatch, type AdapterRequest, type Platform, type SourceAdapter } from "./types";

type WorkerRepository = Pick<UnifiedAggregationRepository, "claim" | "heartbeat" | "stageAndPublish" | "fail">;
type WorkerManagement = Pick<UnifiedManagementRepository, "snapshot">;
export interface AggregationOutcome { jobId: string; platform: Platform; status: "PUBLISHED" | "FAILED" | "LEASE_LOST" }

/** Collection uncertainty can be published; an actual execution failure retains the last good revision. */
export function assertSourceExecutionSucceeded(batch: AdapterBatch): void {
  if (batch.coverage.some(coverage => coverage.quality.issues.some(issue =>
    /(?:READ|NORMALIZATION)_FAILED|SOURCE_SELECTION_REQUIRED|CURRENT_LINEAGE_UNVERIFIED|CURRENT_(?:SALES|ADS)_WITHHELD/.test(issue))))
    throw new Error("SOURCE_EXECUTION_FAILED");
}

/** These adapters include shipping/manual costs directly and intentionally have no separate common ledger. */
export function completeSourceCoverage(claim: AggregationClaim, batch: AdapterBatch): AdapterBatch {
  // Naver's adapter reports numeric cost gaps on SALE; preserve that evidence as the explicit cost component.
  if (claim.platform === "NAVER" && !batch.coverage.some(row => row.component === "DIRECT_COST")) {
    const sale = batch.coverage.find(row => row.component === "SALE");
    if (!sale) return batch;
    return { ...batch, coverage: [...batch.coverage, { ...sale, component: "DIRECT_COST",
      collectionState: sale.missingCostRows > 0 ? "PARTIAL" : sale.collectionState,
      zeroConfirmed: sale.missingCostRows > 0 ? false : sale.zeroConfirmed }] };
  }
  if (!["CAFE24", "COUPANG"].includes(claim.platform) || batch.commonExpenses.length || batch.coverage.some(row => row.component === "COMMON_EXPENSE")) return batch;
  const sale = batch.coverage.find(row => row.component === "SALE");
  if (!sale) return batch;
  return { ...batch, coverage: [...batch.coverage, { ...sale, component: "COMMON_EXPENSE", participation: "NOT_APPLICABLE",
    collectionState: "COMPLETE", rowsPresent: 0, zeroConfirmed: true, mappedRows: 0, unmappedRows: 0, unmatchedAmount: "0.000000",
    missingCostRows: 0, missingFxAmount: null, unallocatedAmount: "0.000000", quality: { isEstimate: sale.quality.isEstimate,
      confidence: sale.quality.confidence, issues: ["COMMON_COSTS_INCLUDED_IN_DIRECT_LEDGER"] } }] };
}

/** Explicitly invoked worker only. It has no timers, Nest lifecycle hook, or web-request fallback. */
export class UnifiedAggregationWorker {
  constructor(
    private readonly repository: WorkerRepository,
    private readonly management: WorkerManagement,
    private readonly adapters: Readonly<Record<Platform, SourceAdapter>>,
    private readonly prepare: (request: AdapterRequest, batch: AdapterBatch, rules: UnifiedRule[]) => ReportFact[] = prepareReportBatch
  ) {}

  async runOne(jobId?: string): Promise<AggregationOutcome | null> {
    assertUnifiedEnabled();
    const claim = await this.repository.claim(jobId);
    if (!claim) return null;
    try {
      const snapshot = await this.management.snapshot();
      const request = aggregationAdapterRequest(claim, snapshot.versions);
      request.sourcePolicySnapshot.participationOverrides = Object.fromEntries((snapshot.products ?? [])
        .filter(product => snapshot.rules.some(rule => rule.kind === "SCOPE_POLICY" && rule.active && rule.productId === product.id))
        .map(product => [product.canonicalName, scopePolicyComponents(snapshot.rules, product.id, claim.platform, claim.scopeKey, claim.date,
          PLATFORM_COMPONENTS[claim.platform])]));
      const batch = completeSourceCoverage(claim, await this.adapters[claim.platform].read(request));
      assertSourceExecutionSucceeded(batch);
      if (!await this.repository.heartbeat(claim)) return { jobId: claim.runId, platform: claim.platform, status: "LEASE_LOST" };
      const facts = this.prepare(request, batch, snapshot.rules);
      await this.repository.stageAndPublish(claim, request, batch, facts);
      return { jobId: claim.runId, platform: claim.platform, status: "PUBLISHED" };
    } catch {
      const failed = await this.repository.fail(claim, "SOURCE_EXECUTION_FAILED");
      return { jobId: claim.runId, platform: claim.platform, status: failed ? "FAILED" : "LEASE_LOST" };
    }
  }

  async runPending(limit = 100): Promise<AggregationOutcome[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error("INVALID_AGGREGATION_WORK_LIMIT");
    const outcomes: AggregationOutcome[] = [];
    for (let index = 0; index < limit; index++) {
      const outcome = await this.runOne();
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }
}

export function aggregationAdapterRequest(claim: AggregationClaim, versions: {
  scopePolicyVersion: string; nameRuleVersion: string; saleUnitRuleVersion: string; allocationRuleVersion: string
}): AdapterRequest {
  return {
    contractVersion: CONTRACT_VERSION, runId: claim.runId, readSnapshotId: randomUUID(), from: claim.date, to: claim.date,
    scopeKeys: [claim.scopeKey], platforms: [claim.platform], ...versions, calculationVersion: REPORT_CALCULATION_VERSION,
    fxVersion: "stored-daily-fx-v1", sourcePolicySnapshot: { reconciliation: "FULL_PARTITION", platform: claim.platform },
    // A full day read intentionally does not rely on updated_at watermarks. It catches deletion/zero/cost/name corrections.
    sourceWatermarks: {}, cursor: null, limit: 10000
  };
}

export function aggregationWorkerDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.UNIFIED_AGGREGATION_DATABASE_URL;
  if (!configured) throw new Error("UNIFIED_AGGREGATION_DATABASE_URL_REQUIRED");
  const url = new URL(configured);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.pathname || url.pathname === "/")
    throw new Error("UNIFIED_AGGREGATION_DATABASE_URL_INVALID");
  // The source-reading job role must not accidentally be the web report role.
  if (env.DATABASE_URL && decodeURIComponent(new URL(env.DATABASE_URL).username) === decodeURIComponent(url.username))
    throw new Error("UNIFIED_AGGREGATION_REQUIRES_DISTINCT_ROLE");
  return configured;
}
