import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { cafe24ObservationEpochKey, type Cafe24ObservationEpochScope } from "../../../apps/api/src/daily-sync/cafe24-observation-epoch";

// Synthetic key material only. No process.env mutation, provider, SQL or private input.
const connection = "74ac848b-91d9-42d1-af6b-96d764720980";
const otherConnection = "6c92e4f6-5e39-48fe-91d0-0577f5ff48b1";
const day = "2026-10-16";
function fixture() {
  const scope: Cafe24ObservationEpochScope = { connectionId: connection, keyVersion: 2,
    epochReference: "ff7081d0-a9d0-4bf6-af1f-33647675891c",
    epochStartedAt: new Date("2026-10-19T00:00:00.000Z"),
    baselineApprovalSha256: "a".repeat(64), sourceClosureSha256: "b".repeat(64),
    approvedDay: day, explicitManualDay: true };
  const env: NodeJS.ProcessEnv = {
    DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED: "false",
    DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION: "2",
    DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64: randomBytes(32).toString("base64"),
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_CONNECTION_ID: connection,
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_REFERENCE: scope.epochReference,
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_STARTED_AT: scope.epochStartedAt.toISOString(),
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_APPROVAL_SHA256: scope.baselineApprovalSha256,
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_SOURCE_SHA256: scope.sourceClosureSha256,
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_APPROVED_DAY: day,
  };
  return { scope, env };
}
function denied(action: () => unknown) {
  assert.throws(action, (error: unknown) => !!error && typeof error === "object" &&
    "safeCode" in error && error.safeCode === "FIELD_UNSUPPORTED");
}

test("approved epoch derives a distinct scoped key while preserving the input key", () => {
  const { scope, env } = fixture();
  const base = env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64!;
  const result = cafe24ObservationEpochKey(connection, day, scope, env);
  try {
    assert.equal(result.version, 2);
    assert.equal(result.key.length, 32);
    assert.notEqual(result.key.toString("base64"), base);
    assert.equal(env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64, base);
    assert.match(result.metadata.keyCommitment, /^[a-f0-9]{64}$/);
    assert.match(result.metadata.keyIdentityCommitment, /^[a-f0-9]{64}$/);
    assert.notEqual(result.metadata.epochStartedAt, scope.epochStartedAt);
  } finally { result.key.fill(0); }
});

test("a matching argument and scope cannot redirect the trusted connection approval", () => {
  const { scope, env } = fixture();
  denied(() => cafe24ObservationEpochKey(otherConnection, day,
    { ...scope, connectionId: otherConnection }, env));
});

test("each trusted approval field is mandatory and the quarantine flag remains authoritative", () => {
  const { scope, env } = fixture();
  for (const name of ["CONNECTION_ID", "REFERENCE", "STARTED_AT", "APPROVAL_SHA256", "SOURCE_SHA256", "APPROVED_DAY"]) {
    const copy = { ...env }; delete copy[`DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_${name}`];
    denied(() => cafe24ObservationEpochKey(connection, day, scope, copy));
  }
  denied(() => cafe24ObservationEpochKey(connection, day, scope,
    { ...env, DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED: "true" }));
  denied(() => cafe24ObservationEpochKey(connection, day,
    { ...scope, explicitManualDay: false } as unknown as Cafe24ObservationEpochScope, env));
});

test("future genesis, incomplete day and V1 capabilities fail closed", () => {
  const { scope, env } = fixture();
  const future = new Date(Date.now() + 86_400_000);
  denied(() => cafe24ObservationEpochKey(connection, day, { ...scope, epochStartedAt: future },
    { ...env, DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_STARTED_AT: future.toISOString() }));
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  denied(() => cafe24ObservationEpochKey(connection, tomorrow, { ...scope, approvedDay: tomorrow },
    { ...env, DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_APPROVED_DAY: tomorrow }));
  denied(() => cafe24ObservationEpochKey(connection, day, { ...scope, keyVersion: 1 },
    { ...env, DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION: "1" }));
});

test("credential and checkpoint key reuse cannot become an epoch key", () => {
  const { scope, env } = fixture();
  for (const name of ["DAILY_SYNC_CREDENTIAL_KEY_V2", "DAILY_SYNC_CHECKPOINT_KEY_B64"]) {
    denied(() => cafe24ObservationEpochKey(connection, day, scope,
      { ...env, [name]: env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64 }));
  }
});

test("key identity is stable across version labels but epoch-derived keys are separated", () => {
  const { scope, env } = fixture();
  const first = cafe24ObservationEpochKey(connection, day, scope, env);
  const nextScope = { ...scope, keyVersion: 3,
    epochReference: "a3cafbfe-6eac-4a74-b1e2-55f867d9c33d" };
  const second = cafe24ObservationEpochKey(connection, day, nextScope,
    { ...env, DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION: "3",
      DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_REFERENCE: nextScope.epochReference });
  try {
    assert.equal(first.metadata.keyIdentityCommitment, second.metadata.keyIdentityCommitment);
    assert.notEqual(first.metadata.keyCommitment, second.metadata.keyCommitment);
    assert.notDeepEqual(first.key, second.key);
  } finally { first.key.fill(0); second.key.fill(0); }
});
