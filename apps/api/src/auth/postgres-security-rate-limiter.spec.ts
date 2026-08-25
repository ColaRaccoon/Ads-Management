import { describe, expect, it, vi } from "vitest";
import { PostgresSecurityRateLimiter } from "./postgres-security-rate-limiter";

describe("PostgresSecurityRateLimiter", () => {
  it("returns the atomic database decision and persists only a SHA-256 key", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ count: 1, retryAfterSeconds: 60 }])
      .mockResolvedValueOnce([{ count: 2, retryAfterSeconds: 59 }]);
    const limiter = new PostgresSecurityRateLimiter({
      $queryRaw: query,
      securityRateLimitBucket: { deleteMany: vi.fn() }
    } as never);

    await expect(limiter.consume("sensitive-account@example.test", 1, 60_000)).resolves.toEqual({
      allowed: true,
      limit: 1,
      remaining: 0,
      retryAfterSeconds: 60
    });
    await expect(limiter.consume("sensitive-account@example.test", 1, 60_000)).resolves.toEqual({
      allowed: false,
      limit: 1,
      remaining: 0,
      retryAfterSeconds: 59
    });
    expect(JSON.stringify(query.mock.calls)).not.toContain("sensitive-account@example.test");
    expect(JSON.stringify(query.mock.calls)).toMatch(/[0-9a-f]{64}/);
  });

  it("rejects unsafe policies before querying the shared store", async () => {
    const query = vi.fn();
    const limiter = new PostgresSecurityRateLimiter({ $queryRaw: query } as never);
    await expect(limiter.consume("key", 0, 60_000)).rejects.toThrow("limit is out of range");
    await expect(limiter.consume("key", 1, 999)).rejects.toThrow("window is out of range");
    expect(query).not.toHaveBeenCalled();
  });
});
