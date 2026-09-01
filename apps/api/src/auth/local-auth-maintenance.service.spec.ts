import { describe, expect, it, vi } from "vitest";
import { LocalAuthMaintenanceService } from "./local-auth-maintenance.service";

describe("LocalAuthMaintenanceService", () => {
  it("prunes only expired or terminal local security state while leaving the append-only audit ledger untouched", async () => {
    const calls: unknown[] = [];
    const model = () => ({ deleteMany: vi.fn((input) => { calls.push(input); return input; }) });
    const prisma = {
      appAuthSession: model(), localAccountSetupToken: model(), securityRateLimitBucket: model(), localEdgeRequestNonce: model(),
      $transaction: vi.fn(async (operations) => operations)
    };
    const service = new LocalAuthMaintenanceService(prisma as never, { provider: "local" } as never);
    await service.prune(new Date("2026-08-26T00:00:00.000Z"));
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls)).not.toContain("securityAuditEvent");
  });

  it("does not schedule or call local pruning under Supabase cloud Auth", async () => {
    vi.useFakeTimers();
    try {
      const deleteMany = vi.fn();
      const prisma = {
        appAuthSession: { deleteMany },
        localAccountSetupToken: { deleteMany },
        securityRateLimitBucket: { deleteMany },
        localEdgeRequestNonce: { deleteMany },
        $transaction: vi.fn()
      };
      const service = new LocalAuthMaintenanceService(
        prisma as never,
        { provider: "supabase" } as never
      );

      service.onModuleInit();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1_000);
      await service.prune();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(deleteMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
