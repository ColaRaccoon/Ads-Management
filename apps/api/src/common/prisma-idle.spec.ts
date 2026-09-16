import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaIdlePool, resolvePrismaIdleDisconnectMs } from "./prisma-idle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Prisma pool idle lifecycle", () => {
  it("defaults off and strictly validates explicit opt-in", () => {
    for (const value of [undefined, "", "0"]) expect(resolvePrismaIdleDisconnectMs(value)).toBe(0);
    expect(resolvePrismaIdleDisconnectMs("60000")).toBe(60000);
    for (const value of ["999", "300001", "-1", "1e3", "Infinity", "1000.5", "abc"]) {
      expect(() => resolvePrismaIdleDisconnectMs(value)).toThrow("PRISMA_IDLE_DISCONNECT_MS");
    }
  });

  it("never polls while unused and closes only once after completed work", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const pool = new PrismaIdlePool(1000, disconnect);
    await vi.advanceTimersByTimeAsync(10000);
    expect(disconnect).not.toHaveBeenCalled();
    await pool.run(async () => 42);
    await vi.advanceTimersByTimeAsync(999);
    expect(disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10001);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule any automatic disconnect when disabled", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const pool = new PrismaIdlePool(0, disconnect);
    await pool.run(async () => 42);
    await vi.advanceTimersByTimeAsync(600000);
    expect(disconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await pool.shutdown();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps all concurrent active queries safe and restarts the full idle window", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const pool = new PrismaIdlePool(1000, disconnect);
    const first = deferred<number>();
    const second = deferred<number>();
    const a = pool.run(() => first.promise);
    const b = pool.run(() => second.promise);
    first.resolve(1);
    await a;
    await vi.advanceTimersByTimeAsync(10000);
    expect(disconnect).not.toHaveBeenCalled();
    second.resolve(2);
    await b;
    await vi.advanceTimersByTimeAsync(900);
    await pool.run(async () => 3);
    await vi.advanceTimersByTimeAsync(900);
    expect(disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("protects interactive transaction gaps between nested middleware queries", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const pool = new PrismaIdlePool(1000, disconnect);
    const gap = deferred<void>();
    const transaction = pool.run(async () => {
      await pool.run(async () => "BEGIN and first query");
      await gap.promise;
      return pool.run(async () => "second query and COMMIT");
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(disconnect).not.toHaveBeenCalled();
    gap.resolve();
    await expect(transaction).resolves.toBe("second query and COMMIT");
    await vi.advanceTimersByTimeAsync(1000);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("serializes new work behind an ongoing close (close fails=%s)", async (fails) => {
    const closing = deferred<void>();
    const disconnect = vi.fn().mockReturnValueOnce(closing.promise).mockResolvedValue(undefined);
    const onError = vi.fn();
    const pool = new PrismaIdlePool(1000, disconnect, onError);
    await pool.run(async () => 1);
    await vi.advanceTimersByTimeAsync(1000);
    const query = vi.fn().mockResolvedValue(2);
    const a = pool.run(query);
    const b = pool.run(query);
    expect(query).not.toHaveBeenCalled();
    if (fails) closing.reject(new Error("disconnect failed"));
    else closing.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual([2, 2]);
    expect(onError).toHaveBeenCalledTimes(fails ? 1 : 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("releases failed queries and retries a failed idle close without polling forever", async () => {
    const disconnect = vi.fn().mockRejectedValueOnce(new Error("close failed")).mockResolvedValue(undefined);
    const onError = vi.fn();
    const pool = new PrismaIdlePool(1000, disconnect, onError);
    await expect(pool.run(async () => { throw new Error("query failed"); })).rejects.toThrow("query failed");
    await vi.advanceTimersByTimeAsync(10000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shutdown drains the transaction, permits its nested query, and never rearms", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const pool = new PrismaIdlePool(1000, disconnect);
    const gap = deferred<void>();
    const transaction = pool.run(async () => {
      await gap.promise;
      return pool.run(async () => 42);
    });
    const shutdown = pool.shutdown();
    await vi.advanceTimersByTimeAsync(10000);
    expect(disconnect).not.toHaveBeenCalled();
    gap.resolve();
    await expect(transaction).resolves.toBe(42);
    await shutdown;
    await expect(pool.run(async () => 0)).rejects.toThrow("PRISMA_SERVICE_STOPPING");
    await vi.advanceTimersByTimeAsync(10000);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shutdown waits for an idle close already in flight without starting another", async () => {
    const closing = deferred<void>();
    const disconnect = vi.fn().mockReturnValue(closing.promise);
    const pool = new PrismaIdlePool(1000, disconnect);
    await pool.run(async () => 42);
    await vi.advanceTimersByTimeAsync(1000);
    const shutdown = pool.shutdown();
    closing.resolve();
    await shutdown;
    await vi.advanceTimersByTimeAsync(10000);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
