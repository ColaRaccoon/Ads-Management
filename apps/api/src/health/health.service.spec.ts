import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthService } from "./health.service";

afterEach(() => vi.unstubAllGlobals());

describe("HealthService", () => {
  it("requires both the database and identity provider while returning no internals", async () => {
    const database = vi.fn().mockResolvedValue([{ ok: 1 }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const health = makeHealth(database);
    await expect(health.assertReady()).resolves.toBeUndefined();
    expect(database).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://ehnfrrmbkvlsbpvqcvkr.supabase.co/auth/v1/health",
      expect.objectContaining({ headers: { apikey: "publishable-test-key" } })
    );
  });

  it("fails closed with a stable minimal 503 when a dependency is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503 })));
    await expect(makeHealth(vi.fn().mockResolvedValue([{ ok: 1 }])).assertReady())
      .rejects.toMatchObject({
        status: 503,
        response: { code: "SERVICE_NOT_READY", message: "Service is not ready.", details: null }
      });
  });

  it("bounds a database probe that never settles with the overall readiness deadline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const health = makeHealth(vi.fn(() => new Promise(() => undefined)), 10);
    const started = Date.now();
    await expect(health.assertReady()).rejects.toMatchObject({ status: 503 });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("reuses one in-flight database probe after a deadline instead of consuming the pool", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const database = vi.fn(() => new Promise(() => undefined));
    const health = makeHealth(database, 10);
    await expect(health.assertReady()).rejects.toMatchObject({ status: 503 });
    await expect(health.assertReady()).rejects.toMatchObject({ status: 503 });
    expect(database).toHaveBeenCalledTimes(1);
  });

  it("fails readiness before a scoped Storage credential expires", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const health = makeHealth(vi.fn().mockResolvedValue([{ ok: 1 }]), 1_000, Date.now() + 299_000);
    await expect(health.assertReady()).rejects.toMatchObject({ status: 503 });
  });

  it("requires the private Storage sentinel when the scoped provider is active", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const health = makeHealth(
      vi.fn().mockResolvedValue([{ ok: 1 }]),
      1_000,
      Date.now() + 86_400_000,
      "health/readiness-sentinel"
    );
    await expect(health.assertReady()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://ehnfrrmbkvlsbpvqcvkr.supabase.co/storage/v1/object/private-bucket/health/readiness-sentinel",
      expect.objectContaining({
        method: "HEAD",
        headers: {
          apikey: "publishable-test-key",
          authorization: "Bearer scoped-storage-token"
        }
      })
    );
  });
});

function makeHealth(
  database: ReturnType<typeof vi.fn>,
  readinessTimeoutMs = 1_000,
  storageCredentialExpiresAtMs: number | null = null,
  storageReadinessKey: string | null = null
) {
  const transaction = vi.fn(async (
    callback: (client: { $queryRaw: (query: unknown) => Promise<unknown> }) => Promise<unknown>,
    options: { maxWait: number; timeout: number }
  ) => {
    expect(options).toEqual({
      maxWait: Math.max(1, readinessTimeoutMs - 1),
      timeout: Math.max(1, readinessTimeoutMs - 1)
    });
    return callback({
      $queryRaw: (query: unknown) => {
        const sql = (query as { strings?: string[] }).strings?.join("?") ?? "";
        if (sql.includes("set_config('statement_timeout'")) {
          return Promise.resolve([{ set_config: String(Math.max(1, readinessTimeoutMs - 1)) }]);
        }
        return database();
      }
    });
  });
  return new HealthService(
    { $transaction: transaction } as never,
    {
      supabaseUrl: "https://ehnfrrmbkvlsbpvqcvkr.supabase.co",
      supabasePublishableKey: "publishable-test-key"
    } as never,
    {
      readinessTimeoutMs,
      databaseReadinessTimeoutMs: Math.max(1, readinessTimeoutMs - 1),
      storageCredentialExpiresAtMs,
      storageReadinessKey
    } as never,
    { get: (key: string) => ({
      SUPABASE_STORAGE_BUCKET: "private-bucket",
      SUPABASE_STORAGE_ACCESS_TOKEN: "scoped-storage-token"
    })[key as "SUPABASE_STORAGE_BUCKET" | "SUPABASE_STORAGE_ACCESS_TOKEN"] } as never
  );
}
