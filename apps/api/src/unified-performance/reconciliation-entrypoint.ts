import "reflect-metadata";
import { PrismaClient } from "@prisma/client";
import type { PrismaService } from "../common/prisma.service";
import { databaseUrlWithConnectionLimit } from "../common/prisma.service";
import { UnifiedAggregationRepository } from "./aggregation.repository";
import { UnifiedAggregationWorker, aggregationWorkerDatabaseUrl } from "./aggregation.worker";
import { UnifiedManagementRepository } from "./management.repository";
import { UnifiedReportRepository } from "./report.repository";
import { ReconciliationRepository } from "./reconciliation.repository";
import { reconcilePublications, reconciliationOptions } from "./reconciliation";
import { assertUnifiedEnabled } from "./management.service";
import { PLATFORMS } from "./types";
import { MetaPerformanceAdapter } from "./adapters/meta.adapter";
import { GooglePerformanceAdapter } from "./adapters/google.adapter";
import { Cafe24PerformanceAdapter } from "./adapters/cafe24.adapter";
import { CoupangPerformanceAdapter } from "./adapters/coupang.adapter";
import { NaverPerformanceAdapter } from "./adapters/naver.adapter";

export function assertReconciliationRole(role: { role: string; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; owns: bigint | number | string } | undefined) {
  if (!role || role.role !== "meta_ads_unified_worker" || [role.rolsuper, role.rolbypassrls, role.rolcreatedb, role.rolcreaterole].some(flag => flag !== false) || String(role.owns) !== "0")
    throw new Error("UNIFIED_RECONCILIATION_REQUIRES_RESTRICTED_WORKER_ROLE");
}

/** Private cron executable; importing it has no side effects. No HTTP route, timer or web lifecycle hook. */
export async function runReconciliation(args = process.argv.slice(2)) {
  assertUnifiedEnabled();
  if (!["true", "false"].includes(process.env.DAILY_SYNC_FEATURE_ENABLED ?? "")) throw new Error("UNIFIED_RECONCILIATION_SOURCE_POLICY_REQUIRED");
  const options = reconciliationOptions(args);
  const url = aggregationWorkerDatabaseUrl(), username = decodeURIComponent(new URL(url).username).split(".")[0];
  if (username !== "meta_ads_unified_worker") throw new Error("UNIFIED_RECONCILIATION_REQUIRES_RESTRICTED_WORKER_ROLE");
  const client = new PrismaClient({ datasourceUrl: databaseUrlWithConnectionLimit(url, "1") });
  try {
    const [role] = await client.$queryRaw<Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; owns: bigint }>>`
      SELECT current_user AS role,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,
        (SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
    assertReconciliationRole(role);
    const prisma = client as unknown as PrismaService, management = new UnifiedManagementRepository(prisma);
    const adapters = { META: new MetaPerformanceAdapter(prisma, management), GOOGLE: new GooglePerformanceAdapter(prisma, management),
      CAFE24: new Cafe24PerformanceAdapter(prisma, management), COUPANG: new CoupangPerformanceAdapter(management), NAVER: new NaverPerformanceAdapter(management) };
    const aggregation = new UnifiedAggregationRepository(prisma);
    const scopes = await new UnifiedReportRepository(management).access([...PLATFORMS]);
    const result = await reconcilePublications({ scopes, options, repository: new ReconciliationRepository(prisma), aggregation, management,
      worker: new UnifiedAggregationWorker(aggregation, management, adapters), adapters });
    return { through: options.through, lookback: options.lookback, limit: options.limit, ...result };
  } finally { await client.$disconnect(); }
}

if (require.main === module) {
  runReconciliation().then(result => {
    // Counts only: never source names, orders, credentials, raw rows or provider/SQL errors.
    process.stdout.write(`${JSON.stringify({ event: "unified.reconciliation", ...result })}\n`);
    if (result.failed || result.discoveryFailures.length) process.exitCode = 1;
  }).catch(() => { process.stderr.write("UNIFIED_RECONCILIATION_FAILED\n"); process.exitCode = 1; });
}
