import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UploadStorageService } from "./upload-storage.service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("UploadStorageService", () => {
  it("uses only a server hash in a tagged key and never a user filename", async () => {
    const root = await temporaryRoot();
    const service = new UploadStorageService(config(root));
    const file = multerFile("../../private-order-list.csv", Buffer.from("safe synthetic csv"));
    const hash = createHash("sha256").update(file.buffer).digest("hex");
    const objectId = "11111111-1111-4111-8111-111111111111";

    const reference = service.prepareOriginalFileReference(hash, new Date("2026-08-25T00:00:00.000Z"), objectId);
    await service.putOriginalFile(file, reference);

    expect(reference).toBe(`local:2026/08/${objectId}/${hash}`);
    expect(reference).not.toContain("private-order-list");
    await expect(service.deleteStoredUploadFile(reference)).resolves.toBe(true);
  });

  it("never reuses an active key when the same bytes are uploaded again", () => {
    const service = new UploadStorageService(config("unused"));
    const hash = "a".repeat(64);
    const now = new Date("2026-08-25T00:00:00.000Z");

    const first = service.prepareOriginalFileReference(hash, now, "11111111-1111-4111-8111-111111111111");
    const second = service.prepareOriginalFileReference(hash, now, "22222222-2222-4222-8222-222222222222");

    expect(first).not.toBe(second);
  });

  it("supports contained legacy local paths and rejects an outside path", async () => {
    const root = await temporaryRoot();
    const service = new UploadStorageService(config(root));
    const file = multerFile("meta.csv", Buffer.from("legacy fixture"));
    const hash = createHash("sha256").update(file.buffer).digest("hex");
    const reference = service.prepareOriginalFileReference(hash);
    await service.putOriginalFile(file, reference);
    const key = reference.slice("local:".length);

    await expect(service.deleteStoredUploadFile(path.join(root, ...key.split("/")))).resolves.toBe(true);
    await expect(service.deleteStoredUploadFile(path.resolve(root, "..", "outside.csv"))).rejects.toThrow();
  });

  it("fails closed when an unapproved provider is configured", () => {
    const service = new UploadStorageService(config("unused", "candidate"));
    expect(() => service.prepareOriginalFileReference("a".repeat(64))).toThrow("approved adapter");
  });
});

function config(root: string, provider = "local") {
  return {
    get: (key: string) => key === "STORAGE_PROVIDER" ? provider : key === "UPLOAD_STORAGE_DIR" ? root : undefined
  } as never;
}

function multerFile(originalname: string, buffer: Buffer): Express.Multer.File {
  return {
    fieldname: "file",
    originalname,
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

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "upload-storage-"));
  roots.push(root);
  return root;
}
