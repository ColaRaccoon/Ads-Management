import "reflect-metadata";
import { PrismaClient } from "@prisma/client";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { UnifiedAggregationRepository } from "../apps/api/src/unified-performance/aggregation.repository";
import { UnifiedAggregationWorker, aggregationWorkerDatabaseUrl } from "../apps/api/src/unified-performance/aggregation.worker";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { assertUnifiedEnabled } from "../apps/api/src/unified-performance/management.service";
import { MetaPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/meta.adapter";
import { GooglePerformanceAdapter } from "../apps/api/src/unified-performance/adapters/google.adapter";
import { Cafe24PerformanceAdapter } from "../apps/api/src/unified-performance/adapters/cafe24.adapter";
import { CoupangPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/coupang.adapter";
import { NaverPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/naver.adapter";

async function main() {
  assertUnifiedEnabled();
  const args = process.argv.slice(2);
  const idArg = args.find(arg => arg.startsWith("--job="))?.slice(6);
  const limitArg = args.find(arg => arg.startsWith("--limit="))?.slice(8) ?? "100";
  if (args.some(arg => !arg.startsWith("--job=") && !arg.startsWith("--limit=")) || !/^[1-9]\d{0,3}$/.test(limitArg) || Number(limitArg) > 5000 ||
      idArg !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idArg))
    throw new Error("INVALID_WORKER_ARGUMENTS");
  const client = new PrismaClient({ datasourceUrl: aggregationWorkerDatabaseUrl() });
  try {
    const [role] = await client.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; owns: bigint }>>`
      SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,
        (SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
    if (!role || Object.values(role).some(Boolean)) throw new Error("UNIFIED_AGGREGATION_REQUIRES_RESTRICTED_ROLE");
    const prisma = client as unknown as PrismaService;
    const management = new UnifiedManagementRepository(prisma);
    const worker = new UnifiedAggregationWorker(new UnifiedAggregationRepository(prisma), management, {
      META: new MetaPerformanceAdapter(prisma, management), GOOGLE: new GooglePerformanceAdapter(prisma, management),
      CAFE24: new Cafe24PerformanceAdapter(prisma, management), COUPANG: new CoupangPerformanceAdapter(management), NAVER: new NaverPerformanceAdapter(management)
    });
    const outcomes = idArg ? [await worker.runOne(idArg)].filter(Boolean) : await worker.runPending(Number(limitArg));
    process.stdout.write(`${JSON.stringify({ outcomes })}\n`);
    if (outcomes.some(outcome => outcome?.status !== "PUBLISHED")) process.exitCode = 1;
  } finally { await client.$disconnect(); }
}
main().catch(() => {
  // Connection URLs, provider errors, raw names and order fields are deliberately never logged.
  process.stderr.write("UNIFIED_AGGREGATION_WORKER_FAILED\n");
  process.exitCode = 1;
});
