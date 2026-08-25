import { NotFoundException, ServiceUnavailableException, StreamableFile } from "@nestjs/common";
import { ReportType } from "@prisma/client";
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

  it("cleans a stored report and retains a FAILED reference when the final DB update fails", async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(new Error("final DB failure"))
      .mockResolvedValueOnce({ status: "FAILED" });
    const storage = {
      provider: "local",
      put: vi.fn(async ({ key }: { key: string }) => ({ key, hash: "a".repeat(64), size: 10 })),
      delete: vi.fn(async () => true),
      getStream: vi.fn(),
      exists: vi.fn()
    };
    const service = new ReportsService(
      {
        reportExport: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...reportRow(), ...data })),
          update
        },
        decisionLog: { findMany: vi.fn(async () => []) }
      } as never,
      safeMetrics() as never,
      config()
    );
    (service as unknown as { fileStorage: typeof storage }).fileStorage = storage;

    await expect(service.export(exportBody(), ACTOR_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(storage.put).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { status: "FAILED", fileHashSha256: null } }));
  });

  it("streams a contained legacy local report without buffering it into the service", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    const stored = await storage.put({ key: "2026/08/legacy-report.html", body: Buffer.from("legacy report") });
    const report = {
      ...reportRow(),
      status: "CREATED",
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
