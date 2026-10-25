import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { ClaimedRun } from "./sync-foundation.service";
import { syncError } from "./sync-contract";
import { Cafe24ChunkState } from "./cafe24-scheduled-chunk";

const MAX_BYTES = 16 * 1024 * 1024;
function key() {
  const value = process.env.DAILY_SYNC_CHECKPOINT_KEY_B64 ?? "";
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== 32 || buffer.toString("base64") !== value ||
      Object.entries(process.env).filter(([name]) => /^DAILY_SYNC_CREDENTIAL_KEY_V\d+$/.test(name) ||
        /^(?:AUTH_.*SECRET|INTERNAL_PROBE_TOKEN|SUPABASE_.*KEY|SUPABASE_STORAGE_ACCESS_TOKEN|DAILY_SYNC_MACHINE_TOKEN(?:_PREVIOUS)?)$/.test(name))
        .some(([, entry]) => entry === value))
    { buffer.fill(0); syncError("CHECKPOINT_CONFIGURATION_REQUIRED"); }
  return buffer;
}
/** Validate before any provider request, including the first chunk with no row. */
export function assertScheduledCheckpointConfigured() { key().fill(0); }
type Row = { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; revision: number; expires_at: Date };
export async function loadScheduledCheckpoint(prisma: PrismaService, claim: ClaimedRun, unitKey: string) {
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT ciphertext, iv, auth_tag, revision, expires_at FROM sync_unit_checkpoints
    WHERE run_id = ${claim.runId}::uuid AND unit_key = ${unitKey}`);
  if (!rows[0]) return null;
  const row = rows[0], material = key();
  try {
    if (row.expires_at <= new Date() || row.ciphertext.length > MAX_BYTES) syncError("RUN_LIMIT_EXCEEDED");
    const cipher = createDecipheriv("aes-256-gcm", material, row.iv);
    cipher.setAAD(Buffer.from(`${claim.connectionId}:${claim.runId}:${unitKey}`)); cipher.setAuthTag(row.auth_tag);
    return JSON.parse(Buffer.concat([cipher.update(row.ciphertext), cipher.final()]).toString("utf8")) as Cafe24ChunkState;
  } catch { return syncError("RECONCILIATION_FAILED"); }
  finally { material.fill(0); }
}
export async function saveScheduledCheckpoint(prisma: PrismaService, claim: ClaimedRun, unitKey: string, state: Cafe24ChunkState) {
  const plaintext = Buffer.from(JSON.stringify(state)), material = key();
  try {
    if (plaintext.length > MAX_BYTES) syncError("RUN_LIMIT_EXCEEDED");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", material, iv);
    cipher.setAAD(Buffer.from(`${claim.connectionId}:${claim.runId}:${unitKey}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]), tag = cipher.getAuthTag();
    return await prisma.$transaction(async (tx) => {
      const fence = await tx.$queryRaw<Array<{ generation: bigint }>>(Prisma.sql`
        SELECT generation FROM sync_leases WHERE connection_id = ${claim.connectionId}::uuid
        AND owner_run_id = ${claim.runId}::uuid AND generation = ${claim.generation}
        AND expires_at > clock_timestamp() FOR UPDATE`);
      if (fence.length !== 1) syncError("LEASE_LOST");
      const run = await tx.syncRun.findUnique({ where: { id: claim.runId } });
      if (!run || run.status !== "RUNNING" || !run.deadlineAt || run.deadlineAt <= new Date()) syncError("LEASE_LOST");
      await tx.$executeRaw(Prisma.sql`INSERT INTO sync_unit_checkpoints
        (run_id, unit_key, ciphertext, iv, auth_tag, expires_at)
        VALUES (${claim.runId}::uuid, ${unitKey}, ${ciphertext}, ${iv}, ${tag}, clock_timestamp() + interval '2 hours')
        ON CONFLICT (run_id, unit_key) DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
        iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, revision = sync_unit_checkpoints.revision + 1`);
      await tx.runUnit.update({ where: { runId_unitKey: { runId: claim.runId, unitKey } },
        data: { status: "QUEUED", attempts: 0, checkpointValue: createHash("sha256").update(ciphertext).digest("hex") } });
      await tx.syncRun.update({ where: { id: claim.runId }, data: { safeErrorCode: null } });
      if (run.deadlineAt <= new Date()) syncError("LEASE_LOST");
    }, { timeout: 5_000, maxWait: 2_000 });
  } finally { material.fill(0); plaintext.fill(0); }
}
export async function removeScheduledCheckpoint(prisma: PrismaService, runId: string, unitKey: string) {
  await prisma.$executeRaw(Prisma.sql`DELETE FROM sync_unit_checkpoints WHERE run_id = ${runId}::uuid AND unit_key = ${unitKey}`);
}
export async function cleanupScheduledCheckpoints(prisma: PrismaService, connectionId: string) {
  // A bounded cleanup on the next account wake; no polling worker is installed.
  await prisma.$executeRaw(Prisma.sql`DELETE FROM sync_unit_checkpoints WHERE (run_id, unit_key) IN (
    SELECT c.run_id,c.unit_key FROM sync_unit_checkpoints c JOIN sync_runs r ON r.id = c.run_id
    WHERE r.connection_id = ${connectionId}::uuid AND c.expires_at <= clock_timestamp() LIMIT 100)`);
}
