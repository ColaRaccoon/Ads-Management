import { HttpException, Injectable } from "@nestjs/common";
import { SourceDataKind, SourceKind, SourceProvider, SyncRunStatus } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { ProviderFailure } from "./bounded-request";
import { GoogleAdsClient } from "./google-ads.client";
import { GoogleCanonicalWriterService } from "./google-canonical-writer.service";
import { assertGoogleMetaRunScope } from "./provider-run-scope";
import { SyncFoundationService } from "./sync-foundation.service";
import { accountAllowlist, accountKey } from "./source-connections.service";
import { assertEnabled, safeSyncCode, syncError } from "./sync-contract";

/** Explicit synchronous executor; the external scheduler requests one date per call. */
@Injectable()
export class GoogleSyncRunnerService {
  constructor(private readonly prisma: PrismaService, private readonly foundation: SyncFoundationService,
    private readonly client: GoogleAdsClient, private readonly writer: GoogleCanonicalWriterService) {}

  async execute(runId: string, options?: { maxUnits: number; deadlineAt: number }) {
    assertEnabled();
    const run = await this.prisma.syncRun.findUnique({ where: { id: runId },
      include: { connection: true, units: { orderBy: { unitKey: "asc" } } } });
    if (!run || run.connection.provider !== SourceProvider.GOOGLE ||
        !accountAllowlist().has(accountKey(run.connection.provider,
          run.connection.externalAccountId, run.connection.shopKey)))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    // The current ADC must be deliberately bound to this connection's opaque
    // vault reference. Neither a path nor a credential is persisted here.
    if (!/^vault:\/\/google\/[0-9a-f-]{36}$/.test(run.connection.credentialRef ?? "") ||
        process.env.DAILY_SYNC_GOOGLE_CREDENTIAL_REF !== run.connection.credentialRef)
      syncError("PROVIDER_AUTH_REQUIRED");
    const loginCustomerId = process.env.DAILY_SYNC_GOOGLE_LOGIN_CUSTOMER_ID ?? null;
    if (loginCustomerId && !/^\d{1,20}$/.test(loginCustomerId))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    if (run.status !== SyncRunStatus.QUEUED && run.status !== SyncRunStatus.PARTIAL)
      syncError("RECONCILIATION_FAILED");
    assertGoogleMetaRunScope(run);
    const claim = await this.foundation.claimRun(runId, options?.deadlineAt);
    if (!claim) syncError("LEASE_LOST");
    let leaseLost = false;
    let renewing = false;
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
          if (Date.now() >= deadlineAt) syncError("RUN_LIMIT_EXCEEDED");
          const policy = await this.prisma.sourcePolicy.findFirst({ where: {
            connectionId: claim.connectionId, dataKind: SourceDataKind.GOOGLE_CAMPAIGN,
            fromDate: { lte: metricDate }, OR: [{ toDate: null }, { toDate: { gt: metricDate } }]
          } });
          if (policy?.primarySource !== SourceKind.API) syncError("SOURCE_SELECTION_REQUIRED");
          const snapshot = await this.client.fetchDay({
            customerId: run.connection.externalAccountId, day, deadlineAt,
            loginCustomerId
          });
          if (snapshot.requestId)
            await this.prisma.syncRun.update({ where: { id: runId },
              data: { providerRequestId: snapshot.requestId } });
          await this.writer.publish({ runId, connectionId: claim.connectionId,
            generation: claim.generation, metricDate, policyVersion: policy.version, snapshot });
        } catch (error) {
          if (leaseLost) syncError("LEASE_LOST");
          const failure = error instanceof ProviderFailure ? error : null;
          const response = error instanceof HttpException ? error.getResponse() : null;
          const responseCode = response && typeof response === "object" && "code" in response
            ? response.code : null;
          const code = failure ? safeSyncCode(failure.safeCode) :
            responseCode ? safeSyncCode(responseCode) : "PROVIDER_UNAVAILABLE";
          if (code === "LEASE_LOST") throw error;
          if (failure?.requestId)
            await this.prisma.syncRun.update({ where: { id: runId },
              data: { providerRequestId: failure.requestId } });
          const actionRequired = ["PROVIDER_AUTH_REQUIRED", "FIELD_UNSUPPORTED",
            "ACCOUNT_SCOPE_MISMATCH", "CURRENCY_MISMATCH", "TIMEZONE_MISMATCH",
            "SOURCE_SELECTION_REQUIRED", "RECONCILIATION_FAILED", "PROVIDER_VERSION_UNVERIFIED"].includes(code);
          await this.foundation.failUnit({ runId, generation: claim.generation,
            unitKey: day, dataKinds: [SourceDataKind.GOOGLE_CAMPAIGN], metricDate,
            source: SourceKind.API, code, actionRequired,
            diagnosticCode: safeGoogleDiagnostic(failure?.diagnosticCode) });
          if (actionRequired || code === "RUN_LIMIT_EXCEEDED" ||
              code === "PROVIDER_RATE_LIMITED") break;
        }
      }
      await this.foundation.finishRun(claim);
      const finished = await this.prisma.syncRun.findUniqueOrThrow({ where: { id: runId },
        select: { id: true, status: true, rowsFetched: true, rowsPublished: true,
          safeErrorCode: true, providerRequestId: true } });
      return finished;
    } finally {
      clearInterval(timer);
      claim.release();
    }
  }
}

function safeGoogleDiagnostic(value: unknown):
  "GOOGLE_AUTH_REFRESH_FAILED" | "GOOGLE_ACCESS_TOKEN_REJECTED" |
  "GOOGLE_ADS_ACCESS_DENIED" | "GOOGLE_CUSTOMER_NOT_FOUND" | null {
  return value === "GOOGLE_AUTH_REFRESH_FAILED" ||
    value === "GOOGLE_ACCESS_TOKEN_REJECTED" ||
    value === "GOOGLE_ADS_ACCESS_DENIED" ||
    value === "GOOGLE_CUSTOMER_NOT_FOUND" ? value : null;
}
