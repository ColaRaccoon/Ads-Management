import { BadRequestException } from "@nestjs/common";
import { AdStage, ConflictPolicy, MatchSource, UploadLevel, UploadStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { META_AD_DAILY_CSV_COLUMNS } from "../domain/meta-ad-daily-csv";
import { MetaAdDailyImportService } from "./meta-ad-daily-import.service";
import { snapshotAdMetricKey } from "./upload-keys";

describe("MetaAdDailyImportService response and snapshot contract", () => {
  it("returns the established ad import fields through the real parser/orchestrator path", async () => {
    const harness = dailyImportHarness();

    const result = await harness.service.importMetaAdDailyCsv(file(dailyCsv()), ConflictPolicy.NEW_VERSION);

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
  });

  it("includes a SKIP duplicate in the ad snapshot and still refreshes derived adsets", async () => {
    const harness = dailyImportHarness({ metricResult: { imported: false, skipped: true } });

    const result = await harness.service.importMetaAdDailyCsv(file(dailyCsv()), ConflictPolicy.SKIP);

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
      harness.service.importMetaAdDailyCsv(file(Buffer.from('"unknown"\n"value"', "utf8")), ConflictPolicy.NEW_VERSION)
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
      harness.service.importMetaAdDailyCsv(file(dailyCsv(2)), ConflictPolicy.NEW_VERSION)
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

function dailyImportHarness(options: { metricResult?: { imported: boolean; skipped: boolean } } = {}) {
  const batchUpdates: Record<string, unknown>[] = [];
  const rowErrorCreates: Array<Array<Record<string, unknown>>> = [];
  const processedMetricInputs: unknown[] = [];
  const aggregateCalls: Array<{ batchId: string; snapshotDates: Date[] }> = [];
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
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        rowErrorCreates.push(data);
        return { count: data.length };
      }
    },
    uploadRow: {
      create: async () => ({ id: "upload-row-1" })
    },
    metaAdset: {
      update: async () => ({})
    }
  };
  const storage = { storeOriginalFile: async () => "storage/uploads/meta.csv" };
  const entityWriter = {
    upsertCampaign: async () => ({ id: "campaign-ref-1" }),
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
    batchUpdates,
    rowErrorCreates,
    processedMetricInputs,
    aggregateCalls,
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
