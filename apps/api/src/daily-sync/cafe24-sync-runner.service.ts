import { assertScheduledCheckpointConfigured, loadScheduledCheckpoint, saveScheduledCheckpoint, removeScheduledCheckpoint } from "./scheduled-checkpoint";
import { HttpException, Injectable } from "@nestjs/common";
import { SourceDataKind, SourceKind, SyncRunStatus } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { Cafe24OrdersClient } from "./cafe24-orders.client";
import { Cafe24CanonicalWriterService } from "./cafe24-canonical-writer.service";
import { ProviderFailure } from "./bounded-request";
import { isCafe24FailureDiagnosticCode } from "./cafe24-failure-diagnostic";
import { SyncFoundationService } from "./sync-foundation.service";
import { safeSyncCode, syncError } from "./sync-contract";
import { accountAllowlist, accountKey, SourceConnectionsService } from "./source-connections.service";

@Injectable()
export class Cafe24SyncRunnerService {
  constructor(private readonly prisma: PrismaService,
    private readonly foundation: SyncFoundationService,
    private readonly client: Cafe24OrdersClient,
    private readonly writer: Cafe24CanonicalWriterService) {}

  async execute(runId: string, options?: { maxUnits: number; deadlineAt: number }) {
    const run = await this.prisma.syncRun.findUnique({ where: { id: runId },
      include: { connection: true, units: { orderBy: { unitKey: "asc" } } } });
    if (!run || run.connection.provider !== "CAFE24" ||
        !accountAllowlist().has(accountKey("CAFE24", run.connection.externalAccountId,
          run.connection.shopKey)) ||
        run.connection.currencyCode !== "KRW" || run.connection.timeZone !== "Asia/Seoul")
      syncError("ACCOUNT_SCOPE_MISMATCH");
    if (run.status !== SyncRunStatus.QUEUED && run.status !== SyncRunStatus.PARTIAL)
      syncError("RECONCILIATION_FAILED");
    // Existing multi-day runs from the retired sweep must never reach the provider.
    if (run.fromDate.getTime() !== run.toDate.getTime() || run.units.length !== 1 ||
        run.units[0].unitKey !== run.fromDate.toISOString().slice(0, 10))
      syncError("RUN_LIMIT_EXCEEDED");
    const claim = await this.foundation.claimRun(runId, options?.deadlineAt);
    if (!claim) syncError("LEASE_LOST");
    let leaseLost = false;
    let renewing = false;
    let completedShadow: { day: string; policyVersion: number } | null = null;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.foundation.renewLease(claim).then((valid) => { if (!valid) leaseLost = true; })
        .catch(() => { leaseLost = true; }).finally(() => { renewing = false; });
    }, 60_000);
    try {
      const deadlineAt = options?.deadlineAt ?? Date.now() + 10 * 60_000;
      let processed = 0;
      for (const unit of run.units) {
        if (unit.status === "SUCCEEDED" || options && unit.attempts >= 3) continue;
        if (options && processed >= options.maxUnits) break;
        processed += 1;
        if (options) await this.foundation.beginScheduledUnit(claim, unit.unitKey);
        if (leaseLost) syncError("LEASE_LOST");
        const day = unit.unitKey;
        const metricDate = new Date(`${day}T00:00:00.000Z`);
        try {
          if (options) assertScheduledCheckpointConfigured();
          if (!/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(metricDate.getTime()) ||
              Date.now() >= deadlineAt) syncError("RUN_LIMIT_EXCEEDED");
          const policy = await this.prisma.sourcePolicy.findFirst({ where: {
            connectionId: claim.connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
            fromDate: { lte: metricDate }, OR: [{ toDate: null }, { toDate: { gt: metricDate } }]
          } });
          if (!policy || (policy.primarySource !== SourceKind.API &&
              policy.primarySource !== SourceKind.CSV)) syncError("SOURCE_SELECTION_REQUIRED");
          const chunk = options ? await this.client.fetchScheduledChunk(claim.connectionId, day, deadlineAt,
            await loadScheduledCheckpoint(this.prisma, claim, day)) : null;
          if (chunk && !chunk.snapshot) {
            await saveScheduledCheckpoint(this.prisma, claim, day, chunk.state);
            break;
          }
          const snapshot = chunk?.snapshot ?? await this.client.fetchDaySnapshot(claim.connectionId, day, deadlineAt);
          if (leaseLost) syncError("LEASE_LOST");
          await this.writer.publishCafe24Day({ connectionId: claim.connectionId, runId,
            generation: claim.generation, metricDate, pageCount: snapshot.pageCount,
            policyVersion: policy.version, checkpointValue: snapshot.checkpointValue,
            completeDaySnapshot: true, fetchedAt: snapshot.fetchedAt, orders: snapshot.orders });
          // Cleanup must not demote a committed successful publish. A retained
          // encrypted row expires and is removed on the next account wake.
          if (options) await removeScheduledCheckpoint(this.prisma, runId, day).catch(() => undefined);
          if (policy.primarySource === SourceKind.CSV)
            completedShadow = { day, policyVersion: policy.version };
        } catch (error) {
          if (leaseLost) syncError("LEASE_LOST");
          const failure = error instanceof ProviderFailure ? error : null;
          const response = error instanceof HttpException ? error.getResponse() : null;
          const responseCode = response && typeof response === "object" && "code" in response
            ? response.code : null;
          const code = safeSyncCode(failure?.safeCode ?? responseCode);
          const candidateDiagnostic = failure?.diagnosticCode ??
            (error instanceof HttpException && "diagnosticCode" in error
              ? error.diagnosticCode : null);
          const diagnosticCode = isCafe24FailureDiagnosticCode(candidateDiagnostic) &&
            (code === "FIELD_UNSUPPORTED" ||
              (code === "PROVIDER_VERSION_UNVERIFIED" &&
                candidateDiagnostic === "CAFE24_EVIDENCE_APP_VERSION"))
            ? candidateDiagnostic : null;
          if (code === "LEASE_LOST") throw error;
          const actionRequired = ["CHECKPOINT_CONFIGURATION_REQUIRED", "PROVIDER_AUTH_REQUIRED", "FIELD_UNSUPPORTED",
            "ACCOUNT_SCOPE_MISMATCH", "CURRENCY_MISMATCH", "TIMEZONE_MISMATCH",
            "SOURCE_SELECTION_REQUIRED", "RECONCILIATION_FAILED", "PROVIDER_VERSION_UNVERIFIED"].includes(code);
          await this.foundation.failUnit({ runId, generation: claim.generation, unitKey: day,
            dataKinds: [SourceDataKind.CAFE24_ORDER], metricDate, source: SourceKind.API,
            code, actionRequired, diagnosticCode });
          if (actionRequired || code === "RUN_LIMIT_EXCEEDED" ||
              code === "PROVIDER_RATE_LIMITED") break;
        }
      }
      await this.foundation.finishRun(claim);
      const finished = await this.prisma.syncRun.findUniqueOrThrow({ where: { id: runId },
        select: { id: true, status: true, rowsFetched: true, rowsPublished: true,
          safeErrorCode: true } });
      // Feature-gated scheduled source choice occurs only after a committed
      // successful day. A failed activation leaves shadow coverage and CSV
      // primary intact for explicit review; no later date is caught up.
      if (completedShadow && finished.status === SyncRunStatus.SUCCEEDED &&
          run.trigger === "SCHEDULED" &&
          process.env.DAILY_SYNC_CAFE24_SCHEDULED_API_ONLY_ACTIVATION_ENABLED === "true") {
        const selected = process.env.DAILY_SYNC_CAFE24_SCHEDULED_COUPON_INPUT_SOURCE;
        try {
          if (selected !== "UNKNOWN" && selected !== "API_ACTUAL_PRODUCT_PLUS_SHIPPING")
            syncError("SOURCE_SELECTION_REQUIRED");
          await new SourceConnectionsService(this.prisma).activateCafe24Day(claim.connectionId, {
            day: completedShadow.day, expectedPolicyVersion: completedShadow.policyVersion,
            expectedSuccessRunId: runId, reason: "CAFE24_SCHEDULED_API_ONLY",
            mode: "API_ONLY", couponInputSource: selected
          }, null);
        } catch (error) {
          const metricDate = new Date(`${completedShadow.day}T00:00:00.000Z`);
          const selectedPolicy = await this.prisma.sourcePolicy.findFirst({ where: {
            connectionId: claim.connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
            fromDate: { lte: metricDate },
            OR: [{ toDate: null }, { toDate: { gt: metricDate } }]
          } });
          // A post-commit response error must not demote a successful API
          // activation or turn its readable coverage back into shadow state.
          if (selectedPolicy?.primarySource === SourceKind.API) {
            const activeCoverage = await this.prisma.sourceCoverage.findUnique({ where: {
              connectionId_dataKind_metricDate: { connectionId: claim.connectionId,
                dataKind: SourceDataKind.CAFE24_ORDER, metricDate }
            } });
            if (activeCoverage?.lastSuccessRunId === runId &&
                activeCoverage.reconciliationStatus === "CAFE24_API_ONLY_VERIFIED" &&
                !activeCoverage.warningCodes.includes("CAFE24_SHADOW_NOT_PRIMARY"))
              return finished;
            throw error;
          }
          if (selectedPolicy?.primarySource !== SourceKind.CSV) throw error;
          // The day was collected successfully but remains a CSV-primary shadow.
          // Preserve its success pointer and expose the unfinished source choice.
          await this.prisma.sourceCoverage.updateMany({ where: {
            connectionId: claim.connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
            metricDate, source: SourceKind.API, lastSuccessRunId: runId,
            warningCodes: { has: "CAFE24_SHADOW_NOT_PRIMARY" }
          }, data: { reconciliationStatus: "CAFE24_SOURCE_ACTIVATION_REQUIRED",
            warningCodes: { push: "CAFE24_SOURCE_ACTIVATION_REQUIRED" } } });
          throw error;
        }
      }
      return finished;
    } finally { clearInterval(timer); claim.release(); }
  }
}
