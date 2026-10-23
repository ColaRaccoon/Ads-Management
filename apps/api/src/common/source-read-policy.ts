import { ConflictException } from "@nestjs/common";
import { Prisma, SourceCoverage, SourceDataKind, SourceKind } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { validatedMetaApiDays } from "./meta-source-read-coverage";

type SourceRow = {
  source: SourceKind;
  connectionId: string | null;
};

type ReadPolicy = {
  connectionId: string; dataKind: SourceDataKind; fromDate: Date; toDate: Date | null; primarySource: SourceKind;
};
const contextBrand = Symbol("source-read-context");
/** Request-local evidence reuse, valid only on the creating transaction and range. */
export type SourceReadContext = {
  readonly [contextBrand]: true;
  readonly client: Prisma.TransactionClient;
  readonly from: number;
  readonly to: number;
  readonly policies: readonly ReadPolicy[];
  readonly apiDays: Map<SourceDataKind, Promise<Set<string>>>;
  readonly coverage?: readonly SourceCoverage[];
};
/** Optional coverage must be the complete, bounded full projection read on this RR transaction/range. */
export function createSourceReadContext(client: Prisma.TransactionClient, from: Date, to: Date,
  policies: readonly ReadPolicy[], coverage?: readonly SourceCoverage[]): SourceReadContext {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) sourceSelectionRequired();
  return { [contextBrand]: true, client, from: from.getTime(), to: to.getTime(), policies, apiDays: new Map(),
    coverage: coverage?.map(row => ({ ...row, metricDate: new Date(row.metricDate),
      lastSuccessAt: row.lastSuccessAt && new Date(row.lastSuccessAt), warningCodes: [...row.warningCodes] })) };
}

/** Reuse only this request's full-range, same-transaction source evidence. */
export async function sourceApiDaysInContext(client: PrismaService | Prisma.TransactionClient,
  dataKind: SourceDataKind, from: Date, to: Date, context: SourceReadContext): Promise<Set<string>> {
  if (context[contextBrand] !== true || context.client !== client ||
      !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to ||
      from.getTime() < context.from || to.getTime() > context.to ||
      (dataKind !== SourceDataKind.META_AD && dataKind !== SourceDataKind.META_ADSET && dataKind !== SourceDataKind.CAFE24_ORDER))
    sourceSelectionRequired();
  let pending = context.apiDays.get(dataKind);
  if (!pending) {
    const policies = context.policies.filter(policy => policy.dataKind === dataKind);
    pending = validatedSourceApiDays(client, dataKind, policies,
      [...new Set(policies.map(policy => policy.connectionId))], new Date(context.from), new Date(context.to), context.coverage);
    context.apiDays.set(dataKind, pending);
  }
  return pending;
}

/** Select one published source per bound account, kind, and local calendar date. */
export async function selectCurrentSourceRows<T extends SourceRow>(
  client: PrismaService | Prisma.TransactionClient,
  dataKind: SourceDataKind,
  rows: T[],
  dateOf: (row: T) => Date | null,
  context?: SourceReadContext
): Promise<T[]> {
  if (rows.length === 0) return [];
  if (process.env.DAILY_SYNC_FEATURE_ENABLED !== "true") {
    // Source-off rollback always projects CSV, including bound rows. Legacy
    // rows predate origin fields in some read-model fixtures; database rows
    // receive the CSV default in the additive origin migration.
    return rows.filter((row) => row.source !== SourceKind.API);
  }
  const dates = rows.map(dateOf).filter((date): date is Date => date instanceof Date);
  if (dates.length !== rows.length) sourceSelectionRequired();
  const ids = [...new Set(rows.flatMap((row) => row.connectionId ? [row.connectionId] : []))];
  const hasUnbound = rows.some((row) => row.connectionId == null);
  let earliest = dates[0];
  let latest = dates[0];
  for (const date of dates) {
    if (date < earliest) earliest = date;
    if (date > latest) latest = date;
  }
  if (context && (context[contextBrand] !== true || context.client !== client ||
      dates.some(date => !Number.isFinite(date.getTime())) ||
      earliest.getTime() < context.from || latest.getTime() > context.to)) sourceSelectionRequired();
  const policies = context ? context.policies.filter(policy => policy.dataKind === dataKind &&
    (hasUnbound || ids.includes(policy.connectionId)) && policy.fromDate <= latest &&
    (policy.toDate === null || policy.toDate > earliest)) : await client.sourcePolicy.findMany({
    where: {
      ...(!hasUnbound ? { connectionId: { in: ids } } : {}),
      dataKind,
      fromDate: { lte: latest },
      OR: [{ toDate: null }, { toDate: { gt: earliest } }]
    },
    select: { connectionId: true, fromDate: true, toDate: true, primarySource: true }
  });
  const policiesByConnection = new Map<string, typeof policies>();
  for (const policy of policies) {
    const bucket = policiesByConnection.get(policy.connectionId) ?? [];
    bucket.push(policy);
    policiesByConnection.set(policy.connectionId, bucket);
  }
  // A prematurely seeded API policy cannot silently hide a bound CSV day or
  // silently fall back to CSV. The explicit activation path checks more
  // evidence under the connection lock; this read guard fails closed.
  const isMeta = dataKind === SourceDataKind.META_AD || dataKind === SourceDataKind.META_ADSET;
  let apiCoverage = new Set<string>();
  if ((isMeta || dataKind === SourceDataKind.CAFE24_ORDER && ids.length > 0) &&
      policies.some(policy => policy.primarySource === SourceKind.API)) {
    if (context) {
      apiCoverage = await sourceApiDaysInContext(client, dataKind, earliest, latest, context);
    } else apiCoverage = await validatedSourceApiDays(client, dataKind, policies, ids, earliest, latest);
  }
  const apiDaysInRead = new Set(rows.filter((row) => row.connectionId &&
    row.source === SourceKind.API).map((row) =>
    `${row.connectionId}:${dateOf(row)!.getTime()}`));
  return rows.filter((row) => {
    if (!row.connectionId) {
      if (row.source !== SourceKind.CSV) return false;
      const date = dateOf(row)!;
      if (isMeta && policies.some((policy) => policy.primarySource === SourceKind.API &&
          policy.fromDate <= date && (policy.toDate === null || date < policy.toDate)))
        sourceSelectionRequired();
      // Unbound legacy rows are visible only before any account policy owns
      // this data kind and date. Once a policy exists, binding needs review.
      return !policies.some((policy) =>
        policy.fromDate.getTime() <= date.getTime() &&
        (policy.toDate === null || date.getTime() < policy.toDate.getTime())
      );
    }
    const date = dateOf(row);
    if (!date) sourceSelectionRequired();
    const matching = (policiesByConnection.get(row.connectionId) ?? []).filter((policy) =>
      policy.fromDate.getTime() <= date.getTime() &&
      (policy.toDate === null || date.getTime() < policy.toDate.getTime())
    );
    if (matching.length !== 1) sourceSelectionRequired();
    if (isMeta && matching[0].primarySource === SourceKind.API &&
        !apiCoverage.has(`${row.connectionId}:${date.getTime()}`)) sourceSelectionRequired();
    if (dataKind === SourceDataKind.CAFE24_ORDER &&
        matching[0].primarySource === SourceKind.API &&
        !apiCoverage.has(`${row.connectionId}:${date.getTime()}`))
      sourceSelectionRequired();
    if (dataKind === SourceDataKind.CAFE24_ORDER &&
        matching[0].primarySource === SourceKind.API && row.source === SourceKind.CSV &&
        !apiDaysInRead.has(`${row.connectionId}:${date.getTime()}`))
      sourceSelectionRequired();
    return matching[0].primarySource === row.source;
  });
}

async function validatedSourceApiDays(client: PrismaService | Prisma.TransactionClient,
  dataKind: SourceDataKind, policies: readonly Omit<ReadPolicy, "dataKind">[], ids: string[],
  earliest: Date, latest: Date, snapshotCoverage?: readonly SourceCoverage[]): Promise<Set<string>> {
  const apiCoverage = new Set<string>();
  const isMeta = dataKind === SourceDataKind.META_AD || dataKind === SourceDataKind.META_ADSET;
  if (isMeta && policies.some((policy) => policy.primarySource === SourceKind.API)) {
    const validated = await validatedMetaApiDays(client, dataKind,
      [...new Set(policies.filter((policy) => policy.primarySource === SourceKind.API).map((policy) => policy.connectionId))],
      earliest, latest);
    for (const day of validated) apiCoverage.add(day);
  }
  if (dataKind === SourceDataKind.CAFE24_ORDER && ids.length > 0 &&
      policies.some((policy) => policy.primarySource === SourceKind.API)) {
    const [coverage, currentCounts] = await Promise.all([
      snapshotCoverage ? snapshotCoverage.filter(row => row.dataKind === dataKind &&
        ids.includes(row.connectionId) && row.metricDate >= earliest && row.metricDate <= latest) :
      client.sourceCoverage.findMany({ where: {
        connectionId: { in: ids }, dataKind,
        metricDate: { gte: earliest, lte: latest }
      }, select: { connectionId: true, metricDate: true, source: true, state: true,
        lastSuccessRunId: true, lastSuccessAt: true, rowCount: true,
        reconciliationStatus: true, warningCodes: true } }),
      client.$queryRaw<Array<{ connectionId: string; orderDate: Date;
        rowCount: number; linkedCount: number; validLinkedCount: number;
        validVersionCount: number; validMappingCount: number }>>(Prisma.sql`
        SELECT l.connection_id AS "connectionId", l.order_date AS "orderDate",
          COUNT(*)::int AS "rowCount", COUNT(r.id)::int AS "linkedCount",
          COUNT(r.id) FILTER (WHERE r.version = l.import_version)::int AS "validLinkedCount",
          COUNT(v.id) FILTER (WHERE v.version = l.import_version)::int AS "validVersionCount",
          COUNT(*) FILTER (WHERE
            (l.validation_status::text = 'VALID' AND l.match_source::text = 'RULE'
              AND l.product_id IS NOT NULL AND l.cafe24_product_rule_id IS NOT NULL) OR
            (l.validation_status::text = 'UNMATCHED' AND l.match_source::text = 'UNMATCHED'
              AND l.product_id IS NULL AND l.cafe24_product_rule_id IS NULL)
          )::int AS "validMappingCount"
        FROM cafe24_order_lines l
        LEFT JOIN source_record_links r ON r.record_id = l.id
          AND r.connection_id = l.connection_id
          AND r.data_kind::text = 'CAFE24_ORDER' AND r.source::text = 'API'
          AND r.record_table = 'cafe24_order_lines' AND r.is_current = true
        LEFT JOIN cafe24_order_api_versions v ON v.connection_id = l.connection_id
          AND v.canonical_key_hash = r.canonical_key_hash AND v.version = r.version
          AND v.order_date = l.order_date AND v.is_current = true
          AND v.fetched_at IS NOT NULL AND v.content_fingerprint IS NOT NULL
          AND v.fingerprint_key_version IS NOT NULL
        WHERE l.connection_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          AND l.order_date >= ${earliest.toISOString().slice(0, 10)}::date
          AND l.order_date <= ${latest.toISOString().slice(0, 10)}::date
          AND l.source::text = 'API' AND l.is_current = true
        GROUP BY l.connection_id, l.order_date`)
    ]);
    const counts = new Map(currentCounts.map((row) =>
      [`${row.connectionId}:${row.orderDate.getTime()}`, row]));
    for (const day of coverage) {
      // A later failed manual reread changes state/lastAttempt, while the
      // successful current snapshot and its lastSuccess pointer remain valid.
      if (day.source === SourceKind.API && day.lastSuccessRunId && day.lastSuccessAt &&
          ["CSV_API_PARITY_VERIFIED", "CSV_API_INPUTS_REVIEWED",
            "CAFE24_API_ONLY_VERIFIED"].includes(day.reconciliationStatus ?? "") &&
          !day.warningCodes.includes("CAFE24_SHADOW_NOT_PRIMARY") &&
          Number.isSafeInteger(day.rowCount) && day.rowCount! >= 0 &&
          ((counts.get(`${day.connectionId}:${day.metricDate.getTime()}`)?.rowCount ?? 0) === day.rowCount) &&
          ((counts.get(`${day.connectionId}:${day.metricDate.getTime()}`)?.linkedCount ?? 0) === day.rowCount) &&
          ((counts.get(`${day.connectionId}:${day.metricDate.getTime()}`)?.validLinkedCount ?? 0) === day.rowCount) &&
          ((counts.get(`${day.connectionId}:${day.metricDate.getTime()}`)?.validVersionCount ?? 0) === day.rowCount) &&
          ((counts.get(`${day.connectionId}:${day.metricDate.getTime()}`)?.validMappingCount ?? 0) === day.rowCount))
        apiCoverage.add(`${day.connectionId}:${day.metricDate.getTime()}`);
    }
  }
  return apiCoverage;
}

function sourceSelectionRequired(): never {
  throw new ConflictException({
    code: "SOURCE_SELECTION_REQUIRED",
    message: "An account and date must have exactly one selected source."
  });
}
