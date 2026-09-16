import { ConfigService } from "@nestjs/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportsService } from "./reports.service";
import { ReportReconciliationStateService } from "./report-reconciliation-state.service";

const clean = { scanned: 0, created: 0, failed: 0, unresolved: 0 };
const pending = { ...clean, unresolved: 1 };
const body = { reportType: "DAILY_HTML", from: "2026-09-01", to: "2026-09-02" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function harness(reportExport: object = {}, gate?: object) {
  const findMany = vi.fn().mockResolvedValue([]);
  const state = new ReportReconciliationStateService();
  const service = new ReportsService(
    { reportExport: { findMany, ...reportExport } } as never,
    {} as never,
    new ConfigService({ STORAGE_PROVIDER: "local" }),
    state,
    gate as never
  );
  return { service, state, findMany };
}

describe("report reconciliation idle scheduling", () => {
  it("scans on startup and generates no subsequent idle DB queries", async () => {
    const { service, state, findMany } = harness();
    await service.onApplicationBootstrap();
    expect(() => state.assertReady()).not.toThrow();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries unresolved work and DB failures, then stops after recovery", async () => {
    const { service, state } = harness();
    const scan = vi.spyOn(service, "reconcileStaleCreatingReports")
      .mockResolvedValueOnce(pending)
      .mockRejectedValueOnce(new Error("DB unavailable"))
      .mockResolvedValue(clean);
    await service.onApplicationBootstrap();
    expect(() => state.assertReady()).toThrow("REPORT_RECONCILIATION_PENDING");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(() => state.assertReady()).toThrow("REPORT_RECONCILIATION_PENDING");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(() => state.assertReady()).not.toThrow();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(scan).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a busy heavy-operation gate without claiming startup readiness", async () => {
    const release = vi.fn();
    const gate = { tryAcquire: vi.fn().mockReturnValueOnce(null).mockReturnValue({ release }) };
    const { service, state, findMany } = harness({}, gate);
    await service.onApplicationBootstrap();
    expect(findMany).not.toHaveBeenCalled();
    expect(() => state.assertReady()).toThrow("REPORT_RECONCILIATION_PENDING");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(() => state.assertReady()).not.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["create", "render"])("rearms after an uncertain %s failure and retains work through the stale grace", async (failure) => {
    let createdAt: Date | undefined;
    let status = "CREATING";
    const row = { id: "report-id", filePath: null };
    const create = vi.fn(async () => {
      createdAt = new Date();
      if (failure === "create") throw new Error("lost create acknowledgement");
      return row;
    });
    let writesUnavailable = true;
    const updateMany = vi.fn(async () => {
      if (writesUnavailable) throw new Error("DB unavailable");
      status = "FAILED";
      return { count: 1 };
    });
    const { service, findMany } = harness({
      create, updateMany, findUnique: vi.fn(async () => ({ ...row, status }))
    });
    findMany.mockImplementation(async ({ where }: { where: { createdAt: { lt: Date } } }) =>
      createdAt && createdAt < where.createdAt.lt && status === "CREATING" ? [row] : []
    );
    await service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(service.export(body, "actor-id")).rejects.toThrow();
    writesUnavailable = false;
    updateMany.mockClear();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(updateMany).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(status).toBe("FAILED");
    expect(updateMany).toHaveBeenCalledTimes(1);
    const scans = findMany.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(findMany).toHaveBeenCalledTimes(scans);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not lose a newer failure arriving during a reconciliation scan", async () => {
    const { service } = harness({ create: vi.fn().mockRejectedValue(new Error("lost ACK")) });
    const scan = vi.spyOn(service, "reconcileStaleCreatingReports").mockResolvedValue(clean);
    await service.onApplicationBootstrap();
    await expect(service.export(body, "actor-id")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    let finish!: (value: typeof clean) => void;
    scan.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(service.export(body, "actor-id")).rejects.toThrow();
    finish(clean);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(scan.mock.calls.at(-1)?.[0]?.getTime()).toBeGreaterThan(new Date("2026-09-16T00:06:00Z").getTime());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels retries on shutdown and cannot rearm from an in-flight failure", async () => {
    const { service } = harness();
    let fail!: (error: Error) => void;
    vi.spyOn(service, "reconcileStaleCreatingReports").mockImplementation(
      () => new Promise((_resolve, reject) => { fail = reject; })
    );
    const starting = service.onApplicationBootstrap();
    const stopping = service.onModuleDestroy();
    fail(new Error("DB unavailable"));
    await Promise.all([starting, stopping]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.reconcileStaleCreatingReports).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an already queued retry when the module shuts down", async () => {
    const { service } = harness();
    const scan = vi.spyOn(service, "reconcileStaleCreatingReports").mockResolvedValue(pending);
    await service.onApplicationBootstrap();
    expect(vi.getTimerCount()).toBe(1);
    await service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
