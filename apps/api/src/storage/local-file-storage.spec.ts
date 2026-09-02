import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvalidStorageKeyError,
  StorageIntegrityError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError
} from "./file-storage";
import {
  LocalFileStorage,
  withDurablySynchronizedPendingDirectory,
  writeAndSyncOwnedPendingFile
} from "./local-file-storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalFileStorage", () => {
  it("probes an existing non-reparse root without creating files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-storage-ready-"));
    try {
      const storage = new LocalFileStorage(root);
      await expect(storage.assertReady(1)).resolves.toBeUndefined();
      await expect(readdir(root)).resolves.toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("handles partial writes before sync and owned handle close without a write stream", async () => {
    const events: string[] = [];
    const written = Buffer.alloc(7);
    const pending = {
      write: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesWritten = Math.min(2, length);
        buffer.copy(written, position, offset, offset + bytesWritten);
        events.push(`write:${position}:${bytesWritten}`);
        return { bytesWritten, buffer };
      }),
      sync: vi.fn(async () => { events.push("sync"); }),
      close: vi.fn(async () => { events.push("close"); })
    } as unknown as Parameters<typeof writeAndSyncOwnedPendingFile>[0];

    await expect(completesWithin(writeAndSyncOwnedPendingFile(
      pending,
      Readable.from([Buffer.from("durable")]),
      7
    ), 1_000)).resolves.toEqual({
      hash: createHash("sha256").update("durable").digest("hex"),
      size: 7
    });
    expect(written.toString("utf8")).toBe("durable");
    expect(events).toEqual(["write:0:2", "write:2:2", "write:4:2", "write:6:1", "sync", "close"]);
    expect(pending.sync).toHaveBeenCalledTimes(1);
    expect(pending.close).toHaveBeenCalledTimes(1);
  });

  it("closes the owned handle and destroys the source when a partial write fails", async () => {
    const source = Readable.from([Buffer.from("failure")]);
    const writeFailure = new Error("synthetic write failure");
    const pending = {
      write: vi.fn()
        .mockResolvedValueOnce({ bytesWritten: 2, buffer: Buffer.from("failure") })
        .mockRejectedValueOnce(writeFailure),
      sync: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    } as unknown as Parameters<typeof writeAndSyncOwnedPendingFile>[0];

    await expect(writeAndSyncOwnedPendingFile(pending, source, 7)).rejects.toBe(writeFailure);
    expect(source.destroyed).toBe(true);
    expect(pending.sync).not.toHaveBeenCalled();
    expect(pending.close).toHaveBeenCalledTimes(1);
  });

  it("awaits backing async-iterator cleanup before closing the pending handle and rejecting", async () => {
    const events: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    async function* backingSource() {
      try {
        yield Buffer.from("failure");
      } finally {
        events.push("cleanup-start");
        await cleanupGate;
        events.push("cleanup-finished");
      }
    }
    const writeFailure = new Error("synthetic write failure");
    const pending = {
      write: vi.fn(async () => { throw writeFailure; }),
      sync: vi.fn(async () => undefined),
      close: vi.fn(async () => { events.push("pending-close"); })
    } as unknown as Parameters<typeof writeAndSyncOwnedPendingFile>[0];
    const outcome = writeAndSyncOwnedPendingFile(pending, Readable.from(backingSource()), 7)
      .then(
        () => ({ status: "fulfilled" as const, error: undefined }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );

    await waitForCondition(() => events.includes("cleanup-start"));
    expect(events).toEqual(["cleanup-start"]);
    releaseCleanup();
    await expect(completesWithin(outcome, 1_000)).resolves.toEqual({
      status: "rejected",
      error: writeFailure
    });
    expect(events).toEqual(["cleanup-start", "cleanup-finished", "pending-close"]);
    expect(pending.sync).not.toHaveBeenCalled();
  });

  it("waits for delayed readable destruction and close before rejecting a failed write", async () => {
    const events: string[] = [];
    let releaseDestroy!: () => void;
    const destroyGate = new Promise<void>((resolve) => { releaseDestroy = resolve; });
    let pushed = false;
    const source = new Readable({
      read() {
        if (pushed) return;
        pushed = true;
        this.push(Buffer.from("failure"));
      },
      destroy(error, callback) {
        events.push("destroy-start");
        void destroyGate.then(() => {
          events.push("destroy-finished");
          callback(error);
        });
      }
    });
    source.once("close", () => { events.push("source-close"); });
    const writeFailure = new Error("synthetic write failure");
    const pending = {
      write: vi.fn(async () => { throw writeFailure; }),
      sync: vi.fn(async () => undefined),
      close: vi.fn(async () => { events.push("pending-close"); })
    } as unknown as Parameters<typeof writeAndSyncOwnedPendingFile>[0];
    let settled = false;
    const outcome = writeAndSyncOwnedPendingFile(pending, source, 7)
      .then(
        () => ({ status: "fulfilled" as const, error: undefined }),
        (error: unknown) => ({ status: "rejected" as const, error })
      )
      .finally(() => { settled = true; });

    await waitForCondition(() => events.includes("destroy-start"));
    expect(settled).toBe(false);
    expect(events).toEqual(["destroy-start"]);
    releaseDestroy();
    await expect(completesWithin(outcome, 1_000)).resolves.toEqual({
      status: "rejected",
      error: writeFailure
    });
    expect(events).toEqual(["destroy-start", "destroy-finished", "source-close", "pending-close"]);
  });

  it("opens the parent before a pending operation and fsyncs it after publication cleanup", async () => {
    const events: string[] = [];
    const stored = await withDurablySynchronizedPendingDirectory(
      "/synthetic/parent",
      "/synthetic/parent/.pending-owned",
      async ({ syncPublishedDirectory }) => {
        events.push("open-pending");
        events.push("write");
        events.push("file-sync");
        events.push("link-target");
        await syncPublishedDirectory();
        events.push("unlink-pending");
        return "stored";
      },
      {
        openDirectory: async () => {
          events.push("open-parent");
          return {
            stat: async () => { events.push("parent-stat"); return { isDirectory: () => true }; },
            sync: async () => {
              events.push(events.includes("unlink-pending") ? "parent-sync-cleanup" : "parent-sync-published");
            },
            close: async () => { events.push("parent-close"); }
          };
        },
        removePending: async () => { events.push("force-remove-pending"); }
      }
    );

    expect(stored).toBe("stored");
    expect(events).toEqual([
      "open-parent",
      "parent-stat",
      "open-pending",
      "write",
      "file-sync",
      "link-target",
      "parent-sync-published",
      "unlink-pending",
      "force-remove-pending",
      "parent-sync-cleanup",
      "parent-close"
    ]);
  });

  it("surfaces directory durability uncertainty and still closes the parent handle", async () => {
    const publicationFailure = new StorageIntegrityError();
    const syncFailure = new Error("synthetic parent fsync failure");
    const events: string[] = [];
    const outcome = withDurablySynchronizedPendingDirectory(
      "/synthetic/parent",
      "/synthetic/parent/.pending-owned",
      async () => { events.push("operation"); throw publicationFailure; },
      {
        openDirectory: async () => ({
          stat: async () => ({ isDirectory: () => true }),
          sync: async () => { events.push("parent-sync"); throw syncFailure; },
          close: async () => { events.push("parent-close"); }
        }),
        removePending: async () => { events.push("force-remove-pending"); }
      }
    );

    const failure = await outcome.then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([publicationFailure, syncFailure]);
    expect(events).toEqual(["operation", "force-remove-pending", "parent-sync", "parent-close"]);
  });

  it("rejects a publication whose first parent fsync fails even when cleanup fsync succeeds", async () => {
    const syncFailure = new Error("synthetic publication fsync failure");
    const events: string[] = [];
    let syncCalls = 0;
    const outcome = withDurablySynchronizedPendingDirectory(
      "/synthetic/parent",
      "/synthetic/parent/.pending-owned",
      async ({ syncPublishedDirectory }) => {
        events.push("link-target");
        await syncPublishedDirectory();
        events.push("unlink-pending");
      },
      {
        openDirectory: async () => ({
          stat: async () => ({ isDirectory: () => true }),
          sync: async () => {
            syncCalls += 1;
            events.push(`parent-sync-${syncCalls}`);
            if (syncCalls === 1) throw syncFailure;
          },
          close: async () => { events.push("parent-close"); }
        }),
        removePending: async () => { events.push("force-remove-pending"); }
      }
    );

    await expect(outcome).rejects.toBe(syncFailure);
    expect(events).toEqual([
      "link-target",
      "parent-sync-1",
      "force-remove-pending",
      "parent-sync-2",
      "parent-close"
    ]);
  });

  it.skipIf(process.platform !== "linux")(
    "publishes and cleans pending files on Linux without relying on write-stream close events",
    async () => {
      const root = await temporaryRoot();
      const storage = new LocalFileStorage(root);
      await expect(completesWithin(storage.put({
        key: "linux-lifecycle/object",
        body: Readable.from(Buffer.from("linux durable object"))
      }), 2_000)).resolves.toMatchObject({ key: "linux-lifecycle/object", size: 20 });
      expect(await readdir(path.join(root, "linux-lifecycle"))).toEqual(["object"]);
      expect(await readFile(path.join(root, "linux-lifecycle", "object"), "utf8")).toBe("linux durable object");
    }
  );
  it("puts and streams an object with stable size and SHA-256 metadata", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    const body = Buffer.from("safe report");
    const expectedHashSha256 = createHash("sha256").update(body).digest("hex");

    const stored = await storage.put({
      key: "2026/08/report-id.xlsx",
      body: Readable.from(body),
      expectedHashSha256,
      maxBytes: body.length
    });
    expect(await readdir(path.join(root, "2026", "08"))).toEqual(["report-id.xlsx"]);
    expect(await readFile(path.join(root, ...stored.key.split("/")))).toEqual(body);
    const downloaded = await storage.getStream(stored.key);

    expect(stored).toEqual({ key: "2026/08/report-id.xlsx", hash: expectedHashSha256, size: body.length });
    expect(downloaded.size).toBe(body.length);
    expect(await collect(downloaded.stream)).toEqual(body);
    expect(await storage.exists(stored.key)).toBe(true);
  });

  it("makes a same-key/same-content put idempotent and rejects a hash mismatch", async () => {
    const storage = new LocalFileStorage(await temporaryRoot());
    const body = Buffer.from("same object");
    const first = await storage.put({ key: "stable/key", body });
    const second = await storage.put({ key: "stable/key", body, expectedHashSha256: first.hash });

    expect(second).toEqual(first);
    await expect(
      storage.put({ key: "stable/key", body, expectedHashSha256: "0".repeat(64) })
    ).rejects.toBeInstanceOf(StorageIntegrityError);
  });

  it("atomically publishes one same-key writer and never overwrites it in a race", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    const firstBody = Buffer.from("first concurrent object");
    const secondBody = Buffer.from("second concurrent object");
    const firstHash = createHash("sha256").update(firstBody).digest("hex");
    const secondHash = createHash("sha256").update(secondBody).digest("hex");

    const outcomes = await Promise.allSettled([
      storage.put({ key: "raced/key", body: firstBody, expectedHashSha256: firstHash }),
      storage.put({ key: "raced/key", body: secondBody, expectedHashSha256: secondHash })
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StorageIntegrityError);
    const stored = await storage.getStream("raced/key");
    const bytes = await collect(stored.stream);
    expect([firstBody.toString("hex"), secondBody.toString("hex")]).toContain(bytes.toString("hex"));

    const winnerHash = createHash("sha256").update(bytes).digest("hex");
    const sameContent = await Promise.all([
      storage.put({ key: "raced/key", body: bytes, expectedHashSha256: winnerHash }),
      storage.put({ key: "raced/key", body: bytes, expectedHashSha256: winnerHash })
    ]);
    expect(sameContent.every(({ hash }) => hash === winnerHash)).toBe(true);
    expect((await readdir(path.join(root, "raced"))).filter((name) => name.startsWith(".pending-"))).toEqual([]);
    await storage.delete("raced/key");
    expect(await readdir(path.join(root, "raced"))).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")(
    "repeats competing Linux publishes without treating the winner pending link as an external hard link",
    async () => {
      const root = await temporaryRoot();
      const storage = new LocalFileStorage(root);
      for (let round = 0; round < 25; round += 1) {
        const key = `linux-race/object-${round}`;
        const firstBody = Buffer.from(`first-${round}`);
        const secondBody = Buffer.from(`second-${round}`);
        const outcomes = await Promise.allSettled([
          storage.put({ key, body: firstBody }),
          storage.put({ key, body: secondBody })
        ]);
        expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        const rejected = outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(StorageIntegrityError);
      }
      expect((await readdir(path.join(root, "linux-race"))).some((name) => name.startsWith(".pending-"))).toBe(false);
    }
  );

  it("removes incomplete temporary data when the stream exceeds its bound", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);

    await expect(
      storage.put({ key: "bounded/object", body: Readable.from(Buffer.alloc(9)), maxBytes: 8 })
    ).rejects.toBeInstanceOf(StorageObjectTooLargeError);
    expect(await storage.exists("bounded/object")).toBe(false);
    await expect(readFile(path.join(root, "bounded", "object"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../outside", "/absolute", "C:/drive", "nested\\escape", "nested/../escape", "bad\0key"])(
    "rejects an unsafe key: %s",
    async (key) => {
      const storage = new LocalFileStorage(await temporaryRoot());
      await expect(storage.put({ key, body: Buffer.from("x") })).rejects.toBeInstanceOf(InvalidStorageKeyError);
    }
  );

  it("refuses a symlinked parent that resolves outside the storage root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "object"), "outside object");
    try {
      await symlink(outside, path.join(root, "linked"), "junction");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const storage = new LocalFileStorage(root);

    await expect(storage.put({ key: "linked/object", body: Buffer.from("x") }))
      .rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.getStream("linked/object")).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.delete("linked/object")).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.exists("linked/object")).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(readFile(path.join(outside, "object"), "utf8")).resolves.toBe("outside object");
  });

  it.skipIf(process.platform !== "win32")(
    "rejects a leaf symlink for read, existence, and handle-based deletion",
    async () => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      const outsideFile = path.join(outside, "outside-object");
      await writeFile(outsideFile, "outside object");
      try {
        await symlink(outsideFile, path.join(root, "linked-object"), "file");
      } catch (error) {
        if (isWindowsSymlinkPrivilegeError(error)) return;
        throw error;
      }
      const storage = new LocalFileStorage(root);

      await expect(storage.getStream("linked-object")).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.exists("linked-object")).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.delete("linked-object")).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside object");
    }
  );

  it("rejects a same-volume hard link so an outside file cannot be read or deleted", async () => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      const outsideFile = path.join(outside, "outside-object");
      await writeFile(outsideFile, "outside object");
      await link(outsideFile, path.join(root, "hard-linked-object"));
      const storage = new LocalFileStorage(root);

      await expect(storage.getStream("hard-linked-object")).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.exists("hard-linked-object")).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.delete("hard-linked-object")).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside object");
  });

  it.skipIf(process.platform !== "linux")(
    "fails a put closed against a persistent target hard link with a matching pending-shaped link",
    async () => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      const outsideFile = path.join(outside, "outside-object");
      await writeFile(outsideFile, "outside object");
      await link(outsideFile, path.join(root, "hard-linked-object"));
      await link(outsideFile, path.join(root, ".pending-attacker"));
      const waits: number[] = [];
      const storage = new LocalFileStorage(root, {
        waitForConcurrentPublish: async (milliseconds) => { waits.push(milliseconds); }
      });

      await expect(storage.put({
        key: "hard-linked-object",
        body: Buffer.from("replacement object")
      })).rejects.toBeInstanceOf(InvalidStorageKeyError);
      expect(waits).toEqual(Array.from({ length: 24 }, () => 10));
      expect((await readdir(root)).sort()).toEqual([".pending-attacker", "hard-linked-object"]);
      await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside object");
    }
  );

  it.skipIf(process.platform !== "win32")(
    "holds parent and leaf handles while streaming so same-user rename and delete races fail closed",
    async () => {
      const root = await temporaryRoot();
      const storage = new LocalFileStorage(root);
      const body = Buffer.alloc(4 * 1024 * 1024, 0x5a);
      await storage.put({ key: "read-lease/object", body });
      const opened = await storage.getStream("read-lease/object");
      const parent = path.join(root, "read-lease");
      const target = path.join(parent, "object");

      await expectWindowsLeaseBlocked(() => rename(parent, path.join(root, "moved-read-lease")));
      await expectWindowsLeaseBlocked(() => rm(target, { force: false }));
      expect(await collect(opened.stream)).toEqual(body);
      await expect(stat(path.join(root, "moved-read-lease"))).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000
  );

  it.skipIf(process.platform !== "win32")(
    "holds parent handles throughout a streaming atomic publish",
    async () => {
      const root = await temporaryRoot();
      const storage = new LocalFileStorage(root);
      const body = new PassThrough();
      const put = storage.put({ key: "write-lease/object", body });
      const parent = path.join(root, "write-lease");
      await waitForPendingFile(parent);

      try {
        await expectWindowsLeaseBlocked(() => rename(parent, path.join(root, "moved-write-lease")));
      } finally {
        body.end("published object");
      }
      await expect(put).resolves.toMatchObject({ key: "write-lease/object", size: 16 });
      await expect(readFile(path.join(parent, "object"), "utf8")).resolves.toBe("published object");
      await expect(stat(path.join(root, "moved-write-lease"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("rejects a reparse ancestor before creating any directory through it", async () => {
    const parent = await temporaryRoot();
    const outside = await temporaryRoot();
    const junction = path.join(parent, "junction");
    try {
      await symlink(outside, junction, "junction");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const storage = new LocalFileStorage(path.join(junction, "must-not-be-created"));
    await expect(storage.put({ key: "object", body: Buffer.from("x") }))
      .rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(stat(path.join(outside, "must-not-be-created"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns false for a missing delete and keeps missing reads distinct", async () => {
    const storage = new LocalFileStorage(await temporaryRoot());

    await expect(storage.delete("missing/object")).resolves.toBe(false);
    await expect(storage.getStream("missing/object")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "meta-storage-"));
  roots.push(root);
  return root;
}

async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function completesWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("LOCAL_STORAGE_OPERATION_TIMEOUT")), timeoutMs);
    timeout.unref?.();
    operation.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); }
    );
  });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("LOCAL_STORAGE_CONDITION_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function isWindowsSymlinkPrivilegeError(error: unknown) {
  return error instanceof Error && "code" in error &&
    ["EPERM", "EACCES", "UNKNOWN"].includes(String((error as NodeJS.ErrnoException).code));
}

async function expectWindowsLeaseBlocked(operation: () => Promise<unknown>) {
  let failure: unknown;
  try { await operation(); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(["EPERM", "EACCES", "EBUSY"]).toContain(String((failure as NodeJS.ErrnoException).code));
}

async function waitForPendingFile(parent: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await readdir(parent)).some((name) => name.startsWith(".pending-"))) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The Windows storage helper did not open its pending file in time.");
}
