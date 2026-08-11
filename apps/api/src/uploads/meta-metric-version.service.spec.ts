import { AdStage, ConflictPolicy, MatchSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { toDateOnly } from "../domain/date-number";
import { MetaMetricVersionService } from "./meta-metric-version.service";
import { snapshotAdMetricKey } from "./upload-keys";

describe("MetaMetricVersionService adset history", () => {
  it.each([ConflictPolicy.NEW_VERSION, ConflictPolicy.OVERWRITE])(
    "%s preserves the old row and makes version 2 current",
    async (conflictPolicy) => {
      const harness = adsetMetricHarness();

      const result = await harness.service.importMetric(metricInput(conflictPolicy));

      expect(result).toEqual({ imported: true, skipped: false });
      expect(harness.rows).toHaveLength(2);
      expect(harness.rows[0]).toMatchObject({
        id: "metric-v1",
        importVersion: 1,
        isCurrent: false,
        supersededByMetricId: "metric-v2"
      });
      expect(harness.rows[1]).toMatchObject({
        id: "metric-v2",
        uploadBatchId: "batch-new",
        importVersion: 2,
        isCurrent: true,
        supersededByMetricId: null,
        resultCount: 3
      });
      expect(String(harness.rows[1].spendUsd)).toBe("10");
    }
  );

  it("SKIP leaves the current row unchanged and does not create another version", async () => {
    const harness = adsetMetricHarness();

    const result = await harness.service.importMetric(metricInput(ConflictPolicy.SKIP));

    expect(result).toEqual({ imported: false, skipped: true });
    expect(harness.rows).toEqual([
      expect.objectContaining({ id: "metric-v1", importVersion: 1, isCurrent: true, supersededByMetricId: null })
    ]);
  });
});

describe("MetaMetricVersionService snapshot deactivation", () => {
  it("deactivates only ad metrics absent from the imported snapshot", async () => {
    const metricDate = date("2026-08-10");
    let updatedIds: string[] = [];
    const currentMetrics = [
      adSnapshotMetric("metric-keep", "ad-keep", metricDate),
      adSnapshotMetric("metric-stale", "ad-stale", metricDate)
    ];
    const prisma = {
      metaAdDailyMetric: {
        findMany: async () => currentMetrics,
        updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          updatedIds = where.id.in;
          return { count: updatedIds.length };
        }
      }
    };
    const service = new MetaMetricVersionService(prisma as never);

    const count = await service.deactivateMissingAdSnapshotMetrics({
      snapshotDates: [metricDate],
      includedKeys: new Set([snapshotAdMetricKey(currentMetrics[0])])
    });

    expect(count).toBe(1);
    expect(updatedIds).toEqual(["metric-stale"]);
  });
});

type StoredAdsetMetric = {
  id: string;
  uploadBatchId: string;
  importVersion: number;
  isCurrent: boolean;
  supersededByMetricId: string | null;
} & Record<string, unknown>;

function adsetMetricHarness() {
  const rows: StoredAdsetMetric[] = [{
    id: "metric-v1",
    uploadBatchId: "batch-old",
    metricDate: date("2026-08-10"),
    metaAdsetId: "adset-ref-1",
    importVersion: 1,
    isCurrent: true,
    supersededByMetricId: null
  }];
  const model = {
    findMany: async () => [...rows].sort((left, right) => right.importVersion - left.importVersion),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error(`Missing row: ${where.id}`);
      Object.assign(row, data);
      return row;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { ...data, id: `metric-v${rows.length + 1}` } as StoredAdsetMetric;
      rows.push(row);
      return row;
    }
  };
  const prisma = {
    $transaction: async (callback: (tx: { metaAdsetDailyMetric: typeof model }) => Promise<void>) =>
      callback({ metaAdsetDailyMetric: model })
  };
  return { rows, service: new MetaMetricVersionService(prisma as never) };
}

function metricInput(conflictPolicy: ConflictPolicy) {
  return {
    batchId: "batch-new",
    uploadRowId: "row-new",
    parsedRow: {
      dateStart: date("2026-08-10"),
      dateEnd: date("2026-08-10"),
      metricDate: date("2026-08-10"),
      adsetName: "광고세트",
      adsetNameKey: "광고세트",
      deliveryStatus: "active",
      attributionSetting: null,
      resultCount: 3,
      resultIndicator: "구매",
      reach: 100,
      frequency: 1.2,
      costPerResultUsd: 3.33,
      adsetBudgetLabel: null,
      adsetBudgetType: null,
      spendUsd: 10,
      endStatus: null,
      startDate: null,
      impressions: 120,
      cpmUsd: 83.33,
      linkClicks: 10,
      shopClicks: 0,
      cpcLinkUsd: 1,
      ctrLinkPct: 8.33,
      clicksAll: 12,
      ctrAllPct: 10,
      cpcAllUsd: 0.83,
      landingPageViews: 8,
      costPerLandingPageViewUsd: 1.25
    },
    rawRow: {},
    metaAdsetId: "adset-ref-1",
    productId: "product-1",
    productMatchSource: MatchSource.RULE,
    productMatchRuleId: "rule-1",
    stage: AdStage.SC,
    stageMatchSource: MatchSource.RULE,
    conflictPolicy
  };
}

function adSnapshotMetric(id: string, adIdentityKey: string, metricDate: Date) {
  return {
    id,
    metricDate,
    metaCampaignId: "campaign-1",
    metaAdsetId: "adset-1",
    adIdentityKey
  };
}

function date(value: string) {
  const parsed = toDateOnly(value);
  if (!parsed) throw new Error(`Invalid date: ${value}`);
  return parsed;
}
