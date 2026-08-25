import { ConfigService } from "@nestjs/config";
import { PrismaClient, StorageTombstoneDomain } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { configuredFileStorage } from "./configured-file-storage";
import { StorageTombstoneService } from "./storage-tombstone.service";

const APPROVED_DEVELOPMENT_HOST = "ehnfrrmbkvlsbpvqcvkr.supabase.co";
let verificationStage = "startup-boundary";
let providerFailureCode: string | undefined;

async function main() {
  const startedAt = Date.now();
  assertLocalDatabase(process.env.DATABASE_URL);
  const supabaseUrl = required("SUPABASE_URL");
  const parsedSupabaseUrl = new URL(supabaseUrl);
  if (parsedSupabaseUrl.hostname !== APPROVED_DEVELOPMENT_HOST) {
    throw new Error("The Supabase project is outside the approved development boundary.");
  }
  if ((process.env.STORAGE_PROVIDER ?? "").trim().toLowerCase() !== "supabase") {
    throw new Error("STORAGE_PROVIDER must be supabase for the live verification.");
  }
  const secret = required("SUPABASE_SECRET_KEY");
  const bucket = required("SUPABASE_STORAGE_BUCKET");
  const maxObjectBytes = Number(process.env.SUPABASE_STORAGE_MAX_OBJECT_BYTES ?? "52428800");
  const client = createClient(supabaseUrl, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  verificationStage = "bucket-read";
  const existingBucket = await client.storage.getBucket(bucket);
  if (existingBucket.error) {
    providerFailureCode = safeErrorCode(existingBucket.error);
    if (providerFailureCode !== "HTTP_404" && providerFailureCode !== "HTTP_400") {
      throw existingBucket.error;
    }
    verificationStage = "bucket-create";
    const created = await client.storage.createBucket(bucket, {
      public: false,
      fileSizeLimit: maxObjectBytes
    });
    if (created.error) {
      providerFailureCode = safeErrorCode(created.error);
      throw created.error;
    }
    providerFailureCode = undefined;
  } else if (existingBucket.data.public) {
    throw new Error("The approved development bucket is public.");
  }
  verificationStage = "bucket-confirm-private";
  const confirmedBucket = await client.storage.getBucket(bucket);
  if (confirmedBucket.error || confirmedBucket.data.public) {
    throw new Error("The development bucket private setting could not be confirmed.");
  }

  const prisma = new PrismaClient();
  const config = new ConfigService(process.env);
  const storage = configuredFileStorage(config, "uploads");
  const tombstones = new StorageTombstoneService(prisma as never, config);
  const objectId = randomUUID();
  const businessRecordId = randomUUID();
  const key = `synthetic/${objectId}`;
  const body = randomBytes(4_096);
  const hash = createHash("sha256").update(body).digest("hex");
  let tombstoneId: string | undefined;
  try {
    verificationStage = "synthetic-put";
    await storage.put({ key, body, expectedHashSha256: hash, maxBytes: body.length });
    verificationStage = "public-access-denial";
    const publicResponse = await fetch(
      `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/uploads/synthetic/${objectId}`,
      { cache: "no-store" }
    );
    if (publicResponse.ok) throw new Error("The synthetic object was publicly accessible.");
    verificationStage = "application-soft-delete";
    const retained = await tombstones.retain({
      domain: StorageTombstoneDomain.META_UPLOAD,
      businessRecordId,
      reference: `supabase:${key}`,
      expectedHashSha256: hash
    });
    tombstoneId = retained.tombstoneId;
    if (await storage.exists(key)) throw new Error("The active object remained after logical deletion.");
    if (!(await storage.exists(`trash/${retained.tombstoneId}`))) {
      throw new Error("The retained synthetic object is missing.");
    }
    verificationStage = "application-restore";
    await tombstones.restore(retained.tombstoneId);
    if (await storage.exists(`trash/${retained.tombstoneId}`)) {
      throw new Error("The trash object remained after restoration.");
    }
    verificationStage = "restored-hash";
    const restored = await storage.getStream(key);
    const restoredHash = createHash("sha256");
    let restoredBytes = 0;
    for await (const chunk of restored.stream) {
      restoredBytes += chunk.length;
      restoredHash.update(chunk);
    }
    if (restoredBytes !== body.length || restoredHash.digest("hex") !== hash) {
      throw new Error("The restored synthetic object failed verification.");
    }
    verificationStage = "synthetic-cleanup";
    await storage.delete(key);
    if (await storage.exists(key)) throw new Error("The synthetic active object cleanup did not complete.");
    await prisma.storageTombstone.delete({ where: { id: retained.tombstoneId } });
    if (await prisma.storageTombstone.count({ where: { id: retained.tombstoneId } }) !== 0) {
      throw new Error("The synthetic tombstone cleanup did not complete.");
    }
    tombstoneId = undefined;
    process.stdout.write(`${JSON.stringify({
      result: "PASS",
      bytes: body.length,
      elapsedMs: Date.now() - startedAt,
      bucketPrivate: true,
      applicationSoftDeleteRestore: true,
      hashMatch: true
    })}\n`);
  } finally {
    await storage.delete(key).catch(() => undefined);
    if (tombstoneId) {
      await storage.delete(`trash/${tombstoneId}`).catch(() => undefined);
      await prisma.storageTombstone.deleteMany({
        where: { id: tombstoneId, businessRecordId }
      }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

function required(key: string) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function assertLocalDatabase(value: string | undefined) {
  if (!value) throw new Error("DATABASE_URL is required.");
  const url = new URL(value);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55432" ||
    url.pathname.replace(/^\//, "") !== "meta_ads_security_dev" ||
    url.searchParams.get("schema") !== "meta_ads_security_dev"
  ) {
    throw new Error("Live Storage verification is restricted to the loopback development database.");
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    result: "FAIL",
    stage: verificationStage,
    errorCode: providerFailureCode ?? safeErrorCode(error)
  })}\n`);
  process.exitCode = 1;
});

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const candidate = error as { name?: unknown; status?: unknown; statusCode?: unknown };
  const status = candidate.statusCode ?? candidate.status;
  if (typeof status === "number" && Number.isInteger(status)) return `HTTP_${status}`;
  if (typeof status === "string" && /^\d{3}$/.test(status)) return `HTTP_${status}`;
  if (typeof candidate.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(candidate.name)) {
    return candidate.name.toUpperCase();
  }
  return "PROTECTED_ERROR";
}
