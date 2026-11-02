import { Prisma } from "@prisma/client";
import type { PrismaService } from "../common/prisma.service";
import type { ReportScope } from "./report.repository";
import type { SourcePartition } from "./report-contract";

export type ReconciliationCandidate = SourcePartition & { published: boolean };
/** Only date evidence is projected. Source-policy choice and monetary calculations remain in adapters. */
export function sourceDateStatement(scope: ReportScope, from: string, through: string, limit: number) {
  const read = (table: string, column: string, where: Prisma.Sql) => Prisma.sql`SELECT ${Prisma.raw(column)}::text AS date FROM ${Prisma.raw(table)} t WHERE ${where}`;
  const connection = scope.scopeKey === "LEGACY_UNBOUND" ? Prisma.sql`t.connection_id IS NULL AND t.source='CSV'` : Prisma.sql`t.connection_id::text=${scope.scopeKey}`;
  let sources: Prisma.Sql[];
  switch (scope.platform) {
    case "META": sources = [read("meta_ads.meta_adset_daily_metrics", "t.metric_date", Prisma.sql`t.is_current AND ${connection}`)]; break;
    case "GOOGLE": sources = [read("meta_ads.google_campaign_daily_costs", "t.metric_date", Prisma.sql`t.is_current AND ${connection}`)]; break;
    case "CAFE24": sources = [read("meta_ads.cafe24_order_lines", "t.order_date", Prisma.sql`t.is_current AND t.validation_status<>'ERROR' AND ${connection}`)]; break;
    case "COUPANG": sources = [read("meta_ads.coupang_sale_lines", "t.sale_date", Prisma.sql`t.is_current AND t.validation_status<>'ERROR'`),
      read("meta_ads.coupang_ad_metrics", "t.metric_date", Prisma.sql`t.is_current AND t.validation_status<>'ERROR'`)]; break;
    case "NAVER": sources = [read("public.daily_store_summaries", "t.payload->>'date'", Prisma.sql`t.payload->>'storeId'=${scope.scopeKey}`),
      read("public.daily_sales_unit_profits", "t.payload->>'date'", Prisma.sql`t.payload->>'storeId'=${scope.scopeKey}`)]; break;
  }
  if (["META", "GOOGLE", "CAFE24"].includes(scope.platform) && scope.scopeKey !== "LEGACY_UNBOUND") {
    const kind = scope.platform === "META" ? "META_ADSET" : scope.platform === "GOOGLE" ? "GOOGLE_CAMPAIGN" : "CAFE24_ORDER";
    sources.push(read("meta_ads.source_coverage", "t.metric_date", Prisma.sql`t.connection_id::text=${scope.scopeKey} AND t.data_kind::text=${kind}
      AND t.state='COMPLETE_ZERO' AND t.row_count=0 AND t.last_success_run_id IS NOT NULL AND t.last_success_at IS NOT NULL`));
  }
  return Prisma.sql`WITH observed AS (${Prisma.join(sources, " UNION ALL ")}), dates AS (SELECT DISTINCT date FROM observed
    WHERE date IS NOT NULL AND date<=${through} AND date~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    , classified AS (SELECT d.date, EXISTS(SELECT 1 FROM meta_ads.unified_source_publications p WHERE p.platform=${scope.platform}
      AND p.scope_key=${scope.scopeKey} AND p.business_date::text=d.date) AS published FROM dates d)
    SELECT * FROM (
      (SELECT * FROM classified WHERE date>=${from} ORDER BY date DESC LIMIT ${limit})
      UNION ALL
      (SELECT * FROM classified WHERE date<${from} AND NOT published ORDER BY date DESC LIMIT ${limit})
    ) candidates`;
}

export class ReconciliationRepository {
  constructor(private readonly prisma: PrismaService) {}
  async discover(scopes: ReportScope[], from: string, through: string, limit: number, deadlineAt = Number.POSITIVE_INFINITY) {
    const candidates: ReconciliationCandidate[] = [], failures: string[] = [];
    for (const scope of scopes) {
      if (Date.now() >= deadlineAt) { failures.push("DEADLINE_EXCEEDED"); break; }
      try {
        const rows = await this.prisma.$transaction(async tx => {
          await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
          await tx.$executeRaw(Prisma.sql`SET LOCAL statement_timeout='15000ms'`);
          return tx.$queryRaw<Array<{ date: string; published: boolean }>>(sourceDateStatement(scope, from, through, limit));
        }, { timeout: 20000 });
        candidates.push(...rows.map(row => ({ platform: scope.platform, scopeKey: scope.scopeKey, date: row.date, published: row.published })));
      } catch { failures.push(scope.platform); }
    }
    return { candidates, failures };
  }
  pending(scopes: ReportScope[], limit: number) {
    return this.prisma.unifiedAggregationRun.findMany({ where: { status: "STAGING",
      AND: [{ OR: scopes.map(scope => ({ platform: scope.platform, scopeKey: scope.scopeKey })) },
        { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }] }] },
      select: { id: true }, orderBy: [{ startedAt: "asc" }, { id: "asc" }], take: limit });
  }
  published(partition: SourcePartition) {
    return this.prisma.unifiedSourcePublication.findFirst({ where: { platform: partition.platform, scopeKey: partition.scopeKey,
      businessDate: new Date(`${partition.date}T00:00:00Z`) }, select: { runId: true, run: { select: { sourceFingerprint: true, versions: true } } } });
  }
}
