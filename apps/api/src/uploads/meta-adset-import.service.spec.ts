import { BadRequestException } from "@nestjs/common";
import { AdStage, ConflictPolicy, MatchSource, UploadStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { META_ADSET_REQUIRED_COLUMNS } from "../domain/meta-csv";
import { MetaAdsetImportService } from "./meta-adset-import.service";

describe("MetaAdsetImportService contract", () => {
  it("returns the established adset import fields through the real parser/orchestrator path", async () => {
    const harness = adsetImportHarness();

    const result = await harness.service.importMetaAdsetCsv(file(adsetCsv()), ConflictPolicy.OVERWRITE);

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
      harness.service.importMetaAdsetCsv(file(Buffer.from('"unknown"\n"value"', "utf8")), ConflictPolicy.NEW_VERSION)
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

function adsetImportHarness() {
  const batchUpdates: Record<string, unknown>[] = [];
  const metricInputs: unknown[] = [];
  const batch = {
    id: "batch-1",
    status: UploadStatus.VALIDATING,
    rowCount: 1,
    validRowCount: 0,
    warningCount: 0,
    errorCount: 0,
    reportStart: null,
    reportEnd: null
  };
  const prisma = {
    uploadBatch: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ ...batch, ...data, id: batch.id }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        batchUpdates.push(data);
        return { ...batch, ...data };
      }
    },
    uploadRowError: {
      createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length })
    },
    uploadRow: {
      create: async () => ({ id: "upload-row-1" })
    },
    metaAdset: {
      update: async () => ({})
    }
  };
  const storage = { storeOriginalFile: async () => "storage/uploads/meta-adset.csv" };
  const entityWriter = { upsertAdset: async () => ({ id: "adset-ref-1", firstSeenOn: null }) };
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
    batchUpdates,
    metricInputs,
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
