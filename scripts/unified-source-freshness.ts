import "reflect-metadata";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { aggregationWorkerDatabaseUrl } from "../apps/api/src/unified-performance/aggregation.worker";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedReportRepository, type ReportScope } from "../apps/api/src/unified-performance/report.repository";

const PLATFORMS = ["META", "GOOGLE", "CAFE24", "COUPANG", "NAVER"] as const;
function probeDate(args: string[]) {
  if (args.length > 1 || args.length === 1 && !/^--date=\d{4}-\d{2}-\d{2}$/.test(args[0])) throw Error("FRESHNESS_ARGUMENT_INVALID");
  const date = args[0]?.slice(7) ?? "2026-11-01";
  if (!Number.isFinite(Date.parse(date + "T00:00:00Z")) || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date) throw Error("FRESHNESS_DATE_INVALID");
  return date;
}
/** Aggregates only. No raw payload, customer/order/product names, amount, credentials or error message is emitted. */
export function sourceProbeQueries(scope: ReportScope, date: string, from: string): Array<{ kind: string; query: Prisma.Sql }> {
  const legacy = scope.scopeKey === "LEGACY_UNBOUND";
  const connection = legacy ? Prisma.sql`connection_id IS NULL` : Prisma.sql`connection_id=${scope.scopeKey}::uuid`;
  const count = (table: Prisma.Sql, column: Prisma.Sql, filter: Prisma.Sql) => Prisma.sql`
    SELECT max(${column})::text AS latest_observed_date,
      count(*) FILTER(WHERE ${column}=${date}::date)::int AS target_current_rows,
      count(*)::int AS probe_current_rows FROM ${table}
      WHERE ${filter} AND ${column} BETWEEN ${from}::date AND ${date}::date`;
  if (scope.platform === "META") return [{ kind: "META_ADSET_CURRENT", query: count(Prisma.sql`meta_ads.meta_adset_daily_metrics`, Prisma.sql`metric_date`, Prisma.sql`is_current AND ${connection}`) }];
  if (scope.platform === "GOOGLE") return [{ kind: "GOOGLE_CAMPAIGN_CURRENT", query: count(Prisma.sql`meta_ads.google_campaign_daily_costs`, Prisma.sql`metric_date`, Prisma.sql`is_current AND ${connection}`) }];
  if (scope.platform === "CAFE24") return [{ kind: "CAFE24_ORDER_CURRENT", query: count(Prisma.sql`meta_ads.cafe24_order_lines`, Prisma.sql`order_date`, Prisma.sql`is_current AND ${connection}`) }];
  if (scope.platform === "COUPANG") {
    if (scope.scopeKey !== "LEGACY_COUPANG_SINGLE_UPLOAD") throw Error("COUPANG_SCOPE_REJECTED");
    return [{ kind: "COUPANG_SALE_CURRENT", query: count(Prisma.sql`meta_ads.coupang_sale_lines`, Prisma.sql`sale_date`, Prisma.sql`is_current`) },
      { kind: "COUPANG_AD_CURRENT", query: count(Prisma.sql`meta_ads.coupang_ad_metrics`, Prisma.sql`metric_date`, Prisma.sql`is_current`) }];
  }
  if (scope.platform === "NAVER") {
    // Fixed identifiers only, matching naver-reader.ts' exact business-date expressions.
    return [
      { kind: "NAVER_ORDER_PAYMENT_DATE", query: Prisma.sql`SELECT max(payload->>'paymentDate') AS latest_observed_date,
        count(*) FILTER(WHERE payload->>'paymentDate'=${date})::int AS target_rows, count(*)::int AS probe_rows
        FROM public.order_items WHERE payload->>'storeId'=${scope.scopeKey} AND payload->>'paymentDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND payload->>'paymentDate' BETWEEN ${from} AND ${date}` },
      { kind: "NAVER_AD_REPORT_DATE", query: Prisma.sql`SELECT max(payload->>'reportDate') AS latest_observed_date,
        count(*) FILTER(WHERE payload->>'reportDate'=${date})::int AS target_rows, count(*)::int AS probe_rows
        FROM public.ad_campaign_daily_costs WHERE payload->>'storeId'=${scope.scopeKey} AND payload->>'reportDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND payload->>'reportDate' BETWEEN ${from} AND ${date}` },
      { kind: "NAVER_STORED_DAILY_SUMMARY", query: Prisma.sql`SELECT max(payload->>'date') AS latest_observed_date,
        count(*) FILTER(WHERE payload->>'date'=${date})::int AS target_rows, count(*)::int AS probe_rows
        FROM public.daily_store_summaries WHERE payload->>'storeId'=${scope.scopeKey} AND payload->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND payload->>'date' BETWEEN ${from} AND ${date}` },
    ];
  }
  throw Error("SOURCE_SCOPE_REJECTED");
}
function safeDatabaseCode(error: unknown) {
  const row = error as { code?: unknown; meta?: { code?: unknown } };
  return { prismaCode: typeof row?.code === "string" && /^P[0-9]{4}$/.test(row.code) ? row.code : null,
    databaseCode: typeof row?.meta?.code === "string" && /^[A-Z0-9]{5}$/.test(row.meta.code) ? row.meta.code : null };
}
export async function main() {
  const date = probeDate(process.argv.slice(2)), from = new Date(Date.parse(date + "T00:00:00Z") - 7 * 86400000).toISOString().slice(0, 10);
  const output = join(tmpdir(), `unified-source-freshness-${date}.json`);
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || !lstatSync(output).isFile())) throw Error("EVIDENCE_PATH_REJECTED");
  const client = new PrismaClient({ datasourceUrl: aggregationWorkerDatabaseUrl() });
  const management = new UnifiedManagementRepository(client as unknown as PrismaService);
  const reports = new UnifiedReportRepository(management);
  const evidence: Record<string, unknown> = { operation: "READ_ONLY_SOURCE_FRESHNESS", observedAt: new Date().toISOString(), date,
    probeRange: { from, to: date }, sourceWrites: 0, publicationWrites: 0, queryScope: "Existing report repository authorized scopes only",
    note: "Raw current row counts demonstrate stored data, not final source-policy or lineage eligibility. Null/empty is not confirmed zero. Latest observed date is bounded to the probe range." };
  const results: Array<Record<string, unknown>> = [];
  const read = async (kind: string, scope: ReportScope, query: Prisma.Sql) => {
    try {
      const rows = await management.read(async tx => {
        await tx.$executeRaw`SET LOCAL statement_timeout='10000'`;
        return tx.$queryRaw<Array<Record<string, unknown>>>(query);
      }, { timeoutMs: 15000 });
      results.push({ kind, platform: scope.platform, scopeKey: scope.scopeKey, status: "PASS", rows });
    } catch (error) { results.push({ kind, platform: scope.platform, scopeKey: scope.scopeKey, status: "UNAVAILABLE", ...safeDatabaseCode(error) }); }
  };
  try {
    const roles = await management.read(tx => tx.$queryRaw<Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT current_user::text AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    if (roles.length !== 1 || roles[0].role !== "meta_ads_unified_worker" || roles[0].rolsuper || roles[0].rolbypassrls) throw Error("RESTRICTED_WORKER_ROLE_REQUIRED");
    evidence.role = "meta_ads_unified_worker";
    const scopes = await reports.access([...PLATFORMS]);
    if (!scopes.length) throw Error("AUTHORIZED_SCOPES_EMPTY");
    evidence.scopes = scopes.map(scope => ({ platform: scope.platform, scopeKey: scope.scopeKey }));
    for (const scope of scopes) {
      for (const probe of sourceProbeQueries(scope, date, from)) await read(probe.kind, scope, probe.query);
      if (["META", "GOOGLE", "CAFE24"].includes(scope.platform) && scope.scopeKey !== "LEGACY_UNBOUND") {
        await read("SOURCE_COLLECTION_COVERAGE", scope, Prisma.sql`SELECT data_kind::text,metric_date::text,source::text,state::text,row_count,
          last_success_at::text,last_attempt_at::text FROM meta_ads.source_coverage
          WHERE connection_id=${scope.scopeKey}::uuid AND metric_date BETWEEN ${from}::date AND ${date}::date ORDER BY metric_date DESC,data_kind`);
      }
      await read("UNIFIED_PUBLICATIONS", scope, Prisma.sql`SELECT max(business_date)::text AS latest_published_date,
        count(*) FILTER(WHERE business_date=${date}::date)::int AS target_publications, max(updated_at)::text AS latest_pointer_update
        FROM meta_ads.unified_source_publications WHERE platform=${scope.platform} AND scope_key=${scope.scopeKey} AND business_date<=${date}::date`);
      await read("UNIFIED_RUNS_AND_QUEUE", scope, Prisma.sql`SELECT business_date::text,status,
        CASE WHEN coalesce(checkpoint->>'phase','') ~ '^[A-Z_]{1,32}$' THEN checkpoint->>'phase' ELSE 'UNSPECIFIED' END AS phase,
        count(*)::int AS run_count,max(attempts)::int AS maximum_attempts,max(started_at)::text AS latest_started_at,
        max(completed_at)::text AS latest_completed_at,max(published_at)::text AS latest_published_at
        FROM meta_ads.unified_aggregation_runs WHERE platform=${scope.platform} AND scope_key=${scope.scopeKey}
          AND business_date BETWEEN ${from}::date AND ${date}::date
        GROUP BY business_date,status,phase ORDER BY business_date DESC,status,phase`);
    }
    evidence.results = results;
    evidence.status = results.some(row => row.status !== "PASS") ? "PARTIAL" : "PASS";
    if (evidence.status === "PARTIAL") process.exitCode = 2;
  } catch (error) { evidence.status = "FAILED"; evidence.error = safeDatabaseCode(error); process.exitCode = 1; }
  finally {
    try { await client.$disconnect(); } catch { evidence.disconnectStatus = "FAILED"; process.exitCode = 1; }
    writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: evidence.status, operation: evidence.operation, output, sourceWrites: 0, publicationWrites: 0 }) + "\n");
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(() => {
  process.stderr.write("UNIFIED_SOURCE_FRESHNESS_FAILED\n"); process.exitCode = 1;
});
