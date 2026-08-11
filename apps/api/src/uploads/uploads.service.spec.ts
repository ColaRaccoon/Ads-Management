import { describe, expect, it } from "vitest";
import { AdStage, ConflictPolicy, MatchSource } from "@prisma/client";
import { toDateOnly } from "../domain/date-number";
import { MetaAdDailyCsvParser, type ParsedMetaAdDailyRow } from "../domain/meta-ad-daily-csv";
import { findMissingSnapshotMetricIds, nextImportVersion, snapshotMetricKey, UploadsService } from "./uploads.service";
import { MetaMetricVersionService } from "./meta-metric-version.service";
import { UPLOAD_DELETE_TRANSACTION_OPTIONS, UploadLifecycleService } from "./upload-lifecycle.service";

describe("UploadsService public facade contract", () => {
  it("keeps every controller-facing operation public", () => {
    const methods = Object.getOwnPropertyNames(UploadsService.prototype);

    expect(methods).toEqual(expect.arrayContaining([
      "importMetaAdDailyCsv",
      "importMetaAdsetCsv",
      "listUploads",
      "previewUpload",
      "uploadErrors",
      "deleteUpload"
    ]));
  });

  it("delegates all six operations to their responsibility services", async () => {
    const service = new UploadsService(
      { importMetaAdDailyCsv: async () => "ad-daily" } as never,
      { importMetaAdsetCsv: async () => "adset" } as never,
      {
        listUploads: async () => "list",
        previewUpload: async () => "preview",
        uploadErrors: async () => "errors"
      } as never,
      { deleteUpload: async () => "deleted" } as never
    );

    await expect(service.importMetaAdDailyCsv(undefined, ConflictPolicy.SKIP)).resolves.toBe("ad-daily");
    await expect(service.importMetaAdsetCsv(undefined, ConflictPolicy.SKIP)).resolves.toBe("adset");
    await expect(service.listUploads()).resolves.toBe("list");
    await expect(service.previewUpload("batch-1")).resolves.toBe("preview");
    await expect(service.uploadErrors("batch-1")).resolves.toBe("errors");
    await expect(service.deleteUpload("batch-1")).resolves.toBe("deleted");
  });
});

describe("upload snapshot helpers", () => {
  it("uses latest importVersion regardless of current row", () => {
    expect(nextImportVersion(null)).toBe(1);
    expect(nextImportVersion(0)).toBe(1);
    expect(nextImportVersion(3)).toBe(4);
  });

  it("builds stable metric snapshot keys", () => {
    expect(snapshotMetricKey(date("2026-06-01"), "adset-1")).toBe("2026-06-01:adset-1");
  });

  it("finds current metrics missing from the imported CSV snapshot", () => {
    const currentMetrics = [
      { id: "metric-a", metricDate: date("2026-06-01"), metaAdsetId: "adset-a" },
      { id: "metric-b", metricDate: date("2026-06-01"), metaAdsetId: "adset-b" },
      { id: "metric-c", metricDate: date("2026-06-01"), metaAdsetId: "adset-c" }
    ];
    const includedKeys = new Set([
      snapshotMetricKey(date("2026-06-01"), "adset-a"),
      snapshotMetricKey(date("2026-06-01"), "adset-c")
    ]);

    expect(findMissingSnapshotMetricIds(currentMetrics, includedKeys)).toEqual(["metric-b"]);
  });
});

describe("Meta ad daily upload mapping", () => {
  it("passes all five parsed video counts to Prisma without calculating rates", async () => {
    const parsedRow = parseAdRow({
      "동영상 3초 이상 재생": "9",
      "동영상 25% 재생": "2",
      "동영상 50% 재생": "1",
      "동영상 75% 재생": "",
      "동영상 100% 재생": ""
    });
    const data = await captureAdMetricCreateData(parsedRow);

    expect(data).toMatchObject({
      videoPlay3sCount: 9,
      videoPlay25Count: 2,
      videoPlay50Count: 1,
      videoPlay75Count: 0,
      videoPlay100Count: 0
    });
    expect(Object.keys(data).some((key) => key.toLowerCase().includes("ratepct"))).toBe(false);
  });

  it("preserves null counts for a legacy row", async () => {
    const data = await captureAdMetricCreateData(parseAdRow());

    expect(data).toMatchObject({
      videoPlay3sCount: null,
      videoPlay25Count: null,
      videoPlay50Count: null,
      videoPlay75Count: null,
      videoPlay100Count: null
    });
  });
});

describe("Meta ad daily metric version history", () => {
  it("keeps the long-running delete transaction options unchanged", () => {
    expect(UPLOAD_DELETE_TRANSACTION_OPTIONS).toEqual({ maxWait: 30_000, timeout: 300_000 });
  });

  it.each([
    ["NEW_VERSION", ConflictPolicy.NEW_VERSION],
    ["OVERWRITE", ConflictPolicy.OVERWRITE]
  ])("%s preserves the previous version and makes the new video counts current", async (_label, conflictPolicy) => {
    const parsedRow = parseAdRow({
      "동영상 3초 이상 재생": "0",
      "동영상 25% 재생": "12",
      "동영상 50% 재생": "7",
      "동영상 75% 재생": "3",
      "동영상 100% 재생": "1"
    });
    const previousVideoCounts: VideoCounts = {
      videoPlay3sCount: 21,
      videoPlay25Count: 10,
      videoPlay50Count: 5,
      videoPlay75Count: 2,
      videoPlay100Count: 1
    };
    const harness = metricHistoryHarness(parsedRow, previousVideoCounts);

    const result = await importAdMetric(harness.versionService, parsedRow, conflictPolicy, "batch-new");

    expect(result).toEqual({ imported: true, skipped: false });
    expect(harness.rows).toHaveLength(2);
    expect(harness.rows[0]).toMatchObject({
      id: "metric-v1",
      importVersion: 1,
      isCurrent: false,
      supersededByMetricId: "metric-v2",
      ...previousVideoCounts
    });
    expect(harness.rows[1]).toMatchObject({
      id: "metric-v2",
      uploadBatchId: "batch-new",
      importVersion: 2,
      isCurrent: true,
      supersededByMetricId: null,
      videoPlay3sCount: 0,
      videoPlay25Count: 12,
      videoPlay50Count: 7,
      videoPlay75Count: 3,
      videoPlay100Count: 1
    });
  });

  it("stores a legacy row as null counts in a new version instead of coercing it to zero", async () => {
    const parsedRow = parseAdRow();
    const harness = metricHistoryHarness(parsedRow, {
      videoPlay3sCount: 8,
      videoPlay25Count: 4,
      videoPlay50Count: 2,
      videoPlay75Count: 1,
      videoPlay100Count: 1
    });

    await importAdMetric(harness.versionService, parsedRow, ConflictPolicy.NEW_VERSION, "batch-legacy");

    expect(harness.rows[1]).toMatchObject({
      importVersion: 2,
      isCurrent: true,
      videoPlay3sCount: null,
      videoPlay25Count: null,
      videoPlay50Count: null,
      videoPlay75Count: null,
      videoPlay100Count: null
    });
  });

  it("restores the previous version with unchanged video counts after deleting the latest upload", async () => {
    const parsedRow = parseAdRow({
      "동영상 3초 이상 재생": "30",
      "동영상 25% 재생": "15",
      "동영상 50% 재생": "8",
      "동영상 75% 재생": "4",
      "동영상 100% 재생": "2"
    });
    const previousVideoCounts: VideoCounts = {
      videoPlay3sCount: 19,
      videoPlay25Count: 9,
      videoPlay50Count: 4,
      videoPlay75Count: 2,
      videoPlay100Count: 1
    };
    const harness = metricHistoryHarness(parsedRow, previousVideoCounts);
    await importAdMetric(harness.versionService, parsedRow, ConflictPolicy.NEW_VERSION, "batch-new");

    const deleted = await harness.lifecycleService.deleteUpload("batch-new");

    expect(deleted).toMatchObject({
      batchId: "batch-new",
      deletedAdMetricCount: 1,
      restoredAdCurrentCount: 1
    });
    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0]).toMatchObject({
      id: "metric-v1",
      importVersion: 1,
      isCurrent: true,
      supersededByMetricId: null,
      ...previousVideoCounts
    });
  });

  it("restores the newest remaining adset metric using the shared transaction client", async () => {
    const metricDate = date("2026-08-10");
    const rows = [{ id: "adset-v1", metricDate, metaAdsetId: "adset-1", isCurrent: false, supersededByMetricId: null }];
    const tx = {
      metaAdsetDailyMetric: {
        updateMany: async () => {
          rows.forEach((row) => { row.isCurrent = false; });
          return { count: rows.length };
        },
        findFirst: async () => rows[0] ?? null,
        update: async ({ data }: { data: { isCurrent: boolean; supersededByMetricId: string | null } }) => {
          Object.assign(rows[0], data);
          return rows[0];
        }
      }
    };
    const service = new UploadLifecycleService({} as never, {} as never);

    const restored = await service.restoreCurrentAdsetMetrics(tx as never, [
      { id: "adset-v2", metricDate, metaAdsetId: "adset-1" }
    ]);

    expect(restored).toBe(1);
    expect(rows[0]).toMatchObject({ isCurrent: true, supersededByMetricId: null });
  });
});

function date(value: string) {
  const parsed = toDateOnly(value);
  if (!parsed) throw new Error(`Invalid test date: ${value}`);
  return parsed;
}

function parseAdRow(videoValues: Record<string, string> = {}): ParsedMetaAdDailyRow {
  const result = new MetaAdDailyCsvParser().parseRow({
    "보고 시작": "2026-08-10",
    "보고 종료": "2026-08-10",
    "캠페인 이름": "캠페인",
    "캠페인 ID": "campaign-1",
    "광고 세트 이름": "광고세트",
    "광고 세트 ID": "adset-1",
    "광고 이름": "260810_소재_01",
    "광고 게재": "active",
    "지출 금액 (USD)": "10",
    "노출": "100",
    "도달": "80",
    ...videoValues
  });
  if (!result.parsedRow || result.issues.length > 0) {
    throw new Error(`Invalid test row: ${JSON.stringify(result.issues)}`);
  }
  return result.parsedRow;
}

async function captureAdMetricCreateData(parsedRow: ParsedMetaAdDailyRow) {
  let createData: Record<string, unknown> | null = null;
  const transaction = {
    metaAdDailyMetric: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createData = data;
        return { id: "metric-new" };
      },
      update: async () => ({})
    }
  };
  const prisma = {
    $transaction: async (callback: (tx: typeof transaction) => Promise<void>) => callback(transaction)
  };
  const service = new MetaMetricVersionService(prisma as never);

  await service.importAdDailyMetric({
    batchId: "batch-1",
    uploadRowId: "upload-row-1",
    parsedRow,
    rawRow: {},
    campaignRefId: "campaign-ref-1",
    metaAdsetRefId: "adset-ref-1",
    metaAdRefId: "ad-ref-1",
    creativeId: "creative-1",
    productId: null,
    productMatchSource: MatchSource.UNMATCHED,
    productMatchRuleId: null,
    stage: AdStage.UNKNOWN,
    stageMatchSource: MatchSource.UNMATCHED,
    conflictPolicy: ConflictPolicy.NEW_VERSION
  });

  if (!createData) {
    throw new Error("Prisma create was not called.");
  }
  return createData;
}

type VideoCounts = {
  videoPlay3sCount: number | null;
  videoPlay25Count: number | null;
  videoPlay50Count: number | null;
  videoPlay75Count: number | null;
  videoPlay100Count: number | null;
};

type StoredAdMetric = VideoCounts & Record<string, unknown> & {
  id: string;
  uploadBatchId: string;
  metricDate: Date;
  metaCampaignId: string;
  metaAdsetId: string;
  adIdentityKey: string;
  adNameSnapshot: string;
  creativeId: string | null;
  importVersion: number;
  isCurrent: boolean;
  supersededByMetricId: string | null;
};

type MetricQuery = {
  where: Record<string, unknown>;
  data?: Record<string, unknown>;
};

function metricHistoryHarness(parsedRow: ParsedMetaAdDailyRow, previousVideoCounts: VideoCounts) {
  const rows: StoredAdMetric[] = [{
    id: "metric-v1",
    uploadBatchId: "batch-old",
    metricDate: parsedRow.metricDate,
    metaCampaignId: parsedRow.metaCampaignId,
    metaAdsetId: parsedRow.metaAdsetExternalId,
    adIdentityKey: parsedRow.adIdentityKey,
    adNameSnapshot: parsedRow.adName,
    creativeId: null,
    importVersion: 1,
    isCurrent: true,
    supersededByMetricId: null,
    ...previousVideoCounts
  }];

  const metaAdDailyMetric = {
    findMany: async ({ where }: MetricQuery) => {
      const matched = typeof where.uploadBatchId === "string"
        ? rows.filter((row) => row.uploadBatchId === where.uploadBatchId)
        : rows.filter((row) => matchesMetricKey(row, where));
      return [...matched].sort((left, right) => right.importVersion - left.importVersion);
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const created = {
        ...data,
        id: `metric-v${rows.length + 1}`
      } as unknown as StoredAdMetric;
      rows.push(created);
      return created;
    },
    update: async ({ where, data }: MetricQuery) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error(`Metric not found: ${String(where.id)}`);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: MetricQuery) => {
      const supersededFilter = isRecord(where.supersededByMetricId)
        ? where.supersededByMetricId.in
        : null;
      const matched = Array.isArray(supersededFilter)
        ? rows.filter((row) => supersededFilter.includes(row.supersededByMetricId))
        : rows.filter((row) => matchesMetricKey(row, where));
      matched.forEach((row) => Object.assign(row, data));
      return { count: matched.length };
    },
    findFirst: async ({ where }: MetricQuery) => {
      return [...rows]
        .filter((row) => matchesMetricKey(row, where))
        .sort((left, right) => right.importVersion - left.importVersion)[0] ?? null;
    },
    deleteMany: async ({ where }: MetricQuery) => {
      const deletedIds = rows
        .filter((row) => row.uploadBatchId === where.uploadBatchId)
        .map((row) => row.id);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (deletedIds.includes(rows[index].id)) rows.splice(index, 1);
      }
      return { count: deletedIds.length };
    }
  };
  const emptyVersionedMetricModel = {
    findMany: async () => [],
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findFirst: async () => null,
    update: async () => ({})
  };
  const uploadBatch = {
    findUnique: async ({ where }: { where: { id: string } }) => where.id === "batch-new"
      ? {
          id: "batch-new",
          originalFilename: "latest.csv",
          storedFilePath: null
        }
      : null,
    delete: async () => ({})
  };
  const transaction = {
    metaAdDailyMetric,
    metaAdsetDailyMetric: emptyVersionedMetricModel,
    uploadRowError: { deleteMany: async () => ({ count: 0 }) },
    uploadRow: { deleteMany: async () => ({ count: 0 }) },
    uploadBatch
  };
  const prisma = {
    uploadBatch,
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)
  };
  return {
    rows,
    versionService: new MetaMetricVersionService(prisma as never),
    lifecycleService: new UploadLifecycleService(
      prisma as never,
      { deleteStoredUploadFile: async () => false } as never
    )
  };
}

async function importAdMetric(
  service: MetaMetricVersionService,
  parsedRow: ParsedMetaAdDailyRow,
  conflictPolicy: ConflictPolicy,
  batchId: string
) {
  return service.importAdDailyMetric({
    batchId,
    uploadRowId: `row-${batchId}`,
    parsedRow,
    rawRow: {},
    campaignRefId: "campaign-ref-1",
    metaAdsetRefId: "adset-ref-1",
    metaAdRefId: "ad-ref-1",
    creativeId: null,
    productId: null,
    productMatchSource: MatchSource.UNMATCHED,
    productMatchRuleId: null,
    stage: AdStage.UNKNOWN,
    stageMatchSource: MatchSource.UNMATCHED,
    conflictPolicy
  });
}

function matchesMetricKey(row: StoredAdMetric, where: Record<string, unknown>) {
  const dateMatches = !(where.metricDate instanceof Date)
    || row.metricDate.getTime() === where.metricDate.getTime();
  return dateMatches
    && (typeof where.metaCampaignId !== "string" || row.metaCampaignId === where.metaCampaignId)
    && (typeof where.metaAdsetId !== "string" || row.metaAdsetId === where.metaAdsetId)
    && (typeof where.adIdentityKey !== "string" || row.adIdentityKey === where.adIdentityKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
