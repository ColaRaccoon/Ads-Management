import { BadRequestException } from "@nestjs/common";
import { AdStage, ConflictPolicy, MatchSource, UploadLevel, UploadStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { META_ADSET_REQUIRED_COLUMNS } from "../domain/meta-csv";
import { MetaAdsetImportService } from "./meta-adset-import.service";
import {
  pendingMetaOriginalStorageSchema,
  storedMetaOriginalStorageSchema
} from "./meta-original-storage-state";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

describe("MetaAdsetImportService contract", () => {
  it("returns the established adset import fields through the real parser/orchestrator path", async () => {
    const harness = adsetImportHarness();

    const result = await harness.service.importMetaAdsetCsv(file(adsetCsv()), ConflictPolicy.OVERWRITE, ACTOR_ID);

    expect(result).toMatchObject({
      batchId: "batch-1",
      status: UploadStatus.IMPORTED,
      rowCount: 1,
      validRowCount: 1,
      snapshotHiddenMetricCount: 3,
      warningCount: 0,
      errorCount: 0,
      importedMetricCount: 1,
      skippedDuplicateCount: 0,
      unmatchedCount: 0,
      reportStart: "2026-08-10",
      reportEnd: "2026-08-10"
    });
    expect(harness.batchCreates[0]).toMatchObject({ uploadedBy: ACTOR_ID });
    expect(harness.metricInputs).toEqual([
      expect.objectContaining({
        batchId: "batch-1",
        uploadRowId: "upload-row-1",
        metaAdsetId: "adset-ref-1",
        productId: "product-1",
        stage: AdStage.SC,
        conflictPolicy: ConflictPolicy.OVERWRITE
      })
    ]);
  });

  it("preserves the legacy CSV header error code, message, and details", async () => {
    const harness = adsetImportHarness();

    const error = await rejected(
      harness.service.importMetaAdsetCsv(
        file(Buffer.from('"unknown"\n"value"', "utf8")),
        ConflictPolicy.NEW_VERSION,
        ACTOR_ID
      )
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: "CSV_HEADER_INVALID",
      message: "필수 CSV 컬럼이 누락되었습니다.",
      details: {
        batchId: "batch-1",
        missingColumns: expect.arrayContaining(["보고 시작", "광고 세트 이름", "지출 금액 (USD)"])
      }
    });
    expect(harness.batchUpdates.at(-1)).toMatchObject({
      status: UploadStatus.FAILED,
      errorCount: expect.any(Number),
      validatedAt: expect.any(Date)
    });
  });
});

describe("MetaAdsetImportService storage recovery", () => {
  it("reuses a FAILED storage-pending batch and retries a missing object before importing", async () => {
    const buffer = adsetCsv();
    const duplicated = storageRecoveryBatch(buffer, UploadStatus.FAILED, "PENDING");
    const harness = adsetImportHarness({ duplicated, storageObjectState: "missing" });

    const result = await harness.service.importMetaAdsetCsv(file(buffer), ConflictPolicy.SKIP, ACTOR_ID);

    expect(result).toMatchObject({ batchId: "batch-1", status: UploadStatus.IMPORTED });
    expect(result).not.toHaveProperty("duplicate");
    expect(harness.batchCreates).toHaveLength(0);
    expect(harness.putCalls).toEqual([{ reference: duplicated.storedFilePath, objectState: "missing" }]);
  });

  it("reclaims an expired STORED+VALIDATING zero-work batch and idempotently resumes import", async () => {
    const buffer = adsetCsv();
    const duplicated = storageRecoveryBatch(buffer, UploadStatus.VALIDATING, "STORED");
    const harness = adsetImportHarness({ duplicated, storageObjectState: "existing" });

    const result = await harness.service.importMetaAdsetCsv(file(buffer), ConflictPolicy.SKIP, ACTOR_ID);

    expect(result).toMatchObject({ batchId: "batch-1", status: UploadStatus.IMPORTED });
    expect(result).not.toHaveProperty("duplicate");
    expect(harness.batchCreates).toHaveLength(0);
    expect(harness.putCalls).toEqual([{ reference: duplicated.storedFilePath, objectState: "existing" }]);
  });

  it("does not resume a stale storage marker once batch-owned domain work exists", async () => {
    const buffer = adsetCsv();
    const duplicated = storageRecoveryBatch(buffer, UploadStatus.VALIDATING, "STORED");
    const harness = adsetImportHarness({ duplicated, sideEffectCounts: { metrics: 1 } });

    const result = await harness.service.importMetaAdsetCsv(file(buffer), ConflictPolicy.SKIP, ACTOR_ID);

    expect(result).toMatchObject({ duplicate: true, batchId: "batch-1" });
    expect(harness.putCalls).toHaveLength(0);
    expect(harness.metricInputs).toHaveLength(0);
  });

  it("holds the batch fence while an old owner is delayed so a retry cannot become a second writer", async () => {
    const buffer = adsetCsv();
    const entered = deferred<void>();
    const release = deferred<void>();
    let delayed = false;
    const harness = adsetImportHarness({
      duplicated: storageRecoveryBatch(buffer, UploadStatus.VALIDATING, "STORED"),
      serializeTransactions: true,
      beforeDomainWriter: async () => {
        if (delayed) return;
        delayed = true;
        entered.resolve();
        await release.promise;
      }
    });

    const oldOwner = harness.service.importMetaAdsetCsv(file(buffer), ConflictPolicy.SKIP, ACTOR_ID);
    await entered.promise;
    let retrySettled = false;
    const retry = harness.service.importMetaAdsetCsv(file(buffer), ConflictPolicy.SKIP, ACTOR_ID)
      .finally(() => { retrySettled = true; });
    await Promise.resolve();
    expect(retrySettled).toBe(false);
    release.resolve();

    const results = await Promise.all([oldOwner, retry]);
    expect(results.filter((result) => "duplicate" in result && result.duplicate)).toHaveLength(1);
    expect(harness.metricInputs).toHaveLength(1);
  });
});

function adsetImportHarness(options: {
  duplicated?: Record<string, unknown>;
  storageObjectState?: "missing" | "existing";
  sideEffectCounts?: { rows?: number; errors?: number; adMetrics?: number; metrics?: number };
  serializeTransactions?: boolean;
  beforeDomainWriter?: () => Promise<void>;
} = {}) {
  const batchCreates: Record<string, unknown>[] = [];
  const batchUpdates: Record<string, unknown>[] = [];
  const metricInputs: unknown[] = [];
  const putCalls: Array<{ reference: string; objectState: "missing" | "existing" }> = [];
  const batch = {
    id: "batch-1",
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
      createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
      count: async () => options.sideEffectCounts?.errors ?? 0
    },
    uploadRow: {
      create: async () => ({ id: "upload-row-1" }),
      count: async () => options.sideEffectCounts?.rows ?? 0
    },
    metaAdDailyMetric: { count: async () => options.sideEffectCounts?.adMetrics ?? 0 },
    metaAdsetDailyMetric: { count: async () => options.sideEffectCounts?.metrics ?? 0 },
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
    prepareOriginalFileReference: () => "local:test/meta-adset",
    putOriginalFile: async (_file: Express.Multer.File, reference: string) => {
      putCalls.push({ reference, objectState: options.storageObjectState ?? "missing" });
    }
  };
  const entityWriter = {
    upsertAdset: async () => {
      await options.beforeDomainWriter?.();
      return { id: "adset-ref-1", firstSeenOn: null };
    }
  };
  const metricVersion = {
    importMetric: async (input: unknown) => {
      metricInputs.push(input);
      return { imported: true, skipped: false };
    },
    deactivateMissingSnapshotMetrics: async () => 3
  };
  const mappings = {
    matchProduct: async () => ({ productId: "product-1", source: MatchSource.RULE, matchRuleId: "rule-1" }),
    matchStage: async () => ({ stage: AdStage.SC, source: MatchSource.RULE })
  };
  const exchangeRates = { ensureUsdKrwRates: async () => undefined };

  return {
    batchCreates,
    batchUpdates,
    metricInputs,
    putCalls,
    service: new MetaAdsetImportService(
      prisma as never,
      storage as never,
      entityWriter as never,
      metricVersion as never,
      mappings as never,
      exchangeRates as never
    )
  };
}

function storageRecoveryBatch(buffer: Buffer, status: UploadStatus, state: "PENDING" | "STORED") {
  const pending = pendingMetaOriginalStorageSchema(
    { columns: META_ADSET_REQUIRED_COLUMNS },
    "META_ADSET_DAILY",
    new Date(0),
    "00000000-0000-4000-8000-000000000002"
  );
  const columnSchema = state === "STORED"
    ? storedMetaOriginalStorageSchema(pending, "META_ADSET_DAILY")
    : pending;
  return {
    id: "batch-1",
    originalFilename: "meta-adset.csv",
    storedFilePath: "local:test/meta-adset",
    fileHashSha256: createHash("sha256").update(buffer).digest("hex"),
    reportStart: null,
    reportEnd: null,
    level: UploadLevel.ADSET,
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

function adsetCsv() {
  const row: Record<string, string> = {
    "보고 시작": "2026-08-10",
    "보고 종료": "2026-08-10",
    "광고 세트 이름": "광고세트",
    "광고 세트 게재": "active",
    "결과": "2",
    "결과 표시 도구": "구매",
    "도달": "80",
    "지출 금액 (USD)": "10",
    "노출": "100"
  };
  return Buffer.from([
    META_ADSET_REQUIRED_COLUMNS.map(csvCell).join(","),
    META_ADSET_REQUIRED_COLUMNS.map((header) => csvCell(row[header] ?? "")).join(",")
  ].join("\n"), "utf8");
}

function file(buffer: Buffer): Express.Multer.File {
  return { buffer, originalname: "meta-adset.csv" } as Express.Multer.File;
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
