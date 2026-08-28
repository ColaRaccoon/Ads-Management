import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, realpath, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  FileStorage,
  FileStoragePutInput,
  InvalidStorageKeyError,
  StorageIntegrityError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  StoredFile
} from "./file-storage";
import { normalizeStorageKey } from "./storage-reference";
import { WindowsNtfsFileStorage } from "./windows-ntfs-file-storage";

export class LocalFileStorage implements FileStorage {
  readonly provider = "local";
  readonly rootPath: string;
  private readonly windows?: WindowsNtfsFileStorage;

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
    if (process.platform === "win32") this.windows = new WindowsNtfsFileStorage(this.rootPath);
  }

  async assertReady(minimumFreeBytes = 104_857_600) {
    if (this.windows) {
      await this.windows.assertReady();
      const volume = await statfs(this.rootPath, { bigint: true });
      if (volume.bavail * volume.bsize < BigInt(minimumFreeBytes)) throw new StorageObjectTooLargeError();
      return;
    }
    await assertNoReparseComponents(this.rootPath);
    const metadata = await lstat(this.rootPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new InvalidStorageKeyError();
    await realpath(this.rootPath);
    await access(this.rootPath, constants.R_OK | constants.W_OK);
    const volume = await statfs(this.rootPath, { bigint: true });
    if (volume.bavail * volume.bsize < BigInt(minimumFreeBytes)) {
      throw new StorageObjectTooLargeError();
    }
  }

  async put(input: FileStoragePutInput): Promise<StoredFile> {
    const key = normalizeStorageKey(input.key);
    if (this.windows) return this.windows.put({ ...input, key });
    const targetPath = await this.safeTargetPath(key, true);
    const temporaryPath = path.join(path.dirname(targetPath), `.pending-${randomUUID()}`);
    const hash = createHash("sha256");
    let size = 0;
    const limit = checkedLimit(input.maxBytes);
    const integrity = new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limit) {
          callback(new StorageObjectTooLargeError());
          return;
        }
        hash.update(bytes);
        callback(null, bytes);
      }
    });

    try {
      const pending = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        0o600
      );
      try {
        await pipeline(
          Buffer.isBuffer(input.body) ? Readable.from(input.body) : input.body,
          integrity,
          pending.createWriteStream({ autoClose: false })
        );
        await pending.sync();
      } finally {
        await pending.close();
      }
      const digest = hash.digest("hex");
      if (input.expectedHashSha256 && digest !== input.expectedHashSha256.toLowerCase()) {
        throw new StorageIntegrityError();
      }
      try {
        await link(temporaryPath, targetPath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await this.regularFileStat(targetPath);
        const stored = await this.hashFile(key, targetPath, input.maxBytes);
        if (stored.hash !== digest || stored.size !== size) throw new StorageIntegrityError();
        return stored;
      }
      return { key, hash: digest, size };
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async getStream(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    if (this.windows) return this.windows.getStream(normalizedKey);
    const targetPath = await this.safeTargetPath(normalizedKey, false);
    const opened = await this.openRegularFile(targetPath);
    return {
      stream: opened.handle.createReadStream(),
      size: opened.metadata.size
    };
  }

  async delete(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    if (this.windows) return this.windows.delete(normalizedKey);
    try {
      const targetPath = await this.safeTargetPath(normalizedKey, false);
      await this.regularFileStat(targetPath);
      await rm(targetPath, { force: false });
      return true;
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) return false;
      throw error;
    }
  }

  async exists(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    if (this.windows) return this.windows.exists(normalizedKey);
    try {
      const targetPath = await this.safeTargetPath(normalizedKey, false);
      await this.regularFileStat(targetPath);
      return true;
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) return false;
      throw error;
    }
  }

  private async safeTargetPath(key: string, createParent: boolean) {
    await assertNoReparseComponents(this.rootPath);
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    await assertNoReparseComponents(this.rootPath);
    const rootRealPath = await realpath(this.rootPath);
    const targetPath = path.resolve(this.rootPath, ...key.split("/"));
    const relative = path.relative(this.rootPath, targetPath);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new InvalidStorageKeyError();
    }
    const parentPath = path.dirname(targetPath);
    if (createParent) {
      await assertNoReparseComponents(parentPath);
      await mkdir(parentPath, { recursive: true, mode: 0o700 });
    }
    await assertNoReparseComponents(parentPath);
    let parentRealPath: string;
    try {
      parentRealPath = await realpath(parentPath);
    } catch (error) {
      if (isMissing(error)) throw new StorageObjectNotFoundError();
      throw error;
    }
    const realRelative = path.relative(rootRealPath, parentRealPath);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      throw new InvalidStorageKeyError();
    }
    return targetPath;
  }

  private async regularFileStat(targetPath: string) {
    const opened = await this.openRegularFile(targetPath);
    await opened.handle.close();
    return opened.metadata;
  }

  private async openRegularFile(targetPath: string) {
    let handle;
    try {
      handle = await open(targetPath, constants.O_RDONLY | noFollowFlag());
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) throw new InvalidStorageKeyError();
      return { handle, metadata };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (isMissing(error)) throw new StorageObjectNotFoundError();
      if (isNoFollowViolation(error)) throw new InvalidStorageKeyError();
      throw error;
    }
  }

  private async hashFile(key: string, targetPath: string, maxBytes?: number): Promise<StoredFile> {
    const hash = createHash("sha256");
    let size = 0;
    const limit = checkedLimit(maxBytes);
    const opened = await this.openRegularFile(targetPath);
    try {
      for await (const chunk of opened.handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > limit) throw new StorageObjectTooLargeError();
        hash.update(chunk);
      }
    } finally {
      await opened.handle.close();
    }
    return { key, hash: hash.digest("hex"), size };
  }
}

function noFollowFlag() {
  return constants.O_NOFOLLOW ?? 0;
}

async function assertNoReparseComponents(target: string) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const relative = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of relative) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new InvalidStorageKeyError();
  }
}

function checkedLimit(value: number | undefined) {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageObjectTooLargeError();
  return value;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isNoFollowViolation(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error &&
    ["ELOOP", "EMLINK"].includes(String((error as NodeJS.ErrnoException).code));
}
