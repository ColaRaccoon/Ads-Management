// Read-only one-partition source replay. Never invokes a queue/worker repository or publishes.
import "reflect-metadata";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedReportRepository } from "../apps/api/src/unified-performance/report.repository";
import { prepareReportBatch, summarizeReport, scopePolicyComponents } from "../apps/api/src/unified-performance/domain/report-calculation";
import { assertBusinessDate } from "../apps/api/src/unified-performance/domain/product-name-resolver";
import { money } from "../apps/api/src/unified-performance/domain/decimal";
import { PLATFORM_COMPONENTS } from "../apps/api/src/unified-performance/domain/platform-selection";
import { aggregationAdapterRequest, completeSourceCoverage, assertSourceExecutionSucceeded } from "../apps/api/src/unified-performance/aggregation.worker";
import { parseReportQuery } from "../apps/api/src/unified-performance/report-query";
import { MetaPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/meta.adapter";
import { GooglePerformanceAdapter } from "../apps/api/src/unified-performance/adapters/google.adapter";
import { Cafe24PerformanceAdapter } from "../apps/api/src/unified-performance/adapters/cafe24.adapter";
import { CoupangPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/coupang.adapter";
import { NaverPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/naver.adapter";
import { PLATFORMS, type Platform } from "../apps/api/src/unified-performance/types";
import type { ReportFact } from "../apps/api/src/unified-performance/report-contract";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v])=>[k,stable(v)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const orderedFacts = (facts: readonly ReportFact[]) => [...facts].sort((a,b)=>`${a.component}/${a.factKey}`.localeCompare(`${b.component}/${b.factKey}`));

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg); if (!match) throw new Error("INVALID_ARGUMENT");
    return [match[1], match[2]];
  }));
  if (Object.keys(args).some(key => !["platform","scope","date","product","expected-host","expected-database","expected-role","output"].includes(key))) throw new Error("INVALID_ARGUMENT");
  const platform = args.platform as Platform, scopeKey = args.scope, date = args.date;
  if (!PLATFORMS.includes(platform) || !scopeKey || scopeKey.length > 256 || !args["expected-host"] || !args["expected-database"] || !args["expected-role"]) throw new Error("EXPLICIT_TARGET_REQUIRED");
  assertBusinessDate(date);
  const configured = process.env.UNIFIED_STAGE11_RECONCILE_DATABASE_URL;
  if (!configured) throw new Error("RECONCILE_URL_REQUIRED");
  const target = new URL(configured);
  if (!["postgres:","postgresql:"].includes(target.protocol) || target.hostname !== args["expected-host"]) throw new Error("TARGET_HOST_MISMATCH");
  const client = new PrismaClient({ datasourceUrl: configured });
  try {
    const [identity] = await client.$queryRaw<Array<{ database: string; role: string; superuser: boolean; bypassrls: boolean; owns: bigint }>>`
      SELECT current_database() AS database,current_user AS role,r.rolsuper AS superuser,r.rolbypassrls AS bypassrls,
        (SELECT count(*) FROM pg_tables WHERE tableowner=current_user) AS owns FROM pg_roles r WHERE rolname=current_user`;
    if (identity.database !== args["expected-database"] || identity.role !== args["expected-role"]) throw new Error("TARGET_IDENTITY_MISMATCH");
    if (identity.superuser || identity.bypassrls || identity.owns > 0n) throw new Error("RESTRICTED_RUNTIME_ROLE_REQUIRED");
    const prisma = client as unknown as PrismaService, management = new UnifiedManagementRepository(prisma);
    const configuration = await management.snapshot();
    if (args.product && !configuration.products.some(product=>product.canonicalName===args.product)) throw new Error("UNKNOWN_CANONICAL_PRODUCT");
    const reportRepository = new UnifiedReportRepository(management);
    await reportRepository.access([platform],[scopeKey],args.product?[args.product]:[]);
    const claim = { platform, scopeKey, date, runId: randomUUID(), token: randomUUID(), previousRunId: null };
    const request = aggregationAdapterRequest(claim, configuration.versions);
    request.sourcePolicySnapshot.participationOverrides = Object.fromEntries(configuration.products
      .filter(product => configuration.rules.some(rule => rule.kind === "SCOPE_POLICY" && rule.active && rule.productId === product.id))
      .map(product => [product.canonicalName,scopePolicyComponents(configuration.rules, product.id, platform,scopeKey,date,PLATFORM_COMPONENTS[platform])]));
    const adapters = { META: new MetaPerformanceAdapter(prisma,management), GOOGLE: new GooglePerformanceAdapter(prisma,management),
      CAFE24: new Cafe24PerformanceAdapter(prisma,management), COUPANG: new CoupangPerformanceAdapter(management), NAVER: new NaverPerformanceAdapter(management) };
    const batch = completeSourceCoverage(claim, await adapters[platform].read(request));
    const executionSucceeded = (() => { try { assertSourceExecutionSucceeded(batch); return true; } catch { return false; } })();
    const prepared = prepareReportBatch(request,batch,configuration.rules);
    const query = parseReportQuery({ from:date,to:date,compareFrom:date,compareTo:date,platforms:[platform],scopeKeys:[scopeKey] });
    const published = await reportRepository.snapshot(query);
    const sourceFacts = prepared.map(fact=>({...fact,platform,scopeKey,date}));
    const source = summarizeReport(sourceFacts,batch.coverage,{ platforms:[platform],productName:args.product });
    const stored = summarizeReport(published.facts,published.coverage,{ platforms:[platform],productName:args.product });
    const publishedPayloads = published.facts.map(({ platform:_p,scopeKey:_s,date:_d,...payload })=>payload);
    const sourceHash = hash(orderedFacts(prepared)), publishedHash = hash(orderedFacts(publishedPayloads));
    const controls = batch.sourceControlTotals.map(control=>({ measure:control.measure,currency:control.currency,selectedRows:control.selectedRows,
      selectedAmount:control.selectedAmount,assignedAmount:control.assignedAmount,unmatchedAmount:control.unmatchedAmount,
      unallocatedAmount:control.unallocatedAmount,difference:control.difference }));
    const knownControlDifferencesZero = controls.every(control=>control.difference===null || money(control.difference).isZero());
    const evidence = { stage:"11", kind:"READ_ONLY_SOURCE_PUBLICATION_RECONCILIATION", status: executionSucceeded && knownControlDifferencesZero && sourceHash===publishedHash ? "PASS" : "REVIEW_REQUIRED",
      observedAt:new Date().toISOString(), target:{database:identity.database,role:identity.role,hostSha256:hash(target.hostname)},
      partition:{platform,scopeKeyHash:hash(scopeKey),date,productName:args.product??null}, databaseWrites:0, providerCalls:0,
      snapshots:"Source/configuration and report are separate read-only snapshots; a concurrent source/configuration change can require replay.",
      executionSucceeded, knownControlDifferencesZero, sourceFacts:prepared.length,publishedFacts:published.facts.length, sourceHash,publishedHash,
      publication:published.publications.map(p=>({runId:p.runId,revision:p.revision,publishedAt:p.run.publishedAt?.toISOString()??null,versions:p.run.versions})),
      versions:configuration.versions, sourceControls:controls,
      source:{knownTotals:source.knownTotals,completeTotals:source.completeTotals,scopeBalances:source.scopeBalances,issues:source.issues},
      published:{knownTotals:stored.knownTotals,completeTotals:stored.completeTotals,scopeBalances:stored.scopeBalances,issues:stored.issues},
      quality:batch.coverage.map(c=>({component:c.component,participation:c.participation,collectionState:c.collectionState,rowsPresent:c.rowsPresent,
        missingCostRows:c.missingCostRows,isEstimate:c.quality.isEstimate,issues:c.quality.issues,sourceAsOf:c.sourceAsOf})) };
    const output = args.output ?? "docs/product-performance/research/11-data-reconciliation.json";
    writeFileSync(output,JSON.stringify(evidence,null,2)+"\n");
    console.log(JSON.stringify({status:evidence.status,platform,date,sourceFacts:prepared.length,publishedFacts:published.facts.length,output}));
    if (evidence.status!=="PASS") process.exitCode=2;
  } finally { await client.$disconnect(); }
}
main().catch(error => {
  const message=String(error?.message??'');
  const evidence={stage:11,status:'FAIL_EXCEPTION',databaseWrites:0,providerCalls:0,
    errorClass:error?.constructor?.name??'Error',prismaCode:/^P\d{4}$/.test(error?.code??'')?error.code:null,
    databaseCode:/^[0-9A-Z]{5}$/.test(error?.meta?.code??'')?error.meta.code:null,
    permissionObject:message.match(/permission denied for (?:schema|table|function) ["']?([a-z0-9_]+)/i)?.[1]??null,
    transactionExpired:/transaction.*(?:expired|closed)|expired.*transaction/i.test(message)};
  const output=process.argv.find(value=>value.startsWith('--output='))?.slice(9);
  if(output&&/^docs\/product-performance\/research\/11-[a-z0-9-]+\.json$/.test(output))writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
  console.error("STAGE11_RECONCILIATION_FAILED_NO_RAW_ERROR_LOGGED");process.exitCode=1;
});
