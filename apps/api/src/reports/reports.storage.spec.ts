import { NotFoundException, ServiceUnavailableException, StreamableFile } from "@nestjs/common";
import { ReportType } from "@prisma/client";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileStorage } from "../storage/local-file-storage";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReportsService durable storage", () => {
  it("does not create a CREATING row when configured storage has no approved adapter", async () => {
    const create = vi.fn();
    const service = new ReportsService(
      { reportExport: { create } } as never,
      {} as never,
      config({ STORAGE_PROVIDER: "unapproved" })
    );

    await expect(service.export(exportBody(), ACTOR_ID)).rejects.toThrow("approved adapter");
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the deterministic storage reference with CREATING and moves rendering failures to FAILED", async () => {
    const updates: Array<Record<string, unknown>> = [];
    let createdData: Record<string, unknown> | undefined;
    const reportExport = {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdData = data;
        return { ...reportRow(), ...data };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...reportRow(), ...data };
      })
    };
    const service = new ReportsService(
      { reportExport, decisionLog: { findMany: vi.fn(async () => []) } } as never,
      failingMetrics() as never,
      config()
    );

    await expect(service.export(exportBody(), ACTOR_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(createdData).toMatchObject({ status: "CREATING", createdBy: ACTOR_ID });
    expect(createdData?.filePath).toMatch(/^local:\d{4}\/\d{2}\/[0-9a-f-]{36}\.html$/);
    expect(updates.at(-1)).toEqual({ status: "FAILED", fileHashSha256: null });
  });

  it("keeps the payload and returns success when CREATED committed but its acknowledgement was lost", async () => {
    const harness = reportCommitAmbiguityHarness("COMMITTED");

    const result = await harness.service.export(exportBody(), ACTOR_ID);
    expect(result).toMatchObject({
      status: "CREATED",
      fileHashSha256: harness.expectedHash
    });
    expect(harness.storage.getStream).toHaveBeenCalledOnce();
    expect(harness.storage.delete).not.toHaveBeenCalled();
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  it("confirms FAILED after a rolled-back CREATED update before deleting the payload once", async () => {
    const events: string[] = [];
    const harness = reportCommitAmbiguityHarness("ROLLED_BACK", events);

    const error = await rejected(harness.service.export(exportBody(), ACTOR_ID));
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ code: "REPORT_STORAGE_UNAVAILABLE" });
    expect(events).toEqual(["put", "created-update-error", "read-creating", "mark-failed", "read-failed", "delete"]);
    expect(harness.storage.delete).toHaveBeenCalledOnce();
    expect(harness.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "CREATING", fileHashSha256: null }),
      data: { status: "FAILED", fileHashSha256: null }
    }));
  });

  it("re-reads FAILED and cleans once when the FAILED transition acknowledgement is also lost", async () => {
    const events: string[] = [];
    const harness = reportCommitAmbiguityHarness("ROLLED_BACK", events, { failedTransitionAckLost: true });

    const error = await rejected(harness.service.export(exportBody(), ACTOR_ID));
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(events).toEqual(["put", "created-update-error", "read-creating", "mark-failed", "read-failed", "delete"]);
    expect(harness.updateMany).toHaveBeenCalledOnce();
    expect(harness.storage.delete).toHaveBeenCalledOnce();
  });

  it("preserves the payload when the fresh reconciliation read is unavailable", async () => {
    const harness = reportCommitAmbiguityHarness("UNAVAILABLE");

    const error = await rejected(harness.service.export(exportBody(), ACTOR_ID));
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ code: "REPORT_STORAGE_UNAVAILABLE" });
    expect(harness.storage.delete).not.toHaveBeenCalled();
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  it("does not accept or clean up a CREATED row until the stored byte size and hash match", async () => {
    const harness = reportCommitAmbiguityHarness("COMMITTED", [], { reportedSizeDelta: 1 });

    const error = await rejected(harness.service.export(exportBody(), ACTOR_ID));
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(harness.storage.getStream).toHaveBeenCalledOnce();
    expect(harness.storage.delete).not.toHaveBeenCalled();
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  it("streams a contained legacy local report without buffering it into the service", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    const stored = await storage.put({ key: "2026/08/legacy-report.html", body: Buffer.from("legacy report") });
    const report = {
      ...reportRow(),
      status: "CREATED",
      fileHashSha256: stored.hash,
      filePath: path.join(root, ...stored.key.split("/"))
    };
    const service = new ReportsService(
      { reportExport: { findUnique: vi.fn(async () => report) } } as never,
      {} as never,
      config({ REPORT_STORAGE_DIR: root })
    );

    const download = await service.download(REPORT_ID);
    expect(download.size).toBe(Buffer.byteLength("legacy report"));
    expect(await collect(download.stream)).toBe("legacy report");
  });

  it("fails a third concurrent spool closed and releases the shared lease on stream close", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    const body = Buffer.from("budgeted report");
    const stored = await storage.put({ key: "2026/08/budgeted.html", body });
    const report = {
      ...reportRow(),
      status: "CREATED",
      fileHashSha256: stored.hash,
      filePath: `local:${stored.key}`
    };
    const service = new ReportsService(
      { reportExport: { findUnique: vi.fn(async () => report) } } as never,
      {} as never,
      config({ REPORT_STORAGE_DIR: root, TEMP_STORAGE_BUDGET_BYTES: "100" })
    );

    const first = await service.download(REPORT_ID);
    const second = await service.download(REPORT_ID);
    const saturated = await rejected(service.download(REPORT_ID));
    expect(saturated).toBeInstanceOf(ServiceUnavailableException);
    expect((saturated as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "REPORT_STORAGE_UNAVAILABLE"
    });

    await Promise.all([destroyAndWait(first.stream), destroyAndWait(second.stream)]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const retry = await service.download(REPORT_ID);
    expect(await collect(retry.stream)).toBe(body.toString("utf8"));
  });

  it("destroys a slow report stream at the absolute lifetime and releases its lease", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    const body = Buffer.from("slow report");
    const stored = await storage.put({ key: "2026/08/slow.html", body });
    const report = {
      ...reportRow(),
      status: "CREATED",
      fileHashSha256: stored.hash,
      filePath: `local:${stored.key}`
    };
    const service = new ReportsService(
      { reportExport: { findUnique: vi.fn(async () => report) } } as never,
      {} as never,
      config({
        REPORT_STORAGE_DIR: root,
        TEMP_STORAGE_BUDGET_BYTES: "100",
        REPORT_DOWNLOAD_MAX_LIFETIME_MS: "1000"
      })
    );

    vi.useFakeTimers();
    const download = await service.download(REPORT_ID);
    const failed = new Promise<Error>((resolve) => download.stream.once("error", resolve));
    const closed = new Promise<void>((resolve) => download.stream.once("close", () => resolve()));
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(failed).resolves.toBeInstanceOf(Error);
    await closed;
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const retry = await service.download(REPORT_ID);
    expect(await collect(retry.stream)).toBe(body.toString("utf8"));
  });

  it("refuses a same-size corrupted report before publishing response bytes", async () => {
    const root = await temporaryRoot();
    const expected = Buffer.from("expected-report");
    const corrupted = Buffer.from("corruptd-report");
    const stored = await new LocalFileStorage(root).put({
      key: "2026/08/corrupt.html",
      body: corrupted
    });
    const report = {
      ...reportRow(),
      status: "CREATED",
      filePath: `local:${stored.key}`,
      fileHashSha256: createHash("sha256").update(expected).digest("hex")
    };
    const service = new ReportsService(
      { reportExport: { findUnique: vi.fn(async () => report) } } as never,
      {} as never,
      config({ REPORT_STORAGE_DIR: root })
    );

    const error = await rejected(service.download(REPORT_ID));
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "REPORT_STORAGE_INTEGRITY_FAILED"
    });
  });

  it("rejects a legacy report path outside the configured report root", async () => {
    const root = await temporaryRoot();
    const report = { ...reportRow(), status: "CREATED", filePath: path.resolve(root, "..", "outside.html") };
    const service = new ReportsService(
      { reportExport: { findUnique: vi.fn(async () => report) } } as never,
      {} as never,
      config({ REPORT_STORAGE_DIR: root })
    );

    await expect(service.download(REPORT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("omits internal storage references from report list queries", async () => {
    const findMany = vi.fn(async (_args: { select: Record<string, boolean> }) => []);
    const service = new ReportsService(
      { reportExport: { findMany } } as never,
      {} as never,
      config()
    );

    await service.list();
    expect(findMany.mock.calls[0]?.[0].select).not.toHaveProperty("filePath");
  });
});

describe("ReportsController download headers", () => {
  it("returns a StreamableFile with bounded server-generated attachment headers", async () => {
    const stream = Readable.from("report");
    const controller = new ReportsController({
      download: vi.fn(async () => ({
        stream,
        size: 6,
        contentType: "text/html; charset=utf-8",
        filename: "DAILY_HTML-2026-08-01-2026-08-02.html"
      }))
    } as never);
    const headers = new Map<string, string>();
    const response = { setHeader: (key: string, value: string) => headers.set(key, value) };

    const result = await controller.download({ id: REPORT_ID }, response as never);
    expect(result).toBeInstanceOf(StreamableFile);
    expect(headers.get("Content-Disposition")).toMatch(/^attachment; filename=/);
    expect(headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

function exportBody() {
  return { reportType: "DAILY_HTML", from: "2026-08-01", to: "2026-08-02", parameters: {} };
}

function reportRow() {
  return {
    id: REPORT_ID,
    reportType: ReportType.DAILY_HTML,
    periodStart: new Date("2026-08-01T00:00:00.000Z"),
    periodEnd: new Date("2026-08-02T00:00:00.000Z"),
    filePath: null,
    status: "CREATING"
  };
}

function config(overrides: Record<string, string> = {}) {
  const values = {
    STORAGE_PROVIDER: "local",
    UPLOAD_STORAGE_DIR: "./storage/security-dev/uploads",
    REPORT_STORAGE_DIR: "./storage/security-dev/reports",
    ...overrides
  };
  return { get: (key: string) => values[key as keyof typeof values] } as never;
}

function failingMetrics() {
  const failure = async () => { throw new Error("render failure"); };
  return {
    dashboardSummary: failure,
    productMetrics: failure,
    adsetMetrics: failure,
    unmatchedMetrics: failure
  };
}

function safeMetrics() {
  return {
    dashboardSummary: async () => ({
      totals: { spendUsd: 0, spendKrw: 0, purchaseCount: 0, cpaKrw: 0, revenueKrw: 0, marginKrw: 0 },
      health: { unmatchedCount: 0, missingCostRuleCount: 0, missingCpaRuleCount: 0 }
    }),
    productMetrics: async () => [],
    adsetMetrics: async () => [],
    unmatchedMetrics: async () => []
  };
}

function reportCommitAmbiguityHarness(
  outcome: "COMMITTED" | "ROLLED_BACK" | "UNAVAILABLE",
  events: string[] = [],
  options: { reportedSizeDelta?: number; failedTransitionAckLost?: boolean } = {}
) {
  let createdData: Record<string, unknown> = {};
  let databaseStatus: "CREATING" | "CREATED" | "FAILED" = "CREATING";
  let storedBody = Buffer.alloc(0);
  let storedHash = "";

  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (data.status === "CREATED") {
      if (outcome === "COMMITTED") databaseStatus = "CREATED";
      events.push("created-update-error");
      throw new Error("final DB acknowledgement unavailable");
    }
    return { ...reportRow(), ...createdData, ...data };
  });
  const findUnique = vi.fn(async () => {
    if (outcome === "UNAVAILABLE") throw new Error("fresh DB read unavailable");
    events.push(databaseStatus === "CREATING" ? "read-creating" : databaseStatus === "FAILED" ? "read-failed" : "read-created");
    return {
      ...reportRow(),
      ...createdData,
      status: databaseStatus,
      fileHashSha256: databaseStatus === "CREATED" ? storedHash : null
    };
  });
  const updateMany = vi.fn(async () => {
    events.push("mark-failed");
    databaseStatus = "FAILED";
    if (options.failedTransitionAckLost) throw new Error("FAILED transition acknowledgement unavailable");
    return { count: 1 };
  });
  const storage = {
    provider: "local",
    put: vi.fn(async ({ key, body }: { key: string; body: Buffer }) => {
      events.push("put");
      storedBody = Buffer.from(body);
      storedHash = createHash("sha256").update(storedBody).digest("hex");
      return { key, hash: storedHash, size: storedBody.length };
    }),
    delete: vi.fn(async () => {
      events.push("delete");
      return true;
    }),
    getStream: vi.fn(async () => ({
      stream: Readable.from(storedBody),
      size: storedBody.length + (options.reportedSizeDelta ?? 0)
    })),
    exists: vi.fn()
  };
  const service = new ReportsService(
    {
      reportExport: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          createdData = data;
          return { ...reportRow(), ...data };
        }),
        update,
        updateMany,
        findUnique
      },
      decisionLog: { findMany: vi.fn(async () => []) }
    } as never,
    safeMetrics() as never,
    config()
  );
  (service as unknown as { fileStorage: typeof storage }).fileStorage = storage;
  return {
    service,
    storage,
    updateMany,
    findUnique,
    get expectedHash() { return storedHash; }
  };
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "report-storage-"));
  roots.push(root);
  return root;
}

async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function destroyAndWait(stream: Readable) {
  const closed = new Promise<void>((resolve) => stream.once("close", () => resolve()));
  stream.destroy();
  await closed;
}

async function rejected(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}
