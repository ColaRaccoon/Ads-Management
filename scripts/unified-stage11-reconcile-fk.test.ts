import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedManagementService } from "../apps/api/src/unified-performance/management.service";
import { UnifiedAggregationRepository } from "../apps/api/src/unified-performance/aggregation.repository";
import { normalizeAdDay } from "../apps/api/src/unified-performance/adapters/ad-source";
import { prepareReportBatch } from "../apps/api/src/unified-performance/domain/report-calculation";
import { CONTRACT_VERSION, type AdapterRequest } from "../apps/api/src/unified-performance/types";

test("owner-revoked SELECT reproduces FK failure; minimal owner SELECT permits config and atomic publication with FORCE RLS intact", async () => {
  const urls = Object.fromEntries(["owner","report","worker"].map(role => {
    const value=process.env[`UNIFIED_STAGE11_FK_${role.toUpperCase()}_URL`];assert(value);
    const url=new URL(value);assert.equal(url.hostname,"127.0.0.1");assert.equal(url.port,"55461");assert.equal(url.pathname,"/unified_stage11_roles");
    assert.equal(url.username,role==="owner"?"fixture_owner":`meta_ads_unified_${role}`);return [role,value];
  }));
  const owner=new PrismaClient({datasourceUrl:urls.owner}),report=new PrismaClient({datasourceUrl:urls.report}),worker=new PrismaClient({datasourceUrl:urls.worker});
  const evidence: Record<string,unknown>={stage:11,kind:"OWNER_CONTEXT_FK_CONFIGURATION_PUBLICATION_REHEARSAL",remoteWrites:0,status:"RUNNING",checks:[]};
  const checks=evidence.checks as string[];
  try {
    const [identity]=await owner.$queryRaw<Array<{database:string;role:string;version:string}>>`SELECT current_database() AS database,current_user AS role,current_setting('server_version_num') AS version`;
    assert.equal(identity.database,"unified_stage11_roles");assert.equal(identity.role,"fixture_owner");assert.match(identity.version,/^17/);
    // Local-only negative setup recreates the foundation owner's revoked parent-key ACL.
    await owner.$executeRawUnsafe('REVOKE SELECT(id),UPDATE(id) ON meta_ads.unified_products FROM meta_ads_app');
    await owner.$executeRawUnsafe('REVOKE SELECT(id,source_system,platform,scope_key,business_date),UPDATE(id) ON meta_ads.unified_aggregation_runs FROM meta_ads_app');
    const actor={id:randomUUID(),permissions:["products.manage","mappings.manage"] as Array<"products.manage"|"mappings.manage">};
    await owner.appUser.create({data:{id:actor.id,name:"격리 FK 검증"}});
    process.env.UNIFIED_PERFORMANCE_ENABLED="true";
    const service=new UnifiedManagementService(new UnifiedManagementRepository(report as unknown as PrismaService));
    const product=(await service.saveProduct({canonicalName:"FK 검증표본",reason:"격리 owner context 검증"},actor)).product;
    checks.push("Actual restricted report service product INSERT and actor audit succeed");
    const rule={kind:"NAME" as const,productId:product.id,platform:"META" as const,scopeKey:null,payload:{matchType:"EXACT",terms:["FK 검증표본"],nameField:"adset_name"},validFrom:"2026-10-28",reason:"격리 FK 참조 검증"};
    await assert.rejects(service.saveRule(rule,actor),/permission denied for table unified_products/);
    assert.equal(await report.unifiedRule.count(),0);
    checks.push("Actual report service NAME INSERT reproduces permission denied unified_products and rolls back");
    await owner.$executeRawUnsafe('GRANT SELECT(id) ON meta_ads.unified_products TO meta_ads_app');
    await assert.rejects(service.saveRule(rule,actor),/permission denied for table unified_products/);
    checks.push("Owner SELECT alone is insufficient for RI FOR KEY SHARE row locking");
    await owner.$executeRawUnsafe('GRANT UPDATE(id) ON meta_ads.unified_products TO meta_ads_app');
    const saved=await service.saveRule(rule,actor);assert(saved.rule.id);
    assert.equal(await report.unifiedMappingAudit.count(),2);
    checks.push("Owner SELECT(id) plus UPDATE(id) on unified_products fixes actual NAME save/audit; broad SELECT/UPDATE remain absent");

    const repository=new UnifiedAggregationRepository(worker as unknown as PrismaService),date="2026-10-28",scope=randomUUID();
    const queued=await repository.enqueue([{platform:"META",scopeKey:scope,date}],actor.id,"격리 FK 발행 검증","fk-publication");
    const claim=await repository.claim(queued.jobs[0].jobId);assert(claim);
    const request:AdapterRequest={contractVersion:CONTRACT_VERSION,runId:claim.runId,readSnapshotId:randomUUID(),from:date,to:date,scopeKeys:[scope],platforms:["META"],scopePolicyVersion:"scope-v1",nameRuleVersion:"name-v1",saleUnitRuleVersion:"unit-v1",allocationRuleVersion:"allocation-v1",calculationVersion:"unified-report-v1",fxVersion:"fixed",sourcePolicySnapshot:{},sourceWatermarks:{},cursor:null,limit:100};
    const batch=normalizeAdDay(request,{platform:"META",date,scopeKey:scope,currency:"USD",timeZone:"Asia/Seoul",selectedSource:"API",complete:true,sourceIssues:[],storedCoverage:null,excludedRows:0,fx:{rate:"1",sourceDate:date,provider:"FIXTURE",fallbackType:"EXACT"},
      rows:[{id:"fixture-row",entityKey:"fixture-ad",originalName:"FK 검증표본",source:"API",sourceVersion:"1",runOrUploadId:"fixture-only",observedAt:"2026-10-29T00:00:00Z",updatedAt:"2026-10-29T00:00:00Z",amount:"100",conversionRevenue:null}],configuration:{products:[{canonicalName:"FK 검증표본",active:true}],nameRules:[]}});
    const facts=prepareReportBatch(request,batch,[]);
    await assert.rejects(repository.stageAndPublish(claim,request,batch,facts),/permission denied for table unified_aggregation_runs/);
    assert.equal(await report.unifiedDailyFact.count(),0);assert.equal(await report.unifiedSourcePublication.count(),0);
    checks.push("Actual worker stageAndPublish reproduces FK owner unified_aggregation_runs SELECT denial atomically");
    await owner.$executeRawUnsafe('GRANT SELECT(id) ON meta_ads.unified_aggregation_runs TO meta_ads_app');
    await assert.rejects(repository.stageAndPublish(claim,request,batch,facts),/permission denied for table unified_aggregation_runs/);
    await owner.$executeRawUnsafe('GRANT UPDATE(id) ON meta_ads.unified_aggregation_runs TO meta_ads_app');
    try {
      await repository.stageAndPublish(claim,request,batch,facts);
      checks.push("Owner SELECT(id)/UPDATE(id) suffices for both single and composite publication parent checks");
    } catch(error) {
      assert.match(error instanceof Error?error.message:String(error),/permission denied for table unified_aggregation_runs/);
      assert.equal(await report.unifiedDailyFact.count(),0);
      checks.push("Owner SELECT(id)/UPDATE(id) alone cannot satisfy the composite publication FK; atomic rollback preserved");
      await owner.$executeRawUnsafe('GRANT SELECT(source_system,platform,scope_key,business_date) ON meta_ads.unified_aggregation_runs TO meta_ads_app');
      await repository.stageAndPublish(claim,request,batch,facts);
    }
    assert.equal((await report.unifiedAggregationRun.findUniqueOrThrow({where:{id:claim.runId}})).status,"PUBLISHED");
    assert.equal((await report.unifiedDailyFact.findFirstOrThrow({where:{runId:claim.runId}})).amountKrw?.toFixed(),"100");
    assert.equal(await report.unifiedSourcePublication.count(),1);
    checks.push("Minimal FK-key SELECT plus UPDATE(id) permits actual fact/coverage/match/READY/pointer/PUBLISHED transaction");
    evidence.ownerPrivileges=await owner.$queryRaw`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege('meta_ads_app',c.oid,'SELECT') owner_table_select,has_table_privilege('meta_ads_app',c.oid,'UPDATE') owner_table_update,has_column_privilege('meta_ads_app',c.oid,'id','SELECT') owner_id_select,has_column_privilege('meta_ads_app',c.oid,'id','UPDATE') owner_id_update FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relname IN ('unified_products','unified_aggregation_runs') ORDER BY c.relname`;
    for(const row of evidence.ownerPrivileges as Array<{relrowsecurity:boolean;relforcerowsecurity:boolean;owner_table_select:boolean;owner_table_update:boolean;owner_id_select:boolean;owner_id_update:boolean}>){assert(row.relrowsecurity);assert(row.relforcerowsecurity);assert(row.owner_id_select);assert(row.owner_id_update);assert.equal(row.owner_table_select,false);assert.equal(row.owner_table_update,false);}
    const direct=await owner.$transaction(async tx=>{await tx.$executeRawUnsafe('SET LOCAL ROLE meta_ads_app');return tx.$queryRaw<Array<{products:bigint;runs:bigint}>>`SELECT (SELECT count(*) FROM meta_ads.unified_products) products,(SELECT count(*) FROM meta_ads.unified_aggregation_runs) runs`;});
    assert.equal(direct[0].products,0n);assert.equal(direct[0].runs,0n);
    checks.push("FORCE RLS still hides direct owner rows; no broad owner UPDATE, new owner policy, runtime expansion or source grant was added");
    evidence.status="PASS";
  } catch(error) {evidence.status="FAIL";evidence.error=error instanceof Error?error.message:"UNKNOWN";throw error;}
  finally {await Promise.all([owner.$disconnect(),report.$disconnect(),worker.$disconnect()]);writeFileSync("docs/product-performance/research/11-data-fk-fixture.json",JSON.stringify(evidence,null,2)+"\n");}
});
