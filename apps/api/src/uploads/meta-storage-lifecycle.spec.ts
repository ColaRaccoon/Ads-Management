import { ConflictPolicy, UploadStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MetaAdDailyImportService } from "./meta-ad-daily-import.service";
import { MetaAdsetImportService } from "./meta-adset-import.service";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const REFERENCE = `local:2026/08/${"a".repeat(64)}`;

describe("Meta original storage state transitions", () => {
  it("never puts an object when DB reservation creation fails", async () => {
    const putOriginalFile = vi.fn();
    const service = serviceHarness({
      create: vi.fn(async () => { throw new Error("DB reservation failed"); }),
      updateMany: vi.fn(),
      putOriginalFile
    });

    await expect(service.importMetaAdsetCsv(csvFile(), ConflictPolicy.SKIP, ACTOR_ID))
      .rejects.toThrow("DB reservation failed");
    expect(putOriginalFile).not.toHaveBeenCalled();
  });

  it("preserves the tagged DB reference and changes VALIDATING to FAILED when put fails", async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const service = serviceHarness({
      create,
      updateMany,
      putOriginalFile: vi.fn(async () => { throw new Error("storage unavailable"); })
    });

    await expect(service.importMetaAdsetCsv(csvFile(), ConflictPolicy.SKIP, ACTOR_ID)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "UPLOAD_STORAGE_UNAVAILABLE" })
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ storedFilePath: REFERENCE, status: UploadStatus.VALIDATING })
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f-]{36}$/i) }),
      data: expect.objectContaining({ status: UploadStatus.FAILED })
    });
  });

  it("uses the same stable 503 contract for daily storage failures without exposing provider details", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const providerDetail = "synthetic-provider-internal-detail";
    const service = dailyServiceHarness({
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data })),
      updateMany,
      putOriginalFile: vi.fn(async () => { throw new Error(providerDetail); })
    });

    const error = await rejected(service.importMetaAdDailyCsv(csvFile(), ConflictPolicy.SKIP, ACTOR_ID));
    expect(error).toMatchObject({
      response: {
        code: "UPLOAD_STORAGE_UNAVAILABLE",
        message: "The upload could not be stored. The failed batch was preserved for a safe retry."
      }
    });
    expect(JSON.stringify((error as { response: unknown }).response)).not.toContain(providerDetail);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f-]{36}$/i) }),
      data: expect.objectContaining({ status: UploadStatus.FAILED })
    });
  });
});

function serviceHarness(input: {
  create: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  putOriginalFile: ReturnType<typeof vi.fn>;
}) {
  let currentBatch: Record<string, unknown> | null = null;
  const prisma = {
    uploadBatch: {
      findUnique: vi.fn(async () => currentBatch),
      create: vi.fn(async (args: unknown) => {
        const created = await input.create(args);
        currentBatch = created as Record<string, unknown>;
        return created;
      }),
      updateMany: vi.fn(async (args: { data?: Record<string, unknown> }) => {
        const result = await input.updateMany(args);
        if (currentBatch && result?.count === 1) currentBatch = { ...currentBatch, ...args.data };
        return result;
      })
    },
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma)
  };
  const storage = {
    prepareOriginalFileReference: vi.fn(() => REFERENCE),
    putOriginalFile: input.putOriginalFile
  };
  return new MetaAdsetImportService(
    prisma as never,
    storage as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

function dailyServiceHarness(input: {
  create: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  putOriginalFile: ReturnType<typeof vi.fn>;
}) {
  let currentBatch: Record<string, unknown> | null = null;
  const prisma = {
    uploadBatch: {
      findUnique: vi.fn(async () => currentBatch),
      create: vi.fn(async (args: unknown) => {
        const created = await input.create(args);
        currentBatch = created as Record<string, unknown>;
        return created;
      }),
      updateMany: vi.fn(async (args: { data?: Record<string, unknown> }) => {
        const result = await input.updateMany(args);
        if (currentBatch && result?.count === 1) currentBatch = { ...currentBatch, ...args.data };
        return result;
      })
    },
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma)
  };
  const storage = {
    prepareOriginalFileReference: vi.fn(() => REFERENCE),
    putOriginalFile: input.putOriginalFile
  };
  return new MetaAdDailyImportService(
    prisma as never,
    storage as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

function csvFile(): Express.Multer.File {
  const buffer = Buffer.from("보고 시작,보고 종료\r\n2026-08-01,2026-08-01\r\n", "utf8");
  return {
    fieldname: "file",
    originalname: "meta.csv",
    encoding: "7bit",
    mimetype: "text/csv",
    size: buffer.length,
    destination: "",
    filename: "",
    path: "",
    buffer,
    stream: undefined as never
  };
}

async function rejected(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}
