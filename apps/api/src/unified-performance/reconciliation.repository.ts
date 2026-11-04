import { Prisma } from "@prisma/client";
import type { PrismaService } from "../common/prisma.service";
import type { ReportScope } from "./report.repository";
import type { SourcePartition } from "./report-contract";

export type ReconciliationCandidate = SourcePartition & { published: boolean; lastCheckedAt?: string | null };
export type ReconciliationCheckOutcome = "UNCHANGED" | "PUBLISHED" | "QUEUED" | "UNAVAILABLE" | "FAILED";
/** Only date evidence is projected. Source-policy choice and monetary calculations remain in adapters. */
export function sourceDateStatement(scope: ReportScope, from: string, through: string, limit: number) {
  // Collapse repeated dates before the UNION. Keep SQL date columns typed so
  // publication/check lookups can use their existing date indexes. Naver dates
  // are untrusted JSON strings and must never be cast to date here.
  const nativeDates = scope.platform !== "NAVER";
  const read = (table: string, column: string, where: Prisma.Sql) => Prisma.sql`SELECT DISTINCT ${Prisma.raw(column)} AS date FROM ${Prisma.raw(table)} t WHERE ${where}`;
  const connection = scope.scopeKey === "LEGACY_UNBOUND" ? Prisma.sql`t.connection_id IS NULL AND t.source='CSV'` : Prisma.sql`t.connection_id::text=${scope.scopeKey}`;
  let sources: Prisma.Sql[];
  switch (scope.platform) {
    case "META": sources = [read("meta_ads.meta_adset_daily_metrics", "t.metric_date", Prisma.sql`t.is_current AND ${connection}`)]; break;
    case "GOOGLE": sources = [read("meta_ads.google_campaign_daily_costs", "t.metric_date", Prisma.sql`t.is_current AND ${connection}`)]; break;
    case "CAFE24": {
      const ownsNativeAds = scope.scopeKey === "LEGACY_UNBOUND"
        ? Prisma.sql`NOT EXISTS(SELECT 1 FROM meta_ads.source_connections c WHERE c.provider='CAFE24')`
        : Prisma.sql`NOT EXISTS(SELECT 1 FROM meta_ads.source_connections c WHERE c.provider='CAFE24' AND c.id::text<>${scope.scopeKey})`;
      sources = [read("meta_ads.cafe24_order_lines", "t.order_date", Prisma.sql`t.is_current AND t.validation_status<>'ERROR' AND ${connection}`),
        read("meta_ads.meta_adset_daily_metrics", "t.metric_date", Prisma.sql`t.is_current AND ${ownsNativeAds}`),
        read("meta_ads.google_campaign_daily_costs", "t.metric_date", Prisma.sql`t.is_current AND ${ownsNativeAds}`)];
      // The original whole-storefront report includes source-selected legacy CSV.
      // Discover its dates for the sole configured native owner, without copying
      // its money or changing the adapter's source-selection/completeness policy.
      if (scope.scopeKey !== "LEGACY_UNBOUND") sources.push(read("meta_ads.cafe24_order_lines", "t.order_date",
        Prisma.sql`t.is_current AND t.validation_status<>'ERROR' AND t.connection_id IS NULL AND t.source='CSV'
          AND EXISTS(SELECT 1 FROM meta_ads.source_connections c WHERE c.provider='CAFE24' AND c.id::text=${scope.scopeKey})
          AND ${ownsNativeAds}`));
      break;
    }
    case "COUPANG": sources = [read("meta_ads.coupang_sale_lines", "t.sale_date", Prisma.sql`t.is_current AND t.validation_status<>'ERROR'`),
      read("meta_ads.coupang_ad_metrics", "t.metric_date", Prisma.sql`t.is_current AND t.validation_status<>'ERROR'`),
      read("meta_ads.coupang_manual_purchases", "t.purchase_date", Prisma.sql`TRUE`)]; break;
    case "NAVER": sources = [read("public.daily_store_summaries", "t.payload->>'date'", Prisma.sql`t.payload->>'storeId'=${scope.scopeKey}`),
      read("public.daily_sales_unit_profits", "t.payload->>'date'", Prisma.sql`t.payload->>'storeId'=${scope.scopeKey}`),
      read("public.daily_fake_purchases", "t.payload->>'date'", Prisma.sql`t.payload->>'storeId'=${scope.scopeKey}`)]; break;
  }
  // Retain dates after their last source row is deleted, so an old publication
  // can still be checked for a source-confirmed empty replacement or a gap.
  sources.push(read("meta_ads.unified_source_publications", nativeDates ? "t.business_date" : "t.business_date::text", Prisma.sql`t.platform=${scope.platform} AND t.scope_key=${scope.scopeKey}`));
  if (["META", "GOOGLE", "CAFE24"].includes(scope.platform) && scope.scopeKey !== "LEGACY_UNBOUND") {
    const kind = scope.platform === "META" ? "META_ADSET" : scope.platform === "GOOGLE" ? "GOOGLE_CAMPAIGN" : "CAFE24_ORDER";
    sources.push(read("meta_ads.source_coverage", "t.metric_date", Prisma.sql`t.connection_id::text=${scope.scopeKey} AND t.data_kind::text=${kind}
      AND t.state='COMPLETE_ZERO' AND t.row_count=0 AND t.last_success_run_id IS NOT NULL AND t.last_success_at IS NOT NULL`));
  }
  return Prisma.sql`WITH observed AS (${Prisma.join(sources, " UNION ALL ")}), dates AS (SELECT DISTINCT date FROM observed
    WHERE date IS NOT NULL AND date::text<=${through} AND date::text~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    , classified AS (SELECT d.date::text AS date, EXISTS(SELECT 1 FROM meta_ads.unified_source_publications p WHERE p.platform=${scope.platform}
      AND p.scope_key=${scope.scopeKey} AND ${Prisma.raw(nativeDates ? "p.business_date" : "p.business_date::text")}=d.date) AS published,
      c.last_checked_at AS "lastCheckedAt" FROM dates d
      LEFT JOIN meta_ads.unified_reconciliation_checks c ON c.platform=${scope.platform}
        AND c.scope_key=${scope.scopeKey} AND ${Prisma.raw(nativeDates ? "c.business_date" : "c.business_date::text")}=d.date)
    SELECT * FROM (
      (SELECT * FROM classified WHERE date>=${from} ORDER BY "lastCheckedAt" ASC NULLS FIRST, date DESC LIMIT ${limit})
      UNION ALL
      (SELECT * FROM classified WHERE date<${from} ORDER BY "lastCheckedAt" ASC NULLS FIRST, date ASC LIMIT ${limit})
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
          return tx.$queryRaw<Array<{ date: string; published: boolean; lastCheckedAt: Date | null }>>(sourceDateStatement(scope, from, through, limit));
        }, { timeout: 20000 });
        candidates.push(...rows.map(row => ({ platform: scope.platform, scopeKey: scope.scopeKey, date: row.date, published: row.published,
          lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null })));
      } catch { failures.push(scope.platform); }
    }
    return { candidates, failures };
  }
  async recordCheck(partition: SourcePartition, checkedAt: Date, outcome: ReconciliationCheckOutcome) {
    await this.prisma.$executeRaw(Prisma.sql`INSERT INTO meta_ads.unified_reconciliation_checks
      (platform,scope_key,business_date,last_checked_at,last_outcome)
      VALUES (${partition.platform},${partition.scopeKey},${partition.date}::date,${checkedAt},${outcome})
      ON CONFLICT (platform,scope_key,business_date) DO UPDATE SET
        last_checked_at=EXCLUDED.last_checked_at,last_outcome=EXCLUDED.last_outcome
      WHERE meta_ads.unified_reconciliation_checks.last_checked_at<=EXCLUDED.last_checked_at`);
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
