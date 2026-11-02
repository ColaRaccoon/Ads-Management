import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReconciliation } from "../apps/api/src/unified-performance/reconciliation-entrypoint";
import { assertReconciliationRole } from "../apps/api/src/unified-performance/reconciliation-entrypoint";
import { Prisma, PrismaClient } from "@prisma/client";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { databaseUrlWithConnectionLimit } from "../apps/api/src/common/prisma.service";
import { aggregationWorkerDatabaseUrl } from "../apps/api/src/unified-performance/aggregation.worker";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedReportRepository } from "../apps/api/src/unified-performance/report.repository";
import { PLATFORMS } from "../apps/api/src/unified-performance/types";
import { UnifiedAggregationRepository } from "../apps/api/src/unified-performance/aggregation.repository";
import { UnifiedAggregationWorker } from "../apps/api/src/unified-performance/aggregation.worker";
import { MetaPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/meta.adapter";
import { GooglePerformanceAdapter } from "../apps/api/src/unified-performance/adapters/google.adapter";
import { Cafe24PerformanceAdapter } from "../apps/api/src/unified-performance/adapters/cafe24.adapter";
import { CoupangPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/coupang.adapter";
import { NaverPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/naver.adapter";

/** Restricted-role metadata only. No source/financial reads, enqueue, claim or publish. */
async function inspectFailures() {
  if (process.argv.slice(2).length !== 1) throw new Error("INVALID_INSPECTION_ARGUMENTS");
  const client = new PrismaClient({ datasourceUrl: databaseUrlWithConnectionLimit(aggregationWorkerDatabaseUrl(), "1") });
  try {
    const [role] = await client.$queryRaw<Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; owns: bigint }>>`
      SELECT current_user role,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,
        (SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
    assertReconciliationRole(role);
    const scopes = await new UnifiedReportRepository(new UnifiedManagementRepository(client as unknown as PrismaService)).access([...PLATFORMS]);
    const from = new Date(Date.now() - 6 * 3600000);
    const rows = await client.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout='10000ms'`;
      const runs = await tx.unifiedAggregationRun.findMany({ where: { startedAt: { gte: from }, status: { in: ["FAILED", "STAGING"] },
        OR: scopes.map(scope => ({ platform: scope.platform, scopeKey: scope.scopeKey })) },
        select: { id: true, sourceSystem: true, platform: true, scopeKey: true, businessDate: true, status: true, attempts: true,
          issues: true, startedAt: true, completedAt: true, leaseExpiresAt: true }, orderBy: { startedAt: "desc" }, take: 100 });
      return Promise.all(runs.map(async run => {
        const current = await tx.unifiedSourcePublication.findUnique({ where: { sourceSystem_platform_scopeKey_businessDate: {
          sourceSystem: run.sourceSystem, platform: run.platform, scopeKey: run.scopeKey, businessDate: run.businessDate } },
          select: { runId: true, revision: true, updatedAt: true, run: { select: { publishedAt: true, versions: true } } } });
        return { jobId: run.id, platform: run.platform, scopeKey: run.scopeKey, date: run.businessDate.toISOString().slice(0, 10),
          status: run.status, attempts: run.attempts, issueCodes: Array.isArray(run.issues) ? run.issues.filter(value =>
            typeof value === "string" && /^[A-Z][A-Z0-9_:.-]{0,127}$/.test(value)) : [],
          startedAt: run.startedAt, completedAt: run.completedAt, leaseExpiresAt: run.leaseExpiresAt,
          publication: current ? { runId: current.runId, revision: current.revision, updatedAt: current.updatedAt,
            publishedAt: current.run.publishedAt, calculationVersion: (current.run.versions as Record<string, unknown>)?.calculationVersion ?? null } : null };
      }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
    writeFileSync(join(tmpdir(), "unified-reconcile-failures-result.json"), JSON.stringify({ operation: "READ_ONLY_RECONCILIATION_FAILURE_METADATA",
      observedAt: new Date().toISOString(), from, sourceWrites: 0, publicationWrites: 0, rows }, null, 2) + "\n");
  } finally { await client.$disconnect(); }
}

/** One explicitly identified failed partition. Never drains or rebuilds another partition. */
async function retryFailed() {
  const args = process.argv.slice(2), match = args.length === 1 && /^--retry-failed=([a-f0-9-]{36})$/i.exec(args[0]);
  if (!match || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(match[1])) throw new Error("INVALID_RETRY_ARGUMENTS");
  const client = new PrismaClient({ datasourceUrl: databaseUrlWithConnectionLimit(aggregationWorkerDatabaseUrl(), "1") });
  try {
    const [role] = await client.$queryRaw<Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; owns: bigint }>>`
      SELECT current_user role,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,
        (SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
    assertReconciliationRole(role);
    const prisma = client as unknown as PrismaService, management = new UnifiedManagementRepository(prisma);
    const scopes = await new UnifiedReportRepository(management).access([...PLATFORMS]);
    const failed = await client.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const run = await tx.unifiedAggregationRun.findUnique({ where: { id: match[1] }, select: {
        id: true, platform: true, scopeKey: true, businessDate: true, status: true, startedAt: true } });
      if (!run || run.status !== "FAILED" || run.startedAt.getTime() < Date.now() - 6 * 3600000 ||
        !scopes.some(scope => scope.platform === run.platform && scope.scopeKey === run.scopeKey)) throw new Error("AUTHORIZED_RECENT_FAILED_JOB_REQUIRED");
      return run;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10000 });
    const scope = scopes.find(scope => scope.platform === failed.platform && scope.scopeKey === failed.scopeKey)!;
    const partition = { platform: scope.platform, scopeKey: scope.scopeKey, date: failed.businessDate.toISOString().slice(0, 10) };
    const repository = new UnifiedAggregationRepository(prisma);
    const queued = await repository.enqueue([partition], null, "Retry one failed reconciliation partition after read-only diagnostic",
      `retry-failed:${failed.id}`);
    if (queued.jobs.length !== 1) throw new Error("RETRY_PARTITION_COUNT_INVALID");
    const worker = new UnifiedAggregationWorker(repository, management, { META: new MetaPerformanceAdapter(prisma, management),
      GOOGLE: new GooglePerformanceAdapter(prisma, management), CAFE24: new Cafe24PerformanceAdapter(prisma, management),
      COUPANG: new CoupangPerformanceAdapter(management), NAVER: new NaverPerformanceAdapter(management) });
    const outcome = queued.jobs[0].status === "PUBLISHED" ? { status: "ALREADY_PUBLISHED" } : await worker.runOne(queued.jobs[0].jobId);
    const publication = await client.unifiedSourcePublication.findFirst({ where: { platform: partition.platform,
      scopeKey: partition.scopeKey, businessDate: failed.businessDate }, select: { runId: true, revision: true, updatedAt: true,
        run: { select: { status: true, versions: true } } } });
    const succeeded = publication?.runId === queued.jobs[0].jobId && publication.run.status === "PUBLISHED";
    writeFileSync(join(tmpdir(), "unified-reconcile-retry-result.json"), JSON.stringify({ operation: "ONE_FAILED_PARTITION_RETRY",
      observedAt: new Date().toISOString(), sourceWrites: 0, requestedPartitions: 1, originalFailedJob: failed.id, ...partition,
      outcome: outcome?.status ?? "NO_CLAIM", status: succeeded ? "PASS" : "FAILED", publication: publication ? {
        runId: publication.runId, revision: publication.revision, updatedAt: publication.updatedAt, status: publication.run.status,
        calculationVersion: (publication.run.versions as Record<string, unknown>)?.calculationVersion ?? null } : null }, null, 2) + "\n");
    if (!succeeded) process.exitCode = 1;
  } finally { await client.$disconnect(); }
}

// Run only via the protected Stage 11 wrapper. Persist counts, never source rows or errors.
const started = Date.now();
if (process.argv.includes("--inspect-failures")) inspectFailures().catch(() => {
  writeFileSync(join(tmpdir(), "unified-reconcile-failures-result.json"), JSON.stringify({ status: "INSPECTION_FAILED", sourceWrites: 0, publicationWrites: 0 }) + "\n");
  process.exitCode = 1;
});
else if (process.argv.slice(2).some(value => value.startsWith("--retry-failed="))) retryFailed().catch(() => {
  writeFileSync(join(tmpdir(), "unified-reconcile-retry-result.json"), JSON.stringify({ status: "RETRY_FAILED", sourceWrites: 0 }) + "\n");
  process.exitCode = 1;
});
else runReconciliation(process.argv.slice(2)).then(result => {
  writeFileSync(join(tmpdir(), "unified-reconcile-current-result.json"), JSON.stringify({
    observedAt: new Date().toISOString(), elapsedMs: Date.now() - started, ...result,
  }, null, 2) + "\n");
  if (result.failed || result.discoveryFailures.length) process.exitCode = 1;
}).catch(() => {
  writeFileSync(join(tmpdir(), "unified-reconcile-current-result.json"), JSON.stringify({
    status: "FAILED", elapsedMs: Date.now() - started,
  }) + "\n");
  process.exitCode = 1;
});
