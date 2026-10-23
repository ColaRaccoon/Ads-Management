import { Injectable } from "@nestjs/common";
import { ConflictPolicy, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { DuplicatePolicyResolver } from "../domain/duplicate-policy";
import { AdMetricImportInput, AdsetAggregateInput, MetricImportInput } from "./upload-contracts";
import { findMissingSnapshotMetricIds, nextImportVersion, snapshotAdMetricKey } from "./upload-keys";
import {
  adDailyMetricCreateData,
  adsetAggregateMetricCreateData,
  adsetMetricCreateData
} from "./meta-metric-write-data";

@Injectable()
export class MetaMetricVersionService {
  private readonly duplicatePolicyResolver = new DuplicatePolicyResolver();

  constructor(private readonly prisma: PrismaService) {}

  /** API versions share the CSV canonical table but retain independent current/history. */
  async importApiAdDailyMetric(input: {
    connectionId: string; revision: string;
    data: Prisma.MetaAdDailyMetricUncheckedCreateInput;
  }, tx: Prisma.TransactionClient) {
    const key = {
      source: "API" as const, connectionId: input.connectionId,
      metricDate: input.data.metricDate as Date,
      metaCampaignId: input.data.metaCampaignId,
      metaAdsetId: input.data.metaAdsetId,
      adIdentityKey: input.data.adIdentityKey
    };
    const existing = await tx.metaAdDailyMetric.findMany({ where: key,
      orderBy: { importVersion: "desc" },
      select: { id: true, importVersion: true, isCurrent: true, sourceRevision: true }
    });
    const current = existing.find((row) => row.isCurrent);
    if (current?.sourceRevision === input.revision) return { imported: false, metric: current };
    if (current) await tx.metaAdDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
    const metric = await tx.metaAdDailyMetric.create({ data: {
      ...input.data, source: "API", connectionId: input.connectionId,
      sourceRevision: input.revision, importVersion: nextImportVersion(existing[0]?.importVersion), isCurrent: true,
      uploadBatchId: null, uploadRowId: null, rawRow: Prisma.DbNull
    } });
    if (current) await tx.metaAdDailyMetric.update({ where: { id: current.id },
      data: { supersededByMetricId: metric.id } });
    return { imported: true, metric };
  }

  async importApiAdsetMetric(input: {
    connectionId: string; revision: string;
    data: Prisma.MetaAdsetDailyMetricUncheckedCreateInput;
  }, tx: Prisma.TransactionClient) {
    const key = { source: "API" as const, connectionId: input.connectionId,
      metricDate: input.data.metricDate as Date, metaAdsetId: input.data.metaAdsetId };
    const existing = await tx.metaAdsetDailyMetric.findMany({ where: key,
      orderBy: { importVersion: "desc" },
      select: { id: true, importVersion: true, isCurrent: true, sourceRevision: true }
    });
    const current = existing.find((row) => row.isCurrent);
    if (current?.sourceRevision === input.revision) return { imported: false, metric: current };
    if (current) await tx.metaAdsetDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
    const metric = await tx.metaAdsetDailyMetric.create({ data: {
      ...input.data, source: "API", connectionId: input.connectionId,
      sourceRevision: input.revision, importVersion: nextImportVersion(existing[0]?.importVersion), isCurrent: true,
      uploadBatchId: null, uploadRowId: null, rawRow: Prisma.DbNull
    } });
    if (current) await tx.metaAdsetDailyMetric.update({ where: { id: current.id },
      data: { supersededByMetricId: metric.id } });
    return { imported: true, metric };
  }

  async importAdDailyMetric(
    input: AdMetricImportInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    let skipped = false;
    let metricId: string | null = null;
    let version: number | null = null;
    await this.withTransaction(client, async (tx) => {
      const existingRows = await tx.metaAdDailyMetric.findMany({
        where: {
          source: "CSV",
          connectionId: input.connectionId ?? null,
          metricDate: input.parsedRow.metricDate,
          metaCampaignId: input.parsedRow.metaCampaignId,
          metaAdsetId: input.parsedRow.metaAdsetExternalId,
          adIdentityKey: input.parsedRow.adIdentityKey
        },
        orderBy: { importVersion: "desc" },
        select: { id: true, importVersion: true, isCurrent: true }
      });
      const latest = existingRows[0] ?? null;
      const current = existingRows.find((row) => row.isCurrent) ?? null;
      const importVersion = nextImportVersion(latest?.importVersion);
      const duplicateDecision = this.duplicatePolicyResolver.resolve(input.conflictPolicy, Boolean(current));

      if (!duplicateDecision.importMetric) {
        skipped = true;
        metricId = current?.id ?? null;
        version = current?.importVersion ?? null;
        return;
      }

      if (current && duplicateDecision.supersedeExisting && input.publishCurrent !== false) {
        await tx.metaAdDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
      }

      const created = await tx.metaAdDailyMetric.create({
        data: adDailyMetricCreateData(input, importVersion)
      });
      metricId = created.id;
      version = importVersion;

      if (current && duplicateDecision.supersedeExisting && input.publishCurrent !== false) {
        await tx.metaAdDailyMetric.update({
          where: { id: current.id },
          data: { supersededByMetricId: created.id }
        });
      }
    });

    return { imported: !skipped, skipped, metricId, version };
  }

  async importMetric(input: MetricImportInput, client: Prisma.TransactionClient | PrismaService = this.prisma) {
    let skipped = false;
    let metricId: string | null = null;
    let version: number | null = null;
    await this.withTransaction(client, async (tx) => {
      const existingRows = await tx.metaAdsetDailyMetric.findMany({
        where: {
          source: "CSV",
          connectionId: input.connectionId ?? null,
          metricDate: input.parsedRow.metricDate,
          metaAdsetId: input.metaAdsetId
        },
        orderBy: { importVersion: "desc" },
        select: { id: true, importVersion: true, isCurrent: true }
      });
      const latest = existingRows[0] ?? null;
      const current = existingRows.find((row) => row.isCurrent) ?? null;
      const importVersion = nextImportVersion(latest?.importVersion);
      const duplicateDecision = this.duplicatePolicyResolver.resolve(input.conflictPolicy, Boolean(current));

      if (!duplicateDecision.importMetric) {
        skipped = true;
        metricId = current?.id ?? null;
        version = current?.importVersion ?? null;
        return;
      }

      if (current && duplicateDecision.supersedeExisting && input.publishCurrent !== false) {
        await tx.metaAdsetDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
      }

      const created = await tx.metaAdsetDailyMetric.create({
        data: adsetMetricCreateData(input, importVersion)
      });
      metricId = created.id;
      version = importVersion;

      if (current && duplicateDecision.supersedeExisting && input.publishCurrent !== false) {
        await tx.metaAdsetDailyMetric.update({
          where: { id: current.id },
          data: { supersededByMetricId: created.id }
        });
      }
    });

    return { imported: !skipped, skipped, metricId, version };
  }

  async importAdsetAggregateMetric(
    batchId: string,
    input: AdsetAggregateInput,
    conflictPolicy: ConflictPolicy,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
    connectionId: string | null = null
  ) {
    let skipped = false;
    let metricId: string | null = null;
    let version: number | null = null;
    await this.withTransaction(client, async (tx) => {
      const existingRows = await tx.metaAdsetDailyMetric.findMany({
        where: {
          source: "CSV",
          connectionId,
          metricDate: input.metricDate,
          metaAdsetId: input.metaAdsetId
        },
        orderBy: { importVersion: "desc" },
        select: { id: true, importVersion: true, isCurrent: true }
      });
      const latest = existingRows[0] ?? null;
      const current = existingRows.find((row) => row.isCurrent) ?? null;
      const importVersion = nextImportVersion(latest?.importVersion);
      const duplicateDecision = this.duplicatePolicyResolver.resolve(conflictPolicy, Boolean(current));

      if (!duplicateDecision.importMetric) {
        skipped = true;
        metricId = current?.id ?? null;
        version = current?.importVersion ?? null;
        return;
      }

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdsetDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
      }

      const created = await tx.metaAdsetDailyMetric.create({
        data: adsetAggregateMetricCreateData(batchId, input, importVersion, connectionId)
      });
      metricId = created.id;
      version = importVersion;

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdsetDailyMetric.update({
          where: { id: current.id },
          data: { supersededByMetricId: created.id }
        });
      }
    });
    return { imported: !skipped, skipped, metricId, version };
  }

  async deactivateMissingSnapshotMetrics(
    input: { snapshotDates: Date[]; includedKeys: Set<string>; connectionId?: string | null },
    client: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    if (input.snapshotDates.length === 0 || input.includedKeys.size === 0) {
      return 0;
    }

    const currentMetrics = await client.metaAdsetDailyMetric.findMany({
      where: {
        source: "CSV",
        connectionId: input.connectionId ?? null,
        isCurrent: true,
        metricDate: { in: input.snapshotDates }
      },
      select: { id: true, metricDate: true, metaAdsetId: true }
    });
    const staleIds = findMissingSnapshotMetricIds(currentMetrics, input.includedKeys);

    if (staleIds.length === 0) {
      return 0;
    }

    const result = await client.metaAdsetDailyMetric.updateMany({
      where: { id: { in: staleIds } },
      data: { isCurrent: false }
    });
    if (input.connectionId) await client.sourceRecordLink.updateMany({ where: {
      connectionId: input.connectionId, source: "CSV", dataKind: "META_ADSET",
      recordTable: "meta_adset_daily_metrics", recordId: { in: staleIds }, isCurrent: true
    }, data: { isCurrent: false } });
    return result.count;
  }

  async deactivateMissingAdSnapshotMetrics(
    input: { snapshotDates: Date[]; includedKeys: Set<string>; connectionId?: string | null },
    client: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    if (input.snapshotDates.length === 0 || input.includedKeys.size === 0) {
      return 0;
    }

    const currentMetrics = await client.metaAdDailyMetric.findMany({
      where: {
        source: "CSV",
        connectionId: input.connectionId ?? null,
        isCurrent: true,
        metricDate: { in: input.snapshotDates }
      },
      select: {
        id: true,
        metricDate: true,
        metaCampaignId: true,
        metaAdsetId: true,
        adIdentityKey: true
      }
    });
    const staleIds = currentMetrics
      .filter((metric) => !input.includedKeys.has(snapshotAdMetricKey(metric)))
      .map((metric) => metric.id);

    if (staleIds.length === 0) {
      return 0;
    }

    const result = await client.metaAdDailyMetric.updateMany({
      where: { id: { in: staleIds } },
      data: { isCurrent: false }
    });
    if (input.connectionId) await client.sourceRecordLink.updateMany({ where: {
      connectionId: input.connectionId, source: "CSV", dataKind: "META_AD",
      recordTable: "meta_ad_daily_metrics", recordId: { in: staleIds }, isCurrent: true
    }, data: { isCurrent: false } });
    return result.count;
  }

  private withTransaction<T>(
    client: Prisma.TransactionClient | PrismaService,
    work: (tx: Prisma.TransactionClient) => Promise<T>
  ) {
    return client === this.prisma
      ? this.prisma.$transaction(work)
      : work(client as Prisma.TransactionClient);
  }
}
