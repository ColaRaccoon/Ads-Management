import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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
    try {
      await symlink(outside, path.join(root, "linked"), "junction");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const storage = new LocalFileStorage(root);

    await expect(storage.put({ key: "linked/object", body: Buffer.from("x") }))
      .rejects.toBeInstanceOf(InvalidStorageKeyError);
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
