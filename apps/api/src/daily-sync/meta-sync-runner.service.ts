import { HttpException, Injectable } from "@nestjs/common";
import { SourceDataKind, SourceKind, SourceProvider, SyncRunStatus } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { CanonicalApiWriterService } from "./canonical-api-writer.service";
import { safeMetaRuntimeFailureDiagnostic, MetaFailureStage } from "./meta-failure-diagnostic";
import { ProviderFailure } from "./bounded-request";
import { MetaReadSettings } from "./meta-ads.client";
import { MetaDayReader } from "./meta-day-reader";
import { assertMetaOperatingGate, assertMetaSnapshotTransport } from "./meta-operating-gate";
import { MetaCredentialResolver, resolveMetaCredential, configuredMetaTransport } from "./meta-credential-resolver";
import { assertGoogleMetaRunScope } from "./provider-run-scope";
import { SyncFoundationService } from "./sync-foundation.service";
import { accountAllowlist, accountKey } from "./source-connections.service";
import { parseIsoDate } from "./sync-contract";
import { assertEnabled, safeSyncCode, syncError } from "./sync-contract";

export function configuredMetaSettings(env: NodeJS.ProcessEnv = process.env): MetaReadSettings {
  if (configuredMetaTransport(env) === "MCP") {
    if ((env.DAILY_SYNC_META_ACTION_REPORT_TIME !== undefined && env.DAILY_SYNC_META_ACTION_REPORT_TIME !== "MCP_PROVIDER_DEFAULT_UNVERIFIED") ||
        (env.DAILY_SYNC_META_ATTRIBUTION_WINDOWS !== undefined && env.DAILY_SYNC_META_ATTRIBUTION_WINDOWS !== "") ||
        env.DAILY_SYNC_META_EXPECTED_ATTRIBUTION_SETTING !== undefined || env.DAILY_SYNC_META_EXPECTED_ATTRIBUTION_SETTINGS_BY_DAY !== undefined ||
        env.DAILY_SYNC_META_RESULT_ACTION_TYPES_BY_DAY !== undefined) syncError("ATTRIBUTION_MISMATCH");
    return { actionReportTime: "MCP_PROVIDER_DEFAULT_UNVERIFIED", attributionWindows: [] };
  }
  const actionReportTime = env.DAILY_SYNC_META_ACTION_REPORT_TIME;
  const windows = env.DAILY_SYNC_META_ATTRIBUTION_WINDOWS?.split(",");
  const expectedAttributionSetting = env.DAILY_SYNC_META_EXPECTED_ATTRIBUTION_SETTING;
  let expectedAttributionSettingsByDay: Record<string, Record<string, string>> | undefined;
  let resultActionTypesByDay: Record<string, Record<string, string>> | undefined;
  if (env.DAILY_SYNC_META_RESULT_ACTION_TYPES_BY_DAY) {
    try {
      const value: unknown = JSON.parse(env.DAILY_SYNC_META_RESULT_ACTION_TYPES_BY_DAY);
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.entries(value).length > 31 ||
          Object.entries(value).some(([day, mapping]) => !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
            !mapping || typeof mapping !== "object" || Array.isArray(mapping) ||
            Object.entries(mapping).length > 50_000 ||
            Object.entries(mapping).some(([key, action]) => !/^\d{1,30}$/.test(key) ||
              typeof action !== "string" || !(action === "NONE" || /^[a-z][a-z0-9_.]{1,127}$/.test(action)))))
        syncError("FIELD_UNSUPPORTED");
      for (const day of Object.keys(value)) parseIsoDate(day);
      resultActionTypesByDay = value as Record<string, Record<string, string>>;
    } catch { syncError("FIELD_UNSUPPORTED"); }
  }
  if (expectedAttributionSetting !== undefined &&
      (!expectedAttributionSetting.trim() || expectedAttributionSetting !== expectedAttributionSetting.trim() || expectedAttributionSetting.length > 128 || /[\u0000-\u001f\u007f]/.test(expectedAttributionSetting)))
    syncError("ATTRIBUTION_MISMATCH");
  if (env.DAILY_SYNC_META_EXPECTED_ATTRIBUTION_SETTINGS_BY_DAY) {
    try {
      const value: unknown = JSON.parse(env.DAILY_SYNC_META_EXPECTED_ATTRIBUTION_SETTINGS_BY_DAY);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 31)
        syncError("ATTRIBUTION_MISMATCH");
      for (const [day, mapping] of Object.entries(value as Record<string, unknown>)) {
        parseIsoDate(day);
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || Object.keys(mapping).length > 50_000)
          syncError("ATTRIBUTION_MISMATCH");
        for (const [adId, setting] of Object.entries(mapping)) {
          if (!/^\d{1,30}$/.test(adId) || typeof setting !== "string" || !setting.trim() ||
              setting !== setting.trim() || setting.length > 128 || /[\u0000-\u001f\u007f]/.test(setting) ||
              expectedAttributionSetting !== undefined && setting !== expectedAttributionSetting)
            syncError("ATTRIBUTION_MISMATCH");
        }
      }
      expectedAttributionSettingsByDay = value as Record<string, Record<string, string>>;
    } catch { syncError("ATTRIBUTION_MISMATCH"); }
  }
  if (!actionReportTime || !windows ||
      !["conversion", "impression", "mixed"].includes(actionReportTime) ||
      windows.some((item) => !["1d_click", "7d_click", "1d_view", "7d_view"].includes(item)) ||
      windows.length === 0 || new Set(windows).size !== windows.length) syncError("ATTRIBUTION_MISMATCH");
  return { actionReportTime: actionReportTime as MetaReadSettings["actionReportTime"],
    attributionWindows: windows as MetaReadSettings["attributionWindows"], resultActionTypesByDay,
    expectedAttributionSetting, expectedAttributionSettingsByDay };
}

/** Synchronous manual/scheduled executor; no detached in-memory task is registered. */
@Injectable()
export class MetaSyncRunnerService {
  constructor(private readonly prisma: PrismaService, private readonly foundation: SyncFoundationService,
    private readonly client: MetaDayReader, private readonly writer: CanonicalApiWriterService,
    private readonly resolver: MetaCredentialResolver) {}

  async execute(runId: string, options?: { maxUnits: number; deadlineAt: number }) {
    assertEnabled();
    const transport = configuredMetaTransport();
    if ((this.client.transport ?? "GRAPH") !== transport) syncError("PROVIDER_AUTH_REQUIRED");
    const run = await this.prisma.syncRun.findUnique({ where: { id: runId },
      include: { connection: true, units: { orderBy: { unitKey: "asc" } } } });
    if (!run || run.connection.provider !== SourceProvider.META ||
        !accountAllowlist().has(accountKey(run.connection.provider,
          run.connection.externalAccountId, run.connection.shopKey))) syncError("ACCOUNT_SCOPE_MISMATCH");
    if (!run.connection.credentialRef ||
        process.env.DAILY_SYNC_META_CREDENTIAL_REF !== run.connection.credentialRef ||
        !run.connection.credentialExpiresAt ||
        run.connection.credentialExpiresAt.getTime() <= Date.now() + 7 * 86_400_000 ||
        run.connection.accessState !== "READY" || run.connection.enabled !== true || !this.resolver)
      syncError("PROVIDER_AUTH_REQUIRED");
    // Graph and own-account MCP have separate, explicit operating gates.
    assertMetaOperatingGate(transport);
    if (run.status !== SyncRunStatus.QUEUED && run.status !== SyncRunStatus.PARTIAL)
      syncError("RECONCILIATION_FAILED");
    assertGoogleMetaRunScope(run);
    const settings = configuredMetaSettings();
    const credential = await resolveMetaCredential(this.resolver, {
      credentialRef: run.connection.credentialRef, connectionId: run.connectionId,
      accountId: run.connection.externalAccountId, transport
    });
    if (credential.expiresAt.getTime() !== run.connection.credentialExpiresAt.getTime())
      syncError("PROVIDER_AUTH_REQUIRED");
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
        const metricDate = new Date(`${unit.unitKey}T00:00:00.000Z`);
        let failureStage: MetaFailureStage = "META_BINDING";
        try {
          if (Date.now() >= deadlineAt) syncError("RUN_LIMIT_EXCEEDED");
          const currentBinding = await this.prisma.sourceConnection.findUnique({
            where: { id: claim.connectionId },
            select: { credentialRef: true, credentialExpiresAt: true,
              accessState: true, enabled: true }
          });
          if (currentBinding?.credentialRef !== credential.credentialRef ||
              currentBinding.credentialExpiresAt?.getTime() !== credential.expiresAt.getTime() ||
              currentBinding.accessState !== "READY" || currentBinding.enabled !== true ||
              credential.expiresAt.getTime() <= Date.now() + 7 * 86_400_000)
            syncError("PROVIDER_AUTH_REQUIRED");
          const policies = await this.prisma.sourcePolicy.findMany({ where: {
            connectionId: claim.connectionId,
            dataKind: { in: [SourceDataKind.META_AD, SourceDataKind.META_ADSET] },
            fromDate: { lte: metricDate }, OR: [{ toDate: null }, { toDate: { gt: metricDate } }]
          } });
          const adPolicy = policies.find((policy) => policy.dataKind === SourceDataKind.META_AD);
          const adsetPolicy = policies.find((policy) => policy.dataKind === SourceDataKind.META_ADSET);
          if (policies.length !== 2 || adPolicy?.primarySource !== SourceKind.API ||
              adsetPolicy?.primarySource !== SourceKind.API) syncError("SOURCE_SELECTION_REQUIRED");
          failureStage = "META_FETCH";
          const snapshot = await this.client.fetchDay({ accountId: run.connection.externalAccountId,
            day: unit.unitKey, deadlineAt, settings, accessToken: credential.token });
          failureStage = "META_NORMALIZE";
          assertMetaOperatingGate(transport);
          assertMetaSnapshotTransport(snapshot, transport);
          if (snapshot.currencyCode !== "USD" || run.connection.currencyCode !== "USD" ||
              snapshot.currencyCode !== run.connection.currencyCode) syncError("CURRENCY_MISMATCH");
          if (snapshot.timeZone !== run.connection.timeZone) syncError("TIMEZONE_MISMATCH");
          failureStage = "META_PUBLISH";
          await this.writer.publishMetaDay({ runId, connectionId: claim.connectionId,
            generation: claim.generation, metricDate, adPolicyVersion: adPolicy.version,
            adsetPolicyVersion: adsetPolicy.version, ads: snapshot.ads, adsets: snapshot.adsets,...(snapshot.nullBasicParentProjection?{nullBasicParentProjection:snapshot.nullBasicParentProjection}:{}),
            expectedCredentialRef: credential.credentialRef,
            expectedCredentialExpiresAt: credential.expiresAt,
            expectedMetaTransport: transport,
            pageCount: snapshot.pageCount });
        } catch (error) {
          if (leaseLost) syncError("LEASE_LOST");
          const failure = error instanceof ProviderFailure ? error : null;
          const response = error instanceof HttpException ? error.getResponse() : null;
          const responseCode = response && typeof response === "object" && "code" in response
            ? response.code : null;
          const code = failure ? safeSyncCode(failure.safeCode) :
            responseCode ? safeSyncCode(responseCode) : "PROVIDER_UNAVAILABLE";
          if (code === "LEASE_LOST") throw error;
          const actionRequired = ["PROVIDER_AUTH_REQUIRED", "FIELD_UNSUPPORTED", "ATTRIBUTION_MISMATCH",
            "ACCOUNT_SCOPE_MISMATCH", "CURRENCY_MISMATCH", "TIMEZONE_MISMATCH",
            "SOURCE_SELECTION_REQUIRED", "RECONCILIATION_FAILED", "PROVIDER_VERSION_UNVERIFIED"].includes(code);
          await this.foundation.failUnit({ runId, generation: claim.generation,
            unitKey: unit.unitKey, dataKinds: [SourceDataKind.META_AD, SourceDataKind.META_ADSET],
            metricDate, source: SourceKind.API, code, actionRequired,
            diagnosticCode: safeMetaRuntimeFailureDiagnostic(error, failureStage) });
          if (actionRequired || code === "RUN_LIMIT_EXCEEDED" || code === "PROVIDER_RATE_LIMITED") break;
        }
      }
      await this.foundation.finishRun(claim);
      return this.prisma.syncRun.findUniqueOrThrow({ where: { id: runId },
        select: { id: true, status: true, rowsFetched: true, rowsPublished: true,
          safeErrorCode: true, providerRequestId: true } });
    } finally { clearInterval(timer); claim.release(); }
  }
}
