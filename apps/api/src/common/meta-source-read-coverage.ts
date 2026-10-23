import { Prisma, SourceDataKind } from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

/** A selected Meta API day needs the last atomic publish and its intact current links. */
function metaApiDaysQuery(dataKind: SourceDataKind, connectionIds: string[], from: Date, to: Date) {
  const table = dataKind === SourceDataKind.META_AD ? "meta_ad_daily_metrics" : "meta_adset_daily_metrics";
  // Keep coverage, current-lineage counts and the successful publish unit on one
  // statement snapshot and one round trip. A later failed reread does not erase
  // the last success; neither overall run status nor coverage state is a fence.
  return Prisma.sql`
    WITH current_counts AS MATERIALIZED (
      SELECT m.connection_id AS "connectionId", m.metric_date AS "metricDate",
        COUNT(DISTINCT m.id)::int AS "rowCount",
        COUNT(DISTINCT m.id) FILTER (WHERE r.version = m.import_version)::int AS "linkedRows",
        COUNT(r.id)::int AS "allLinks",
        COUNT(r.id) FILTER (WHERE r.version = m.import_version)::int AS "validLinks"
      FROM ${Prisma.raw(table)} m
      LEFT JOIN source_record_links r ON r.record_id = m.id
        AND r.connection_id = m.connection_id AND r.data_kind = ${dataKind}::"SourceDataKind"
        AND r.source = 'API'::"SourceKind" AND r.record_table = ${table} AND r.is_current = true
      WHERE m.connection_id IN (${Prisma.join(connectionIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND m.metric_date >= ${from.toISOString().slice(0, 10)}::date
        AND m.metric_date <= ${to.toISOString().slice(0, 10)}::date
        AND m.source = 'API'::"SourceKind" AND m.is_current = true
      GROUP BY m.connection_id, m.metric_date
    )
    SELECT ${dataKind}::text AS "dataKind", c.connection_id AS "connectionId", c.metric_date AS "metricDate"
    FROM source_coverage c
    LEFT JOIN current_counts n ON n."connectionId" = c.connection_id AND n."metricDate" = c.metric_date
    WHERE c.connection_id IN (${Prisma.join(connectionIds.map(id => Prisma.sql`${id}::uuid`))})
      AND c.data_kind = ${dataKind}::"SourceDataKind" AND c.source = 'API'::"SourceKind"
      AND c.metric_date >= ${from.toISOString().slice(0, 10)}::date
      AND c.metric_date <= ${to.toISOString().slice(0, 10)}::date
      AND c.last_success_run_id IS NOT NULL AND c.last_success_at IS NOT NULL AND c.row_count >= 0
      AND COALESCE(n."rowCount", 0) = c.row_count AND COALESCE(n."validLinks", 0) = c.row_count
      AND COALESCE(n."linkedRows", 0) = c.row_count AND COALESCE(n."allLinks", 0) = c.row_count
      AND EXISTS (
        SELECT 1 FROM run_units u JOIN sync_runs r ON r.id = u.run_id
        WHERE u.run_id = c.last_success_run_id AND u.status = 'SUCCEEDED'::"RunUnitStatus"
          AND r.connection_id = c.connection_id AND u.unit_key = to_char(c.metric_date, 'YYYY-MM-DD')
      )`;
}

/** Each kind keeps its own exact materialized lineage proof in one statement. */
export async function validatedMetaApiDaysBatch(client: PrismaService | Prisma.TransactionClient,
  dataKinds: readonly SourceDataKind[], connectionIds: string[], from: Date, to: Date): Promise<Map<SourceDataKind, Set<string>>> {
  if (dataKinds.some(kind => kind !== SourceDataKind.META_AD && kind !== SourceDataKind.META_ADSET))
    throw new ConflictException({ code: "SOURCE_SELECTION_REQUIRED", message: "Meta source verification requires a Meta data kind." });
  const kinds = [...new Set(dataKinds)];
  const ids = [...new Set(connectionIds)];
  const result = new Map(kinds.map(kind => [kind, new Set<string>()]));
  if (ids.length === 0 || kinds.length === 0) return result;
  const queries = kinds.map(kind => Prisma.sql`SELECT * FROM (${metaApiDaysQuery(kind, ids, from, to)}) validated_days`);
  const days = await client.$queryRaw<Array<{ dataKind: SourceDataKind; connectionId: string; metricDate: Date }>>(
    Prisma.sql`${Prisma.join(queries, " UNION ALL ")}`);
  for (const row of days) result.get(row.dataKind)?.add(`${row.connectionId}:${row.metricDate.getTime()}`);
  return result;
}

/** Standalone callers retain the same selected-kind result and one statement. */
export async function validatedMetaApiDays(client: PrismaService | Prisma.TransactionClient,
  dataKind: SourceDataKind, connectionIds: string[], from: Date, to: Date): Promise<Set<string>> {
  return (await validatedMetaApiDaysBatch(client, [dataKind], connectionIds, from, to)).get(dataKind)!;
}
