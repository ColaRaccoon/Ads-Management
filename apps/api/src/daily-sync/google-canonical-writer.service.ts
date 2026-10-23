import { Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, SourceBindingMethod, SourceDataKind, SourceKind, SourceProvider } from "@prisma/client";
import { GoogleCampaignRow, GoogleDaySnapshot } from "./google-ads.client";
import { SyncFoundationService } from "./sync-foundation.service";
import { syncError } from "./sync-contract";

const MAX_INT64 = 9_223_372_036_854_775_807n;

/** Publishes only a complete, reconciled account/day snapshot. */
@Injectable()
export class GoogleCanonicalWriterService {
  constructor(private readonly foundation: SyncFoundationService) {}

  async publish(input: {
    runId: string; connectionId: string; generation: bigint; metricDate: Date;
    policyVersion: number; snapshot: GoogleDaySnapshot;
  }) {
    const day = input.metricDate.toISOString().slice(0, 10);
    if (input.metricDate.toISOString().slice(10) !== "T00:00:00.000Z" ||
        !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1 ||
        input.snapshot.rows.length > 10_000 || input.snapshot.pageCount < 1)
      syncError("RECONCILIATION_FAILED");
    if (input.snapshot.currencyCode !== "KRW") syncError("CURRENCY_MISMATCH");
    if (input.snapshot.timeZone !== "Asia/Seoul") syncError("TIMEZONE_MISMATCH");
    const keys = new Set<string>();
    let total = 0n;
    for (const row of input.snapshot.rows) {
      validateRow(row);
      if (keys.has(row.campaignId)) syncError("RECONCILIATION_FAILED");
      keys.add(row.campaignId);
      total += row.costMicros;
    }
    if (total !== input.snapshot.accountCostMicros || total > MAX_INT64)
      syncError("RECONCILIATION_FAILED");
    return this.foundation.publishUnit({
      runId: input.runId, generation: input.generation, unitKey: day, metricDate: input.metricDate,
      slices: [{ dataKind: SourceDataKind.GOOGLE_CAMPAIGN, source: SourceKind.API,
        policyVersion: input.policyVersion, fetchedCount: input.snapshot.rows.length,
        pageCount: input.snapshot.pageCount, complete: true,
        totalAmount: new Prisma.Decimal(total.toString()).div(1_000_000) }],
      writeRows: async (tx) => {
        const connection = await tx.sourceConnection.findUnique({ where: { id: input.connectionId },
          select: { provider: true, currencyCode: true, timeZone: true } });
        const run = await tx.syncRun.findUnique({ where: { id: input.runId }, select: { connectionId: true } });
        if (connection?.provider !== SourceProvider.GOOGLE || run?.connectionId !== input.connectionId)
          syncError("ACCOUNT_SCOPE_MISMATCH");
        if (connection.currencyCode !== input.snapshot.currencyCode) syncError("CURRENCY_MISMATCH");
        if (connection.timeZone !== input.snapshot.timeZone) syncError("TIMEZONE_MISMATCH");
        const current = await tx.googleCampaignDailyCost.findMany({ where: {
          connectionId: input.connectionId, metricDate: input.metricDate,
          source: SourceKind.API, isCurrent: true
        } });
        const byId = new Map(current.map((row) => [row.campaignId, row]));
        const changed = input.snapshot.rows.filter((row) => {
          const prior = byId.get(row.campaignId);
          return !prior || !sameRow(prior, row);
        });
        const changedIds = new Set(changed.map((row) => row.campaignId));
        const demoted = current.filter((row) => !keys.has(row.campaignId) ||
          changedIds.has(row.campaignId)).map((row) => row.id);
        for (const ids of chunks(demoted)) {
          await tx.googleCampaignDailyCost.updateMany({ where: { id: { in: ids } }, data: { isCurrent: false } });
          await tx.sourceRecordLink.updateMany({ where: {
            connectionId: input.connectionId, recordTable: "google_campaign_daily_costs",
            recordId: { in: ids }, isCurrent: true
          }, data: { isCurrent: false } });
        }
        if (changed.length) {
          const versions = await tx.googleCampaignDailyCost.groupBy({
            by: ["campaignId"], where: { connectionId: input.connectionId,
              metricDate: input.metricDate, campaignId: { in: changed.map((row) => row.campaignId) } },
            _max: { version: true }
          });
          const maxVersion = new Map(versions.map((item) => [item.campaignId, item._max.version ?? 0]));
          const fetchedAt = new Date();
          const prepared = changed.map((row) => ({ row, id: randomUUID(),
            version: (maxVersion.get(row.campaignId) ?? 0) + 1 }));
          for (const batch of chunks(prepared)) {
            await tx.googleCampaignDailyCost.createMany({ data: batch.map(({ row, id, version }) => ({
              id, connectionId: input.connectionId, metricDate: input.metricDate,
              campaignId: row.campaignId, campaignName: row.campaignName,
              channelType: row.channelType, costMicros: row.costMicros,
              impressions: row.impressions, clicks: row.clicks,
              conversionCount: null, conversionValue: null,
              source: SourceKind.API, syncRunId: input.runId, fetchedAt,
              version, isCurrent: true
            })) });
            await tx.sourceRecordLink.createMany({ data: batch.map(({ row, id, version }) => ({
              connectionId: input.connectionId, dataKind: SourceDataKind.GOOGLE_CAMPAIGN,
              canonicalKeyHash: createHash("sha256").update(JSON.stringify([
                input.connectionId, day, row.campaignId
              ])).digest("hex"),
              source: SourceKind.API, recordTable: "google_campaign_daily_costs",
              recordId: id, syncRunId: input.runId, version,
              isCurrent: true, bindingMethod: SourceBindingMethod.EXACT_ID
            })) });
          }
        }
        return { GOOGLE_CAMPAIGN: input.snapshot.rows.length };
      }
    });
  }
}

function* chunks<T>(items: T[]): Generator<T[]> {
  for (let offset = 0; offset < items.length; offset += 500)
    yield items.slice(offset, offset + 500);
}

function validateRow(row: GoogleCampaignRow) {
  if (!/^\d{1,20}$/.test(row.campaignId) || !row.campaignName.trim() ||
      row.campaignName.length > 256 || !/^[A-Z_]{1,64}$/.test(row.channelType) ||
      [row.costMicros, row.impressions, row.clicks].some((item) =>
        typeof item !== "bigint" || item < 0n || item > MAX_INT64))
    syncError("FIELD_UNSUPPORTED");
}

function sameRow(prior: {
  campaignName: string; channelType: string; costMicros: bigint;
  impressions: bigint; clicks: bigint
}, row: GoogleCampaignRow) {
  return prior.campaignName === row.campaignName && prior.channelType === row.channelType &&
    prior.costMicros === row.costMicros && prior.impressions === row.impressions &&
    prior.clicks === row.clicks;
}
