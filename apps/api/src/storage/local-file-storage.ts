import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
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

export class LocalFileStorage implements FileStorage {
  readonly provider = "local";
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
  }

  async put(input: FileStoragePutInput): Promise<StoredFile> {
    const key = normalizeStorageKey(input.key);
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
      await pipeline(
        Buffer.isBuffer(input.body) ? Readable.from(input.body) : input.body,
        integrity,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 })
      );
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
    const targetPath = await this.safeTargetPath(normalizedKey, false);
    const fileStat = await this.regularFileStat(targetPath);
    return {
      stream: createReadStream(targetPath),
      size: fileStat.size
    };
  }

  async delete(key: string) {
    try {
      const targetPath = await this.safeTargetPath(normalizeStorageKey(key), false);
      await this.regularFileStat(targetPath);
      await rm(targetPath, { force: false });
      return true;
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) return false;
      throw error;
    }
  }

  async exists(key: string) {
    try {
      const targetPath = await this.safeTargetPath(normalizeStorageKey(key), false);
      await this.regularFileStat(targetPath);
      return true;
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) return false;
      throw error;
    }
  }

  private async safeTargetPath(key: string, createParent: boolean) {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
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
    if (createParent) await mkdir(parentPath, { recursive: true, mode: 0o700 });
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
    try {
      const linkStat = await lstat(targetPath);
      if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw new InvalidStorageKeyError();
      return await stat(targetPath);
    } catch (error) {
      if (isMissing(error)) throw new StorageObjectNotFoundError();
      throw error;
    }
  }

  private async hashFile(key: string, targetPath: string, maxBytes?: number): Promise<StoredFile> {
    const hash = createHash("sha256");
    let size = 0;
    const limit = checkedLimit(maxBytes);
    for await (const chunk of createReadStream(targetPath)) {
      size += chunk.length;
      if (size > limit) throw new StorageObjectTooLargeError();
      hash.update(chunk);
    }
    return { key, hash: hash.digest("hex"), size };
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
