import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  FileStorage,
  FileStoragePutInput,
  StorageAccessDeniedError,
  StorageIntegrityError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  StorageProviderRequestError,
  StorageProviderUnavailableError,
  StoredFile
} from "./file-storage";
import { normalizeStorageKey } from "./storage-reference";
import {
  DEFAULT_TEMP_STORAGE_BUDGET_BYTES,
  temporaryStorageBudget
} from "./temporary-storage-budget";

export type SupabaseStorageDomain = "uploads" | "reports";

export type SupabaseFileStorageOptions = {
  supabaseUrl: string;
  apiKey: string;
  accessToken: string;
  bucket: string;
  domain: SupabaseStorageDomain;
  timeoutMs?: number;
  maxObjectBytes?: number;
  temporaryStorageBudgetBytes?: number;
  fetchImplementation?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OBJECT_BYTES = 52_428_800;
type StreamingRequestInit = Omit<RequestInit, "body"> & {
  body?: BodyInit | Readable | string;
  duplex?: "half";
};

/** Private Supabase Storage adapter. Keys stay logical; bucket and domain are constructor-owned. */
export class SupabaseFileStorage implements FileStorage {
  readonly provider = "supabase";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly accessToken: string;
  private readonly bucket: string;
  private readonly domain: SupabaseStorageDomain;
  private readonly timeoutMs: number;
  private readonly maxObjectBytes: number;
  private readonly temporaryStorageBudgetBytes: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: SupabaseFileStorageOptions) {
    let url: URL;
    try {
      url = new URL(options.supabaseUrl);
    } catch {
      throw new Error("SUPABASE_URL must be a valid URL for Supabase Storage.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("SUPABASE_URL must be a credential-free HTTPS origin for Supabase Storage.");
    }
    if (!options.apiKey.trim()) throw new Error("A Supabase Storage API key is required.");
    if (!options.accessToken.trim()) throw new Error("A Supabase Storage access token is required.");
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(options.bucket)) {
      throw new Error("SUPABASE_STORAGE_BUCKET is invalid.");
    }
    this.baseUrl = `${url.origin}/storage/v1`;
    this.apiKey = options.apiKey;
    this.accessToken = options.accessToken;
    this.bucket = options.bucket;
    this.domain = options.domain;
    this.timeoutMs = checkedBound(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 250, 60_000, "timeout");
    this.maxObjectBytes = checkedBound(
      options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES,
      1,
      268_435_456,
      "object size"
    );
    this.temporaryStorageBudgetBytes = checkedBound(
      options.temporaryStorageBudgetBytes ?? DEFAULT_TEMP_STORAGE_BUDGET_BYTES,
      1,
      DEFAULT_TEMP_STORAGE_BUDGET_BYTES,
      "temporary storage budget"
    );
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async put(input: FileStoragePutInput): Promise<StoredFile> {
    const key = normalizeStorageKey(input.key);
    const limit = Math.min(checkedLimit(input.maxBytes), this.maxObjectBytes);
    let lease: ReturnType<typeof temporaryStorageBudget.acquire>;
    try {
      lease = temporaryStorageBudget.acquire(limit, this.temporaryStorageBudgetBytes);
    } catch (error) {
      if (input.body instanceof Readable && !input.body.destroyed) input.body.destroy();
      throw error;
    }
    const temporaryRoot = path.join(tmpdir(), `meta-storage-${randomUUID()}`);
    const temporaryPath = path.join(temporaryRoot, "object");
    try {
      await mkdir(temporaryRoot, { recursive: false, mode: 0o700 });
      const measured = await spoolAndHash(input.body, temporaryPath, limit);
      if (input.expectedHashSha256 && measured.hash !== normalizedHash(input.expectedHashSha256)) {
        throw new StorageIntegrityError();
      }
      const remoteKey = this.remoteKey(key);
      const response = await this.request(this.objectUrl(remoteKey), {
        method: "POST",
        headers: {
          "cache-control": "no-store",
          "content-length": String(measured.size),
          "content-type": "application/octet-stream",
          "x-upsert": "false"
        },
        body: createReadStream(temporaryPath),
        duplex: "half"
      });
      await discardResponseBody(response);
      if (response.ok) return { key, ...measured };
      if (response.status === 400 || response.status === 409) {
        const existing = await this.hashExisting(key, limit);
        if (existing && existing.hash === measured.hash && existing.size === measured.size) {
          return { key, ...measured };
        }
        if (existing) throw new StorageIntegrityError();
      }
      throw mappedStatus(response.status);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      lease.release();
    }
  }

  async getStream(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    const remoteKey = this.remoteKey(normalizedKey);
    const controller = new AbortController();
    let source: Readable | undefined;
    const timer = setTimeout(() => {
      controller.abort();
      source?.destroy(new StorageProviderUnavailableError());
    }, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(this.objectUrl(remoteKey), {
        method: "GET",
        headers: this.headers(),
        cache: "no-store",
        signal: controller.signal
      });
    } catch {
      clearTimeout(timer);
      throw new StorageProviderUnavailableError();
    }
    if (!response.ok) {
      clearTimeout(timer);
      await discardResponseBody(response);
      throw mappedStatus(response.status);
    }
    let size: number;
    try {
      const declaredSize = response.headers.get("content-length");
      size = declaredSize === null ? await this.objectSize(remoteKey) : parseContentLength(declaredSize);
    } catch (error) {
      clearTimeout(timer);
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (size > this.maxObjectBytes) {
      clearTimeout(timer);
      controller.abort();
      throw new StorageObjectTooLargeError();
    }
    if (!response.body) {
      clearTimeout(timer);
      throw new StorageProviderUnavailableError();
    }
    let observed = 0;
    const bounded = new Transform({
      transform: (chunk: Buffer | string, _encoding, callback) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        observed += bytes.length;
        if (observed > this.maxObjectBytes || observed > size) {
          controller.abort();
          callback(new StorageObjectTooLargeError());
          return;
        }
        callback(null, bytes);
      },
      flush: (callback) => {
        if (observed !== size) {
          callback(new StorageIntegrityError());
          return;
        }
        callback();
      }
    });
    source = Readable.fromWeb(response.body as never);
    source.once("error", () => {
      if (!bounded.destroyed) bounded.destroy(new StorageProviderUnavailableError());
    });
    const stream = source.pipe(bounded);
    let completed = false;
    stream.once("end", () => {
      completed = true;
      clearTimeout(timer);
    });
    stream.once("error", () => {
      clearTimeout(timer);
      controller.abort();
      if (!source?.destroyed) source?.destroy();
    });
    stream.once("close", () => {
      clearTimeout(timer);
      if (!completed) {
        controller.abort();
        if (!source?.destroyed) source?.destroy();
      }
    });
    return { stream, size };
  }

  async exists(key: string) {
    const remoteKey = this.remoteKey(normalizeStorageKey(key));
    const response = await this.request(this.objectUrl(remoteKey), { method: "HEAD" });
    await discardResponseBody(response);
    if (response.ok) return true;
    if (response.status === 400 || response.status === 404) return false;
    throw mappedStatus(response.status);
  }

  async delete(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    if (!(await this.exists(normalizedKey))) return false;
    const response = await this.request(this.bucketObjectUrl(), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefixes: [this.remoteKey(normalizedKey)] })
    });
    await discardResponseBody(response);
    if (response.status === 404) return false;
    if (!response.ok) throw mappedStatus(response.status);
    return true;
  }

  private async hashExisting(key: string, limit: number) {
    try {
      const stored = await this.getStream(key);
      if (stored.size > limit) throw new StorageObjectTooLargeError();
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of stored.stream) {
        size += chunk.length;
        if (size > limit) throw new StorageObjectTooLargeError();
        hash.update(chunk);
      }
      return { hash: hash.digest("hex"), size };
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) return null;
      throw error;
    }
  }

  private remoteKey(key: string) {
    const normalized = normalizeStorageKey(key);
    if (normalized.startsWith("trash/")) {
      const trashId = normalized.slice("trash/".length);
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(trashId) || trashId.includes("/")) {
        throw new StorageProviderRequestError();
      }
      return `trash/${this.domain}/${trashId}`;
    }
    return `${this.domain}/${normalized}`;
  }

  private objectUrl(remoteKey: string) {
    return `${this.baseUrl}/object/${encodedPath(this.bucket, remoteKey)}`;
  }

  private objectInfoUrl(remoteKey: string) {
    return `${this.baseUrl}/object/info/${encodedPath(this.bucket, remoteKey)}`;
  }

  private bucketObjectUrl() {
    return `${this.baseUrl}/object/${encodeURIComponent(this.bucket)}`;
  }

  private async objectSize(remoteKey: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.objectInfoUrl(remoteKey), {
        method: "GET",
        headers: this.headers(),
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) {
        await discardResponseBody(response);
        throw mappedStatus(response.status);
      }
      const metadata = await readBoundedJsonObject(response, 16_384, controller.signal);
      const size = metadata.size;
      if (!Number.isSafeInteger(size) || (size as number) < 0) throw new StorageProviderUnavailableError();
      return size as number;
    } catch (error) {
      if (
        error instanceof StorageAccessDeniedError ||
        error instanceof StorageObjectNotFoundError ||
        error instanceof StorageProviderRequestError ||
        error instanceof StorageProviderUnavailableError
      ) {
        throw error;
      }
      throw new StorageProviderUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(extra: HeadersInit = {}) {
    return {
      apikey: this.apiKey,
      authorization: `Bearer ${this.accessToken}`,
      ...extra
    };
  }

  private async request(url: string, init: StreamingRequestInit) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImplementation(url, {
        ...init,
        headers: this.headers(init.headers),
        cache: "no-store",
        signal: controller.signal
      } as RequestInit);
    } catch {
      throw new StorageProviderUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }
}

async function spoolAndHash(body: Buffer | Readable, targetPath: string, limit: number) {
  const hash = createHash("sha256");
  let size = 0;
  const measure = new Transform({
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
  await pipeline(
    Buffer.isBuffer(body) ? Readable.from(body) : body,
    measure,
    createWriteStream(targetPath, { flags: "wx", mode: 0o600 })
  );
  return { hash: hash.digest("hex"), size };
}

function checkedLimit(value: number | undefined) {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageObjectTooLargeError();
  return value;
}

function checkedBound(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Supabase Storage ${label} is outside the allowed range.`);
  }
  return value;
}

function normalizedHash(value: string) {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new StorageIntegrityError();
  return normalized;
}

function parseContentLength(value: string | null) {
  if (!value || !/^\d+$/.test(value)) throw new StorageProviderUnavailableError();
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new StorageProviderUnavailableError();
  return size;
}

function encodedPath(bucket: string, key: string) {
  return [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
}

function mappedStatus(status: number): Error {
  if (status === 404) return new StorageObjectNotFoundError();
  if (status === 401 || status === 403) return new StorageAccessDeniedError();
  if (status === 408 || status === 429 || status >= 500) return new StorageProviderUnavailableError();
  return new StorageProviderRequestError();
}

async function discardResponseBody(response: Response) {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    throw new StorageProviderUnavailableError();
  }
}

async function readBoundedJsonObject(
  response: Response,
  limit: number,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  if (!response.body) throw new StorageProviderUnavailableError();
  const declared = response.headers.get("content-length");
  if (declared !== null && parseContentLength(declared) > limit) {
    await response.body.cancel().catch(() => undefined);
    throw new StorageProviderUnavailableError();
  }
  const source = Readable.fromWeb(response.body as never);
  const abort = () => source.destroy(new StorageProviderUnavailableError());
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new StorageProviderUnavailableError();
      chunks.push(bytes);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new StorageProviderUnavailableError();
    return value as Record<string, unknown>;
  } catch (error) {
    if (!source.destroyed) source.destroy();
    if (error instanceof StorageProviderUnavailableError) throw error;
    throw new StorageProviderUnavailableError();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
