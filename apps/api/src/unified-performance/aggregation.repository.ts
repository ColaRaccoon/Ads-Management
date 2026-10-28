import { createHash, randomUUID } from "node:crypto";
import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { assertAdapterBatch, logicalSourceKey } from "./adapter-contract";
import { PLATFORM_COMPONENTS } from "./domain/platform-selection";
import { assertBusinessDate } from "./domain/product-name-resolver";
import { ExactDecimal, money, quantity } from "./domain/decimal";
import { CONTRACT_VERSION, PLATFORMS, type AdapterBatch, type AdapterRequest } from "./types";
import type { ReportFact, SourcePartition } from "./report-contract";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const dateValue = (date: string) => new Date(`${date}T00:00:00.000Z`);
const day = (value: Date) => value.toISOString().slice(0, 10);
const leaseDuration = (ms: number) => {
  if (!Number.isInteger(ms) || ms < 1000 || ms > 1800000) throw new Error("INVALID_AGGREGATION_LEASE");
  return ms;
};
const conflict = (code: string): never => { throw new ConflictException({ code, message: "집계 실행 또는 발행 상태가 변경되었습니다." }); };

export interface AggregationClaim extends SourcePartition {
  runId: string;
  token: string;
  previousRunId: string | null;
}
export interface AggregationJob extends SourcePartition {
  jobId: string;
  status: string;
  attempts: number;
  issues: string[];
  phase: string;
  startedAt: string;
  completedAt: string | null;
}

/** UUIDs allow a bounded lookup of the first request record without a JSONB queue scan. */
export function aggregationRequestId(actorId: string, key: string): string {
  const hex = digest(["unified-rebuild-v1", actorId, key]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function canonicalPartitions(partitions: readonly SourcePartition[]): SourcePartition[] {
  if (!Array.isArray(partitions) || !partitions.length || partitions.length > 5000) throw new Error("INVALID_AGGREGATION_PARTITIONS");
  const seen = new Set<string>();
  return partitions.map(part => {
    assertBusinessDate(part.date);
    if (!PLATFORMS.includes(part.platform) || typeof part.scopeKey !== "string" || !part.scopeKey.trim() || part.scopeKey.length > 256)
      throw new Error("INVALID_AGGREGATION_PARTITION");
    const key = JSON.stringify([part.platform, part.scopeKey, part.date]);
    if (seen.has(key)) throw new Error("DUPLICATE_AGGREGATION_PARTITION");
    seen.add(key); return { platform: part.platform, scopeKey: part.scopeKey, date: part.date };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function partitionWhere(part: SourcePartition) {
  return { sourceSystem: part.platform, platform: part.platform, scopeKey: part.scopeKey, businessDate: dateValue(part.date) };
}
function pointerWhere(part: SourcePartition) {
  return { sourceSystem_platform_scopeKey_businessDate: partitionWhere(part) };
}
const safeJob = (row: { id: string; platform: string; scopeKey: string; businessDate: Date; status: string; attempts: number;
  issues: Prisma.JsonValue; checkpoint: Prisma.JsonValue | null; startedAt: Date; completedAt: Date | null }): AggregationJob => ({
  jobId: row.id, platform: row.platform as SourcePartition["platform"], scopeKey: row.scopeKey, date: day(row.businessDate), status: row.status,
  attempts: row.attempts, issues: Array.isArray(row.issues) ? row.issues.filter((v): v is string => typeof v === "string") : [],
  phase: row.status === "PUBLISHED" ? "PUBLISHED" : String((row.checkpoint as { phase?: string } | null)?.phase ?? "QUEUED"), startedAt: row.startedAt.toISOString(),
  completedAt: row.completedAt?.toISOString() ?? null
});

/** Recheck the allocation transform at the publication boundary, independently of adapter controls. */
export function assertReportConservation(batch: AdapterBatch, facts: readonly ReportFact[]): void {
  const total = (values: readonly (string | null)[]) => {
    const known = values.filter((value): value is string => value !== null);
    return known.length || !values.length ? known.reduce((sum, value) => sum.plus(money(value)), new ExactDecimal(0)) : null;
  };
  const same = (source: readonly (string | null)[], report: readonly (string | null)[]) => {
    const before = total(source), after = total(report);
    if (before === null ? after !== null : after === null || !before.eq(after)) throw new Error("AGGREGATION_REPORT_CONSERVATION_FAILED");
  };
  same(batch.sales.map(row => row.operatingRevenue), facts.filter(row => row.component === "SALE").map(row => row.amountKrw));
  same(batch.sales.map(row => row.profitBeforeAds), facts.filter(row => row.component === "SALE").map(row => row.profitBeforeAds));
  same(batch.adSpends.map(row => row.amountKrw), facts.filter(row => row.component === "AD_SPEND").map(row => row.amountKrw));
  const currencies = new Set([...batch.adSpends.map(row => row.currency), ...facts.filter(row => row.component === "AD_SPEND").map(row => row.currency)]);
  for (const currency of currencies) same(batch.adSpends.filter(row => row.currency === currency).map(row => row.originalAmount),
    facts.filter(row => row.component === "AD_SPEND" && row.currency === currency).map(row => row.originalAmount));
  for (const income of [true, false]) same(batch.commonExpenses.filter(row => (row.kind === "SHIPPING_INCOME") === income).map(row => row.amountKrw),
    facts.filter(row => income ? row.component === "SHIPPING_INCOME" : row.component === "COMMON_EXPENSE").map(row => row.amountKrw));
}

function factPayload(fact: ReportFact) {
  // Explicit projection prevents an accidental adapter payload/ref/name field escaping into report storage.
  return json({ component: fact.component, factKey: fact.factKey, productName: fact.productName, saleUnitName: fact.saleUnitName,
    amountKrw: fact.amountKrw, completeAmountKrw: fact.completeAmountKrw, profitBeforeAds: fact.profitBeforeAds,
    completeProfitBeforeAds: fact.completeProfitBeforeAds, originalAmount: fact.originalAmount, currency: fact.currency,
    quantity: fact.quantity, attribution: fact.attribution, medium: fact.medium, marketplace: fact.marketplace, commonKind: fact.commonKind,
    rowsCount: fact.rowsCount, quality: { isEstimate: fact.quality.isEstimate, confidence: fact.quality.confidence,
      issues: fact.quality.issues.filter(issue => /^[A-Z][A-Z0-9_:.-]{0,127}$/.test(issue)) } });
}

/** Durable account/day jobs. Only workers read sources; queueing never calls an adapter. */
@Injectable()
export class UnifiedAggregationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(partitions: readonly SourcePartition[], actorId: string, reason: string, idempotencyKey?: string) {
    const normalized = canonicalPartitions(partitions);
    if (typeof reason !== "string" || !reason.trim() || reason.length > 1024) throw new Error("INVALID_AGGREGATION_REASON");
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 128))
      throw new Error("INVALID_AGGREGATION_IDEMPOTENCY_KEY");
    const rootId = idempotencyKey === undefined ? randomUUID() : aggregationRequestId(actorId, idempotencyKey);
    const fingerprint = digest([normalized, reason.trim()]);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(21407, hashtext(${rootId}))::text`);
      const existing = await tx.unifiedAggregationRun.findUnique({ where: { id: rootId } });
      if (existing) {
        if ((existing.checkpoint as { enqueueFingerprint?: string } | null)?.enqueueFingerprint !== fingerprint || existing.requestedBy !== actorId)
          conflict("REBUILD_IDEMPOTENCY_CONFLICT");
        const rows = await tx.unifiedAggregationRun.findMany({ where: { id: { in: normalized.map((part, index) =>
          index === 0 ? rootId : aggregationRequestId(rootId, JSON.stringify(part))) } }, orderBy: { id: "asc" } });
        if (rows.length !== normalized.length) conflict("REBUILD_QUEUE_INCOMPLETE");
        return { jobs: rows.map(safeJob) };
      }
      await tx.unifiedAggregationRun.createMany({ data: normalized.map((part, index) => ({
        id: index === 0 ? rootId : aggregationRequestId(rootId, JSON.stringify(part)), ...partitionWhere(part), status: "STAGING",
        idempotencyKey: idempotencyKey === undefined ? null : digest([rootId, part]), requestedBy: actorId, reason: reason.trim(),
        contractVersion: CONTRACT_VERSION, versions: {}, readSnapshotId: randomUUID(), sourceWatermarks: {}, controlTotals: [], issues: [],
        checkpoint: { phase: "QUEUED", enqueueFingerprint: fingerprint, requestId: rootId }
      })) });
      const rows = await tx.unifiedAggregationRun.findMany({ where: { id: { in: normalized.map((part, index) =>
        index === 0 ? rootId : aggregationRequestId(rootId, JSON.stringify(part))) } }, orderBy: { id: "asc" } });
      return { jobs: rows.map(safeJob) };
    }, { timeout: 30000 });
  }

  async readJobs(runIds: readonly string[]): Promise<AggregationJob[]> {
    if (!Array.isArray(runIds) || runIds.length > 5000) throw new Error("INVALID_AGGREGATION_JOB_IDS");
    const rows = await this.prisma.unifiedAggregationRun.findMany({ where: { id: { in: [...runIds] } }, orderBy: { id: "asc" } });
    return rows.map(safeJob);
  }

  async claim(runId?: string, leaseMs = 300000): Promise<AggregationClaim | null> {
    leaseDuration(leaseMs);
    const now = new Date();
    let cursor: string | undefined;
    while (true) {
      const candidates = await this.prisma.unifiedAggregationRun.findMany({
      where: { ...(runId ? { id: runId } : {}), status: "STAGING", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ startedAt: "asc" }, { id: "asc" }], take: runId ? 1 : 50
      });
      for (const candidate of candidates) {
      const part: SourcePartition = { platform: candidate.platform as SourcePartition["platform"], scopeKey: candidate.scopeKey, date: day(candidate.businessDate) };
      const claimed = await this.prisma.$transaction(async tx => {
        const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`SELECT pg_try_advisory_xact_lock(21408, hashtext(${JSON.stringify(part)})) AS acquired`);
        if (!lock?.acquired) return null;
        const at = new Date();
        const active = await tx.unifiedAggregationRun.findFirst({ where: { ...partitionWhere(part), id: { not: candidate.id }, status: "STAGING", leaseExpiresAt: { gt: at } }, select: { id: true } });
        if (active) return null;
        const current = await tx.unifiedAggregationRun.findUnique({ where: { id: candidate.id } });
        if (!current || current.status !== "STAGING" || current.leaseExpiresAt && current.leaseExpiresAt > at) return null;
        const previous = await tx.unifiedSourcePublication.findUnique({ where: pointerWhere(part), select: { runId: true } });
        const token = randomUUID(), previousRunId = previous?.runId ?? null;
        const changed = await tx.unifiedAggregationRun.updateMany({ where: { id: candidate.id, status: "STAGING", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: at } }] },
          data: { leaseToken: token, leaseExpiresAt: new Date(at.getTime() + leaseMs), attempts: { increment: 1 },
            checkpoint: json({ ...(current.checkpoint as object ?? {}), phase: "READING", previousRunId }), issues: [] } });
        return changed.count === 1 ? { ...part, runId: candidate.id, token, previousRunId } : null;
      });
        if (claimed) return claimed;
      }
      if (runId || candidates.length < 50) return null;
      // Locked early partitions must not starve unrelated sources later in the queue.
      cursor = candidates[candidates.length - 1].id;
    }
  }

  async heartbeat(claim: AggregationClaim, leaseMs = 300000): Promise<boolean> {
    leaseDuration(leaseMs); const now = new Date();
    const changed = await this.prisma.unifiedAggregationRun.updateMany({
      where: { id: claim.runId, status: "STAGING", leaseToken: claim.token, leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: new Date(now.getTime() + leaseMs) }
    });
    return changed.count === 1;
  }

  async stageAndPublish(claim: AggregationClaim, request: AdapterRequest, batch: AdapterBatch, facts: readonly ReportFact[]): Promise<void> {
    if (request.runId !== claim.runId || request.from !== claim.date || request.to !== claim.date || request.scopeKeys.length !== 1 || request.scopeKeys[0] !== claim.scopeKey)
      throw new Error("AGGREGATION_REQUEST_PARTITION_MISMATCH");
    assertAdapterBatch(request, claim.platform, batch);
    if (batch.nextCursor !== null) throw new Error("AGGREGATION_DAY_NOT_FINISHED");
    const components = PLATFORM_COMPONENTS[claim.platform] as readonly string[];
    if (batch.coverage.length !== components.length || components.some(component => batch.coverage.filter(c => c.component === component).length !== 1))
      throw new Error("AGGREGATION_COVERAGE_INCOMPLETE");
    if (batch.sourceControlTotals.some(total => total.difference !== null && !money(total.difference).isZero()))
      throw new Error("AGGREGATION_SOURCE_CONTROL_DIFFERENCE");
    if (facts.length > 50000 || new Set(facts.map(f => JSON.stringify([f.component, f.factKey]))).size !== facts.length)
      throw new Error("AGGREGATION_REPORT_FACTS_INVALID");
    for (const fact of facts) {
      for (const amount of [fact.amountKrw, fact.completeAmountKrw, fact.profitBeforeAds, fact.completeProfitBeforeAds, fact.originalAmount]) if (amount !== null) money(amount);
      if (fact.quantity !== null) quantity(fact.quantity);
    }
    assertReportConservation(batch, facts);
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(21408, hashtext(${JSON.stringify({ platform: claim.platform, scopeKey: claim.scopeKey, date: claim.date })}))::text`);
      const now = new Date();
      const current = await tx.unifiedAggregationRun.findUnique({ where: { id: claim.runId } });
      if (!current) throw new ConflictException({ code: "AGGREGATION_LEASE_LOST", message: "집계 실행이 없습니다." });
      if (current.status !== "STAGING" || current.leaseToken !== claim.token || !current.leaseExpiresAt || current.leaseExpiresAt <= now)
        conflict("AGGREGATION_LEASE_LOST");
      const pointer = await tx.unifiedSourcePublication.findUnique({ where: pointerWhere(claim) });
      if ((pointer?.runId ?? null) !== claim.previousRunId) conflict("AGGREGATION_PUBLICATION_CONFLICT");
      // Full partition replacement handles deletions and confirmed zero-row corrections.
      await tx.unifiedDailyFact.deleteMany({ where: { runId: claim.runId } });
      await tx.unifiedSourceCoverage.deleteMany({ where: { runId: claim.runId } });
      await tx.unifiedProductMatchResult.deleteMany({ where: { runId: claim.runId } });
      // Keep per-source-line provenance behind the writer boundary, using hashes instead of raw order/name fields.
      const matchRows = [...batch.sales, ...batch.adSpends].map(fact => ({
        runId: claim.runId, sourceKey: logicalSourceKey(fact.ref), nameInputHash: fact.name.nameInputHash,
        ruleVersion: fact.name.nameRuleVersion, matchStatus: fact.name.matchStatus, productName: fact.productName,
        evidence: json({ platform: fact.ref.platform, scopeKey: fact.ref.scopeKey, date: fact.ref.businessDate,
          sourceSystem: fact.ref.sourceSystem, recordKind: fact.ref.recordKind, sourceVersion: fact.ref.sourceVersion,
          sourcePayloadHash: fact.ref.payloadHash, selectedSource: fact.ref.selectedSource,
          ruleIds: fact.name.ruleIds, candidateNames: fact.name.candidateNames,
          ...("operatingRevenue" in fact ? { operatingRevenue: fact.operatingRevenue, profitBeforeAds: fact.profitBeforeAds } :
            { amountKrw: fact.amountKrw, originalAmount: fact.originalAmount, currency: fact.currency }),
          allocationRuleVersion: request.allocationRuleVersion })
      }));
      for (let offset = 0; offset < matchRows.length; offset += 1000)
        await tx.unifiedProductMatchResult.createMany({ data: matchRows.slice(offset, offset + 1000) });
      if (facts.length) await tx.unifiedDailyFact.createMany({ data: facts.map(fact => ({
        runId: claim.runId, component: fact.component, factKey: fact.factKey, productName: fact.productName, saleUnitName: fact.saleUnitName,
        amountKrw: fact.amountKrw, originalAmount: fact.originalAmount, currency: fact.currency, quantity: fact.quantity, attribution: fact.attribution,
        payload: factPayload(fact)
      })) });
      await tx.unifiedSourceCoverage.createMany({ data: batch.coverage.map(coverage => ({
        runId: claim.runId, component: coverage.component, participation: coverage.participation, collectionState: coverage.collectionState,
        zeroConfirmed: coverage.zeroConfirmed, rowsPresent: coverage.rowsPresent, sourceAsOf: coverage.sourceAsOf ? new Date(coverage.sourceAsOf) : null,
        isEstimate: coverage.quality.isEstimate, details: json(coverage)
      })) });
      const { scopePolicyVersion, nameRuleVersion, saleUnitRuleVersion, allocationRuleVersion, calculationVersion, fxVersion } = request;
      await tx.unifiedAggregationRun.update({ where: { id: claim.runId }, data: { status: "READY", versions: {
        scopePolicyVersion, nameRuleVersion, saleUnitRuleVersion, allocationRuleVersion, calculationVersion, fxVersion,
        participationOverrides: json(request.sourcePolicySnapshot.participationOverrides ?? {})
      }, sourceWatermarks: json(request.sourceWatermarks), readSnapshotId: request.readSnapshotId, sourceFingerprint: batch.sourceFingerprint,
        controlTotals: json(batch.sourceControlTotals), completedAt: now, checkpoint: json({ ...(current.checkpoint as object ?? {}), phase: "READY", previousRunId: claim.previousRunId }) } });
      if (pointer) {
        const changed = await tx.unifiedSourcePublication.updateMany({ where: { ...partitionWhere(claim), runId: claim.previousRunId! },
          data: { runId: claim.runId, revision: { increment: 1 }, updatedAt: now } });
        if (changed.count !== 1) conflict("AGGREGATION_PUBLICATION_CONFLICT");
      } else await tx.unifiedSourcePublication.create({ data: { ...partitionWhere(claim), runId: claim.runId, revision: 1, updatedAt: now } });
      await tx.unifiedAggregationRun.update({ where: { id: claim.runId }, data: { status: "PUBLISHED", publishedAt: now,
        leaseToken: null, leaseExpiresAt: null } });
    }, { timeout: 30000 });
  }

  async fail(claim: AggregationClaim, issue = "SOURCE_READ_FAILED"): Promise<boolean> {
    // Never persist raw provider/SQL errors, which can contain private source fields.
    const safeIssue = /^[A-Z][A-Z0-9_]{0,95}$/.test(issue) ? issue : "SOURCE_READ_FAILED";
    const current = await this.prisma.unifiedAggregationRun.findUnique({ where: { id: claim.runId } });
    if (!current) return false;
    const changed = await this.prisma.unifiedAggregationRun.updateMany({ where: { id: claim.runId, status: "STAGING", leaseToken: claim.token, leaseExpiresAt: { gt: new Date() } },
      data: { status: "FAILED", issues: [safeIssue], completedAt: new Date(), leaseToken: null, leaseExpiresAt: null,
        checkpoint: json({ ...(current.checkpoint as object ?? {}), phase: "FAILED" }) } });
    return changed.count === 1;
  }
}
