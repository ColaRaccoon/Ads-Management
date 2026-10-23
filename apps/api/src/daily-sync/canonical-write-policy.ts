import { ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma, SourceDataKind, SourceKind, SourceProvider } from "@prisma/client";
import { formatDateOnly } from "../domain/date-number";
import { accountAllowlist, accountKey } from "./source-connections.service";

export type CanonicalWriteDecision = { connectionId: string | null; primaryDates: Set<string> };

/** Shared serialization point for CSV writes, API publish, and policy changes. */
export async function lockCanonicalConnection(tx: Prisma.TransactionClient, connectionId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "source_connections" WHERE "id" = ${connectionId}::uuid FOR UPDATE
  `);
  if (rows.length !== 1) throw sourceSelectionRequired();
}

/**
 * Existing CSV works untouched until the common sync feature is enabled. Once
 * enabled, an explicit single-account binding and policy decide current rows.
 * API-primary dates remain valid CSV shadow uploads with a non-current version.
 */
export async function resolveCsvWritePolicy(tx: Prisma.TransactionClient, input: {
  provider: SourceProvider; dataKind: SourceDataKind; dates: Date[]; sourceConnectionId?: string;
}): Promise<CanonicalWriteDecision> {
  const keys = [...new Set(input.dates.map(formatDateOnly))].sort();
  if (process.env.DAILY_SYNC_FEATURE_ENABLED !== "true") {
    if (input.sourceConnectionId) throw sourceSelectionRequired();
    if (keys.length > 0) {
      // Serialize with policy changes even during source-off rollback. A new
      // unbound upload cannot safely share a date with account-owned rows.
      const connections = await tx.sourceConnection.findMany({ where: { provider: input.provider } });
      for (const connection of [...connections].sort((a, b) => a.id.localeCompare(b.id))) {
        await lockCanonicalConnection(tx, connection.id);
      }
      await assertNoBoundCurrentOrPolicy(tx, input.provider, input.dataKind,
        keys.map((key) => new Date(`${key}T00:00:00.000Z`)));
    }
    return { connectionId: null, primaryDates: new Set(keys) };
  }
  if (keys.length === 0 && !input.sourceConnectionId) return { connectionId: null, primaryDates: new Set() };
  const connections = await tx.sourceConnection.findMany({ where: { provider: input.provider } });
  if (!input.sourceConnectionId && connections.length === 0) {
    return { connectionId: null, primaryDates: new Set(keys) };
  }
  if (connections.length !== 1 && !input.sourceConnectionId) throw sourceSelectionRequired();
  const connection = input.sourceConnectionId
    ? connections.find((item) => item.id === input.sourceConnectionId)
    : connections[0];
  if (!connection || !accountAllowlist().has(accountKey(connection.provider, connection.externalAccountId, connection.shopKey))) {
    throw sourceSelectionRequired();
  }
  const connectionId = connection.id;
  await lockCanonicalConnection(tx, connectionId);
  if (keys.length === 0) return { connectionId, primaryDates: new Set() };
  const policies = await tx.sourcePolicy.findMany({ where: {
    connectionId, dataKind: input.dataKind,
    fromDate: { lte: new Date(`${keys[keys.length - 1]}T00:00:00.000Z`) }
  } });
  if (policies.length === 0 && !input.sourceConnectionId) {
    return { connectionId: null, primaryDates: new Set(keys) };
  }
  if (!input.sourceConnectionId) throw sourceSelectionRequired();
  const primaryDates = new Set<string>();
  for (const key of keys) {
    const date = new Date(`${key}T00:00:00.000Z`);
    const matches = policies.filter((policy) => policy.fromDate <= date && (!policy.toDate || date < policy.toDate));
    if (matches.length !== 1) throw sourceSelectionRequired();
    if (matches[0].primarySource === SourceKind.CSV) primaryDates.add(key);
  }
  await assertNoUnboundCurrentRows(tx, input.dataKind,
    keys.map((key) => new Date(`${key}T00:00:00.000Z`)));
  return { connectionId, primaryDates };
}

async function assertNoBoundCurrentOrPolicy(tx: Prisma.TransactionClient,
  provider: SourceProvider, dataKind: SourceDataKind, dates: Date[]) {
  if (dates.length === 0) return;
  const first = dates[0];
  const last = dates[dates.length - 1];
  const policy = await tx.sourcePolicy.findFirst({ where: {
    dataKind, connection: { provider }, fromDate: { lte: last },
    OR: [{ toDate: null }, { toDate: { gt: first } }]
  }, select: { id: true } });
  if (policy) throw sourceSelectionRequired();
  const scope = { connectionId: { not: null }, isCurrent: true } as const;
  const count = dataKind === SourceDataKind.CAFE24_ORDER
    ? await tx.cafe24OrderLine.count({ where: { ...scope,
      OR: [{ orderDate: null }, { orderDate: { in: dates } }] } })
    : dataKind === SourceDataKind.META_AD
      ? await tx.metaAdDailyMetric.count({ where: { ...scope, metricDate: { in: dates } } })
      : dataKind === SourceDataKind.META_ADSET
        ? await tx.metaAdsetDailyMetric.count({ where: { ...scope, metricDate: { in: dates } } })
        : 0;
  if (count > 0) throw sourceSelectionRequired();
}

export function sourceSelectionRequired() {
  return new ConflictException({ code: "SOURCE_SELECTION_REQUIRED", message: "An explicit account and source policy are required." });
}

/** Unreviewed legacy rows cannot coexist with an account-owned current projection. */
export async function assertNoUnboundCurrentRows(tx: Prisma.TransactionClient,
  dataKind: SourceDataKind, dates: Date[]) {
  if (dates.length === 0) return;
  const scope = { source: SourceKind.CSV, connectionId: null, isCurrent: true } as const;
  const count = dataKind === SourceDataKind.CAFE24_ORDER
    ? await tx.cafe24OrderLine.count({ where: { ...scope, orderDate: { in: dates } } })
    : dataKind === SourceDataKind.META_AD
      ? await tx.metaAdDailyMetric.count({ where: { ...scope, metricDate: { in: dates } } })
      : dataKind === SourceDataKind.META_ADSET
        ? await tx.metaAdsetDailyMetric.count({ where: { ...scope, metricDate: { in: dates } } })
        : 0;
  if (count > 0) throw sourceSelectionRequired();
}

/** Links exact-ID bound CSV versions; name-only keys wait for reviewed binding. */
export async function linkBoundCsvVersion(tx: Prisma.TransactionClient, input: {
  connectionId: string | null; dataKind: SourceDataKind; keyParts: string[];
  recordTable: "cafe24_order_lines" | "meta_ad_daily_metrics" | "meta_adset_daily_metrics";
  recordId: string; version: number; legacyNameKey?: boolean; isCurrent?: boolean;
}) {
  if (!input.connectionId || input.legacyNameKey) return;
  const canonicalKeyHash = canonicalBusinessKeyHash(input.keyParts);
  if (input.isCurrent !== false) await tx.sourceRecordLink.updateMany({ where: {
    connectionId: input.connectionId, dataKind: input.dataKind,
    source: SourceKind.CSV, canonicalKeyHash, isCurrent: true
  }, data: { isCurrent: false } });
  await tx.sourceRecordLink.create({ data: {
    connectionId: input.connectionId, dataKind: input.dataKind,
    canonicalKeyHash, source: SourceKind.CSV,
    recordTable: input.recordTable, recordId: input.recordId,
    version: input.version, syncRunId: null, isCurrent: input.isCurrent !== false,
    bindingMethod: "EXACT_ID"
  } });
}

export function canonicalBusinessKeyHash(parts: string[]) {
  return createHash("sha256").update(JSON.stringify(parts.map((part) => part.trim()))).digest("hex");
}
