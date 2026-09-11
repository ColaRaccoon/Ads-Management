import { describe, expect, it } from "vitest";
import { ConflictPolicy } from "@prisma/client";
import { CAFE24_ORDER_REQUIRED_COLUMNS } from "../domain/cafe24-csv";
import { Cafe24UploadsService } from "./cafe24-uploads.service";

function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, i) => [
    `20260910-${i}`, `20260910-${i}-01`, "10000", "P1", "Test product", "Test option", "1", "10000", "card", "2026-09-10 10:00:00"
  ]);
  return { originalname: "test.csv", buffer: Buffer.from([CAFE24_ORDER_REQUIRED_COLUMNS, ...rows].map(row => row.map(v => `"${v}"`).join(",")).join("\n")) } as Express.Multer.File;
}

function harness(existing = false, failInsert = false) {
  const lines: any[] = [], errors: any[] = [];
  let calls = 0, updates: any[] = [], singleWrites = 0, batch: any = {};
  const tx = {
    cafe24OrderLine: {
      count: async () => { calls++; return existing ? 1 : 0; },
      findMany: async () => { calls++; return [{ id: "old", importVersion: 1 }]; },
      create: async ({ data }: any) => { calls++; singleWrites++; const line = { ...data, id: `line-${singleWrites}` }; lines.push(line); return line; },
      createMany: async ({ data }: any) => { calls++; if (failInsert) throw Error("insert failed"); lines.push(...data); return { count: data.length }; }
    },
    cafe24UploadRowError: { createMany: async ({ data }: any) => { calls++; errors.push(...data); return { count: data.length }; } },
    cafe24UploadBatch: { update: async ({ data }: any) => { calls++; updates.push(data); batch = { ...batch, ...data }; return batch; } }
  };
  const db = {
    cafe24UploadBatch: { findMany: async () => [], findUnique: async () => null, create: async ({ data }: any) => (batch = { ...data, id: "batch" }), update: tx.cafe24UploadBatch.update },
    cafe24ProductRule: { findMany: async () => [] },
    cafe24UploadRowError: { create: async ({ data }: any) => { errors.push(data); }, count: async ({ where }: any) => errors.filter(e => e.severity === where.severity).length },
    cafe24OrderLine: { count: async () => lines.length },
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      try { return await fn(tx); } catch (error) { lines.length = 0; errors.length = 0; throw error; }
    }
  };
  const service = new Cafe24UploadsService(db as never, { ensureUsdKrwRatesForDates: async () => new Map() } as never);
  return { service, lines, errors, updates, calls: () => calls, singleWrites: () => singleWrites };
}

describe("Cafe24 remote database import", () => {
  it("stores 405 distinct new order rows and linked warnings in bounded database calls", async () => {
    const h = harness();
    const result = await h.service.importCafe24Csv(fixture(405), ConflictPolicy.SKIP, "actor");
    expect(result).toMatchObject({ status: "IMPORTED", rowCount: 405, validRowCount: 405 });
    expect(h.lines).toHaveLength(405);
    expect(h.calls()).toBeLessThanOrEqual(12);
    expect(h.singleWrites()).toBe(0);
    const ids = new Set(h.lines.map(line => line.id));
    expect(ids.size).toBe(405);
    expect(h.errors.every(error => ids.has(error.orderLineId))).toBe(true);
    expect(h.lines.every(line => line.isCurrent && line.importVersion === 1)).toBe(true);
  });

  it("keeps the existing SKIP version policy when current keys already exist", async () => {
    const h = harness(true);
    await h.service.importCafe24Csv(fixture(1), ConflictPolicy.SKIP, "actor");
    expect(h.singleWrites()).toBe(1);
    expect(h.lines[0]).toMatchObject({ isCurrent: false, importVersion: 1 });
  });

  it("does not mark a batch imported when a bulk insert fails", async () => {
    const h = harness(false, true);
    await expect(h.service.importCafe24Csv(fixture(405), ConflictPolicy.SKIP, "actor")).rejects.toThrow("insert failed");
    expect(h.lines).toHaveLength(0);
    expect(h.updates.at(-1)).toMatchObject({ status: "FAILED", importedAt: null });
  });
});
