import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { loadScheduledCheckpoint, saveScheduledCheckpoint } from "../../../apps/api/src/daily-sync/scheduled-checkpoint";

test("encrypted checkpoint survives process boundary; auth tag and account binding prevent replay", async () => {
  const previous = process.env.DAILY_SYNC_CHECKPOINT_KEY_B64;
  process.env.DAILY_SYNC_CHECKPOINT_KEY_B64 = randomBytes(32).toString("base64");
  try {
    let stored: any; let attempts: any; let live = true;
    const tx: any = { $queryRaw: async () => live ? [{ generation: 7n }] : [],
      syncRun: { findUnique: async () => ({ status: "RUNNING", deadlineAt: new Date(Date.now() + 60_000) }), update: async () => {} },
      runUnit: { update: async (input: any) => { attempts = input.data; } },
      $executeRaw: async (sql: any) => { const values = sql.values;
        stored = { ciphertext: values[2], iv: values[3], auth_tag: values[4], expires_at: new Date(Date.now() + 60_000) }; } };
    const prisma: any = { $transaction: async (fn: any) => fn(tx), $queryRaw: async () => [stored] };
    const claim: any = { runId: "run", connectionId: "connection", generation: 7n };
    const state: any = { version: 1, day: "2026-10-11", connectionId: "connection", stage: "LIST_FIRST", privateMarker: "synthetic sensitive marker" };
    await saveScheduledCheckpoint(prisma, claim, state.day, state);
    assert.equal(stored.ciphertext.includes(Buffer.from(state.privateMarker)), false);
    assert.equal(attempts.status, "QUEUED"); assert.equal(attempts.attempts, 0);
    assert.deepEqual(await loadScheduledCheckpoint(prisma, claim, state.day), state);
    await assert.rejects(loadScheduledCheckpoint(prisma, { ...claim, connectionId: "foreign" }, state.day));
    stored.auth_tag[0] ^= 1; await assert.rejects(loadScheduledCheckpoint(prisma, claim, state.day));
    stored.auth_tag[0] ^= 1; stored.expires_at = new Date(0);
    await assert.rejects(loadScheduledCheckpoint(prisma, claim, state.day));
    live = false; await assert.rejects(saveScheduledCheckpoint(prisma, claim, state.day, state));
  } finally { if (previous === undefined) delete process.env.DAILY_SYNC_CHECKPOINT_KEY_B64; else process.env.DAILY_SYNC_CHECKPOINT_KEY_B64 = previous; }
});
test("checkpoint encryption refuses credential and internal probe key reuse", async () => {
  const previous = { ...process.env }; const synthetic = randomBytes(32).toString("base64");
  process.env.DAILY_SYNC_CHECKPOINT_KEY_B64 = synthetic;
  try {
    const prisma: any = { $queryRaw: async () => [{ ciphertext: Buffer.alloc(2), iv: Buffer.alloc(12), auth_tag: Buffer.alloc(16), expires_at: new Date(Date.now() + 60_000) }] };
    for (const name of ["DAILY_SYNC_CREDENTIAL_KEY_V2", "INTERNAL_PROBE_TOKEN", "AUTH_CSRF_SECRET"]) {
      process.env[name] = synthetic;
      await assert.rejects(loadScheduledCheckpoint(prisma, { runId: "run", connectionId: "connection" } as any, "day"));
      delete process.env[name];
    }
  } finally { process.env = previous; }
});
