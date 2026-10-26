import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import {
  Prisma, RowValidationStatus, RunUnitStatus, SecurityAuditActorType, SecurityAuditResult,
  SourceCoverageState, SourceDataKind, SourceKind, SourceProvider, SyncRunStatus, SyncTrigger
} from "@prisma/client";
import { HeavyOperationGate, HeavyOperationLease } from "../common/heavy-operation";
import { PrismaService } from "../common/prisma.service";
import { writeSecurityAudit } from "../security-audit/security-audit.types";
import { accountAllowlist, accountKey } from "./source-connections.service";
import { scheduledRunPurpose } from "./schedule-definition";
import { lockCanonicalConnection } from "./canonical-write-policy";
import type { MetaFailureDiagnosticCode } from "./meta-failure-diagnostic";
import type { Cafe24FailureDiagnosticCode } from "./cafe24-failure-diagnostic";
import {
    assertBoundedRows, assertScheduledWindowCadence, assertSyncRunScope,
    assertSyncRunShape, assertEnabled, MAX_RUN_MS, parseDateRange,
  safeSyncCode, syncError
} from "./sync-contract";

type LeaseRow = { generation: bigint };
export type ClaimedRun = { runId: string; connectionId: string; generation: bigint; release: () => void };
export type PublishSlice = {
  dataKind: SourceDataKind;
  source: SourceKind;
  policyVersion: number;
  fetchedCount: number;
  pageCount: number;
  complete: boolean;
  totalAmount?: Prisma.Decimal | null;
};
export type PublishUnit = {
  runId: string;
  unitKey: string;
  generation: bigint;
  metricDate: Date;
  slices: PublishSlice[];
  checkpointValue?: string | null;
  // A provider adapter writes every required kind in this one transaction.
  writeRows: (tx: Prisma.TransactionClient) => Promise<Partial<Record<SourceDataKind, number>>>;
};
export type PublishCafe24Window = {
  runId: string; unitKey: string; generation: bigint; windowDate: Date;
  windowStart?: Date; windowEnd?: Date;
  affectedDates: Array<{ orderDate: Date; policyVersion: number }>;
  daySnapshot?: boolean;
  fetchedCount: number; pageCount: number; complete: boolean;
  checkpointValue?: string | null;
  // Changed orders may belong to dates outside the updatedAt window. The
  // callback and checkpoint commit together; absent orders are never removed.
  writeRows: (tx: Prisma.TransactionClient) => Promise<number>;
};
export type Cafe24WindowPlan = {
  windowDate: Date; windowStart: Date; windowEnd: Date;
};

@Injectable()
export class SyncFoundationService {
  constructor(private readonly prisma: PrismaService, private readonly heavy: HeavyOperationGate) {}

  /** Replace queued day placeholders with the complete updatedAt interval plan before claiming a run. */
  async planCafe24Windows(runId: string, windows: Cafe24WindowPlan[]) {
    assertEnabled();
    if (windows.length === 0 || windows.length > 366) syncError("RECONCILIATION_FAILED");
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.syncRun.findUnique({ where: { id: runId } });
      if (!run) throw new NotFoundException();
      if (run.status !== SyncRunStatus.QUEUED || run.startedAt)
        syncError("RECONCILIATION_FAILED");
      await lockCanonicalConnection(tx, run.connectionId);
      const provider = await assertActiveConnection(tx, run.connectionId);
      if (provider !== SourceProvider.CAFE24) syncError("ACCOUNT_SCOPE_MISMATCH");
      const expectedDays = new Set<string>();
      for (let date = run.fromDate.getTime(); date <= run.toDate.getTime(); date += 86_400_000)
        expectedDays.add(new Date(date).toISOString().slice(0, 10));
      const plannedDays = new Set<string>();
      const keys = windows.map((window) => {
        if (!(window.windowDate instanceof Date) || !Number.isFinite(window.windowDate.getTime()) ||
            !(window.windowStart instanceof Date) || !Number.isFinite(window.windowStart.getTime()) ||
            !(window.windowEnd instanceof Date) || !Number.isFinite(window.windowEnd.getTime()) ||
            window.windowDate.toISOString().slice(10) !== "T00:00:00.000Z" ||
            window.windowStart >= window.windowEnd ||
            window.windowEnd.getTime() - window.windowStart.getTime() > 172_800_000)
          syncError("RECONCILIATION_FAILED");
        const day = window.windowDate.toISOString().slice(0, 10);
        if (!expectedDays.has(day) ||
            formatInTimeZone(new Date(window.windowEnd.getTime() - 1), "Asia/Seoul", "yyyy-MM-dd") !== day)
          syncError("ACCOUNT_SCOPE_MISMATCH");
        plannedDays.add(day);
        return `cafe24-window:${window.windowStart.toISOString()}:${window.windowEnd.toISOString()}`;
      });
      if (plannedDays.size !== expectedDays.size || new Set(keys).size !== keys.length)
        syncError("RECONCILIATION_FAILED");
      const existing = await tx.runUnit.findMany({ where: { runId },
        select: { unitKey: true, status: true, attempts: true } });
      if (existing.some((unit) => unit.status !== RunUnitStatus.QUEUED || unit.attempts !== 0))
        syncError("RECONCILIATION_FAILED");
      const existingKeys = existing.map((unit) => unit.unitKey).sort();
      if (JSON.stringify(existingKeys) === JSON.stringify([...keys].sort())) return;
      if (JSON.stringify(existingKeys) !== JSON.stringify([...expectedDays].sort()))
        syncError("RECONCILIATION_FAILED");
      await tx.runUnit.deleteMany({ where: { runId } });
      await tx.runUnit.createMany({ data: keys.map((unitKey) => ({ runId, unitKey })) });
    }, { timeout: 5_000, maxWait: 2_000 });
  }

  async queueRun(input: {
    connectionId: string; fromDate: string; toDate: string; trigger: SyncTrigger;
    requestKey: string; actorUserId: string | null; reason?: string;
  }) {
    assertEnabled();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(input.requestKey)) syncError("RUN_LIMIT_EXCEEDED", 400);
    if (input.reason && !/^[A-Z][A-Z0-9_]{2,63}$/.test(input.reason)) syncError("RUN_LIMIT_EXCEEDED", 400);
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: input.connectionId } });
    if (!connection) throw new NotFoundException();
    if (!accountAllowlist().has(accountKey(connection.provider, connection.externalAccountId, connection.shopKey))) {
      syncError("ACCOUNT_SCOPE_MISMATCH");
    }
    const now = new Date();
    const { from, to, days } = parseDateRange(input.fromDate, input.toDate, now, connection.timeZone);
    const scope = { ...input, provider: connection.provider, timeZone: connection.timeZone };
    assertSyncRunShape(scope, now);
    const existing = await this.prisma.syncRun.findUnique({
      where: { connectionId_requestKey: { connectionId: input.connectionId, requestKey: input.requestKey } }
    });
    if (existing) {
      if (existing.fromDate.getTime() !== from.getTime() || existing.toDate.getTime() !== to.getTime() ||
          existing.trigger !== input.trigger || existing.actorUserId !== input.actorUserId) {
        syncError("RUN_LIMIT_EXCEEDED");
      }
      return existing;
    }
    if (!connection.enabled || connection.accessState !== "READY" ||
        (connection.credentialExpiresAt && connection.credentialExpiresAt <= new Date())) {
      syncError("PROVIDER_AUTH_REQUIRED");
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockCanonicalConnection(tx, input.connectionId);
        const raced = await tx.syncRun.findUnique({
          where: { connectionId_requestKey: { connectionId: input.connectionId,
            requestKey: input.requestKey } }
        });
        if (raced) {
          if (raced.fromDate.getTime() !== from.getTime() || raced.toDate.getTime() !== to.getTime() ||
              raced.trigger !== input.trigger || raced.actorUserId !== input.actorUserId)
            syncError("RUN_LIMIT_EXCEEDED");
          return raced;
        }
        const overlapping = input.trigger === SyncTrigger.SCHEDULED
          ? await tx.syncRun.findMany({ where: {
            connectionId: input.connectionId, trigger: SyncTrigger.SCHEDULED,
            fromDate: { lte: to }, toDate: { gte: from }
          }, select: { fromDate: true, toDate: true, status: true, requestKey: true }, take: 101 })
          : [];
        // Meta daily/weekly and Google D-1/D-7 deliberately overlap. Within the same
        // purpose keep the original duplicate/retry checks and account lock.
        const samePurpose = connection.provider === "META" || connection.provider === "GOOGLE" ? overlapping.filter(row =>
          scheduledRunPurpose({ ...scope, requestKey: row.requestKey }) === scheduledRunPurpose(scope)) : overlapping;
        const failedRetry = assertScheduledWindowCadence(input, samePurpose);
        if (!failedRetry) assertSyncRunScope(scope, now);
        const run = await tx.syncRun.create({ data: {
          connectionId: input.connectionId, trigger: input.trigger, requestKey: input.requestKey,
          fromDate: from, toDate: to, status: SyncRunStatus.QUEUED,
          deadlineAt: null, actorUserId: input.actorUserId
        } });
        const units = Array.from({ length: days }, (_, offset) => ({
          runId: run.id,
          unitKey: new Date(from.getTime() + offset * 86_400_000).toISOString().slice(0, 10)
        }));
        await tx.runUnit.createMany({ data: units });
        await writeSecurityAudit(tx, {
          actorType: input.actorUserId ? SecurityAuditActorType.USER : SecurityAuditActorType.SYSTEM,
          actorUserId: input.actorUserId,
          action: "SYNC_RUN_QUEUED", targetType: "SYNC_RUN", targetId: run.id,
          result: SecurityAuditResult.REQUESTED,
          afterJson: { connectionId: input.connectionId, trigger: input.trigger,
            requestKeyHash: requestKeyHash(input.requestKey), reasonCode: input.reason ?? null }
        });
        return run;
      }, { timeout: 5_000 });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const raced = await this.prisma.syncRun.findUnique({
          where: { connectionId_requestKey: { connectionId: input.connectionId, requestKey: input.requestKey } }
        });
        if (raced && raced.fromDate.getTime() === from.getTime() && raced.toDate.getTime() === to.getTime() &&
            raced.trigger === input.trigger && raced.actorUserId === input.actorUserId) return raced;
      }
      throw error;
    }
  }

  /** No timer/polling is installed. A later provider worker calls this explicitly. */
  async claimRun(runId: string, invocationDeadlineAt?: number): Promise<ClaimedRun | null> {
    assertEnabled();
    const heavy = this.heavy.tryAcquire();
    if (!heavy) return null;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const run = await tx.syncRun.findUnique({ where: { id: runId } });
        if (!run || (run.status !== SyncRunStatus.QUEUED && run.status !== SyncRunStatus.PARTIAL)) return null;
        await assertActiveConnection(tx, run.connectionId);
        const rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
          INSERT INTO "sync_leases" ("connection_id", "owner_run_id", "generation", "expires_at", "updated_at")
          VALUES (${run.connectionId}::uuid, ${run.id}::uuid, 1, clock_timestamp() + interval '2 minutes', clock_timestamp())
          ON CONFLICT ("connection_id") DO UPDATE SET
            "owner_run_id" = EXCLUDED."owner_run_id",
            "generation" = "sync_leases"."generation" + 1,
            "expires_at" = EXCLUDED."expires_at",
            "updated_at" = clock_timestamp()
          WHERE "sync_leases"."expires_at" <= clock_timestamp()
          RETURNING "generation"
        `);
        if (!rows[0]) return null;
        await tx.syncRun.update({ where: { id: run.id }, data: {
          status: SyncRunStatus.RUNNING, startedAt: run.startedAt ?? new Date(),
          attemptCount: { increment: 1 }, nextAttemptAt: null,
          deadlineAt: new Date(Math.min(Date.now() + MAX_RUN_MS, invocationDeadlineAt ?? Infinity))
        } });
        return { connectionId: run.connectionId, generation: rows[0].generation };
      }, { timeout: 5_000 });
      if (!result) { heavy.release(); return null; }
      return { runId, ...result, release: once(heavy) };
    } catch (error) {
      heavy.release();
      throw error;
    }
  }

  async renewLease(claim: Pick<ClaimedRun, "runId" | "connectionId" | "generation">): Promise<boolean> {
    assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.syncRun.findUnique({ where: { id: claim.runId } });
      if (!run || run.connectionId !== claim.connectionId || run.status !== SyncRunStatus.RUNNING ||
          !run.deadlineAt || run.deadlineAt <= new Date()) return false;
      await assertActiveConnection(tx, claim.connectionId);
      const rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
        UPDATE "sync_leases" SET "expires_at" = clock_timestamp() + interval '2 minutes',
          "updated_at" = clock_timestamp()
        WHERE "connection_id" = ${claim.connectionId}::uuid
          AND "owner_run_id" = ${claim.runId}::uuid AND "generation" = ${claim.generation}
          AND "expires_at" > clock_timestamp()
        RETURNING "generation"
      `);
      return rows.length === 1;
    }, { timeout: 5_000, maxWait: 2_000 });
  }

  async beginScheduledUnit(claim: Pick<ClaimedRun, "runId" | "connectionId" | "generation">, unitKey: string) {
    return this.prisma.$transaction(async (tx) => {
      await assertFenced(tx, claim.connectionId, claim.runId, claim.generation);
      const run = await tx.syncRun.findUnique({ where: { id: claim.runId } });
      if (!run || run.trigger !== SyncTrigger.SCHEDULED || run.status !== SyncRunStatus.RUNNING ||
          !run.deadlineAt || run.deadlineAt <= new Date()) syncError("LEASE_LOST");
      const started = await tx.runUnit.updateMany({ where: { runId: claim.runId, unitKey,
        status: { in: [RunUnitStatus.QUEUED, RunUnitStatus.FAILED] }, attempts: { lt: 3 } },
        data: { status: RunUnitStatus.RUNNING, attempts: { increment: 1 } } });
      if (started.count !== 1) syncError("RUN_LIMIT_EXCEEDED");
    }, { timeout: 5_000, maxWait: 2_000 });
  }

  async publishUnit(input: PublishUnit) {
    assertEnabled();
    for (const slice of input.slices) {
      assertBoundedRows(slice.dataKind, slice.fetchedCount, slice.pageCount, slice.complete);
    }
    if (input.checkpointValue && input.checkpointValue.length > 512) syncError("RUN_LIMIT_EXCEEDED");
    let transactionOptions = { timeout: 5_000, maxWait: 2_000 };
    if (isMetaApiPublication(input.slices)) {
      // A complete Meta day can revisit existing entities and versions. Reserve
      // pool acquisition time within the same absolute run/unit deadline.
      const budget = await this.prisma.syncRun.findUnique({ where: { id: input.runId },
        select: { status: true, deadlineAt: true } });
      if (!budget || budget.status !== SyncRunStatus.RUNNING || !budget.deadlineAt) syncError("LEASE_LOST");
      transactionOptions = metaPublicationTransactionOptions(budget.deadlineAt);
    }
    // The prepared rows are already fetched and validated before this short transaction.
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.syncRun.findUnique({ where: { id: input.runId } });
      if (!run || run.status !== SyncRunStatus.RUNNING || !run.deadlineAt || run.deadlineAt <= new Date()) syncError("LEASE_LOST");
      await lockCanonicalConnection(tx, run.connectionId);
      await assertFenced(tx, run.connectionId, run.id, input.generation);
      const provider = await assertActiveConnection(tx, run.connectionId);
      assertCompleteKinds(provider, input.slices);
      if (input.metricDate < run.fromDate || input.metricDate > run.toDate ||
          input.unitKey !== input.metricDate.toISOString().slice(0, 10)) syncError("ACCOUNT_SCOPE_MISMATCH");
      const unit = await tx.runUnit.findUnique({ where: { runId_unitKey: { runId: run.id, unitKey: input.unitKey } } });
      if (!unit) syncError("ACCOUNT_SCOPE_MISMATCH");
      if (unit.status === RunUnitStatus.SUCCEEDED) return { published: unit.publishedCount };
      for (const slice of input.slices) {
        const policy = await tx.sourcePolicy.findFirst({ where: {
          connectionId: run.connectionId, dataKind: slice.dataKind,
          fromDate: { lte: input.metricDate },
          OR: [{ toDate: null }, { toDate: { gt: input.metricDate } }]
        } });
        if (!policy || policy.version !== slice.policyVersion || policy.primarySource !== slice.source) {
          syncError("SOURCE_SELECTION_REQUIRED");
        }
      }
      const publishedByKind = await input.writeRows(tx);
      if (Object.keys(publishedByKind).length !== input.slices.length) syncError("RECONCILIATION_FAILED");
      let fetched = 0;
      let published = 0;
      for (const slice of input.slices) {
        const count = publishedByKind[slice.dataKind];
        if (!Number.isSafeInteger(count) || count! < 0 || count! > slice.fetchedCount) {
          syncError("RECONCILIATION_FAILED");
        }
        fetched += slice.fetchedCount;
        published += count!;
      }
      await tx.runUnit.upsert({
        where: { runId_unitKey: { runId: run.id, unitKey: input.unitKey } },
        create: { runId: run.id, unitKey: input.unitKey, status: RunUnitStatus.SUCCEEDED,
          attempts: 1, fetchedCount: fetched, publishedCount: published,
          checkpointValue: input.checkpointValue ?? null, completedAt: new Date() },
        update: { status: RunUnitStatus.SUCCEEDED, attempts: { increment: unit.status === RunUnitStatus.RUNNING ? 0 : 1 },
          fetchedCount: fetched, publishedCount: published,
          checkpointValue: input.checkpointValue ?? null, completedAt: new Date() }
      });
      const now = new Date();
      for (const slice of input.slices) {
        const count = publishedByKind[slice.dataKind]!;
        await tx.sourceCoverage.upsert({
          where: { connectionId_dataKind_metricDate: {
            connectionId: run.connectionId, dataKind: slice.dataKind, metricDate: input.metricDate
          } },
          create: { connectionId: run.connectionId, dataKind: slice.dataKind,
            metricDate: input.metricDate, source: slice.source,
            state: count === 0 ? SourceCoverageState.COMPLETE_ZERO : SourceCoverageState.COMPLETE_NONZERO,
            lastAttemptRunId: run.id, lastSuccessRunId: run.id, lastAttemptAt: now, lastSuccessAt: now,
            rowCount: count, totalAmount: slice.totalAmount ?? null, warningCodes: [] },
          update: { source: slice.source,
            state: count === 0 ? SourceCoverageState.COMPLETE_ZERO : SourceCoverageState.COMPLETE_NONZERO,
            lastAttemptRunId: run.id, lastSuccessRunId: run.id, lastAttemptAt: now, lastSuccessAt: now,
            rowCount: count, totalAmount: slice.totalAmount ?? null, warningCodes: [] }
        });
      }
      await tx.syncRun.update({ where: { id: run.id }, data: {
        rowsFetched: { increment: fetched }, rowsPublished: { increment: published }
      } });
      await writeSecurityAudit(tx, {
        ...auditActor(run), action: "SYNC_UNIT_PUBLISHED", targetType: "RUN_UNIT",
        targetId: `${run.id}:${input.unitKey}`, result: SecurityAuditResult.SUCCESS,
        afterJson: { connectionId: run.connectionId, requestKeyHash: requestKeyHash(run.requestKey),
          dataKinds: input.slices.map((slice) => slice.dataKind), fetched, published }
      });
      await assertFenced(tx, run.connectionId, run.id, input.generation);
      if (run.deadlineAt <= new Date()) syncError("RUN_LIMIT_EXCEEDED");
      return { published };
    }, transactionOptions);
  }

  async publishCafe24Window(input: PublishCafe24Window) {
    assertEnabled();
    assertBoundedRows(SourceDataKind.CAFE24_ORDER, input.fetchedCount, input.pageCount, input.complete);
    if (input.checkpointValue && input.checkpointValue.length > 512) syncError("RUN_LIMIT_EXCEEDED");
    const dayKey = input.windowDate.toISOString().slice(0, 10);
    const intervalKey = input.windowStart && input.windowEnd
      ? `cafe24-window:${input.windowStart.toISOString()}:${input.windowEnd.toISOString()}` : null;
    if (input.windowDate.toISOString().slice(10) !== "T00:00:00.000Z" ||
        (input.daySnapshot ? input.unitKey !== dayKey || intervalKey !== null
          : input.unitKey !== intervalKey || !input.windowStart || !input.windowEnd ||
            input.windowStart >= input.windowEnd ||
            input.windowEnd.getTime() - input.windowStart.getTime() > 172_800_000) ||
        (input.daySnapshot
          ? input.affectedDates.length !== 1 ||
            input.affectedDates[0].orderDate.getTime() !== input.windowDate.getTime()
          : (input.fetchedCount === 0) !== (input.affectedDates.length === 0)))
      syncError("RECONCILIATION_FAILED");
    const dateKeys = input.affectedDates.map((item) => item.orderDate.toISOString().slice(0, 10));
    if (new Set(dateKeys).size !== dateKeys.length ||
        input.affectedDates.some((item) => !Number.isSafeInteger(item.policyVersion) || item.policyVersion < 1 ||
          item.orderDate.toISOString().slice(10) !== "T00:00:00.000Z")) syncError("RECONCILIATION_FAILED");
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.syncRun.findUnique({ where: { id: input.runId } });
      if (!run || run.status !== SyncRunStatus.RUNNING || !run.deadlineAt ||
          run.deadlineAt <= new Date()) syncError("LEASE_LOST");
      await lockCanonicalConnection(tx, run.connectionId);
      await assertFenced(tx, run.connectionId, run.id, input.generation);
      const provider = await assertActiveConnection(tx, run.connectionId);
      if (provider !== SourceProvider.CAFE24 || input.windowDate < run.fromDate ||
          input.windowDate > run.toDate)
        syncError("ACCOUNT_SCOPE_MISMATCH");
      const unit = await tx.runUnit.findUnique({ where: {
        runId_unitKey: { runId: run.id, unitKey: input.unitKey }
      } });
      if (!unit) syncError("ACCOUNT_SCOPE_MISMATCH");
      if (unit.status === RunUnitStatus.SUCCEEDED) return { published: unit.publishedCount };
      const shadowDates = new Set<string>();
      for (const item of input.affectedDates) {
        const policy = await tx.sourcePolicy.findFirst({ where: {
          connectionId: run.connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
          fromDate: { lte: item.orderDate },
          OR: [{ toDate: null }, { toDate: { gt: item.orderDate } }]
        } });
        if (!policy || policy.version !== item.policyVersion ||
            (policy.primarySource !== SourceKind.API &&
              !(input.daySnapshot && policy.primarySource === SourceKind.CSV)))
          syncError("SOURCE_SELECTION_REQUIRED");
        if (policy.primarySource === SourceKind.CSV)
          shadowDates.add(item.orderDate.toISOString());
      }
      const published = await input.writeRows(tx);
      if (!Number.isSafeInteger(published) || published < 0 || published > input.fetchedCount)
        syncError("RECONCILIATION_FAILED");
      const now = new Date();
      for (const item of input.affectedDates) {
        const previous = await tx.sourceCoverage.findUnique({ where: {
          connectionId_dataKind_metricDate: {
            connectionId: run.connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
            metricDate: item.orderDate
          }
        } });
        // A failed retry may change state while retaining the last verified
        // API snapshot. An unverified delta clears these success pointers.
        const verifiedBaseline = input.daySnapshot || (previous?.source === SourceKind.API &&
          previous.lastSuccessRunId != null && previous.lastSuccessAt != null);
        const projection = await tx.cafe24OrderLine.findMany({ where: {
          connectionId: run.connectionId, source: SourceKind.API,
          orderDate: item.orderDate, isCurrent: true,
          validationStatus: { not: "ERROR" }
        }, select: { orderNo: true, totalPaidKrw: true, validationStatus: true } });
        const orderAmounts = new Map<string, Prisma.Decimal>();
        for (const row of projection) {
          if (!row.orderNo || !row.totalPaidKrw) syncError("RECONCILIATION_FAILED");
          const previous = orderAmounts.get(row.orderNo);
          if (previous && !previous.eq(row.totalPaidKrw)) syncError("RECONCILIATION_FAILED");
          orderAmounts.set(row.orderNo, row.totalPaidKrw);
        }
        const paidTotal = [...orderAmounts.values()].reduce((sum, value) => sum.plus(value),
          new Prisma.Decimal(0));
        const rowCount = projection.length;
        const state = verifiedBaseline
          ? rowCount === 0 ? SourceCoverageState.COMPLETE_ZERO : SourceCoverageState.COMPLETE_NONZERO
          : SourceCoverageState.PARTIAL;
        const hasUnmatchedMapping = projection.some((row) =>
          row.validationStatus === RowValidationStatus.UNMATCHED);
        const warningCodes = verifiedBaseline
          ? input.daySnapshot
            ? ["CAFE24_CACHE_FRESHNESS_UNVERIFIED", "CAFE24_PAST_CHANGES_REQUIRE_MANUAL_DAY_RERUN",
              ...(hasUnmatchedMapping ? ["CAFE24_PRODUCT_MAPPING_INCOMPLETE"] : []),
              ...(shadowDates.has(item.orderDate.toISOString()) ? ["CAFE24_SHADOW_NOT_PRIMARY"] : [])]
            : []
          : ["CAFE24_BASELINE_UNVERIFIED"];
        await tx.sourceCoverage.upsert({ where: {
          connectionId_dataKind_metricDate: {
            connectionId: run.connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
            metricDate: item.orderDate
          }
        }, create: {
          connectionId: run.connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
          metricDate: item.orderDate, source: SourceKind.API,
          state, lastAttemptRunId: run.id,
          lastSuccessRunId: verifiedBaseline ? run.id : null,
          lastAttemptAt: now, lastSuccessAt: verifiedBaseline ? now : null,
          rowCount, totalAmount: paidTotal,
          warningCodes
        }, update: {
          source: SourceKind.API, state, lastAttemptRunId: run.id,
          lastSuccessRunId: verifiedBaseline ? run.id : null,
          lastAttemptAt: now, lastSuccessAt: verifiedBaseline ? now : null,
          rowCount, totalAmount: paidTotal,
          warningCodes
        } });
      }
      await tx.runUnit.update({ where: { runId_unitKey: { runId: run.id, unitKey: input.unitKey } },
        data: { status: RunUnitStatus.SUCCEEDED, attempts: { increment: unit.status === RunUnitStatus.RUNNING ? 0 : 1 },
          fetchedCount: input.fetchedCount, publishedCount: published,
          checkpointValue: input.checkpointValue ?? null, completedAt: now } });
      await tx.syncRun.update({ where: { id: run.id }, data: {
        rowsFetched: { increment: input.fetchedCount }, rowsPublished: { increment: published }
      } });
      await writeSecurityAudit(tx, {
        ...auditActor(run), action: "SYNC_UNIT_PUBLISHED", targetType: "RUN_UNIT",
        targetId: `${run.id}:${input.unitKey}`, result: SecurityAuditResult.SUCCESS,
        afterJson: { connectionId: run.connectionId, requestKeyHash: requestKeyHash(run.requestKey),
          dataKinds: [SourceDataKind.CAFE24_ORDER], fetched: input.fetchedCount,
          published, affectedDateCount: input.affectedDates.length,
          sourcePolicyVersion: input.affectedDates.length===1 ? input.affectedDates[0].policyVersion : null }
      });
      await assertFenced(tx, run.connectionId, run.id, input.generation);
      if (run.deadlineAt <= new Date()) syncError("RUN_LIMIT_EXCEEDED");
      return { published };
    }, { timeout: 30_000, maxWait: 2_000 });
  }

  async failUnit(input: {
    runId: string; generation: bigint; unitKey: string; dataKinds: SourceDataKind[];
    metricDate: Date; source: SourceKind; code: string; actionRequired: boolean;
    diagnosticCode?: "GOOGLE_AUTH_REFRESH_FAILED" | "GOOGLE_ACCESS_TOKEN_REJECTED" |
      "GOOGLE_ADS_ACCESS_DENIED" | "GOOGLE_CUSTOMER_NOT_FOUND" |
      Cafe24FailureDiagnosticCode | MetaFailureDiagnosticCode | null;
  }) {
    assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.syncRun.findUnique({ where: { id: input.runId } });
      if (!run || run.status !== SyncRunStatus.RUNNING) syncError("LEASE_LOST");
      await assertFenced(tx, run.connectionId, run.id, input.generation);
      const dayKey = input.metricDate.toISOString().slice(0, 10);
      if (input.metricDate < run.fromDate || input.metricDate > run.toDate ||
          (input.unitKey !== dayKey &&
            !(input.dataKinds.length === 1 && input.dataKinds[0] === SourceDataKind.CAFE24_ORDER &&
              connectionWindowKey(input.unitKey, dayKey)))) syncError("ACCOUNT_SCOPE_MISMATCH");
      const unit = await tx.runUnit.findUnique({ where: { runId_unitKey: { runId: run.id, unitKey: input.unitKey } } });
      if (!unit) syncError("ACCOUNT_SCOPE_MISMATCH");
      if (unit.status === RunUnitStatus.SUCCEEDED) syncError("RECONCILIATION_FAILED");
      const connection = await tx.sourceConnection.findUnique({ where: { id: run.connectionId } });
      if (!connection) syncError("ACCOUNT_SCOPE_MISMATCH");
      assertCompleteKinds(connection.provider, input.dataKinds.map((dataKind) => ({ dataKind, source: input.source })));
      const now = new Date();
      const status = input.actionRequired ? RunUnitStatus.ACTION_REQUIRED : RunUnitStatus.FAILED;
      const state = input.code === "FIELD_UNSUPPORTED"
        ? SourceCoverageState.UNSUPPORTED : SourceCoverageState.FAILED;
      const warningCodes = [safeSyncCode(input.code),
        ...(input.diagnosticCode ? [input.diagnosticCode] : [])];
      await tx.runUnit.upsert({
        where: { runId_unitKey: { runId: run.id, unitKey: input.unitKey } },
        create: { runId: run.id, unitKey: input.unitKey, status, attempts: 1, fetchedCount: 0, publishedCount: 0 },
        update: { status, attempts: { increment: unit.status === RunUnitStatus.RUNNING ? 0 : 1 } }
      });
      for (const dataKind of input.dataKinds) {
        const previous = dataKind === SourceDataKind.CAFE24_ORDER
          ? await tx.sourceCoverage.findUnique({ where: { connectionId_dataKind_metricDate: {
            connectionId: run.connectionId, dataKind, metricDate: input.metricDate
          } } }) : null;
        const stableWarnings = previous?.lastSuccessRunId && previous.lastSuccessAt
          ? previous.warningCodes.filter((code) => [
            "CAFE24_CACHE_FRESHNESS_UNVERIFIED",
            "CAFE24_PAST_CHANGES_REQUIRE_MANUAL_DAY_RERUN",
            "CAFE24_PRODUCT_MAPPING_INCOMPLETE",
            "CAFE24_SHADOW_NOT_PRIMARY",
            "CAFE24_SOURCE_ACTIVATION_REQUIRED"
          ].includes(code)) : [];
        const currentWarnings = [...new Set([...warningCodes, ...stableWarnings])];
        await tx.sourceCoverage.upsert({
          where: { connectionId_dataKind_metricDate: {
            connectionId: run.connectionId, dataKind, metricDate: input.metricDate
          } },
          create: { connectionId: run.connectionId, dataKind,
            metricDate: input.metricDate, source: input.source, state,
            lastAttemptRunId: run.id, lastAttemptAt: now, warningCodes: currentWarnings },
          update: { state, lastAttemptRunId: run.id, lastAttemptAt: now,
            warningCodes: currentWarnings }
        });
      }
      await tx.syncRun.update({ where: { id: run.id }, data: {
        status: input.actionRequired ? SyncRunStatus.ACTION_REQUIRED : SyncRunStatus.RUNNING,
        safeErrorCode: safeSyncCode(input.code), finishedAt: input.actionRequired ? now : null
      } });
      if (input.actionRequired && input.code === "PROVIDER_AUTH_REQUIRED") {
        await tx.sourceConnection.updateMany({ where: { id: run.connectionId, accessState: "READY" },
          data: { accessState: "REAUTH_REQUIRED", enabled: false } });
      }
      await writeSecurityAudit(tx, {
        ...auditActor(run), action: input.actionRequired ? "SYNC_UNIT_ACTION_REQUIRED" : "SYNC_UNIT_FAILED",
        targetType: "RUN_UNIT", targetId: `${run.id}:${input.unitKey}`,
        result: SecurityAuditResult.FAILURE,
        afterJson: { connectionId: run.connectionId, requestKeyHash: requestKeyHash(run.requestKey),
          dataKinds: input.dataKinds, safeErrorCode: safeSyncCode(input.code),
          diagnosticCode: input.diagnosticCode ?? null }
      });
      if (input.actionRequired && input.code === "PROVIDER_AUTH_REQUIRED") {
        await writeSecurityAudit(tx, {
          actorType: SecurityAuditActorType.SYSTEM, action: "SOURCE_REAUTH_REQUIRED",
          targetType: "SOURCE_CONNECTION", targetId: run.connectionId,
          result: SecurityAuditResult.FAILURE,
          afterJson: { connectionId: run.connectionId, provider: connection.provider,
            accessState: "REAUTH_REQUIRED" }
        });
      }
    }, { timeout: 5_000, maxWait: 2_000 });
  }

  async finishRun(claim: Pick<ClaimedRun, "runId" | "connectionId" | "generation">) {
    assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      await assertFenced(tx, claim.connectionId, claim.runId, claim.generation);
      const run = await tx.syncRun.findUnique({ where: { id: claim.runId } });
      if (!run) syncError("LEASE_LOST");
      if (run.status === SyncRunStatus.ACTION_REQUIRED) {
        await writeSecurityAudit(tx, { ...auditActor(run), action: "SYNC_RUN_FINISHED",
          targetType: "SYNC_RUN", targetId: run.id, result: SecurityAuditResult.FAILURE,
          afterJson: { status: run.status, safeErrorCode: run.safeErrorCode,
            requestKeyHash: requestKeyHash(run.requestKey) } });
        await releaseLease(tx, claim);
        return;
      }
      if (run.status !== SyncRunStatus.RUNNING) syncError("LEASE_LOST");
      const pending = await tx.runUnit.count({ where: { runId: claim.runId, status: { not: RunUnitStatus.SUCCEEDED } } });
      const succeeded = await tx.runUnit.count({ where: { runId: claim.runId, status: RunUnitStatus.SUCCEEDED } });
      const checkpointed = await tx.runUnit.count({ where: { runId: claim.runId, checkpointValue: { not: null } } });
      const finalStatus = pending ? (succeeded || checkpointed ? SyncRunStatus.PARTIAL : SyncRunStatus.FAILED) : SyncRunStatus.SUCCEEDED;
      const finalErrorCode = pending ? run.safeErrorCode ?? "PARTIAL_PAGE" : null;
      await tx.syncRun.update({ where: { id: claim.runId }, data: {
        status: finalStatus,
        finishedAt: new Date(), safeErrorCode: finalErrorCode,
        nextAttemptAt: pending && run.trigger === SyncTrigger.SCHEDULED && run.safeErrorCode
          ? new Date(Date.now() + 60_000) : null
      } });
      await writeSecurityAudit(tx, { ...auditActor(run), action: "SYNC_RUN_FINISHED",
        targetType: "SYNC_RUN", targetId: run.id,
        result: finalStatus === SyncRunStatus.SUCCEEDED ? SecurityAuditResult.SUCCESS : SecurityAuditResult.PARTIAL,
        afterJson: { status: finalStatus, safeErrorCode: finalErrorCode,
          requestKeyHash: requestKeyHash(run.requestKey) } });
      await assertFenced(tx, claim.connectionId, claim.runId, claim.generation);
      await releaseLease(tx, claim);
    }, { timeout: 5_000, maxWait: 2_000 });
  }

  async resumeStale(runId: string, actorUserId: string) {
    assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.syncRun.findUnique({ where: { id: runId } });
      if (!run) throw new NotFoundException();
      if (run.status !== SyncRunStatus.RUNNING) throw new ConflictException();
      const lease = await tx.syncLease.findUnique({ where: { connectionId: run.connectionId } });
      if (lease && lease.expiresAt > new Date()) syncError("LEASE_LOST");
      await tx.runUnit.updateMany({ where: { runId, status: RunUnitStatus.RUNNING },
        data: { status: RunUnitStatus.QUEUED } });
      const resumed = await tx.syncRun.update({ where: { id: runId }, data: {
        status: SyncRunStatus.QUEUED, nextAttemptAt: new Date(), deadlineAt: null,
        safeErrorCode: "LEASE_LOST"
      } });
      await writeSecurityAudit(tx, { actorType: SecurityAuditActorType.USER,
        actorUserId, action: "SYNC_RUN_RESUMED", targetType: "SYNC_RUN",
        targetId: runId, result: SecurityAuditResult.REQUESTED,
        afterJson: { connectionId: run.connectionId, requestKeyHash: requestKeyHash(run.requestKey) } });
      return resumed;
    }, { timeout: 5_000 });
  }

  /** Scheduler retries only the original run, preserving every committed unit. */
  async prepareScheduledRetry(runId: string, occurrenceDeadline: Date) {
    assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.syncRun.findUnique({ where: { id: runId }, include: { units: true } });
      if (!run || run.trigger !== SyncTrigger.SCHEDULED) syncError("RUN_LIMIT_EXCEEDED");
      await lockCanonicalConnection(tx, run.connectionId);
      const lease = await tx.syncLease.findUnique({ where: { connectionId: run.connectionId } });
      if (lease && lease.expiresAt > new Date()) return false;
      if (run.status === SyncRunStatus.SUCCEEDED) return false;
      const expected = Array.from({ length: (run.toDate.getTime() - run.fromDate.getTime()) / 86_400_000 + 1 }, (_, offset) =>
        new Date(run.fromDate.getTime() + offset * 86_400_000).toISOString().slice(0, 10));
      if (run.units.length === expected.length && expected.every((key) => run.units.some((unit) =>
          unit.unitKey === key && unit.status === RunUnitStatus.SUCCEEDED))) {
        // The last publish may have committed immediately before process loss.
        // Completion follows its durable checkpoints, even after the slot ends.
        await tx.syncRun.update({ where: { id: runId }, data: { status: SyncRunStatus.SUCCEEDED,
          finishedAt: new Date(), nextAttemptAt: null, deadlineAt: null, safeErrorCode: null } });
        await writeSecurityAudit(tx, { actorType: SecurityAuditActorType.SYSTEM,
          action: "SYNC_RUN_FINISHED", targetType: "SYNC_RUN", targetId: runId,
          result: SecurityAuditResult.SUCCESS, afterJson: { status: SyncRunStatus.SUCCEEDED,
            requestKeyHash: requestKeyHash(run.requestKey) } });
        return false;
      }
      if (occurrenceDeadline <= new Date()) return false;
      if (run.status === SyncRunStatus.ACTION_REQUIRED) return false;
      if (run.nextAttemptAt && run.nextAttemptAt > new Date()) return false;
      if (!run.units.some((unit) => unit.status !== RunUnitStatus.SUCCEEDED && unit.attempts < 3)) return false;
      if (run.status === SyncRunStatus.RUNNING || run.status === SyncRunStatus.FAILED) {
        await tx.runUnit.updateMany({ where: { runId, status: RunUnitStatus.RUNNING }, data: { status: RunUnitStatus.QUEUED } });
        await tx.syncRun.update({ where: { id: runId }, data: { status: SyncRunStatus.PARTIAL,
          deadlineAt: null, finishedAt: null } });
        await writeSecurityAudit(tx, { actorType: SecurityAuditActorType.SYSTEM,
          action: "SYNC_RUN_RESUMED", targetType: "SYNC_RUN", targetId: runId,
          result: SecurityAuditResult.REQUESTED,
          afterJson: { connectionId: run.connectionId, requestKeyHash: requestKeyHash(run.requestKey) } });
      }
      return true;
    }, { timeout: 5_000, maxWait: 2_000 });
  }
}

function connectionWindowKey(unitKey: string, dayKey: string) {
  const match = /^cafe24-window:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z):(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/.exec(unitKey);
  if (!match) return false;
  const start = new Date(match[1]), end = new Date(match[2]);
  return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) &&
    start < end && end.getTime() - start.getTime() <= 172_800_000 &&
    formatInTimeZone(new Date(end.getTime() - 1), "Asia/Seoul", "yyyy-MM-dd") === dayKey;
}

async function assertFenced(tx: Prisma.TransactionClient, connectionId: string, runId: string, generation: bigint) {
  const rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
    SELECT "generation" FROM "sync_leases"
    WHERE "connection_id" = ${connectionId}::uuid AND "owner_run_id" = ${runId}::uuid
      AND "generation" = ${generation} AND "expires_at" > clock_timestamp()
    FOR UPDATE
  `);
  if (rows.length !== 1) syncError("LEASE_LOST");
}

async function releaseLease(tx: Prisma.TransactionClient,
  claim: Pick<ClaimedRun, "runId" | "connectionId" | "generation">) {
  // Keep the row so the generation never resets to 1 on the next owner.
  const rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
    UPDATE "sync_leases" SET "expires_at" = clock_timestamp(), "updated_at" = clock_timestamp()
    WHERE "connection_id" = ${claim.connectionId}::uuid AND "owner_run_id" = ${claim.runId}::uuid
      AND "generation" = ${claim.generation} AND "expires_at" > clock_timestamp()
    RETURNING "generation"
  `);
  if (rows.length !== 1) syncError("LEASE_LOST");
}

async function assertActiveConnection(tx: Prisma.TransactionClient, connectionId: string): Promise<SourceProvider> {
  // FOR SHARE blocks both policy writers (which lock this parent FOR UPDATE)
  // and connection disable/reauth updates until this publish commits.
  const rows = await tx.$queryRaw<Array<{
    enabled: boolean; access_state: string; provider: string; credential_expires_at: Date | null;
    external_account_id: string; shop_key: string;
  }>>(Prisma.sql`
    SELECT "enabled", "access_state"::text AS "access_state", "provider"::text AS "provider",
      "credential_expires_at",
      "external_account_id", "shop_key"
    FROM "source_connections" WHERE "id" = ${connectionId}::uuid FOR SHARE
  `);
  const connection = rows[0];
  if (connection?.enabled !== true || connection.access_state !== "READY" ||
      (connection.credential_expires_at && connection.credential_expires_at <= new Date()) ||
      !accountAllowlist().has(accountKey(connection.provider as SourceProvider,
        connection.external_account_id, connection.shop_key))) syncError("PROVIDER_AUTH_REQUIRED");
  return connection.provider as SourceProvider;
}

function assertCompleteKinds(provider: SourceProvider, slices: Array<{ dataKind: SourceDataKind; source: SourceKind }>) {
  const expected = provider === SourceProvider.META
    ? [SourceDataKind.META_AD, SourceDataKind.META_ADSET]
    : provider === SourceProvider.GOOGLE
      ? [SourceDataKind.GOOGLE_CAMPAIGN]
      : [SourceDataKind.CAFE24_ORDER];
  const kinds = slices.map((slice) => slice.dataKind).sort();
  if (kinds.length !== expected.length || kinds.some((kind, index) => kind !== [...expected].sort()[index]) ||
      new Set(slices.map((slice) => slice.source)).size !== 1) syncError("FIELD_UNSUPPORTED");
}

function once(lease: HeavyOperationLease) {
  let done = false;
  return () => { if (!done) { done = true; lease.release(); } };
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function auditActor(run: { actorUserId: string | null }) {
  return { actorType: run.actorUserId ? SecurityAuditActorType.USER : SecurityAuditActorType.SYSTEM,
    actorUserId: run.actorUserId };
}

function isMetaApiPublication(slices: Array<{dataKind: SourceDataKind; source: SourceKind}>) {
  return slices.length === 2 && slices.every(slice => slice.source === SourceKind.API) &&
    slices.map(slice => slice.dataKind).sort().join() === "META_AD,META_ADSET";
}

export function metaPublicationTransactionOptions(deadlineAt: Date, now = Date.now()) {
  const remaining = deadlineAt.getTime() - now - 2_500;
  if (!Number.isFinite(remaining) || remaining < 1) syncError("RUN_LIMIT_EXCEEDED");
  return { timeout: Math.min(30_000, Math.floor(remaining)), maxWait: 2_000 };
}

function requestKeyHash(requestKey: string) {
  return createHash("sha256").update(requestKey).digest("hex");
}
