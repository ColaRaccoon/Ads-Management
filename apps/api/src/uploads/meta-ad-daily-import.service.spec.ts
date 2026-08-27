import { BadRequestException } from "@nestjs/common";
import { AdStage, ConflictPolicy, MatchSource, Prisma, UploadLevel, UploadStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { META_AD_DAILY_CSV_COLUMNS } from "../domain/meta-ad-daily-csv";
import { MetaAdDailyImportService } from "./meta-ad-daily-import.service";
import {
  pendingMetaOriginalStorageSchema,
  storedMetaOriginalStorageSchema
} from "./meta-original-storage-state";
import { snapshotAdMetricKey } from "./upload-keys";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

describe("MetaAdDailyImportService response and snapshot contract", () => {
  it("returns the established ad import fields through the real parser/orchestrator path", async () => {
    const harness = dailyImportHarness();

    const result = await harness.service.importMetaAdDailyCsv(file(dailyCsv()), ConflictPolicy.NEW_VERSION, ACTOR_ID);

    expect(result).toMatchObject({
      batchId: "batch-1",
      sourceLevel: UploadLevel.AD,
      schemaVersion: "meta_ad_daily_v3",
      status: UploadStatus.IMPORTED,
      rowCount: 1,
      validRowCount: 1,
      warningCount: 0,
      errorCount: 0,
      importedAdMetricCount: 1,
      importedAdsetMetricCount: 1,
      snapshotHiddenAdMetricCount: 2,
      skippedDuplicateCount: 0,
      unmatchedCount: 0,
      reportStart: "2026-08-10",
      reportEnd: "2026-08-10",
      previewSummary: expect.objectContaining({ rowCount: 1, videoMetricSchema: "FULL" })
    });
    expect(harness.batchCreates[0]).toMatchObject({ uploadedBy: ACTOR_ID });
  });

  it("includes a SKIP duplicate in the ad snapshot and still refreshes derived adsets", async () => {
    const harness = dailyImportHarness({ metricResult: { imported: false, skipped: true } });

    const result = await harness.service.importMetaAdDailyCsv(file(dailyCsv()), ConflictPolicy.SKIP, ACTOR_ID);

    const expectedKey = snapshotAdMetricKey({
      metricDate: new Date("2026-08-10T00:00:00.000Z"),
      metaCampaignId: "campaign-1",
      metaAdsetId: "adset-1",
      adIdentityKey: "ad-1"
    });
    expect(harness.snapshotInput?.includedKeys).toEqual(new Set([expectedKey]));
    expect(harness.aggregateCalls).toEqual([{ batchId: "batch-1", snapshotDates: [new Date("2026-08-10T00:00:00.000Z")] }]);
    expect(result).toMatchObject({ importedAdMetricCount: 0, skippedDuplicateCount: 1, importedAdsetMetricCount: 1 });
  });
});

describe("MetaAdDailyImportService validation contract", () => {
  it("preserves header error code, message, and details", async () => {
    const harness = dailyImportHarness();

    const error = await rejected(
      harness.service.importMetaAdDailyCsv(
        file(Buffer.from('"unknown"\n"value"', "utf8")),
        ConflictPolicy.NEW_VERSION,
        ACTOR_ID
      )
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: "CSV_HEADER_INVALID",
      message: "필수 광고 단위 CSV 컬럼이 누락되었습니다.",
      details: {
        batchId: "batch-1",
        missingColumns: expect.arrayContaining(["보고 시작", "캠페인 ID", "광고 이름"]),
        previewSummary: expect.objectContaining({ rowCount: 1 })
      }
    });
    expect(harness.batchUpdates.at(-1)).toMatchObject({
      status: UploadStatus.FAILED,
      errorCount: expect.any(Number),
      validatedAt: expect.any(Date)
    });
  });

  it("rejects duplicate ad-day keys inside one file before processing rows", async () => {
    const harness = dailyImportHarness();

    const error = await rejected(
      harness.service.importMetaAdDailyCsv(file(dailyCsv(2)), ConflictPolicy.NEW_VERSION, ACTOR_ID)
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: "DUPLICATE_AD_DAILY_KEY",
      message: "같은 파일 안에 중복 광고 일별 키가 있습니다.",
      details: {
        batchId: "batch-1",
        duplicateKeys: ["2026-08-10:campaign-1:adset-1:ad-1"]
      }
    });
    expect(harness.rowErrorCreates.flat()).toEqual([
      expect.objectContaining({ errorCode: "DUPLICATE_AD_DAILY_KEY" })
    ]);
    expect(harness.processedMetricInputs).toHaveLength(0);
  });
});

describe("MetaAdDailyImportService storage recovery", () => {
  it("returns the winning SKIP batch when concurrent creates collide",async()=>{
    const buffer=dailyCsv();const winner=storageRecoveryBatch(buffer,UploadStatus.IMPORTED,"STORED");const harness=dailyImportHarness({createRaceWinner:winner});
    await expect(harness.service.importMetaAdDailyCsv(file(buffer),ConflictPolicy.SKIP,ACTOR_ID)).resolves.toMatchObject({duplicate:true,batchId:"batch-1",status:UploadStatus.IMPORTED});
    expect(harness.processedMetricInputs).toHaveLength(0);
  });
  it("reuses a FAILED storage-pending batch and retries a missing object before importing", async () => {
    const buffer = dailyCsv();
    const duplicated = storageRecoveryBatch(buffer, UploadStatus.FAILED, "PENDING");
    const harness = dailyImportHarness({ duplicated, storageObjectState: "missing" });

    const result = await harness.service.importMetaAdDailyCsv(file(buffer), ConflictPolicy.SKIP, ACTOR_ID);

    expect(result).toMatchObject({ batchId: "batch-1", status: UploadStatus.IMPORTED });
    expect(result).not.toHaveProperty("duplicate");
    expect(harness.batchCreates).toHaveLength(0);
    expect(harness.putCalls).toEqual([{ reference: duplicated.storedFilePath, objectState: "missing" }]);
  });

  it("reclaims an expired STORED+VALIDATING zero-work batch and idempotently resumes import", async () => {
    const buffer = dailyCsv();
    const duplicated = storageRecoveryBatch(buffer, UploadStatus.VALIDATING, "STORED");
    const harness = dailyImportHarness({ duplicated, storageObjectState: "existing" });

    const result = await harness.service.importMetaAdDailyCsv(file(buffer), ConflictPolicy.SKIP, ACTOR_ID);

    expect(result).toMatchObject({ batchId: "batch-1", status: UploadStatus.IMPORTED });
    expect(result).not.toHaveProperty("duplicate");
    expect(harness.batchCreates).toHaveLength(0);
    expect(harness.putCalls).toEqual([{ reference: duplicated.storedFilePath, objectState: "existing" }]);
  });

  it("does not resume a stale storage marker once batch-owned domain work exists", async () => {
    const buffer = dailyCsv();
    const duplicated = storageRecoveryBatch(buffer, UploadStatus.VALIDATING, "STORED");
    const harness = dailyImportHarness({ duplicated, sideEffectCounts: { rows: 1 } });

    const result = await harness.service.importMetaAdDailyCsv(file(buffer), ConflictPolicy.SKIP, ACTOR_ID);

    expect(result).toMatchObject({ duplicate: true, batchId: "batch-1" });
    expect(harness.putCalls).toHaveLength(0);
    expect(harness.processedMetricInputs).toHaveLength(0);
  });

  it("holds the batch fence while an old owner is delayed so a retry cannot become a second writer", async () => {
    const buffer = dailyCsv();
    const entered = deferred<void>();
    const release = deferred<void>();
    let delayed = false;
    const harness = dailyImportHarness({
      duplicated: storageRecoveryBatch(buffer, UploadStatus.VALIDATING, "STORED"),
      serializeTransactions: true,
      beforeDomainWriter: async () => {
        if (delayed) return;
        delayed = true;
        entered.resolve();
        await release.promise;
      }
    });

    const oldOwner = harness.service.importMetaAdDailyCsv(file(buffer), ConflictPolicy.SKIP, ACTOR_ID);
    await entered.promise;
    let retrySettled = false;
    const retry = harness.service.importMetaAdDailyCsv(file(buffer), ConflictPolicy.SKIP, ACTOR_ID)
      .finally(() => { retrySettled = true; });
    await Promise.resolve();
    expect(retrySettled).toBe(false);
    release.resolve();

    const results = await Promise.all([oldOwner, retry]);
    expect(results.filter((result) => "duplicate" in result && result.duplicate)).toHaveLength(1);
    expect(harness.processedMetricInputs).toHaveLength(1);
  });
});

function dailyImportHarness(options: {
  metricResult?: { imported: boolean; skipped: boolean };
  duplicated?: Record<string, unknown>;
  storageObjectState?: "missing" | "existing";
  sideEffectCounts?: { rows?: number; errors?: number; adMetrics?: number; adsetMetrics?: number };
  serializeTransactions?: boolean;
  beforeDomainWriter?: () => Promise<void>;
  createRaceWinner?: Record<string, unknown>;
} = {}) {
  const batchCreates: Record<string, unknown>[] = [];
  const batchUpdates: Record<string, unknown>[] = [];
  const rowErrorCreates: Array<Array<Record<string, unknown>>> = [];
  const processedMetricInputs: unknown[] = [];
  const aggregateCalls: Array<{ batchId: string; snapshotDates: Date[] }> = [];
  const putCalls: Array<{ reference: string; objectState: "missing" | "existing" }> = [];
  let snapshotInput: { snapshotDates: Date[]; includedKeys: Set<string> } | null = null;
  const batch = {
    id: "batch-1",
    level: UploadLevel.AD,
    status: UploadStatus.VALIDATING,
    rowCount: 1,
    validRowCount: 0,
    warningCount: 0,
    errorCount: 0,
    reportStart: null,
    reportEnd: null,
    importedAt: null,
    validatedAt: null
  };
  let currentBatch: Record<string, unknown> | null = options.duplicated ? { ...options.duplicated } : null;
  let transactionTail: Promise<void> = Promise.resolve();
  const prisma = {
    uploadBatch: {
      findUnique: async () => currentBatch,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        batchCreates.push(data);
        if(options.createRaceWinner){currentBatch={...options.createRaceWinner};throw new Prisma.PrismaClientKnownRequestError("unique",{code:"P2002",clientVersion:"test"})}
        currentBatch = { ...batch, ...data, id: batch.id };
        return currentBatch;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        batchUpdates.push(data);
        currentBatch = { ...batch, ...currentBatch, ...data };
        return currentBatch;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!currentBatch || !matchesBatch(currentBatch, where)) return { count: 0 };
        batchUpdates.push(data);
        currentBatch = { ...currentBatch, ...data };
        return { count: 1 };
      }
    },
    uploadRowError: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        rowErrorCreates.push(data);
        return { count: data.length };
      },
      count: async () => options.sideEffectCounts?.errors ?? 0
    },
    uploadRow: {
      create: async () => ({ id: "upload-row-1" }),
      count: async () => options.sideEffectCounts?.rows ?? 0
    },
    metaAdDailyMetric: { count: async () => options.sideEffectCounts?.adMetrics ?? 0 },
    metaAdsetDailyMetric: { count: async () => options.sideEffectCounts?.adsetMetrics ?? 0 },
    metaAdset: {
      update: async () => ({})
    },
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => {
      const previous = transactionTail;
      let releaseTransaction!: () => void;
      transactionTail = new Promise<void>((resolve) => { releaseTransaction = resolve; });
      if (options.serializeTransactions) await previous;
      try {
        return await work(prisma);
      } finally {
        releaseTransaction();
      }
    }
  };
  const storage = {
    prepareOriginalFileReference: () => "local:test/meta-ad-daily",
    putOriginalFile: async (_file: Express.Multer.File, reference: string) => {
      putCalls.push({ reference, objectState: options.storageObjectState ?? "missing" });
    }
  };
  const entityWriter = {
    upsertCampaign: async () => {
      await options.beforeDomainWriter?.();
      return { id: "campaign-ref-1" };
    },
    upsertAdsetFromAdDaily: async () => ({ id: "adset-ref-1", firstSeenOn: null }),
    upsertCreativeFromAdDaily: async () => ({
      creative: { id: "creative-1" },
      parsedName: { originalName: "260810_소재_01", creativeKey: "소재_01" }
    }),
    upsertAd: async () => ({ id: "ad-ref-1" }),
    upsertCreativeAlias: async () => ({}),
    upsertCreativePlacement: async () => ({})
  };
  const metricVersion = {
    importAdDailyMetric: async (input: unknown) => {
      processedMetricInputs.push(input);
      return options.metricResult ?? { imported: true, skipped: false };
    },
    deactivateMissingAdSnapshotMetrics: async (input: typeof snapshotInput) => {
      snapshotInput = input;
      return 2;
    }
  };
  const aggregate = {
    refreshAdsetAggregatesFromAdMetrics: async (batchId: string, snapshotDates: Date[]) => {
      aggregateCalls.push({ batchId, snapshotDates });
      return 1;
    }
  };
  const mappings = {
    matchProduct: async () => ({ productId: "product-1", source: MatchSource.RULE, matchRuleId: "rule-1" }),
    matchStage: async () => ({ stage: AdStage.SC, source: MatchSource.RULE })
  };
  const exchangeRates = { ensureUsdKrwRates: async () => undefined };

  return {
    batchCreates,
    batchUpdates,
    rowErrorCreates,
    processedMetricInputs,
    aggregateCalls,
    putCalls,
    get snapshotInput() { return snapshotInput; },
    service: new MetaAdDailyImportService(
      prisma as never,
      storage as never,
      entityWriter as never,
      metricVersion as never,
      aggregate as never,
      mappings as never,
      exchangeRates as never
    )
  };
}

function storageRecoveryBatch(buffer: Buffer, status: UploadStatus, state: "PENDING" | "STORED") {
  const pending = pendingMetaOriginalStorageSchema(
    { columns: META_AD_DAILY_CSV_COLUMNS },
    "META_AD_DAILY",
    new Date(0),
    "00000000-0000-4000-8000-000000000001"
  );
  const columnSchema = state === "STORED"
    ? storedMetaOriginalStorageSchema(pending, "META_AD_DAILY")
    : pending;
  return {
    id: "batch-1",
    originalFilename: "meta.csv",
    storedFilePath: "local:test/meta-ad-daily",
    fileHashSha256: createHash("sha256").update(buffer).digest("hex"),
    reportStart: null,
    reportEnd: null,
    level: UploadLevel.AD,
    columnSchema,
    rowCount: 1,
    validRowCount: 0,
    warningCount: 0,
    errorCount: 0,
    conflictPolicy: ConflictPolicy.SKIP,
    status,
    timezone: "Asia/Seoul",
    uploadedBy: ACTOR_ID,
    uploadedAt: new Date(0),
    validatedAt: status === UploadStatus.FAILED ? new Date(0) : null,
    importedAt: null,
    note: null
  };
}

function matchesBatch(batch: Record<string, unknown>, where: Record<string, unknown>) {
  if (where.id && where.id !== batch.id) return false;
  if (where.status && where.status !== batch.status) return false;
  const jsonFilter = where.columnSchema as { equals?: unknown } | undefined;
  return jsonFilter?.equals === undefined || JSON.stringify(jsonFilter.equals) === JSON.stringify(batch.columnSchema);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function dailyCsv(rowCount = 1) {
  const row: Record<string, string> = {
    "보고 시작": "2026-08-10",
    "보고 종료": "2026-08-10",
    "캠페인 이름": "캠페인",
    "캠페인 ID": "campaign-1",
    "광고 세트 이름": "광고세트",
    "광고 세트 ID": "adset-1",
    "광고 이름": "260810_소재_01",
    "광고 ID": "ad-1",
    "광고 게재": "active",
    "지출 금액 (USD)": "10",
    "노출": "100",
    "도달": "80",
    "결과": "1",
    "결과 표시 도구": "구매"
  };
  return Buffer.from([
    META_AD_DAILY_CSV_COLUMNS.map(csvCell).join(","),
    ...Array.from({ length: rowCount }, () => META_AD_DAILY_CSV_COLUMNS.map((header) => csvCell(row[header] ?? "")).join(","))
  ].join("\n"), "utf8");
}

function file(buffer: Buffer): Express.Multer.File {
  return { buffer, originalname: "meta.csv" } as Express.Multer.File;
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

async function rejected(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}
