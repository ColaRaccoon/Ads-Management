import { Injectable } from "@nestjs/common";
import { ConflictPolicy, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { formatDateOnly } from "../domain/date-number";
import { aggregateAdRows } from "./meta-adset-aggregates";
import { MetaMetricVersionService } from "./meta-metric-version.service";
import { snapshotMetricKey } from "./upload-keys";
import { linkBoundCsvVersion } from "../daily-sync/canonical-write-policy";

@Injectable()
export class MetaAdsetAggregateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metricVersionService: MetaMetricVersionService
  ) {}

  async refreshAdsetAggregatesFromAdMetrics(
    batchId: string,
    snapshotDates: Date[],
    client: Prisma.TransactionClient | PrismaService = this.prisma,
    connectionId: string | null = null
  ) {
    if (snapshotDates.length === 0) {
      return 0;
    }

    const metrics = await client.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
        source: "CSV",
        connectionId,
        metricDate: { in: snapshotDates }
      },
      orderBy: [{ metricDate: "asc" }, { adsetNameSnapshot: "asc" }, { adNameSnapshot: "asc" }]
    });
    const groups = new Map<string, typeof metrics>();
    for (const metric of metrics) {
      const key = `${formatDateOnly(metric.metricDate)}:${metric.metaAdsetRefId}`;
      groups.set(key, [...(groups.get(key) ?? []), metric]);
    }

    let importedCount = 0;
    const includedAdsetKeys = new Set<string>();
    for (const rows of groups.values()) {
      const aggregate = aggregateAdRows(rows);
      const result = await this.metricVersionService.importAdsetAggregateMetric(
        batchId,
        aggregate,
        ConflictPolicy.OVERWRITE,
        client,
        connectionId
      );
      if (result.imported) {
        if (result.metricId && result.version !== null) {
          await linkBoundCsvVersion(client as Prisma.TransactionClient, {
            connectionId, dataKind: "META_ADSET",
            keyParts: [connectionId ?? "", formatDateOnly(aggregate.metricDate), rows[0].metaAdsetId],
            recordTable: "meta_adset_daily_metrics", recordId: result.metricId,
            version: result.version
          });
        }
        includedAdsetKeys.add(snapshotMetricKey(aggregate.metricDate, aggregate.metaAdsetId));
        importedCount += 1;
      }
    }

    if (includedAdsetKeys.size > 0) {
      await this.metricVersionService.deactivateMissingSnapshotMetrics(
        { snapshotDates, includedKeys: includedAdsetKeys, connectionId },
        client
      );
    }
    return importedCount;
  }
}
