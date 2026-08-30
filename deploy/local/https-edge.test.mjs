import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createBodyIdleWatchdog, createBodyTransferBudget, createLocalHttpsEdge, runtimeConfigIdentityMatches, takePerClientToken } from "./https-edge.mjs";

test("edge refuses the shipped loopback-only configuration before reading certificates", () => {
  const config = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8"));
  assert.throws(() => createLocalHttpsEdge(config), /SUPABASE_DATABASE_CONFIG_INVALID|LAN_NOT_READY/);
});

test("request-body idle watchdog is cleared when upload input ends", async () => {
  let timedOut = false;
  const watchdog = createBodyIdleWatchdog(() => { timedOut = true; }, 20);
  watchdog.activity();
  await new Promise((resolve) => setTimeout(resolve, 10));
  watchdog.complete();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timedOut, false, "upstream computation may exceed the body idle timeout after input completes");
});

test("request-body idle watchdog aborts a stalled upload", async () => {
  let timedOut = false;
  const watchdog = createBodyIdleWatchdog(() => { timedOut = true; }, 15);
  watchdog.activity();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timedOut, true);
});

test("request-body transfer budget rejects an upload below the minimum sustained rate", async () => {
  let exceeded = false;
  const budget = createBodyTransferBudget(
    () => { exceeded = true; },
    { deadlineMs: 100, graceMs: 5, sampleMs: 5, minimumBytesPerSecond: 10_000 }
  );
  budget.activity(Buffer.from("x"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(exceeded, true);
});

test("request-body transfer budget clears both deadline and sampler on completion", async () => {
  let exceeded = false;
  const budget = createBodyTransferBudget(
    () => { exceeded = true; },
    { deadlineMs: 20, graceMs: 5, sampleMs: 5, minimumBytesPerSecond: 1 }
  );
  budget.activity(Buffer.alloc(1024));
  budget.complete();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(exceeded, false);
});

test("per-client limiter is cardinality-bounded and only reclaims stale entries", () => {
  const buckets = new Map();
  assert.equal(takePerClientToken(buckets, "192.168.1.1", 1, 2, { now: 1_000, maximumEntries: 2, staleAfterMs: 1_000 }), true);
  assert.equal(takePerClientToken(buckets, "192.168.1.2", 1, 2, { now: 1_000, maximumEntries: 2, staleAfterMs: 1_000 }), true);
  assert.equal(takePerClientToken(buckets, "192.168.1.3", 1, 2, { now: 1_500, maximumEntries: 2, staleAfterMs: 1_000 }), false);
  assert.equal(buckets.size, 2);
  assert.equal(takePerClientToken(buckets, "192.168.1.3", 1, 2, { now: 2_001, maximumEntries: 2, staleAfterMs: 1_000 }), true);
  assert.equal(buckets.size, 1);
});

test("running edge rejects any runtime-config byte or identity drift until restart", () => {
  const raw = { version: 3, database: { host: "db.example" }, release: { id: "r1" }, backup: { root: "x" } };
  const frozen = JSON.stringify(raw);
  const sha = "a".repeat(64);
  assert.equal(runtimeConfigIdentityMatches(frozen, sha, structuredClone(raw), sha), true);
  assert.equal(runtimeConfigIdentityMatches(frozen, sha, { ...raw, database: { host: "changed" } }, sha), false);
  assert.equal(runtimeConfigIdentityMatches(frozen, sha, raw, "b".repeat(64)), false);
});
