import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, readdir, realpath, rm, statfs } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
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
  private readonly waitForConcurrentPublish: (milliseconds: number) => Promise<void>;

  constructor(rootPath: string, options: LocalFileStorageOptions = {}) {
    this.rootPath = path.resolve(rootPath);
    this.waitForConcurrentPublish = options.waitForConcurrentPublish ?? wait;
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
    const limit = checkedLimit(input.maxBytes);

    return withDurablySynchronizedPendingDirectory(
      path.dirname(targetPath),
      temporaryPath,
      async ({ syncPublishedDirectory }) => {
        const pending = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
          0o600
        );
        const { hash: digest, size } = await writeAndSyncOwnedPendingFile(
          pending,
          Buffer.isBuffer(input.body) ? Readable.from([input.body]) : input.body,
          limit
        );
        if (input.expectedHashSha256 && digest !== input.expectedHashSha256.toLowerCase()) {
          throw new StorageIntegrityError();
        }
        try {
          await link(temporaryPath, targetPath);
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          await this.regularFileStatAfterConcurrentPublish(targetPath);
          const stored = await this.hashFile(key, targetPath, input.maxBytes);
          if (stored.hash !== digest || stored.size !== size) throw new StorageIntegrityError();
          return stored;
        }
        await syncPublishedDirectory();
        await rm(temporaryPath, { force: false });
        return { key, hash: digest, size };
      }
    );
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

  private async regularFileStatAfterConcurrentPublish(targetPath: string) {
    const attempts = 25;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.regularFileStat(targetPath);
      } catch (error) {
        if (!(error instanceof MultipleLinkStorageError)) throw error;
        const pendingLink = await hasMatchingPendingLink(targetPath, error);
        if (!pendingLink) {
          // The winning writer may have unlinked its pending name between stat and directory inspection.
          try { return await this.regularFileStat(targetPath); }
          catch (confirmed) {
            if (confirmed instanceof MultipleLinkStorageError) throw confirmed;
            throw confirmed;
          }
        }
        if (attempt === attempts - 1) throw error;
        await this.waitForConcurrentPublish(10);
      }
    }
    throw new InvalidStorageKeyError();
  }

  private async openRegularFile(targetPath: string) {
    let handle;
    try {
      handle = await open(targetPath, constants.O_RDONLY | noFollowFlag());
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new InvalidStorageKeyError();
      if (metadata.nlink !== 1) throw new MultipleLinkStorageError(metadata.dev, metadata.ino);
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

export type LocalFileStorageOptions = {
  /** Test seam only: retry count and all fail-closed checks remain fixed. */
  waitForConcurrentPublish?: (milliseconds: number) => Promise<void>;
};

type DurableDirectoryHandle = {
  stat: () => Promise<{ isDirectory: () => boolean }>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

type DurablePendingDirectoryIo = {
  openDirectory: (parentPath: string) => Promise<DurableDirectoryHandle>;
  removePending: (temporaryPath: string) => Promise<void>;
};

const defaultDurablePendingDirectoryIo: DurablePendingDirectoryIo = {
  openDirectory: async (parentPath) => open(
    parentPath,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollowFlag()
  ),
  removePending: async (temporaryPath) => {
    await rm(temporaryPath, { force: true });
  }
};

export async function withDurablySynchronizedPendingDirectory<T>(
  parentPath: string,
  temporaryPath: string,
  operation: (durability: { syncPublishedDirectory: () => Promise<void> }) => Promise<T>,
  io: DurablePendingDirectoryIo = defaultDurablePendingDirectoryIo
): Promise<T> {
  const parent = await io.openDirectory(parentPath);
  let operationFailed = false;
  let operationFailure: unknown;
  let result: T | undefined;
  try {
    const metadata = await parent.stat();
    if (!metadata.isDirectory()) throw new InvalidStorageKeyError();
    result = await operation({ syncPublishedDirectory: () => parent.sync() });
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  const durabilityFailures: unknown[] = [];
  try { await io.removePending(temporaryPath); }
  catch (error) { durabilityFailures.push(error); }
  try { await parent.sync(); }
  catch (error) { durabilityFailures.push(error); }
  try { await parent.close(); }
  catch (error) { durabilityFailures.push(error); }

  if (operationFailed) {
    if (durabilityFailures.length > 0) {
      throw new AggregateError(
        [operationFailure, ...durabilityFailures],
        "The storage operation failed and its pending-directory durability is uncertain."
      );
    }
    throw operationFailure;
  }
  if (durabilityFailures.length === 1) throw durabilityFailures[0];
  if (durabilityFailures.length > 1) {
    throw new AggregateError(durabilityFailures, "The pending-directory durability is uncertain.");
  }
  return result!;
}

class MultipleLinkStorageError extends InvalidStorageKeyError {
  constructor(readonly device: number, readonly inode: number) {
    super();
  }
}

async function hasMatchingPendingLink(targetPath: string, target: MultipleLinkStorageError) {
  const parent = path.dirname(targetPath);
  const names = await readdir(parent);
  for (const name of names) {
    if (!name.startsWith(".pending-")) continue;
    try {
      const metadata = await lstat(path.join(parent, name));
      if (metadata.isFile() && !metadata.isSymbolicLink() &&
          metadata.dev === target.device && metadata.ino === target.inode) return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return false;
}

export async function writeAndSyncOwnedPendingFile(
  pending: Pick<FileHandle, "write" | "sync" | "close">,
  source: Readable,
  maximumBytes: number
): Promise<{ hash: string; size: number }> {
  let size = 0;
  let sourceCompleted = false;
  let result: { hash: string; size: number } | undefined;
  let iterator: AsyncIterator<unknown> | undefined;
  let operationFailed = false;
  let operationFailure: unknown;
  try {
    const limit = checkedLimit(maximumBytes);
    const hash = createHash("sha256");
    iterator = source[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        sourceCompleted = true;
        break;
      }
      const bytes = storageChunk(next.value);
      if (bytes.byteLength === 0) continue;
      if (bytes.byteLength > limit - size) throw new StorageObjectTooLargeError();
      let chunkOffset = 0;
      while (chunkOffset < bytes.byteLength) {
        const write = await pending.write(
          bytes,
          chunkOffset,
          bytes.byteLength - chunkOffset,
          size + chunkOffset
        );
        if (!Number.isSafeInteger(write.bytesWritten) || write.bytesWritten < 1 ||
            write.bytesWritten > bytes.byteLength - chunkOffset) {
          throw new StorageIntegrityError();
        }
        chunkOffset += write.bytesWritten;
      }
      hash.update(bytes);
      size += bytes.byteLength;
    }
    await pending.sync();
    result = { hash: hash.digest("hex"), size };
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }
  if (operationFailed && !sourceCompleted) {
    const sourceFinished = finished(source, { cleanup: true }).then(
      () => undefined,
      () => undefined
    );
    try { source.destroy(); } catch { /* Preserve the original write/read failure. */ }
    try { await iterator?.return?.(); }
    catch { /* Cancellation is awaited, but the primary storage failure takes precedence. */ }
    await sourceFinished;
  }
  let closeFailure: unknown;
  try { await pending.close(); }
  catch (error) { closeFailure = error; }
  if (operationFailed) throw operationFailure;
  if (closeFailure !== undefined) throw closeFailure;
  return result!;
}

function storageChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new StorageIntegrityError();
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

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
