import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { databaseUrlWithConnectionLimit } from "../apps/api/src/common/prisma.service";
import { aggregationAdapterRequest, aggregationWorkerDatabaseUrl, assertSourceExecutionSucceeded, completeSourceCoverage } from "../apps/api/src/unified-performance/aggregation.worker";
import { assertReconciliationRole } from "../apps/api/src/unified-performance/reconciliation-entrypoint";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedReportRepository } from "../apps/api/src/unified-performance/report.repository";
import { scopePolicyComponents } from "../apps/api/src/unified-performance/domain/report-calculation";
import { PLATFORM_COMPONENTS } from "../apps/api/src/unified-performance/domain/platform-selection";
import { datesIn, range } from "../apps/api/src/unified-performance/report-query";
import { PLATFORMS, type Platform } from "../apps/api/src/unified-performance/types";
import { MetaPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/meta.adapter";
import { GooglePerformanceAdapter } from "../apps/api/src/unified-performance/adapters/google.adapter";
import { Cafe24PerformanceAdapter } from "../apps/api/src/unified-performance/adapters/cafe24.adapter";
import { CoupangPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/coupang.adapter";
import { NaverPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/naver.adapter";

// Protected maintenance wrapper only. This diagnostic never queues, claims or publishes a job.
// It persists enum codes, dates and timings only, never source IDs/names/amounts or error messages.
const target = join(tmpdir(), "unified-reconciliation-diagnose-result.json");
const safe = (code: string) => /^[A-Z][A-Z0-9_]{0,95}$/.test(code);
type ResultRow = { platform: Platform; scopeOrdinal: number; date: string; status: string; issueCodes: string[]; databaseCode?: string; elapsedMs: number };
async function main() {
  const args = new Map<string, string>();
  for (const value of process.argv.slice(2)) {
    const match = /^--(from|to|platform)=(.+)$/.exec(value);
    if (!match || args.has(match[1])) throw Error("INVALID_DIAGNOSTIC_ARGUMENTS");
    args.set(match[1], match[2]);
  }
  const dates = range(args.get("from") ?? "2026-10-26", args.get("to") ?? "2026-11-01", 14);
  const platforms = args.has("platform") ? [args.get("platform") as Platform] : [...PLATFORMS];
  if (platforms.some(platform => !PLATFORMS.includes(platform))) throw Error("INVALID_DIAGNOSTIC_PLATFORM");
  const client = new PrismaClient({ datasourceUrl: databaseUrlWithConnectionLimit(aggregationWorkerDatabaseUrl(), "1") });
  const rows: ResultRow[] = [], started = Date.now();
  const save = (status: string) => writeFileSync(target, JSON.stringify({ status, observedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    from: dates.from, to: dates.to, readOnly: true, rows }, null, 2) + "\n");
  try {
    const [role] = await client.$queryRaw<Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; owns: bigint }>>`
      SELECT current_user AS role,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,
        (SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
    assertReconciliationRole(role);
    const prisma = client as unknown as PrismaService, management = new UnifiedManagementRepository(prisma);
    const adapters = { META: new MetaPerformanceAdapter(prisma, management), GOOGLE: new GooglePerformanceAdapter(prisma, management),
      CAFE24: new Cafe24PerformanceAdapter(prisma, management), COUPANG: new CoupangPerformanceAdapter(management), NAVER: new NaverPerformanceAdapter(management) };
    const scopes = await new UnifiedReportRepository(management).access(platforms), snapshot = await management.snapshot();
    const ordinals = new Map<Platform, number>();
    for (const scope of scopes) {
      const ordinal = (ordinals.get(scope.platform) ?? 0) + 1; ordinals.set(scope.platform, ordinal);
      for (const date of datesIn(dates.from, dates.to)) {
        const readStarted = Date.now(), request = aggregationAdapterRequest({ ...scope, date, runId: randomUUID(), token: "diagnostic", previousRunId: null }, snapshot.versions);
        request.sourcePolicySnapshot.participationOverrides = Object.fromEntries(snapshot.products.filter(product => snapshot.rules.some(rule =>
          rule.kind === "SCOPE_POLICY" && rule.active && rule.productId === product.id)).map(product => [product.canonicalName,
            scopePolicyComponents(snapshot.rules, product.id, scope.platform, scope.scopeKey, date, PLATFORM_COMPONENTS[scope.platform])]));
        try {
          const batch = completeSourceCoverage({ ...scope, date, runId: request.runId, token: "diagnostic", previousRunId: null }, await adapters[scope.platform].read(request));
          const issueCodes = [...new Set(batch.coverage.flatMap(row => row.quality.issues).filter(safe))].sort();
          let status = "READY";
          try { assertSourceExecutionSucceeded(batch); } catch { status = "SOURCE_EXECUTION_FAILED"; }
          rows.push({ platform: scope.platform, scopeOrdinal: ordinal, date, status, issueCodes, elapsedMs: Date.now() - readStarted });
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          rows.push({ platform: scope.platform, scopeOrdinal: ordinal, date, status: "ADAPTER_READ_FAILED", issueCodes: [],
            ...(typeof code === "string" && /^P\d{4}$/.test(code) ? { databaseCode: code } : {}), elapsedMs: Date.now() - readStarted });
        }
        save("RUNNING");
      }
    }
    save("COMPLETE");
  } finally { await client.$disconnect(); }
}
main().catch(() => {
  writeFileSync(target, JSON.stringify({ status: "DIAGNOSTIC_SETUP_FAILED", readOnly: true }) + "\n");
  process.exitCode = 1;
});
