import { Prisma, SourceProvider } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { PrismaService } from "../common/prisma.service";
import { writeSecurityAudit } from "../security-audit/security-audit.types";
import { lockCanonicalConnection } from "./canonical-write-policy";
import { computeCafe24ActivationEvidence } from "./cafe24-activation-evidence";
import { openCredential } from "./credential-vault";
import { Cafe24ActivationReviewQuery, Cafe24ManualPreparationInput } from "./daily-sync.dto";
import { accountAllowlist, accountKey } from "./source-connections.service";
import { assertEnabled, assertSourceAdministrationEnabled, parseIsoDate, syncError } from "./sync-contract";

function preparationEnabled() {
  assertSourceAdministrationEnabled();
  if (process.env.DAILY_SYNC_CAFE24_MANUAL_PREPARATION_ENABLED !== "true")
    syncError("SOURCE_SELECTION_REQUIRED");
}

function completedDay(value: string) {
  const date = parseIsoDate(value);
  if (value >= formatInTimeZone(new Date(), "Asia/Seoul", "yyyy-MM-dd"))
    syncError("RUN_LIMIT_EXCEEDED", 400);
  return date;
}

async function allowedConnection(db: Prisma.TransactionClient, connectionId: string) {
  const connection = await db.sourceConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.provider !== SourceProvider.CAFE24 ||
      connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul" ||
      !accountAllowlist().has(accountKey(connection.provider, connection.externalAccountId, connection.shopKey)))
    syncError("ACCOUNT_SCOPE_MISMATCH");
  return connection;
}

const credentialMetadata = {
  kind: true, revision: true, expiresAt: true, refreshOwner: true, refreshUntil: true
} as const;

/** Read only normal OAuth metadata. No token, ciphertext or credential reference is returned. */
export async function cafe24ManualPreparationPreview(db: PrismaService, connectionId: string) {
  preparationEnabled();
  return db.$transaction(async (tx) => {
    const connection = await allowedConnection(tx, connectionId);
    const credentials = await tx.sourceCredential.findMany({
      where: { connectionId }, select: credentialMetadata, orderBy: { kind: "asc" }
    });
    return { connectionId, enabled: connection.enabled, accessState: connection.accessState,
      updatedAt: connection.updatedAt.toISOString(), credentials: credentials.map(row => ({
        kind: row.kind, revision: row.revision, expiresAt: row.expiresAt?.toISOString() ?? null,
        refreshInProgress: row.refreshOwner !== null || row.refreshUntil !== null
      })) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 5_000 });
}

/** Admit a completed-day shadow run after genuine OAuth binding; keep CSV primary. */
export async function prepareCafe24ManualConnection(db: PrismaService, connectionId: string,
  input: Cafe24ManualPreparationInput, actorUserId: string) {
  preparationEnabled();
  const fromDate = completedDay(input.fromDate);
  return db.$transaction(async (tx) => {
    await lockCanonicalConnection(tx, connectionId);
    const connection = await allowedConnection(tx, connectionId);
    if (connection.updatedAt.toISOString() !== input.expectedUpdatedAt)
      syncError("LEASE_LOST");
    if (connection.enabled || connection.accessState !== "READY" ||
        connection.credentialRef !== `source_credentials:${connectionId}:CAFE24_REFRESH`)
      syncError("PROVIDER_AUTH_REQUIRED");
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "source_credentials"
      WHERE "connection_id" = ${connectionId}::uuid FOR UPDATE`);
    const credentials = await tx.sourceCredential.findMany({ where: { connectionId } });
    const access = credentials.find(row => row.kind === "CAFE24_ACCESS");
    const refresh = credentials.find(row => row.kind === "CAFE24_REFRESH");
    if (credentials.length !== 2 || !access || !refresh ||
        access.revision !== input.expectedAccessRevision || refresh.revision !== input.expectedRefreshRevision ||
        !access.expiresAt || access.expiresAt.getTime() <= Date.now() + 11 * 60_000 ||
        !refresh.expiresAt || refresh.expiresAt <= new Date() ||
        refresh.expiresAt.getTime() !== connection.credentialExpiresAt?.getTime() ||
        credentials.some(row => row.refreshOwner !== null || row.refreshUntil !== null))
      syncError("PROVIDER_AUTH_REQUIRED");
    // Authenticate each encrypted row against this connection, kind and key version.
    // Neither provider requests nor refresh operations are performed here.
    for (const row of credentials) openCredential(row, connectionId, row.kind);
    const used = await Promise.all([tx.sourcePolicy.count({ where: { connectionId } }),
      tx.syncRun.count({ where: { connectionId } }), tx.syncLease.count({ where: { connectionId } }),
      tx.sourceCoverage.count({ where: { connectionId } })]);
    if (used.some(count => count !== 0)) syncError("SOURCE_SELECTION_REQUIRED");
    const unbound = await tx.cafe24OrderLine.findFirst({ where: {
      source: "CSV", isCurrent: true, connectionId: null,
      OR: [{ orderDate: null }, { orderDate: { gte: fromDate } }]
    }, select: { id: true } });
    if (unbound) syncError("SOURCE_SELECTION_REQUIRED");
    const policy = await tx.sourcePolicy.create({ data: {
      connectionId, dataKind: "CAFE24_ORDER", fromDate, primarySource: "CSV", version: 1,
      changedByUserId: actorUserId, reason: "CAFE24_MANUAL_PREPARATION"
    } });
    const changed = await tx.sourceConnection.updateMany({ where: {
      id: connectionId, enabled: false, accessState: "READY", updatedAt: connection.updatedAt,
      credentialRef: connection.credentialRef, credentialExpiresAt: connection.credentialExpiresAt
    }, data: { enabled: true } });
    if (changed.count !== 1) syncError("LEASE_LOST");
    await writeSecurityAudit(tx, { actorType: "USER", actorUserId,
      action: "CAFE24_MANUAL_PREPARED", targetType: "SOURCE_CONNECTION", targetId: connectionId,
      result: "SUCCESS", beforeJson: { enabled: false, accessState: "READY" },
      afterJson: { enabled: true, accessState: "READY", fromDate: input.fromDate,
        primarySource: "CSV", policyVersion: policy.version, apiActivated: false } });
    return { connectionId, enabled: true, accessState: "READY", fromDate: input.fromDate,
      primarySource: "CSV", policyVersion: policy.version, apiActivated: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 5_000, maxWait: 2_000 });
}

/** The existing activation service rechecks this digest while holding its write lock. */
export async function cafe24ManualActivationPreview(db: PrismaService, connectionId: string,
  input: Cafe24ActivationReviewQuery) {
  assertEnabled();
  completedDay(input.day);
  return db.$transaction(async (tx) => {
    await allowedConnection(tx, connectionId);
    const snapshotDigest = await computeCafe24ActivationEvidence(tx, connectionId, input.day, input);
    return { connectionId, ...input, snapshotDigest };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 5_000 });
}
