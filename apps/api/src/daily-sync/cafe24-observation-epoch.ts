import { createHash, hkdfSync, randomUUID } from "node:crypto";
import { Prisma, type Cafe24ObservedEpochDayCheckpoint, type Cafe24ObservedEpochOrderRevision } from "@prisma/client";
import type { PrismaService } from "../common/prisma.service";
import type { Cafe24OrderPreflightClient } from "./cafe24-order-preflight.client";
import { ProviderFailure } from "./bounded-request";
import { cafe24ObservationHmac, cafe24ObservationKey } from "./cafe24-observed-revision";
import { cafe24TestAllowed } from "./cafe24-test-connection.service";
import { parseIsoDate, syncError } from "./sync-contract";

/** Trusted operator approval, not a request DTO or an automatic catch-up option. */
export interface Cafe24ObservationEpochScope {
  connectionId: string;
  keyVersion: number;
  epochReference: string;
  epochStartedAt: Date;
  baselineApprovalSha256: string;
  sourceClosureSha256: string;
  approvedDay: string;
  explicitManualDay: true;
}
export interface Cafe24ObservationEpochMetadata {
  connectionId: string;
  keyVersion: number;
  epochReference: string;
  epochStartedAt: Date;
  keyCommitment: string;
  keyIdentityCommitment: string;
  baselineApprovalSha256: string;
  sourceClosureSha256: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
function unsupported(): never { throw new ProviderFailure("FIELD_UNSUPPORTED", false); }
function iso(value: Date) { return value.toISOString(); }

/** The commitment uses the independent base key. RAW_ALLOWLIST fingerprints use
 * a distinct epoch-derived key; neither is a canonical writer fingerprint. */
export function cafe24ObservationEpochKey(connectionId: string, day: string,
  scope: Cafe24ObservationEpochScope, env: NodeJS.ProcessEnv = process.env) {
  const orderDate = parseIsoDate(day);
  if (!scope || !UUID.test(connectionId) || scope.connectionId !== connectionId ||
      !UUID.test(scope.epochReference) || scope.explicitManualDay !== true || scope.approvedDay !== day ||
      !Number.isInteger(scope.keyVersion) || scope.keyVersion < 2 || scope.keyVersion > 99 ||
      !(scope.epochStartedAt instanceof Date) || !Number.isFinite(scope.epochStartedAt.getTime()) ||
      scope.epochStartedAt.getTime() > Date.now() || !SHA.test(scope.baselineApprovalSha256) ||
      !SHA.test(scope.sourceClosureSha256) ||
      env.DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_CONNECTION_ID !== connectionId ||
      env.DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_REFERENCE !== scope.epochReference ||
      env.DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_STARTED_AT !== iso(scope.epochStartedAt) ||
      env.DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_APPROVAL_SHA256 !== scope.baselineApprovalSha256 ||
      env.DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_SOURCE_SHA256 !== scope.sourceClosureSha256 ||
      env.DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_APPROVED_DAY !== day ||
      !env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64 ||
      // Only completed, explicit days. No date-range or historical catch-up is inferred.
      orderDate.getTime() + 24 * 60 * 60 * 1000 - 9 * 60 * 60 * 1000 > Date.now()) unsupported();
  const base = cafe24ObservationKey(env); // The existing quarantine flag remains authoritative.
  try {
    if (base.version !== scope.keyVersion) unsupported();
    const keyCommitment = cafe24ObservationHmac(base.key, "CAFE24_EPOCH_KEY_COMMITMENT_V2",
      `${connectionId}\0${base.version}`);
    const metadata: Cafe24ObservationEpochMetadata = { connectionId, keyVersion: base.version,
      epochReference: scope.epochReference, epochStartedAt: new Date(scope.epochStartedAt),
      keyCommitment, keyIdentityCommitment: cafe24ObservationHmac(base.key,
        "CAFE24_EPOCH_KEY_IDENTITY_V2", connectionId), baselineApprovalSha256: scope.baselineApprovalSha256,
      sourceClosureSha256: scope.sourceClosureSha256 };
    const key = Buffer.from(hkdfSync("sha256", base.key,
      Buffer.from("cafe24-raw-observation-epoch-v2"),
      Buffer.from(`${connectionId}\0${base.version}\0${scope.epochReference}\0${iso(scope.epochStartedAt)}`), 32));
    return { version: base.version, key, metadata };
  } finally { base.key.fill(0); }
}

function metadataTuple(m: Cafe24ObservationEpochMetadata) {
  return [m.connectionId, m.keyVersion, m.epochReference, iso(m.epochStartedAt), m.keyCommitment,
    m.keyIdentityCommitment, m.baselineApprovalSha256, m.sourceClosureSha256];
}
export function cafe24EpochRevisionIntegrity(key: Buffer, row: Omit<Cafe24ObservedEpochOrderRevision, "integrityHash">) {
  return cafe24ObservationHmac(key, "EPOCH_REVISION_INTEGRITY_V2", JSON.stringify([
    ...metadataTuple(row), iso(row.orderDate), row.orderKeyHash, row.revision, row.contentHash,
    iso(row.firstObservedAt), iso(row.lastObservedAt), row.observationId, row.isCurrent]));
}
export function cafe24EpochCheckpointIntegrity(key: Buffer, row: Omit<Cafe24ObservedEpochDayCheckpoint, "integrityHash">) {
  return cafe24ObservationHmac(key, "EPOCH_CHECKPOINT_INTEGRITY_V2", JSON.stringify([
    ...metadataTuple(row), iso(row.orderDate), iso(row.queryStartedAt), iso(row.completedAt),
    row.observationId, row.checkpointRevision, row.orderCount, row.itemCount, row.snapshotHash]));
}
function snapshot(key: Buffer, rows: Array<{ orderKeyHash: string; contentHash: string }>) {
  return cafe24ObservationHmac(key, "SNAPSHOT_V1", JSON.stringify(rows
    .map(({ orderKeyHash, contentHash }) => ({ orderKeyHash, contentHash }))
    .sort((a, b) => a.orderKeyHash.localeCompare(b.orderKeyHash))));
}

/** Every positive storage query is epoch-scoped. Version-wide negative metadata
 * checks deliberately detect a reused version/key/epoch on a different day. */
async function epochState(tx: Prisma.TransactionClient, m: Cafe24ObservationEpochMetadata, key: Buffer) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "source_connections" WHERE "id" = ${m.connectionId}::uuid FOR UPDATE`);
  if (locked.length !== 1) syncError("ACCOUNT_SCOPE_MISMATCH");
  const connection = await tx.sourceConnection.findUnique({ where: { id: m.connectionId }, select: {
    provider: true, externalAccountId: true, shopKey: true, currencyCode: true,
    timeZone: true, accessState: true, enabled: true, credentialRef: true,
    credentialExpiresAt: true, updatedAt: true } });
  const isolated = process.env.DAILY_SYNC_FEATURE_ENABLED !== "true" &&
    process.env.DAILY_SYNC_CAFE24_TEST_ENABLED === "true";
  if (!connection || connection.provider !== "CAFE24" ||
      (isolated ? connection.enabled : !connection.enabled) || connection.accessState !== "READY" ||
      connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul" ||
      !cafe24TestAllowed(connection.externalAccountId, connection.shopKey)) syncError("ACCOUNT_SCOPE_MISMATCH");
  if (await tx.syncLease.count({ where: { connectionId: m.connectionId, expiresAt: { gt: new Date() } } }))
    syncError("LEASE_LOST");
  const versionScope = { connectionId: m.connectionId, keyVersion: m.keyVersion };
  const supersededVersion = { connectionId: m.connectionId, keyVersion: { gt: m.keyVersion } };
  if (await tx.cafe24ObservedEpochDayCheckpoint.count({ where: supersededVersion }) ||
      await tx.cafe24ObservedEpochOrderRevision.count({ where: supersededVersion })) unsupported();
  // Reusing a reference for a later key version obscures the comparison boundary.
  const reusedEpoch = { connectionId: m.connectionId, epochReference: m.epochReference,
    keyVersion: { not: m.keyVersion } };
  if (await tx.cafe24ObservedEpochDayCheckpoint.count({ where: reusedEpoch }) ||
      await tx.cafe24ObservedEpochOrderRevision.count({ where: reusedEpoch })) unsupported();
  const renamedKey = { connectionId: m.connectionId, keyVersion: { not: m.keyVersion },
    keyIdentityCommitment: m.keyIdentityCommitment };
  if (await tx.cafe24ObservedEpochDayCheckpoint.count({ where: renamedKey }) ||
      await tx.cafe24ObservedEpochOrderRevision.count({ where: renamedKey })) unsupported();
  const mismatch = { ...versionScope, OR: [
    { epochReference: { not: m.epochReference } }, { epochStartedAt: { not: m.epochStartedAt } },
    { keyCommitment: { not: m.keyCommitment } },
    { keyIdentityCommitment: { not: m.keyIdentityCommitment } },
    { baselineApprovalSha256: { not: m.baselineApprovalSha256 } },
    { sourceClosureSha256: { not: m.sourceClosureSha256 } }] };
  if (await tx.cafe24ObservedEpochDayCheckpoint.count({ where: mismatch }) ||
      await tx.cafe24ObservedEpochOrderRevision.count({ where: mismatch })) unsupported();
  const scope = { ...versionScope, epochReference: m.epochReference };
  const days = await tx.cafe24ObservedEpochDayCheckpoint.findMany({ where: scope,
    orderBy: { orderDate: "asc" }, take: 1001 });
  const revisions = await tx.cafe24ObservedEpochOrderRevision.findMany({ where: scope,
    orderBy: [{ orderDate: "asc" }, { orderKeyHash: "asc" }, { revision: "asc" }], take: 100001 });
  if (days.length > 1000 || revisions.length > 100000) syncError("RUN_LIMIT_EXCEEDED");
  const byDay = new Map(days.map((d) => [iso(d.orderDate), d]));
  const byKey = new Map<string, Cafe24ObservedEpochOrderRevision[]>();
  for (const row of revisions) {
    if (!byDay.has(iso(row.orderDate)) || row.integrityHash !== cafe24EpochRevisionIntegrity(key, row))
      syncError("RECONCILIATION_FAILED");
    const list = byKey.get(row.orderKeyHash) ?? [];
    list.push(row); byKey.set(row.orderKeyHash, list);
  }
  for (const list of byKey.values()) {
    if (list.some((row, index) => row.revision !== index + 1 ||
        iso(row.orderDate) !== iso(list[0].orderDate) || row.isCurrent !== (index === list.length - 1)))
      syncError("RECONCILIATION_FAILED");
  }
  for (const d of days) {
    const current = revisions.filter((r) => r.isCurrent && +r.orderDate === +d.orderDate);
    if (d.integrityHash !== cafe24EpochCheckpointIntegrity(key, d) || current.length !== d.orderCount ||
        snapshot(key, current) !== d.snapshotHash || current.some((r) => +r.lastObservedAt !== +d.queryStartedAt))
      syncError("RECONCILIATION_FAILED");
  }
  return { days, revisions, stateHash: createHash("sha256")
    .update(JSON.stringify([connection, days, revisions])).digest("hex") };
}

/** Explicit typed capability only; no scheduled runner or legacy observe mode
 * invokes it. A baseline severs comparison continuity with all earlier epochs. */
export async function observeCafe24EpochDay(prisma: PrismaService,
  orders: Pick<Cafe24OrderPreflightClient, "readDayObservedRevision">,
  connectionId: string, day: string, scope: Cafe24ObservationEpochScope) {
  const { key, metadata } = cafe24ObservationEpochKey(connectionId, day, scope);
  const options = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 2000, timeout: 60000 };
  try {
    const before = await prisma.$transaction((tx) => epochState(tx, metadata, key), options);
    const observation = await orders.readDayObservedRevision(connectionId, day, scope);
    if (!observation.epoch || JSON.stringify(metadataTuple(observation.epoch)) !== JSON.stringify(metadataTuple(metadata)) ||
        observation.keyVersion !== metadata.keyVersion || observation.day !== day ||
        observation.snapshotComplete !== false || observation.readComplete !== true ||
        !Number.isFinite(+observation.startedAt) || +observation.startedAt < +metadata.epochStartedAt ||
        +observation.startedAt > Date.now() || !Number.isInteger(observation.orderCount) ||
        observation.rows.length !== observation.orderCount || observation.orderCount > 1000 ||
        !Number.isInteger(observation.itemCount) || observation.itemCount < observation.orderCount ||
        observation.rows.some((r) => !SHA.test(r.orderKeyHash) || !SHA.test(r.contentHash)) ||
        new Set(observation.rows.map((r) => r.orderKeyHash)).size !== observation.rows.length ||
        observation.snapshotHash !== snapshot(key, observation.rows)) syncError("RECONCILIATION_FAILED");
    return await prisma.$transaction(async (tx) => {
      // Recheck the approval/env/hold and full state under the final connection lock.
      const active = cafe24ObservationEpochKey(connectionId, day, scope);
      try {
        if (JSON.stringify(metadataTuple(active.metadata)) !== JSON.stringify(metadataTuple(metadata))) unsupported();
      } finally { active.key.fill(0); }
      const state = await epochState(tx, metadata, key);
      if (state.stateHash !== before.stateHash) syncError("LEASE_LOST");
      const orderDate = parseIsoDate(day);
      const checkpoint = state.days.find((d) => +d.orderDate === +orderDate);
      if (checkpoint && +checkpoint.queryStartedAt > +observation.startedAt) syncError("LEASE_LOST");
      const prior = state.revisions.filter((r) => r.isCurrent && +r.orderDate === +orderDate);
      const current = new Map(prior.map((r) => [r.orderKeyHash, r]));
      const next = new Set(observation.rows.map((r) => r.orderKeyHash));
      if (prior.some((r) => !next.has(r.orderKeyHash)) || state.revisions.some((r) =>
        r.isCurrent && +r.orderDate !== +orderDate && next.has(r.orderKeyHash))) syncError("RECONCILIATION_FAILED");
      const replayed = !!checkpoint && +checkpoint.queryStartedAt === +observation.startedAt;
      if (replayed && (checkpoint.snapshotHash !== observation.snapshotHash ||
          checkpoint.itemCount !== observation.itemCount || checkpoint.orderCount !== observation.orderCount))
        syncError("RECONCILIATION_FAILED");
      const baselineEstablished = !checkpoint;
      let changedOrders = 0, unchangedOrders = 0, newlyObservedWithinEpoch = 0;
      const observationId = randomUUID();
      const inserts: Prisma.Cafe24ObservedEpochOrderRevisionCreateManyInput[] = [];
      for (const row of observation.rows) {
        const old = current.get(row.orderKeyHash);
        if (old?.contentHash === row.contentHash) unchangedOrders++;
        else if (old) changedOrders++;
        else if (!baselineEstablished) newlyObservedWithinEpoch++;
        if (replayed) continue;
        if (old) {
          const updated = { ...old, lastObservedAt: observation.startedAt,
            isCurrent: old.contentHash === row.contentHash };
          updated.integrityHash = cafe24EpochRevisionIntegrity(key, updated);
          const result = await tx.cafe24ObservedEpochOrderRevision.updateMany({ where: {
            connectionId, keyVersion: metadata.keyVersion, epochReference: metadata.epochReference,
            orderDate, orderKeyHash: old.orderKeyHash, revision: old.revision,
            integrityHash: old.integrityHash, isCurrent: true }, data: {
            lastObservedAt: updated.lastObservedAt, isCurrent: updated.isCurrent, integrityHash: updated.integrityHash } });
          if (result.count !== 1) syncError("LEASE_LOST");
        }
        if (!old || old.contentHash !== row.contentHash) {
          const created = { ...metadata, orderDate, orderKeyHash: row.orderKeyHash,
            revision: (old?.revision ?? 0) + 1, contentHash: row.contentHash,
            firstObservedAt: observation.startedAt, lastObservedAt: observation.startedAt,
            observationId, isCurrent: true };
          inserts.push({ ...created, integrityHash: cafe24EpochRevisionIntegrity(key, created) });
        }
      }
      if (!replayed) {
        const created = { ...metadata, orderDate, queryStartedAt: observation.startedAt,
          completedAt: new Date(), observationId, checkpointRevision: (checkpoint?.checkpointRevision ?? 0) + 1,
          orderCount: observation.orderCount, itemCount: observation.itemCount, snapshotHash: observation.snapshotHash };
        const data = { ...created, integrityHash: cafe24EpochCheckpointIntegrity(key, created) };
        if (checkpoint) {
          const result = await tx.cafe24ObservedEpochDayCheckpoint.updateMany({ where: {
            connectionId, keyVersion: metadata.keyVersion, epochReference: metadata.epochReference, orderDate,
            checkpointRevision: checkpoint.checkpointRevision, integrityHash: checkpoint.integrityHash }, data });
          if (result.count !== 1) syncError("LEASE_LOST");
        } else await tx.cafe24ObservedEpochDayCheckpoint.create({ data });
        if (inserts.length) await tx.cafe24ObservedEpochOrderRevision.createMany({ data: inserts });
      }
      // Also verifies the final lease and all newly written seals before commit.
      await epochState(tx, metadata, key);
      return { observedOrders: observation.orderCount, baselineEstablished,
        newEpochBaselineOrders: baselineEstablished ? observation.orderCount : 0,
        newlyObservedWithinEpoch, changedOrders, unchangedOrders, replayed,
        continuityRestored: false as const, comparisonBoundary: "NEW_EPOCH_NO_V1_COMPARISON" as const,
        snapshotComplete: false as const };
    }, options);
  } finally { key.fill(0); }
}
