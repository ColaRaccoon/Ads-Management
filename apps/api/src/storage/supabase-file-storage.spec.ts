import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  StorageIntegrityError,
  StorageObjectTooLargeError,
  StorageProviderUnavailableError
} from "./file-storage";
import { SupabaseFileStorage } from "./supabase-file-storage";

const SECRET = "sb_secret_synthetic-test-only";
const BUCKET = "synthetic-private";
const BODY = Buffer.from("synthetic-storage-object", "utf8");
const HASH = createHash("sha256").update(BODY).digest("hex");

describe("SupabaseFileStorage", () => {
  it("owns the upload domain prefix, bounds and hashes a streamed put, and sends no public URL", async () => {
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const uploaded = await collectRequestBody(init?.body);
      expect(uploaded).toEqual(BODY);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${SECRET}`);
      expect(headers.get("x-upsert")).toBe("false");
      expect(String(url)).toContain(`/storage/v1/object/${BUCKET}/uploads/2026/08/object`);
      expect(String(url)).not.toContain("/public/");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const storage = adapter(fetchImplementation);

    await expect(storage.put({
      key: "2026/08/object",
      body: Readable.from(BODY),
      expectedHashSha256: HASH,
      maxBytes: BODY.length
    })).resolves.toEqual({ key: "2026/08/object", hash: HASH, size: BODY.length });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("treats a duplicate-put race as idempotent only after a streamed remote hash match", async () => {
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        await collectRequestBody(init.body);
        return new Response("{}", { status: 409 });
      }
      return objectResponse(BODY);
    }) as typeof fetch;
    const storage = adapter(fetchImplementation);

    await expect(storage.put({ key: "same", body: BODY, expectedHashSha256: HASH }))
      .resolves.toMatchObject({ hash: HASH, size: BODY.length });

    const mismatchedFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        await collectRequestBody(init.body);
        return new Response("{}", { status: 409 });
      }
      return objectResponse(Buffer.from("different"));
    }) as typeof fetch;
    await expect(adapter(mismatchedFetch).put({ key: "same", body: BODY, expectedHashSha256: HASH }))
      .rejects.toBeInstanceOf(StorageIntegrityError);
  });

  it("streams reads with declared-size enforcement and maps short or oversized bodies safely", async () => {
    const storage = adapter(vi.fn(async () => objectResponse(BODY)) as typeof fetch);
    const downloaded = await storage.getStream("2026/08/object");
    expect(downloaded.size).toBe(BODY.length);
    expect(await collect(downloaded.stream)).toEqual(BODY);

    const short = adapter(vi.fn(async () => new Response("abc", {
      status: 200,
      headers: { "content-length": "4" }
    })) as typeof fetch);
    const shortDownload = await short.getStream("short");
    await expect(collect(shortDownload.stream)).rejects.toBeInstanceOf(StorageIntegrityError);

    const oversized = adapter(
      vi.fn(async () => new Response("", { status: 200, headers: { "content-length": "65" } })) as typeof fetch,
      { maxObjectBytes: 64 }
    );
    await expect(oversized.getStream("oversized")).rejects.toBeInstanceOf(StorageObjectTooLargeError);
  });

  it("uses bounded authenticated object metadata when a valid streamed GET is chunked", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/object/info/")) {
        return new Response(JSON.stringify({ size: BODY.length }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(Uint8Array.from(BODY), { status: 200 });
    });
    const fetchImplementation = fetchMock as typeof fetch;
    const downloaded = await adapter(fetchImplementation).getStream("chunked");

    expect(downloaded.size).toBe(BODY.length);
    expect(await collect(downloaded.stream)).toEqual(BODY);
    expect(fetchMock.mock.calls.map(([url]) => String(url).includes("/object/info/"))).toEqual([false, true]);
  });

  it("times out and cancels a stalled chunked object-metadata body", async () => {
    const metadataCancel = vi.fn();
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/object/info/")) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from(Buffer.from("{")));
          },
          cancel: metadataCancel
        }), { status: 200 });
      }
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    }) as typeof fetch;

    await expect(adapter(fetchImplementation, { timeoutMs: 250 }).getStream("stalled-metadata"))
      .rejects.toBeInstanceOf(StorageProviderUnavailableError);
    await vi.waitFor(() => expect(metadataCancel).toHaveBeenCalledOnce());
  });

  it("aborts and cancels the provider body when a download consumer disconnects early", async () => {
    let requestSignal: AbortSignal | null = null;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from(Buffer.from("partial")));
      },
      cancel
    });
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return new Response(body, {
        status: 200,
        headers: { "content-length": "64" }
      });
    }) as typeof fetch;
    const downloaded = await adapter(fetchImplementation).getStream("early-disconnect");

    downloaded.stream.destroy();

    await vi.waitFor(() => {
      expect(requestSignal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
    });
  });

  it("normalizes 404 existence/delete and maps provider timeout without exposing credentials", async () => {
    const missingFetch = vi.fn(async () => new Response("", { status: 404 })) as typeof fetch;
    const missing = adapter(missingFetch);
    await expect(missing.exists("missing")).resolves.toBe(false);
    await expect(missing.delete("missing")).resolves.toBe(false);

    const timeoutFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true });
      })) as typeof fetch;
    const timeout = adapter(timeoutFetch, { timeoutMs: 250 });
    const error = await rejected(timeout.exists("timeout"));
    expect(error).toBeInstanceOf(StorageProviderUnavailableError);
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(String((error as Error).message)).not.toContain(BUCKET);
  });

  it("maps logical trash keys below the domain-owned trash prefix and rejects traversal", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain(`/storage/v1/object/${BUCKET}/trash/uploads/${id}`);
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const storage = adapter(fetchImplementation);
    await expect(storage.exists(`trash/${id}`)).resolves.toBe(true);
    await expect(storage.exists("../reports/object")).rejects.toThrow("storage key is invalid");
    await expect(storage.exists("trash/not-a-uuid")).rejects.toThrow("provider rejected");
  });

  it("rejects a body above maxBytes before making any provider request", async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch;
    await expect(adapter(fetchImplementation).put({ key: "bounded", body: BODY, maxBytes: 3 }))
      .rejects.toBeInstanceOf(StorageObjectTooLargeError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("cancels status-only success, conflict, and error response bodies without reading them", async () => {
    const putSuccessCancel = vi.fn();
    const putSuccess = adapter(vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await collectRequestBody(init?.body);
      return statusResponse(200, putSuccessCancel);
    }) as typeof fetch);
    await putSuccess.put({ key: "status-success", body: BODY, expectedHashSha256: HASH });
    expect(putSuccessCancel).toHaveBeenCalledOnce();

    const conflictCancel = vi.fn();
    const conflictFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        await collectRequestBody(init.body);
        return statusResponse(409, conflictCancel);
      }
      return objectResponse(BODY);
    }) as typeof fetch;
    await adapter(conflictFetch).put({ key: "status-conflict", body: BODY, expectedHashSha256: HASH });
    expect(conflictCancel).toHaveBeenCalledOnce();

    const errorCancel = vi.fn();
    const errorStorage = adapter(vi.fn(async () => statusResponse(503, errorCancel)) as typeof fetch);
    await expect(errorStorage.getStream("status-error")).rejects.toBeInstanceOf(StorageProviderUnavailableError);
    expect(errorCancel).toHaveBeenCalledOnce();
  });
});

function adapter(
  fetchImplementation: typeof fetch,
  overrides: Partial<{ timeoutMs: number; maxObjectBytes: number }> = {}
) {
  return new SupabaseFileStorage({
    supabaseUrl: "https://synthetic.supabase.co",
    secretKey: SECRET,
    bucket: BUCKET,
    domain: "uploads",
    timeoutMs: overrides.timeoutMs ?? 1_000,
    maxObjectBytes: overrides.maxObjectBytes ?? 1_024,
    fetchImplementation
  });
}

function objectResponse(body: Buffer) {
  return new Response(Uint8Array.from(body), {
    status: 200,
    headers: { "content-length": String(body.length) }
  });
}

function statusResponse(status: number, cancel: () => void) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1));
    },
    cancel
  }), {
    status,
    headers: { "content-length": "1" }
  });
}

async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function collectRequestBody(body: BodyInit | null | undefined) {
  if (!body) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Readable) return collect(body);
  return Buffer.from(await new Response(body).arrayBuffer());
}

async function rejected(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}
