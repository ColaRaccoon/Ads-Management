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
});

function makeHealth(database: ReturnType<typeof vi.fn>, readinessTimeoutMs = 1_000) {
  return new HealthService(
    { $queryRaw: database } as never,
    {
      supabaseUrl: "https://ehnfrrmbkvlsbpvqcvkr.supabase.co",
      supabasePublishableKey: "publishable-test-key"
    } as never,
    { readinessTimeoutMs } as never
  );
}
