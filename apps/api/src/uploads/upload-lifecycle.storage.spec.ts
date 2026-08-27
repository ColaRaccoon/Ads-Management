import { UploadStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { UploadLifecycleService } from "./upload-lifecycle.service";

describe("Meta upload delete storage transitions", () => {
  it("does not mutate upload rows when object retention fails", async () => {
    const harness = lifecycleHarness(UploadStatus.IMPORTED, async () => { throw new Error("storage outage"); });

    await expect(harness.service.deleteUpload("batch-1")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "UPLOAD_FILE_RETENTION_RETRY_REQUIRED" })
    });
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it("deletes rows and the batch in one transaction after retention succeeds", async () => {
    const harness = lifecycleHarness(UploadStatus.CANCELLED, async () => retained());

    await expect(harness.service.deleteUpload("batch-1")).resolves.toMatchObject({
      batchId: "batch-1",
      storedFileRetained: true,
      tombstoneId: "22222222-2222-4222-8222-222222222222"
    });
    expect(harness.remove).toHaveBeenCalledWith({ where: { id: "batch-1" } });
  });

  it("restores the retained file when the database transaction rolls back", async () => {
    const harness = lifecycleHarness(UploadStatus.IMPORTED, async () => retained(), true);

    await expect(harness.service.deleteUpload("batch-1")).rejects.toThrow("finalize failure");
    expect(harness.restore).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", undefined);
    expect(harness.update).not.toHaveBeenCalled();
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

  it("does not restore a retained tombstone when a concurrent delete already committed", async () => {
    let removed = false;
    const emptyVersioned = {
      findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 0 })), findFirst: vi.fn(async () => null), update: vi.fn()
    };
    const batch = {
      id: "batch-1", originalFilename: "meta.csv", storedFilePath: "local:active/meta.csv",
      fileHashSha256: "a".repeat(64), columnSchema: { originalFileHashSha256: "a".repeat(64) }
    };
    const uploadBatch = {
      findUnique: vi.fn(async () => removed ? null : batch),
      delete: vi.fn(async () => { if (removed) throw new Error("P2025"); removed = true; return {}; })
    };
    const tx = {
      $executeRawUnsafe: vi.fn(), $queryRaw: vi.fn(),
      metaAdDailyMetric: emptyVersioned, metaAdsetDailyMetric: emptyVersioned,
      uploadRowError: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      uploadRow: { deleteMany: vi.fn(async () => ({ count: 0 })) }, uploadBatch,
      storageTombstone:{findUnique:vi.fn(async()=>removed?{id:"22222222-2222-4222-8222-222222222222",state:"RETAINED"}:null)}
    };
    let tail=Promise.resolve();
    const transaction=vi.fn(async (work:(value:typeof tx)=>Promise<unknown>)=>{let release!:()=>void;const prior=tail;tail=new Promise<void>((resolve)=>{release=resolve});await prior;try{return await work(tx)}finally{release()}});
    const prisma = { uploadBatch, $transaction: transaction };
    const retain = vi.fn(async () => retained());
    const restore = vi.fn();
    const service = new UploadLifecycleService(prisma as never, { retain, restore } as never);

    const results = await Promise.all([service.deleteUpload("batch-1"), service.deleteUpload("batch-1")]);

    expect(results.some((result) => "alreadyDeleted" in result && result.alreadyDeleted === true)).toBe(true);
    expect(restore).not.toHaveBeenCalled();
    expect(retain).toHaveBeenCalledTimes(1);
    expect(removed).toBe(true);
  });

  it("keeps compensation inside the business-record fence before a waiting delete finalizes", async () => {
    let removed=false;let deleteAttempt=0;const events:string[]=[];
    let firstDeleteEntered!:()=>void;const entered=new Promise<void>((resolve)=>{firstDeleteEntered=resolve});
    const emptyVersioned={findMany:vi.fn(async()=>[]),deleteMany:vi.fn(async()=>({count:0})),updateMany:vi.fn(async()=>({count:0})),findFirst:vi.fn(async()=>null),update:vi.fn()};
    const batch={id:"batch-1",originalFilename:"meta.csv",storedFilePath:"local:active/meta.csv",fileHashSha256:"a".repeat(64),columnSchema:{originalFileHashSha256:"a".repeat(64)}};
    const uploadBatch={
      findUnique:vi.fn(async()=>removed?null:batch),
      delete:vi.fn(async()=>{deleteAttempt+=1;events.push(`delete-${deleteAttempt}`);if(deleteAttempt===1){firstDeleteEntered();throw new Error("first finalize failed")};removed=true;return{}})
    };
    const tx={$executeRawUnsafe:vi.fn(),$queryRaw:vi.fn(),metaAdDailyMetric:emptyVersioned,metaAdsetDailyMetric:emptyVersioned,uploadRowError:{deleteMany:vi.fn(async()=>({count:0}))},uploadRow:{deleteMany:vi.fn(async()=>({count:0}))},uploadBatch,storageTombstone:{findUnique:vi.fn(async()=>removed?{id:"22222222-2222-4222-8222-222222222222",state:"RETAINED"}:null)}};
    let tail=Promise.resolve();const transaction=vi.fn(async(work:(value:typeof tx)=>Promise<unknown>)=>{let release!:()=>void;const prior=tail;tail=new Promise<void>((resolve)=>{release=resolve});await prior;try{return await work(tx)}finally{release()}});
    const restore=vi.fn(async()=>{events.push("restore");return{state:"RESTORED"}});
    const service=new UploadLifecycleService({uploadBatch,$transaction:transaction} as never,{retain:vi.fn(async()=>retained()),restore} as never);
    const first=service.deleteUpload("batch-1");await entered;const second=service.deleteUpload("batch-1");
    await expect(first).rejects.toThrow("first finalize failed");await expect(second).resolves.toMatchObject({batchId:"batch-1",storedFileRetained:true});
    expect(events).toEqual(["delete-1","restore","delete-2"]);expect(removed).toBe(true);
  });

  it("restores the retained payload when the callback completed but the outer commit rolled back", async () => {
    const harness = unknownCommitHarness("ROLLED_BACK");

    await expect(harness.service.deleteUpload("batch-1")).rejects.toThrow("commit outcome unknown");

    expect(harness.restore).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", undefined);
    expect(harness.events).toEqual([
      "delete-attempt",
      "outer-callback-complete",
      "outer-commit-rolled-back",
      "restore"
    ]);
  });

  it("returns the completed delete idempotently when commit succeeded but its acknowledgement was lost", async () => {
    const harness = unknownCommitHarness("COMMITTED");

    await expect(harness.service.deleteUpload("batch-1")).resolves.toMatchObject({
      batchId: "batch-1",
      storedFileRetained: true
    });

    expect(harness.restore).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      "delete-attempt",
      "outer-callback-complete",
      "outer-commit-persisted"
    ]);
  });

  it("treats a concurrent committed delete between rollback and reconciliation as idempotent success", async () => {
    const harness = unknownCommitHarness("CONCURRENT_COMMIT");

    await expect(harness.service.deleteUpload("batch-1")).resolves.toMatchObject({
      batchId: "batch-1",
      storedFileRetained: true
    });

    expect(harness.restore).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      "delete-attempt",
      "outer-callback-complete",
      "outer-commit-rolled-back",
      "concurrent-delete-committed"
    ]);
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
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
    metaAdDailyMetric: emptyVersioned,
    metaAdsetDailyMetric: emptyVersioned,
    uploadRowError: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    uploadRow: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    uploadBatch,
    storageTombstone:{findUnique:vi.fn(async()=>null)}
  };
  const prisma = {
    uploadBatch,
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
  };
  const retain = vi.fn(retainObject);
  const restore = vi.fn(async () => ({ state: "RESTORED" }));
  return {
    update,
    remove,
    retain,
    restore,
    transaction: prisma.$transaction,
    service: new UploadLifecycleService(
      prisma as never,
      { retain, restore } as never
    )
  };
}

function unknownCommitHarness(outcome: "ROLLED_BACK" | "COMMITTED" | "CONCURRENT_COMMIT") {
  const events: string[] = [];
  let batchExists = true;
  let transactionAttempt = 0;
  const batch = {
    id: "batch-1",
    originalFilename: "meta.csv",
    storedFilePath: "local:active/meta.csv",
    fileHashSha256: "a".repeat(64),
    columnSchema: { originalFileHashSha256: "a".repeat(64) }
  };
  const tombstone = {
    id: "22222222-2222-4222-8222-222222222222",
    state: "RETAINED"
  };
  const emptyVersioned = {
    findMany: vi.fn(async () => []),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    updateMany: vi.fn(async () => ({ count: 0 })),
    findFirst: vi.fn(async () => null),
    update: vi.fn(async () => ({}))
  };
  const uploadBatch = {
    findUnique: vi.fn(async () => batchExists ? batch : null),
    delete: vi.fn(async () => {
      events.push("delete-attempt");
      batchExists = false;
      return {};
    })
  };
  const tx = {
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
    metaAdDailyMetric: emptyVersioned,
    metaAdsetDailyMetric: emptyVersioned,
    uploadRowError: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    uploadRow: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    uploadBatch,
    storageTombstone: { findUnique: vi.fn(async () => tombstone) }
  };
  const transaction = vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => {
    transactionAttempt += 1;
    if (transactionAttempt === 1) {
      const result = await work(tx);
      events.push("outer-callback-complete");
      if (outcome === "COMMITTED") {
        events.push("outer-commit-persisted");
      } else {
        batchExists = true;
        events.push("outer-commit-rolled-back");
      }
      void result;
      throw new Error("commit outcome unknown");
    }
    if (transactionAttempt === 2 && outcome === "CONCURRENT_COMMIT") {
      batchExists = false;
      events.push("concurrent-delete-committed");
    }
    return work(tx);
  });
  const restore = vi.fn(async () => {
    events.push("restore");
    tombstone.state = "RESTORED";
    return { ...retained(), state: "RESTORED" as const };
  });
  const retain = vi.fn(async () => retained());
  return {
    events,
    restore,
    service: new UploadLifecycleService(
      { uploadBatch, $transaction: transaction } as never,
      { retain, restore } as never
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
