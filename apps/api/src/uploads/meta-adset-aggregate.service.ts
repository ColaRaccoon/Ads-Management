import { Injectable } from "@nestjs/common";
import { ConflictPolicy } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { formatDateOnly } from "../domain/date-number";
import { aggregateAdRows } from "./meta-adset-aggregates";
import { MetaMetricVersionService } from "./meta-metric-version.service";
import { snapshotMetricKey } from "./upload-keys";

@Injectable()
export class MetaAdsetAggregateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metricVersionService: MetaMetricVersionService
  ) {}

  async refreshAdsetAggregatesFromAdMetrics(batchId: string, snapshotDates: Date[]) {
    if (snapshotDates.length === 0) {
      return 0;
    }

    const metrics = await this.prisma.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
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
      const result = await this.metricVersionService.importAdsetAggregateMetric(batchId, aggregate, ConflictPolicy.OVERWRITE);
      if (result.imported) {
        includedAdsetKeys.add(snapshotMetricKey(aggregate.metricDate, aggregate.metaAdsetId));
        importedCount += 1;
      }
    }

    if (includedAdsetKeys.size > 0) {
      await this.metricVersionService.deactivateMissingSnapshotMetrics({ snapshotDates, includedKeys: includedAdsetKeys });
    }
    return importedCount;
  }
}
