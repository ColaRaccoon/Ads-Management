import { PrismaClient, StorageTombstoneDomain, StorageTombstoneState } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorage } from "./local-file-storage";
import { StorageTombstoneService } from "./storage-tombstone.service";

const integrationDescribe = integrationEnabled() ? describe : describe.skip;

integrationDescribe("storage tombstone PostgreSQL lifecycle", () => {
  let prisma: PrismaClient;
  let root: string;
  const businessRecordId = randomUUID();
  const transitionBusinessRecordId = randomUUID();
  const body = Buffer.from("synthetic postgres storage lifecycle", "utf8");
  const hash = createHash("sha256").update(body).digest("hex");

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    root = await mkdtemp(path.join(tmpdir(), "storage-postgres-integration-"));
  });

  afterAll(async () => {
    try {
      await prisma.storageTombstone.deleteMany({
        where: {
          domain: StorageTombstoneDomain.META_UPLOAD,
          businessRecordId: { in: [businessRecordId, transitionBusinessRecordId] }
        }
      });
      await rm(root, { recursive: true, force: true });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("fences concurrent logical-delete retries and restores the exact object", async () => {
    const storage = new LocalFileStorage(root);
    await storage.put({ key: "active/object", body, expectedHashSha256: hash });
    const config = {
      get: (key: string) => ({
        STORAGE_PROVIDER: "local",
        UPLOAD_STORAGE_DIR: root,
        REPORT_STORAGE_DIR: path.join(root, "reports"),
        SUPABASE_STORAGE_RETENTION_DAYS: "30"
      })[key as "STORAGE_PROVIDER"]
    };
    const first = new StorageTombstoneService(prisma as never, config as never);
    const second = new StorageTombstoneService(prisma as never, config as never);
    const input = {
      domain: StorageTombstoneDomain.META_UPLOAD,
      businessRecordId,
      reference: "local:active/object",
      expectedHashSha256: hash
    };

    const results = await Promise.all([first.retain(input), second.retain(input)]);
    expect(new Set(results.map(({ tombstoneId }) => tombstoneId)).size).toBe(1);
    expect(results.every(({ state }) => state === StorageTombstoneState.RETAINED)).toBe(true);
    expect(await storage.exists("active/object")).toBe(false);
    expect(await storage.exists(`trash/${results[0].tombstoneId}`)).toBe(true);

    await first.restore(results[0].tombstoneId);
    const restored = await storage.getStream("active/object");
    const restoredHash = createHash("sha256");
    for await (const chunk of restored.stream) restoredHash.update(chunk);
    expect(restoredHash.digest("hex")).toBe(hash);
    expect(await storage.exists(`trash/${results[0].tombstoneId}`)).toBe(false);
  });

  it("serializes concurrent restore and force-purge into one coherent terminal state", async () => {
    const storage = new LocalFileStorage(root);
    await storage.put({ key: "active/transition-race", body, expectedHashSha256: hash });
    const config = {
      get: (key: string) => ({
        STORAGE_PROVIDER: "local",
        UPLOAD_STORAGE_DIR: root,
        REPORT_STORAGE_DIR: path.join(root, "reports"),
        SUPABASE_STORAGE_RETENTION_DAYS: "30"
      })[key as "STORAGE_PROVIDER"]
    };
    const first = new StorageTombstoneService(prisma as never, config as never);
    const second = new StorageTombstoneService(prisma as never, config as never);
    const retained = await first.retain({
      domain: StorageTombstoneDomain.META_UPLOAD,
      businessRecordId: transitionBusinessRecordId,
      reference: "local:active/transition-race",
      expectedHashSha256: hash
    });

    const outcomes = await Promise.allSettled([
      first.restore(retained.tombstoneId),
      second.purge(retained.tombstoneId, undefined, true)
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const row = await prisma.storageTombstone.findUniqueOrThrow({ where: { id: retained.tombstoneId } });
    expect([StorageTombstoneState.RESTORED, StorageTombstoneState.PURGED]).toContain(row.state);
    expect(await storage.exists(`trash/${retained.tombstoneId}`)).toBe(false);
    expect(await storage.exists("active/transition-race")).toBe(row.state === StorageTombstoneState.RESTORED);
  });
});

function integrationEnabled() {
  if (process.env.RUN_STORAGE_DB_INTEGRATION !== "true") return false;
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required for storage integration tests.");
  const target = new URL(raw);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55432" ||
    target.pathname !== "/meta_ads_security_dev" ||
    target.searchParams.get("schema") !== "meta_ads_security_dev"
  ) {
    throw new Error("Storage integration tests require the isolated local security dev database.");
  }
  return true;
}
