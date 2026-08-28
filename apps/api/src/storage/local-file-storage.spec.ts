import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidStorageKeyError,
  StorageIntegrityError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError
} from "./file-storage";
import { LocalFileStorage } from "./local-file-storage";

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

  it.skipIf(process.platform !== "win32")(
    "rejects a same-volume hard link so an outside file cannot be read or deleted",
    async () => {
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
