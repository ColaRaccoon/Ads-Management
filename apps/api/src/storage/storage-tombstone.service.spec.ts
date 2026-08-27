import { StorageTombstoneDomain, StorageTombstoneState } from "@prisma/client";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileStorage } from "./local-file-storage";
import { StorageTombstoneService } from "./storage-tombstone.service";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const BODY = Buffer.from("synthetic tombstone body", "utf8");
const HASH = createHash("sha256").update(BODY).digest("hex");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("StorageTombstoneService", () => {
  it("logically deletes, restores, and explicitly purges only the server-owned object keys", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    await storage.put({ key: "active/meta", body: BODY, expectedHashSha256: HASH });
    const harness = prismaHarness();
    const service = new StorageTombstoneService(harness.prisma as never, config(root));

    const retained = await service.retain({
      domain: StorageTombstoneDomain.META_UPLOAD,
      businessRecordId: BUSINESS_ID,
      reference: "local:active/meta",
      expectedHashSha256: HASH,
      actorUserId: ACTOR_ID
    });
    expect(retained.state).toBe(StorageTombstoneState.RETAINED);
    expect(await storage.exists("active/meta")).toBe(false);
    expect(await storage.exists(`trash/${retained.tombstoneId}`)).toBe(true);

    const restored = await service.restore(retained.tombstoneId, ACTOR_ID);
    expect(restored.state).toBe(StorageTombstoneState.RESTORED);
    expect(await storage.exists("active/meta")).toBe(true);
    expect(await storage.exists(`trash/${retained.tombstoneId}`)).toBe(false);
    await expect(service.restore(retained.tombstoneId, ACTOR_ID)).resolves.toMatchObject({
      state: StorageTombstoneState.RESTORED
    });

    await storage.delete("active/meta");
    harness.row!.state = StorageTombstoneState.RETAINED;
    await storage.put({ key: `trash/${retained.tombstoneId}`, body: BODY, expectedHashSha256: HASH });
    await expect(service.purge(retained.tombstoneId, undefined, false)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "STORAGE_PURGE_NOT_DUE" })
    });
    await expect(service.purge(retained.tombstoneId, ACTOR_ID, true)).resolves.toMatchObject({
      state: StorageTombstoneState.PURGED
    });
    expect(await storage.exists(`trash/${retained.tombstoneId}`)).toBe(false);
  });

  it("recovers idempotently when storage retention succeeds before the DB finalize update fails", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    await storage.put({ key: "active/retry", body: BODY, expectedHashSha256: HASH });
    const harness = prismaHarness({ failRetainedUpdateOnce: true });
    const service = new StorageTombstoneService(harness.prisma as never, config(root));
    const input = {
      domain: StorageTombstoneDomain.META_UPLOAD,
      businessRecordId: BUSINESS_ID,
      reference: "local:active/retry",
      expectedHashSha256: HASH
    };

    await expect(service.retain(input)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "STORAGE_RETENTION_RETRY_REQUIRED" })
    });
    expect(harness.row?.state).toBe(StorageTombstoneState.FAILED);
    expect(await storage.exists("active/retry")).toBe(false);
    expect(await storage.exists(`trash/${harness.row!.id}`)).toBe(true);

    await expect(service.retain(input)).resolves.toMatchObject({ state: StorageTombstoneState.RETAINED });
    expect(harness.row?.state).toBe(StorageTombstoneState.RETAINED);
  });

  it("rejects hash/provider confusion and leaves the active object untouched", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    await storage.put({ key: "active/mismatch", body: BODY, expectedHashSha256: HASH });
    const harness = prismaHarness();
    const service = new StorageTombstoneService(harness.prisma as never, config(root));

    await expect(service.retain({
      domain: StorageTombstoneDomain.META_UPLOAD,
      businessRecordId: BUSINESS_ID,
      reference: "local:active/mismatch",
      expectedHashSha256: "0".repeat(64)
    })).rejects.toThrow("integrity check");
    expect(await storage.exists("active/mismatch")).toBe(true);
    expect(harness.row).toBeNull();
  });

  it("keeps retention maintenance dry-run by default", async () => {
    const root = await temporaryRoot();
    const harness = prismaHarness();
    const service = new StorageTombstoneService(harness.prisma as never, config(root));
    harness.dueIds.push("33333333-3333-4333-8333-333333333333");

    await expect(service.purgeExpired({ execute: false })).resolves.toEqual({
      candidateCount: 1,
      purgedCount: 0,
      dryRun: true
    });
    expect(harness.findMany).toHaveBeenCalledOnce();
  });

  it("does not purge the retained last copy while its Meta upload business record is active", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    await storage.put({ key: "active/commit-unknown", body: BODY, expectedHashSha256: HASH });
    const harness = prismaHarness({ activeMetaUpload: true });
    const service = new StorageTombstoneService(harness.prisma as never, config(root));
    const retained = await service.retain({
      domain: StorageTombstoneDomain.META_UPLOAD,
      businessRecordId: BUSINESS_ID,
      reference: "local:active/commit-unknown",
      expectedHashSha256: HASH
    });

    await expect(service.purge(retained.tombstoneId, ACTOR_ID, true)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "STORAGE_PURGE_BUSINESS_RECORD_ACTIVE" })
    });
    expect(await storage.exists(`trash/${retained.tombstoneId}`)).toBe(true);
  });

  it("purges a verified active object after restore storage succeeds but DB finalization rolls back", async () => {
    const root = await temporaryRoot();
    const storage = new LocalFileStorage(root);
    await storage.put({ key: "active/partial-restore", body: BODY, expectedHashSha256: HASH });
    const harness = prismaHarness({ failRestoreFinalizeOnce: true });
    const service = new StorageTombstoneService(harness.prisma as never, config(root));
    const retained = await service.retain({
      domain: StorageTombstoneDomain.META_UPLOAD,
      businessRecordId: BUSINESS_ID,
      reference: "local:active/partial-restore",
      expectedHashSha256: HASH
    });

    await expect(service.restore(retained.tombstoneId)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "STORAGE_RESTORE_RETRY_REQUIRED" })
    });
    expect(harness.row?.state).toBe(StorageTombstoneState.RETAINED);
    expect(await storage.exists("active/partial-restore")).toBe(true);
    expect(await storage.exists(`trash/${retained.tombstoneId}`)).toBe(false);

    await expect(service.purge(retained.tombstoneId, ACTOR_ID, true)).resolves.toMatchObject({
      state: StorageTombstoneState.PURGED
    });
    expect(await storage.exists("active/partial-restore")).toBe(false);
    expect(await storage.exists(`trash/${retained.tombstoneId}`)).toBe(false);
  });
});

function prismaHarness(options: {
  failRetainedUpdateOnce?: boolean;
  failRestoreFinalizeOnce?: boolean;
  activeMetaUpload?: boolean;
} = {}) {
  let row: Record<string, any> | null = null;
  let failRetainedUpdateOnce = options.failRetainedUpdateOnce ?? false;
  let failRestoreFinalizeOnce = options.failRestoreFinalizeOnce ?? false;
  const dueIds: string[] = [];
  const update = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    if (!row || row.id !== where.id) throw new Error("tombstone missing");
    if (data.state === StorageTombstoneState.RETAINED && failRetainedUpdateOnce) {
      failRetainedUpdateOnce = false;
      throw new Error("synthetic DB finalize failure");
    }
    row = { ...row, ...data, updatedAt: new Date() };
    return row;
  });
  const findMany = vi.fn(async () => dueIds.map((id) => ({ id })));
  const updateMany = vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, unknown> }) => {
    if (!row || (where.id && row.id !== where.id)) return { count: 0 };
    const allowedStates = where.state?.in ?? (where.state ? [where.state] : null);
    if (allowedStates && !allowedStates.includes(row.state)) return { count: 0 };
    row = { ...row, ...data, updatedAt: new Date() };
    return { count: 1 };
  });
  const storageTombstone = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, any> }) => {
      if (!row) return null;
      if (where.id) return row.id === where.id ? row : null;
      const compound = where.domain_businessRecordId;
      return compound?.domain === row.domain && compound?.businessRecordId === row.businessRecordId ? row : null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
      row = {
        ...data,
        restoredAt: null,
        purgedAt: null,
        failureCode: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      return row;
    }),
    update,
    updateMany,
    findMany
  };
  const securityAuditEvent = { create: vi.fn(async ({ data }: { data: unknown }) => data) };
  const tx = {
    storageTombstone,
    securityAuditEvent,
    uploadBatch: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        options.activeMetaUpload && where.id === BUSINESS_ID ? { id: BUSINESS_ID } : null
      )
    },
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [])
  };
  const prisma = {
    storageTombstone,
    securityAuditEvent,
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      const before = row ? { ...row } : null;
      const result = await callback(tx);
      if (failRestoreFinalizeOnce && row?.state === StorageTombstoneState.RESTORED) {
        failRestoreFinalizeOnce = false;
        row = before;
        throw new Error("synthetic restore transaction commit failure");
      }
      return result;
    })
  };
  return {
    prisma,
    dueIds,
    findMany,
    get row() { return row; }
  };
}

function config(root: string) {
  const values: Record<string, string> = {
    STORAGE_PROVIDER: "local",
    UPLOAD_STORAGE_DIR: root,
    REPORT_STORAGE_DIR: path.join(root, "reports"),
    SUPABASE_STORAGE_RETENTION_DAYS: "30"
  };
  return { get: (key: string) => values[key] } as never;
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "storage-tombstone-"));
  roots.push(root);
  return root;
}
