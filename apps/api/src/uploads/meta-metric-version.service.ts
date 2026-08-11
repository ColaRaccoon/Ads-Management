import { Injectable } from "@nestjs/common";
import { ConflictPolicy } from "@prisma/client";
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

  async importAdDailyMetric(input: AdMetricImportInput) {
    let skipped = false;
    await this.prisma.$transaction(async (tx) => {
      const existingRows = await tx.metaAdDailyMetric.findMany({
        where: {
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
        return;
      }

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
      }

      const created = await tx.metaAdDailyMetric.create({
        data: adDailyMetricCreateData(input, importVersion)
      });

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdDailyMetric.update({
          where: { id: current.id },
          data: { supersededByMetricId: created.id }
        });
      }
    });

    return { imported: !skipped, skipped };
  }

  async importMetric(input: MetricImportInput) {
    let skipped = false;
    await this.prisma.$transaction(async (tx) => {
      const existingRows = await tx.metaAdsetDailyMetric.findMany({
        where: {
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
        return;
      }

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdsetDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
      }

      const created = await tx.metaAdsetDailyMetric.create({
        data: adsetMetricCreateData(input, importVersion)
      });

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdsetDailyMetric.update({
          where: { id: current.id },
          data: { supersededByMetricId: created.id }
        });
      }
    });

    return { imported: !skipped, skipped };
  }

  async importAdsetAggregateMetric(batchId: string, input: AdsetAggregateInput, conflictPolicy: ConflictPolicy) {
    let skipped = false;
    await this.prisma.$transaction(async (tx) => {
      const existingRows = await tx.metaAdsetDailyMetric.findMany({
        where: {
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
        return;
      }

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdsetDailyMetric.update({ where: { id: current.id }, data: { isCurrent: false } });
      }

      const created = await tx.metaAdsetDailyMetric.create({
        data: adsetAggregateMetricCreateData(batchId, input, importVersion)
      });

      if (current && duplicateDecision.supersedeExisting) {
        await tx.metaAdsetDailyMetric.update({
          where: { id: current.id },
          data: { supersededByMetricId: created.id }
        });
      }
    });
    return { imported: !skipped, skipped };
  }

  async deactivateMissingSnapshotMetrics(input: { snapshotDates: Date[]; includedKeys: Set<string> }) {
    if (input.snapshotDates.length === 0 || input.includedKeys.size === 0) {
      return 0;
    }

    const currentMetrics = await this.prisma.metaAdsetDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { in: input.snapshotDates }
      },
      select: { id: true, metricDate: true, metaAdsetId: true }
    });
    const staleIds = findMissingSnapshotMetricIds(currentMetrics, input.includedKeys);

    if (staleIds.length === 0) {
      return 0;
    }

    const result = await this.prisma.metaAdsetDailyMetric.updateMany({
      where: { id: { in: staleIds } },
      data: { isCurrent: false }
    });
    return result.count;
  }

  async deactivateMissingAdSnapshotMetrics(input: { snapshotDates: Date[]; includedKeys: Set<string> }) {
    if (input.snapshotDates.length === 0 || input.includedKeys.size === 0) {
      return 0;
    }

    const currentMetrics = await this.prisma.metaAdDailyMetric.findMany({
      where: {
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

    const result = await this.prisma.metaAdDailyMetric.updateMany({
      where: { id: { in: staleIds } },
      data: { isCurrent: false }
    });
    return result.count;
  }
}
