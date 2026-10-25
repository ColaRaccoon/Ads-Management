import { Injectable } from "@nestjs/common";
import { SyncRunStatus, SyncTrigger } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { Cafe24SyncRunnerService } from "./cafe24-sync-runner.service";
import { GoogleSyncRunnerService } from "./google-sync-runner.service";
import { MetaSyncRunnerService } from "./meta-sync-runner.service";
import { occurrence, schedules, SCHEDULE_UNIT_MS } from "./scheduled-occurrence";
import { accountAllowlist, accountKey } from "./source-connections.service";
import { assertEnabled, syncError } from "./sync-contract";
import { SyncFoundationService } from "./sync-foundation.service";
import { cleanupScheduledCheckpoints } from "./scheduled-checkpoint";
import { cafe24ScheduledDayActivated, reconcileCafe24ScheduledDay } from "./cafe24-scheduled-activation";
import { ExchangeRatesService } from "../exchange-rates/exchange-rates.service";
import { definitionCadenceDays } from "./schedule-definition";

@Injectable()
export class ScheduledSyncService {
  constructor(private readonly prisma: PrismaService, private readonly foundation: SyncFoundationService,
    private readonly google: GoogleSyncRunnerService, private readonly cafe24: Cafe24SyncRunnerService,
    private readonly meta: MetaSyncRunnerService, private readonly exchangeRates: ExchangeRatesService) {}

  private async scope(input: { scheduleKey: string; scheduledFor: string }, executing = false) {
    assertEnabled();
    if (executing && process.env.DAILY_SYNC_SCHEDULE_ENABLED !== "true") syncError("PROVIDER_UNAVAILABLE", 503);
    const definition = schedules().find((item) => item.key === input.scheduleKey);
    if (!definition) syncError("ACCOUNT_SCOPE_MISMATCH");
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: definition.connectionId } });
    if (!connection || !accountAllowlist().has(accountKey(connection.provider, connection.externalAccountId, connection.shopKey)))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    return { connection, ...occurrence(definition, connection.provider, connection.timeZone, input.scheduledFor) };
  }
  async step(input: { scheduleKey: string; scheduledFor: string }) {
    const scope = await this.scope(input, true);
    if (scope.connection.provider === "CAFE24") await cleanupScheduledCheckpoints(this.prisma, scope.connection.id);
    const existing = await this.prisma.syncRun.findUnique({ where: { connectionId_requestKey: {
      connectionId: scope.connection.id, requestKey: scope.requestKey } } });
    if(existing?.status===SyncRunStatus.SUCCEEDED && scope.connection.provider==="CAFE24") {
      await reconcileCafe24ScheduledDay(this.prisma,scope.connection.id,scope.fromDate,existing.id);
      return this.status(input);
    }
    if (scope.deadlineAt <= new Date()) {
      if (existing && existing.status !== SyncRunStatus.SUCCEEDED)
        await this.foundation.prepareScheduledRetry(existing.id, scope.deadlineAt);
      const finalized=await this.prisma.syncRun.findUnique({where:{connectionId_requestKey:{connectionId:scope.connection.id,requestKey:scope.requestKey}}});
      if(finalized?.status==="SUCCEEDED" && scope.connection.provider==="CAFE24")
        await reconcileCafe24ScheduledDay(this.prisma,scope.connection.id,scope.fromDate,finalized.id);
      return this.status(input);
    }
    const run = existing ?? await this.foundation.queueRun({ connectionId: scope.connection.id,
      fromDate: scope.fromDate, toDate: scope.toDate, trigger: SyncTrigger.SCHEDULED,
      actorUserId: null, requestKey: scope.requestKey });
    if (run.status === SyncRunStatus.SUCCEEDED || run.status === SyncRunStatus.ACTION_REQUIRED) return this.status(input);
    if (!await this.foundation.prepareScheduledRetry(run.id, scope.deadlineAt)) return this.status(input);
    const options = { maxUnits: 1, deadlineAt: scheduledUnitDeadline(scope.connection.provider, scope.deadlineAt) };
    if (options.deadlineAt <= Date.now()) return this.status(input);
    if (scope.connection.provider === "META") {
      const unit = await this.prisma.runUnit.findFirst({ where: { runId: run.id, status: { not: "SUCCEEDED" } },
        orderBy: { unitKey: "asc" }, select: { unitKey: true } });
      if (unit) await this.exchangeRates.ensureUsdKrwRatesForDates([new Date(`${unit.unitKey}T00:00:00.000Z`)]);
      if (options.deadlineAt <= Date.now()) return this.status(input);
    }
    const runner = scope.connection.provider === "CAFE24" ? this.cafe24 : scope.connection.provider === "GOOGLE" ? this.google : this.meta;
    await runner.execute(run.id, options);
    if(scope.connection.provider==="CAFE24") {
      const finalized=await this.prisma.syncRun.findUnique({where:{id:run.id}});
      if(finalized?.status==="SUCCEEDED") await reconcileCafe24ScheduledDay(this.prisma,scope.connection.id,scope.fromDate,run.id);
    }
    return this.status(input);
  }
  async status(input: { scheduleKey: string; scheduledFor: string }) {
    const scope = await this.scope(input);
    const run = await this.prisma.syncRun.findUnique({ where: {
      connectionId_requestKey: { connectionId: scope.connection.id, requestKey: scope.requestKey } }, include: { units: true } });
    const expired = scope.deadlineAt <= new Date();
    const pendingActivation=scope.connection.provider==="CAFE24" && run?.status==="SUCCEEDED" &&
      !await cafe24ScheduledDayActivated(this.prisma,scope.connection.id,scope.fromDate,run.id);
    return { scheduleKey: input.scheduleKey, scheduledFor: input.scheduledFor,
      fromDate: scope.fromDate, toDate: scope.toDate, id: run?.id ?? null,
      status: pendingActivation ? "ACTION_REQUIRED" : run?.status === "SUCCEEDED" || run?.status === "ACTION_REQUIRED" ? run.status : expired ? "EXPIRED" : run?.status ?? "NOT_STARTED",
      completedUnits: run?.units.filter((unit) => unit.status === "SUCCEEDED").length ?? 0,
      totalUnits: scope.totalUnits,
      safeErrorCode: pendingActivation ? "SOURCE_SELECTION_REQUIRED" : run?.safeErrorCode ?? null,
      nextAttemptAt: run?.nextAttemptAt?.toISOString() ?? null,
      deadlineAt: scope.deadlineAt.toISOString() };
  }

  async warnings() {
    assertEnabled();
    const items = [];
    const history = [];
    for (const definition of schedules()) {
      const connection = await this.prisma.sourceConnection.findUnique({ where: { id: definition.connectionId } });
      if (!connection || !accountAllowlist().has(accountKey(connection.provider, connection.externalAccountId, connection.shopKey))) continue;
      const cadence = definitionCadenceDays(connection.provider, definition);
      const dualMeta = connection.provider === "META" && schedules().some(d => d.connectionId === connection.id && d.kind === "META_DAILY");
      const anchor = new Date(definition.anchorAt).getTime(), interval = cadence * 86_400_000;
      if (Date.now() < anchor) continue;
      const latest = Math.floor((Date.now() - anchor) / interval);
      // Historical warning reads do not queue or fetch missed dates.
      const slots = Array.from({ length: Math.min(latest + 1, cadence === 1 ? 31 : 5) }, (_, offset) =>
        occurrence(definition, connection.provider, connection.timeZone, new Date(anchor + (latest - offset) * interval).toISOString()));
      history.push({ scheduleKey: definition.key, trackingFromDate: slots[slots.length - 1].fromDate,
        truncatedEarlierWindows: latest + 1 > slots.length,
        warningCode: latest + 1 > slots.length ? "OLDER_SCHEDULE_HISTORY_NOT_SCANNED" : null });
      const runs = await this.prisma.syncRun.findMany({ where: { connectionId: connection.id,
        requestKey: { in: slots.map((slot) => slot.requestKey) } }, include: { units: true }, take: 31 });
      const kinds = connection.provider === "CAFE24" ? ["CAFE24_ORDER" as const] : connection.provider === "GOOGLE"
        ? ["GOOGLE_CAMPAIGN" as const] : ["META_AD" as const, "META_ADSET" as const];
      const coverage = await this.prisma.sourceCoverage.findMany({ where: { connectionId: connection.id, source: "API", dataKind: { in: kinds },
        metricDate: { gte: new Date(`${slots[slots.length - 1].fromDate}T00:00:00.000Z`),
          lte: new Date(`${slots[0].toDate}T00:00:00.000Z`) } }, take: 70 });
      for (const slot of slots) {
        const run = runs.find((row) => row.requestKey === slot.requestKey);
        const succeeded = new Set(run?.units.filter((unit) => unit.status === "SUCCEEDED").map((unit) => unit.unitKey));
        if(connection.provider==="CAFE24" && run?.status==="SUCCEEDED" &&
          !coverage.some(row=>row.metricDate.toISOString().slice(0,10)===slot.fromDate &&
            row.lastSuccessRunId===run.id && row.reconciliationStatus==="CAFE24_API_ONLY_VERIFIED" &&
            !row.warningCodes.some(code=>["CAFE24_SHADOW_NOT_PRIMARY","CAFE24_SOURCE_ACTIVATION_REQUIRED"].includes(code)))) succeeded.clear();
        const totalUnits = cadence;
        const missingDates = Array.from({ length: totalUnits }, (_, offset) =>
          new Date(Date.parse(`${slot.fromDate}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10))
          .filter((day) => !succeeded.has(day) && !kinds.every((kind) => coverage.some((row) =>
            row.source === "API" && row.dataKind === kind && row.metricDate.toISOString().slice(0, 10) === day && row.lastSuccessRunId &&
            row.lastSuccessAt && row.lastSuccessAt >= new Date(slot.scheduledFor) &&
            (!dualMeta || row.lastSuccessRunId === run?.id) &&
            (connection.provider!=="CAFE24" || row.reconciliationStatus==="CAFE24_API_ONLY_VERIFIED" &&
              !row.warningCodes.some(code=>["CAFE24_SHADOW_NOT_PRIMARY","CAFE24_SOURCE_ACTIVATION_REQUIRED"].includes(code))) &&
            (row.state === "COMPLETE_ZERO" || row.state === "COMPLETE_NONZERO"))));
        if (missingDates.length) items.push({ scheduleKey: definition.key, scheduledFor: slot.scheduledFor,
          fromDate: slot.fromDate, toDate: slot.toDate, id: run?.id ?? null,
          status: run?.status === "ACTION_REQUIRED" ? "ACTION_REQUIRED" : slot.deadlineAt <= new Date() ? "EXPIRED" : run?.status ?? "NOT_STARTED",
          missingDates, warningCode: slot.deadlineAt <= new Date() ? "MISSING_SCHEDULE" : "SCHEDULE_INCOMPLETE" });
      }
    }
    return { items, history, historyLimits: { cafe24Occurrences: 31, adsOccurrences: 5 }, automaticBackfill: false };
  }
}

export function scheduledUnitDeadline(provider: "CAFE24" | "GOOGLE" | "META", deadlineAt: Date, now = Date.now()) {
  return Math.min(now + (provider === "META" ? 65_000 : SCHEDULE_UNIT_MS), deadlineAt.getTime() - 10_000);
}
