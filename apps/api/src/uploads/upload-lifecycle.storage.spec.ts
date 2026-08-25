import { UploadStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { UploadLifecycleService } from "./upload-lifecycle.service";

describe("Meta upload delete storage transitions", () => {
  it("commits CANCELLED with the DB reference before attempting object retention", async () => {
    const harness = lifecycleHarness(UploadStatus.IMPORTED, async () => { throw new Error("storage outage"); });

    await expect(harness.service.deleteUpload("batch-1")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "UPLOAD_FILE_RETENTION_RETRY_REQUIRED" })
    });
    expect(harness.update).toHaveBeenCalledWith({
      where: { id: "batch-1" },
      data: { status: UploadStatus.CANCELLED }
    });
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it("finalizes an idempotent retry when the already-cancelled object is retained", async () => {
    const harness = lifecycleHarness(UploadStatus.CANCELLED, async () => retained());

    await expect(harness.service.deleteUpload("batch-1")).resolves.toMatchObject({
      batchId: "batch-1",
      storedFileRetained: true,
      tombstoneId: "22222222-2222-4222-8222-222222222222"
    });
    expect(harness.remove).toHaveBeenCalledWith({ where: { id: "batch-1" } });
  });

  it("retains the CANCELLED reference when DB finalization fails after object retention", async () => {
    const harness = lifecycleHarness(UploadStatus.IMPORTED, async () => retained(), true);

    await expect(harness.service.deleteUpload("batch-1")).rejects.toThrow("finalize failure");
    expect(harness.update).toHaveBeenCalled();
    expect(harness.remove).toHaveBeenCalled();
  });

  it("retains duplicate-policy objects against their original byte hash, not the uniqueness hash", async () => {
    const originalHash = "b".repeat(64);
    const harness = lifecycleHarness(UploadStatus.IMPORTED, async () => retained(), false, originalHash);

    await harness.service.deleteUpload("batch-1");

    expect(harness.retain).toHaveBeenCalledWith(expect.objectContaining({
      expectedHashSha256: originalHash
    }));
  });
});

function lifecycleHarness(
  initialStatus: UploadStatus,
  retainObject: () => Promise<ReturnType<typeof retained>>,
  failFinalization = false,
  originalHashSha256 = "a".repeat(64)
) {
  const update = vi.fn(async () => ({}));
  const remove = vi.fn(async () => {
    if (failFinalization) throw new Error("finalize failure");
    return {};
  });
  const emptyVersioned = {
    findMany: vi.fn(async () => []),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    updateMany: vi.fn(async () => ({ count: 0 })),
    findFirst: vi.fn(async () => null),
    update: vi.fn(async () => ({}))
  };
  const uploadBatch = {
    findUnique: vi.fn(async () => ({
      id: "batch-1",
      originalFilename: "meta.csv",
      storedFilePath: `local:2026/08/${"a".repeat(64)}`,
      fileHashSha256: "a".repeat(64),
      columnSchema: { originalFileHashSha256: originalHashSha256 },
      status: initialStatus
    })),
    update,
    delete: remove
  };
  const tx = {
    metaAdDailyMetric: emptyVersioned,
    metaAdsetDailyMetric: emptyVersioned,
    uploadRowError: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    uploadRow: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    uploadBatch
  };
  const prisma = {
    uploadBatch,
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
  };
  const retain = vi.fn(retainObject);
  return {
    update,
    remove,
    retain,
    service: new UploadLifecycleService(
      prisma as never,
      { retain } as never
    )
  };
}

function retained() {
  return {
    tombstoneId: "22222222-2222-4222-8222-222222222222",
    state: "RETAINED" as const,
    purgeAfter: new Date("2026-09-24T00:00:00.000Z"),
    restoredAt: null,
    purgedAt: null
  };
}
