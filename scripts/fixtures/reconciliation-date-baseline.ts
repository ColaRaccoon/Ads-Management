// Frozen pre-optimization query for local PostgreSQL equivalence and measurements only.
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../apps/api/src/common/prisma.service";
import type { ReportScope } from "../../apps/api/src/unified-performance/report.repository";
import type { SourcePartition } from "../../apps/api/src/unified-performance/report-contract";

export type ReconciliationCandidate = SourcePartition & { published: boolean; lastCheckedAt?: string | null };
export type ReconciliationCheckOutcome = "UNCHANGED" | "PUBLISHED" | "QUEUED" | "UNAVAILABLE" | "FAILED";
/** Only date evidence is projected. Source-policy choice and monetary calculations remain in adapters. */
export function sourceDateStatement(scope: ReportScope, from: string, through: string, limit: number) {
  const read = (table: string, column: string, where: Prisma.Sql) => Prisma.sql`SELECT ${Prisma.raw(column)}::text AS date FROM ${Prisma.raw(table)} t WHERE ${where}`;
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
  sources.push(read("meta_ads.unified_source_publications", "t.business_date", Prisma.sql`t.platform=${scope.platform} AND t.scope_key=${scope.scopeKey}`));
  if (["META", "GOOGLE", "CAFE24"].includes(scope.platform) && scope.scopeKey !== "LEGACY_UNBOUND") {
    const kind = scope.platform === "META" ? "META_ADSET" : scope.platform === "GOOGLE" ? "GOOGLE_CAMPAIGN" : "CAFE24_ORDER";
    sources.push(read("meta_ads.source_coverage", "t.metric_date", Prisma.sql`t.connection_id::text=${scope.scopeKey} AND t.data_kind::text=${kind}
      AND t.state='COMPLETE_ZERO' AND t.row_count=0 AND t.last_success_run_id IS NOT NULL AND t.last_success_at IS NOT NULL`));
  }
  return Prisma.sql`WITH observed AS (${Prisma.join(sources, " UNION ALL ")}), dates AS (SELECT DISTINCT date FROM observed
    WHERE date IS NOT NULL AND date<=${through} AND date~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    , classified AS (SELECT d.date, EXISTS(SELECT 1 FROM meta_ads.unified_source_publications p WHERE p.platform=${scope.platform}
      AND p.scope_key=${scope.scopeKey} AND p.business_date::text=d.date) AS published,
      (SELECT c.last_checked_at FROM meta_ads.unified_reconciliation_checks c WHERE c.platform=${scope.platform}
        AND c.scope_key=${scope.scopeKey} AND c.business_date::text=d.date) AS "lastCheckedAt" FROM dates d)
    SELECT * FROM (
      (SELECT * FROM classified WHERE date>=${from} ORDER BY "lastCheckedAt" ASC NULLS FIRST, date DESC LIMIT ${limit})
      UNION ALL
      (SELECT * FROM classified WHERE date<${from} ORDER BY "lastCheckedAt" ASC NULLS FIRST, date ASC LIMIT ${limit})
    ) candidates`;
}
