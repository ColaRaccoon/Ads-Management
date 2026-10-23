// Synthetic complete-day fixtures on a new native loopback cluster only.
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {Reflector} from "@nestjs/core";
import {Prisma,SyncTrigger} from "@prisma/client";
import {PrismaService} from "../../../apps/api/src/common/prisma.service";
import {HeavyOperationGate} from "../../../apps/api/src/common/heavy-operation";
import {selectCurrentSourceRows} from "../../../apps/api/src/common/source-read-policy";
import {SyncFoundationService} from "../../../apps/api/src/daily-sync/sync-foundation.service";
import {CanonicalApiWriterService} from "../../../apps/api/src/daily-sync/canonical-api-writer.service";
import {GoogleCanonicalWriterService} from "../../../apps/api/src/daily-sync/google-canonical-writer.service";
import {MetaEntityWriterService} from "../../../apps/api/src/uploads/meta-entity-writer.service";
import {MetaMetricVersionService} from "../../../apps/api/src/uploads/meta-metric-version.service";
import {MappingsService} from "../../../apps/api/src/mappings/mappings.service";
import {CreativeNameParser} from "../../../apps/api/src/domain/creative-name-parser";
import {assertOldAppRollbackReady,inspectOldAppRollbackReadiness} from "../../../apps/api/src/daily-sync/old-app-rollback-readiness";
const raw=process.env.PHASE10_API_SYNTHETIC_TEST_URL;
const stable=(v:any):string=>v===null||typeof v!=="object"?typeof v==="bigint"?JSON.stringify(v.toString()):JSON.stringify(v):v instanceof Date?JSON.stringify(v.toISOString()):Prisma.Decimal.isDecimal(v)?JSON.stringify(v.toString()):Array.isArray(v)?`[${v.map(stable).join(",")}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
const hash=(v:any)=>createHash("sha256").update(stable(v)).digest("hex");
const spec=[{model:"metaAdDailyMetric",kind:"META_AD",table:"meta_ad_daily_metrics"},{model:"metaAdsetDailyMetric",kind:"META_ADSET",table:"meta_adset_daily_metrics"},{model:"googleCampaignDailyCost",kind:"GOOGLE_CAMPAIGN",table:"google_campaign_daily_costs"}];
test("actual Meta ad/adset and Google writers complete-day before-image CAS, feature off/on and old-app return",{skip:!raw},async()=>{
 assert(raw);const url=new URL(raw);assert.equal(url.hostname,"127.0.0.1");assert.equal(url.port,"55437");assert.equal(url.pathname,"/phase10_independent_rollback_20261020");
 const saved={...process.env};Object.assign(process.env,{DATABASE_URL:raw,DAILY_SYNC_FEATURE_ENABLED:"true",PRISMA_IDLE_DISCONNECT_MS:"0"});
 const db=new PrismaService();const foundation=new SyncFoundationService(db,new HeavyOperationGate({heavyOperationConcurrency:1} as any,new Reflector()));
 const metaWriter=new CanonicalApiWriterService(db,foundation,new MappingsService(db),new MetaEntityWriterService(db),new MetaMetricVersionService(db));const googleWriter=new GoogleCanonicalWriterService(foundation);
 const require=createRequire(import.meta.url);const Old=require(process.env.PHASE10_API_OLD_CLIENT_PATH!);const old=new Old.PrismaClient({datasourceUrl:raw});
 try{
  const day="2026-10-19",at=new Date(`${day}Z`),account=`synthetic-${randomUUID()}`,expiry=new Date(Date.now()+30*86400000),ref=`synthetic:${randomUUID()}`;
  const user=await db.appUser.create({data:{name:"Synthetic rollback owner",role:"SUPER_ADMIN"}});
  const product=await db.product.create({data:{code:randomUUID(),name:"Unrelated product",displayName:"Before"}});
  const meta=await db.sourceConnection.create({data:{provider:"META",externalAccountId:account,shopKey:"default",displayName:"Synthetic Meta",currencyCode:"USD",timeZone:"Asia/Seoul",enabled:true,accessState:"READY",credentialRef:ref,credentialExpiresAt:expiry}});
  const google=await db.sourceConnection.create({data:{provider:"GOOGLE",externalAccountId:account,shopKey:"default",displayName:"Synthetic Google",currencyCode:"KRW",timeZone:"Asia/Seoul",enabled:true,accessState:"READY",credentialExpiresAt:expiry}});
  process.env.DAILY_SYNC_ALLOWED_ACCOUNTS=JSON.stringify([`META/${account}/default`,`GOOGLE/${account}/default`]);
  for(const entry of spec)await db.sourcePolicy.create({data:{connectionId:entry.kind==="GOOGLE_CAMPAIGN"?google.id:meta.id,dataKind:entry.kind as any,primarySource:"API",fromDate:at,version:1,effectiveAt:new Date(),reason:"SYNTHETIC_REVIEWED"}});
  const publish=async(version:number)=>{
   const runs=[];
   for(const c of [meta,google]){
    const run=await foundation.queueRun({connectionId:c.id,fromDate:day,toDate:day,trigger:SyncTrigger.MANUAL,actorUserId:user.id,requestKey:`synthetic:${randomUUID()}`});const claim=await foundation.claimRun(run.id,Date.now()+65000);assert(claim);
    try{
     if(c.id===meta.id){
      const base=(i:number)=>({campaignId:`10${i}`,campaignName:`Synthetic campaign ${i}`,adsetId:`20${i}`,adsetName:`Synthetic set ${i}`,sourceRevision:`synthetic-v${version}-${i}`,spendUsd:`${version*i}.0000`,impressions:"100",inlineLinkClicks:0,purchaseCount:null,resultCount:0,reach:100,attributionSetting:"7d_click",actionReportTime:"conversion",attributionWindows:["7d_click"],metricUnavailableReasons:{},shopClicks:0,landingPageViews:0,clicksAll:0});
      const adsets=[1,2].map(base);const ads=adsets.map((r,i)=>{const adName=`1019_Synthetic${i}_01_IG`;return {...r,purchaseCount:0,adId:`30${i}`,adName,creative:new CreativeNameParser().parse(adName),videoPlay3sCount:0,videoPlay25Count:0,videoPlay50Count:0,videoPlay75Count:0,videoPlay100Count:0,addToCartCount:0};});
      assert.equal((await metaWriter.publishMetaDay({runId:run.id,connectionId:c.id,generation:claim.generation,metricDate:at,pageCount:1,adPolicyVersion:version===1?1:3,adsetPolicyVersion:version===1?1:3,expectedCredentialRef:ref,expectedCredentialExpiresAt:expiry,ads:ads as any,adsets:adsets as any})).published,4);
     }else{
      const rows=[1,2].map(i=>({campaignId:`40${i}`,campaignName:`Synthetic campaign ${i}`,channelType:"SEARCH",costMicros:BigInt(version*i*1000000),impressions:100n,clicks:0n}));
      assert.equal((await googleWriter.publish({runId:run.id,connectionId:c.id,generation:claim.generation,metricDate:at,policyVersion:version===1?1:3,snapshot:{rows,accountCostMicros:BigInt(version*3*1000000),pageCount:1,currencyCode:"KRW",timeZone:"Asia/Seoul"} as any})).published,2);
     }
     await foundation.finishRun(claim);runs.push(run.id);
    }finally{claim.release();}
   }return runs;
  };
  const ids=[meta.id,google.id];
  const capture=async(client:any)=>{
   const records:any={};for(const entry of spec)records[entry.model]=await client[entry.model].findMany({where:{connectionId:{in:ids},metricDate:at,source:"API",isCurrent:true},orderBy:{id:"asc"}});
   return {records,links:await client.sourceRecordLink.findMany({where:{connectionId:{in:ids},source:"API",isCurrent:true},orderBy:{id:"asc"}}),coverage:await client.sourceCoverage.findMany({where:{connectionId:{in:ids},metricDate:at},orderBy:{dataKind:"asc"}}),policies:await client.sourcePolicy.findMany({where:{connectionId:{in:ids}},orderBy:{dataKind:"asc"}})};
  };
  await publish(1);
  for(const entry of spec)assert.equal((await db.sourcePolicy.updateMany({where:{connectionId:entry.kind==="GOOGLE_CAMPAIGN"?google.id:meta.id,dataKind:entry.kind as any,primarySource:"API",version:1},data:{primarySource:"CSV",version:2,reason:"SYNTHETIC_BEFORE_IMAGE_SOURCE_OFF"}})).count,1);
  const before=await capture(db);assert.equal(before.links.length,6);assert.equal(before.coverage.length,3);assert.equal(Object.values(before.records).flat().length,6);
  const firstAttempt=before.coverage.map((c:any)=>c.lastAttemptRunId);
  for(const policy of before.policies)assert.equal((await db.sourcePolicy.updateMany({where:{id:policy.id,primarySource:"CSV",version:2},data:{primarySource:"API",version:3,reason:"SYNTHETIC_ACTIVATION"}})).count,1);
  await publish(2);const after=await capture(db);assert.equal(Object.values(after.records).flat().length,6);assert.notDeepEqual(firstAttempt,after.coverage.map((c:any)=>c.lastAttemptRunId));
  const inactive:any={};for(const entry of spec)inactive[entry.model]=await (db as any)[entry.model].findMany({where:{id:{in:before.records[entry.model].map((r:any)=>r.id)}},orderBy:{id:"asc"}});
  const inactiveLinks=await db.sourceRecordLink.findMany({where:{id:{in:before.links.map((r:any)=>r.id)}},orderBy:{id:"asc"}});
  if(process.env.PHASE10_API_MULTI_SOURCE_EVIDENCE)writeFileSync(process.env.PHASE10_API_MULTI_SOURCE_EVIDENCE,JSON.stringify({kind:"SYNTHETIC_COMPLETE_FIXTURE_MULTI_SOURCE_MANIFEST",before,after,beforeInactive:inactive,beforeInactiveLinks:inactiveLinks},(_k,v)=>typeof v==="bigint"?v.toString():v,2),{flag:"wx"});
  for(const entry of spec){
   const rows=after.records[entry.model];process.env.DAILY_SYNC_FEATURE_ENABLED="true";assert.equal((await selectCurrentSourceRows(db,entry.kind as any,rows,(r:any)=>r.metricDate)).length,2);
   process.env.DAILY_SYNC_FEATURE_ENABLED="false";assert.equal((await selectCurrentSourceRows(db,entry.kind as any,rows,(r:any)=>r.metricDate)).length,0);
  }process.env.DAILY_SYNC_FEATURE_ENABLED="true";
  // Later CSV rows are model fixtures with real batch/row/link provenance; API uses real writers above.
  const batch=await db.uploadBatch.create({data:{originalFilename:"synthetic.csv",fileHashSha256:hash(randomUUID()),columnSchema:[],status:"IMPORTED"}});const csvIds:any={};let number=0;
  for(const entry of spec.filter(e=>e.kind!=="GOOGLE_CAMPAIGN")){
   const r=before.records[entry.model][0];const uploadRow=await db.uploadRow.create({data:{uploadBatchId:batch.id,rowNumber:++number,sourceRowHash:hash(randomUUID()),rawRow:{synthetic:true}}});
   const {id,...data}=r;const csv=await (db as any)[entry.model].create({data:{...data,source:"CSV",uploadBatchId:batch.id,uploadRowId:uploadRow.id,rawRow:{synthetic:true},sourceRevision:null,syncRunId:null,isCurrent:true,supersededByMetricId:null,importVersion:2,spendUsd:new Prisma.Decimal("149")}});csvIds[entry.model]=csv.id;
   const link=before.links.find((x:any)=>x.recordId===r.id);assert(link);await db.sourceRecordLink.create({data:{connectionId:meta.id,dataKind:entry.kind as any,canonicalKeyHash:link.canonicalKeyHash,source:"CSV",recordTable:entry.table,recordId:csv.id,version:2,isCurrent:true,bindingMethod:"EXACT_ID"}});
  }
  for(const p of after.policies.filter(p=>p.dataKind!=="META_AD"))assert.equal((await db.sourcePolicy.updateMany({where:{id:p.id,version:p.version,primarySource:"API"},data:{primarySource:"CSV",version:4,reason:"USER_LATER_SELECTION",changedByUserId:user.id}})).count,1);
  await db.product.update({where:{id:product.id},data:{displayName:"USER_LATER_EDIT"}});
  const preserved=hash({csv:await db.metaAdDailyMetric.findMany({where:{id:csvIds.metaAdDailyMetric}}),csvSet:await db.metaAdsetDailyMetric.findMany({where:{id:csvIds.metaAdsetDailyMetric}}),csvLinks:await db.sourceRecordLink.findMany({where:{connectionId:meta.id,source:"CSV"},orderBy:{id:"asc"}}),policies:await db.sourcePolicy.findMany({where:{connectionId:{in:ids},dataKind:{not:"META_AD"}},orderBy:{id:"asc"}}),product:await db.product.findUnique({where:{id:product.id}})});
  await db.sourceConnection.updateMany({where:{id:{in:ids}},data:{enabled:false}});
  const rollback=async()=>db.$transaction(async tx=>{
   await tx.$queryRaw(Prisma.sql`SELECT id FROM source_connections WHERE id IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`);
   assert.equal(await tx.syncLease.count({where:{connectionId:{in:ids},expiresAt:{gt:new Date()}}}),0);
   const current=await capture(tx);assert.equal(hash(current.records),hash(after.records),"CURRENT_CONTENT_CHANGED");assert.equal(hash(current.links),hash(after.links),"CURRENT_LINK_CHANGED");assert.equal(hash(current.coverage),hash(after.coverage),"CURRENT_COVERAGE_CHANGED");
   for(const entry of spec){const actual=await (tx as any)[entry.model].findMany({where:{id:{in:before.records[entry.model].map((r:any)=>r.id)}},orderBy:{id:"asc"}});assert.equal(hash(actual),hash(inactive[entry.model]),"BEFORE_IMAGE_CHANGED");}
   assert.equal(hash(await tx.sourceRecordLink.findMany({where:{id:{in:before.links.map((r:any)=>r.id)}},orderBy:{id:"asc"}})),hash(inactiveLinks),"BEFORE_LINK_CHANGED");
   for(const entry of spec){const model=(tx as any)[entry.model];for(const r of after.records[entry.model])assert.equal((await model.updateMany({where:{id:r.id,connectionId:r.connectionId,source:"API",isCurrent:true,syncRunId:r.syncRunId},data:{isCurrent:false}})).count,1);for(const r of before.records[entry.model])assert.equal((await model.updateMany({where:{id:r.id,connectionId:r.connectionId,source:"API",isCurrent:false},data:{isCurrent:true,...(entry.kind!=="GOOGLE_CAMPAIGN"?{supersededByMetricId:r.supersededByMetricId}: {})}})).count,1);}
   assert.equal((await tx.sourceRecordLink.updateMany({where:{id:{in:after.links.map((r:any)=>r.id)},isCurrent:true,source:"API"},data:{isCurrent:false}})).count,6);
   assert.equal((await tx.sourceRecordLink.updateMany({where:{id:{in:before.links.map((r:any)=>r.id)},isCurrent:false,source:"API"},data:{isCurrent:true}})).count,6);
   for(const old of before.coverage){const {connectionId,dataKind,metricDate,lastAttemptAt,lastAttemptRunId,...content}=old;assert.equal((await tx.sourceCoverage.updateMany({where:{connectionId,dataKind,metricDate,lastSuccessRunId:after.coverage.find((c:any)=>c.connectionId===connectionId&&c.dataKind===dataKind).lastSuccessRunId},data:content})).count,1);}
   let skippedPolicies=0,restoredPolicies=0;for(const p of after.policies){const currentPolicy=await tx.sourcePolicy.findUniqueOrThrow({where:{id:p.id}});if(hash(currentPolicy)!==hash(p)){skippedPolicies++;continue;}const desired=before.policies.find((b:any)=>b.id===p.id);assert(desired);assert.equal((await tx.sourcePolicy.updateMany({where:{id:p.id,version:p.version,primarySource:p.primarySource},data:{primarySource:desired.primarySource,version:p.version+1,reason:"SYNTHETIC_BEFORE_IMAGE_ROLLBACK"}})).count,1);restoredPolicies++;}assert.equal(skippedPolicies,2);assert.equal(restoredPolicies,1);
   await tx.securityAuditEvent.create({data:{actorType:"USER",actorUserId:user.id,action:"SYNTHETIC_MULTI_SOURCE_ROLLBACK",targetType:"SOURCE_CONNECTION",targetId:meta.id,result:"SUCCESS",afterJson:{beforeSha256:hash(before),afterSha256:hash(after),skippedPolicies,restoredPolicies}}});
  },{isolationLevel:"Serializable",timeout:10000});
  // Three different CAS fences reject with no partial row/link/coverage writes.
  const unchanged=()=>capture(db);
  const tamper=async(change:()=>Promise<any>,restore:()=>Promise<any>,reason:string)=>{await change();const b=await unchanged();await assert.rejects(rollback(),new RegExp(reason));assert.equal(hash(await unchanged()),hash(b));await restore();};
  const second=after.records.googleCampaignDailyCost[0];await tamper(()=>db.googleCampaignDailyCost.update({where:{id:second.id},data:{costMicros:999n}}),()=>db.googleCampaignDailyCost.update({where:{id:second.id},data:{costMicros:second.costMicros}}),"CURRENT_CONTENT_CHANGED");
  const cov=after.coverage[0];await tamper(()=>db.sourceCoverage.update({where:{connectionId_dataKind_metricDate:{connectionId:cov.connectionId,dataKind:cov.dataKind,metricDate:at}},data:{state:"FAILED"}}),()=>db.sourceCoverage.update({where:{connectionId_dataKind_metricDate:{connectionId:cov.connectionId,dataKind:cov.dataKind,metricDate:at}},data:{state:cov.state}}),"CURRENT_COVERAGE_CHANGED");
  const stale=inactive.googleCampaignDailyCost[0];await tamper(()=>db.googleCampaignDailyCost.update({where:{id:stale.id},data:{campaignName:"TAMPER"}}),()=>db.googleCampaignDailyCost.update({where:{id:stale.id},data:{campaignName:stale.campaignName}}),"BEFORE_IMAGE_CHANGED");
  await rollback();const restored=await capture(db);
  for(const entry of spec){assert.deepEqual(restored.records[entry.model].map((r:any)=>r.id),before.records[entry.model].map((r:any)=>r.id));assert.equal(restored.records[entry.model].every((r:any)=>(entry.kind==="GOOGLE_CAMPAIGN"?r.version:r.importVersion)===1),true);}
  assert.equal(hash(restored.links),hash(before.links));for(const c of restored.coverage){const b=before.coverage.find((v:any)=>v.connectionId===c.connectionId&&v.dataKind===c.dataKind),a=after.coverage.find((v:any)=>v.connectionId===c.connectionId&&v.dataKind===c.dataKind);assert.equal(c.lastSuccessRunId,b.lastSuccessRunId);assert.equal(c.lastAttemptRunId,a.lastAttemptRunId);}
  await assert.rejects(rollback(),/CURRENT_CONTENT_CHANGED/);assert.equal(await db.securityAuditEvent.count({where:{action:"SYNTHETIC_MULTI_SOURCE_ROLLBACK",targetId:meta.id}}),1);
  assert.equal(hash({csv:await db.metaAdDailyMetric.findMany({where:{id:csvIds.metaAdDailyMetric}}),csvSet:await db.metaAdsetDailyMetric.findMany({where:{id:csvIds.metaAdsetDailyMetric}}),csvLinks:await db.sourceRecordLink.findMany({where:{connectionId:meta.id,source:"CSV"},orderBy:{id:"asc"}}),policies:await db.sourcePolicy.findMany({where:{connectionId:{in:ids},dataKind:{not:"META_AD"}},orderBy:{id:"asc"}}),product:await db.product.findUnique({where:{id:product.id}})}),preserved);
  for(const entry of spec){const rows=await (db as any)[entry.model].findMany({where:{connectionId:entry.kind==="GOOGLE_CAMPAIGN"?google.id:meta.id,metricDate:at,isCurrent:true}});for(const enabled of ["false","true"]){process.env.DAILY_SYNC_FEATURE_ENABLED=enabled;const selected=await selectCurrentSourceRows(db,entry.kind as any,rows,(r:any)=>r.metricDate);assert(selected.every((r:any)=>r.source==="CSV"));assert.equal(selected.length,entry.kind==="GOOGLE_CAMPAIGN"?0:1);}}
  for(const entry of spec)await (db as any)[entry.model].updateMany({where:{connectionId:entry.kind==="GOOGLE_CAMPAIGN"?google.id:meta.id,source:"API",isCurrent:true},data:{isCurrent:false}});
  await db.sourceRecordLink.updateMany({where:{connectionId:{in:ids},source:"API",isCurrent:true},data:{isCurrent:false}});
  // Earlier independent fixture connections are already disabled and CSV policy restored.
  // No global policy rewrite: an owned, closed historical API policy is retained.
  const historical=await db.sourcePolicy.create({data:{connectionId:google.id,dataKind:"GOOGLE_CAMPAIGN",primarySource:"API",fromDate:new Date("2026-09-01Z"),toDate:new Date("2026-09-02Z"),version:1,effectiveAt:new Date(),reason:"HISTORICAL_MUST_SURVIVE"}});
  await db.$transaction(tx=>assertOldAppRollbackReady(tx,{stopConfirmed:true,schedulesPausedConfirmed:true,policyScope:{connectionIds:ids,fromDate:at,toDate:at}}),{isolationLevel:"RepeatableRead"});
  assert.equal(hash(await db.sourcePolicy.findUniqueOrThrow({where:{id:historical.id}})),hash(historical));
  assert.equal((await old.metaAdDailyMetric.findMany({where:{uploadBatchId:batch.id,isCurrent:true}})).length,1);assert.equal((await old.metaAdsetDailyMetric.findMany({where:{uploadBatchId:batch.id,isCurrent:true}})).length,1);
  await old.product.update({where:{id:product.id},data:{displayName:"OLD_APP_WRITE_AFTER_SAFE_RETURN"}});assert.equal((await old.product.findUniqueOrThrow({where:{id:product.id}})).displayName,"OLD_APP_WRITE_AFTER_SAFE_RETURN");
  // A current API row outside this manifest must remain blocked and unchanged.
  const unowned=await db.sourceConnection.create({data:{provider:"GOOGLE",externalAccountId:`unowned-${randomUUID()}`,shopKey:"default",displayName:"Synthetic outside manifest",currencyCode:"KRW",timeZone:"Asia/Seoul",enabled:false,accessState:"PENDING"}});
  const unownedRun=await db.syncRun.create({data:{connectionId:unowned.id,trigger:"MANUAL",requestKey:randomUUID(),fromDate:at,toDate:at,status:"SUCCEEDED"}});
  const foreign=await db.googleCampaignDailyCost.create({data:{connectionId:unowned.id,metricDate:at,campaignId:"9999",campaignName:"Outside manifest must survive",channelType:"SEARCH",costMicros:1n,impressions:1n,clicks:0n,source:"API",syncRunId:unownedRun.id,fetchedAt:new Date(),version:1,isCurrent:true}});
  const foreignHash=hash(foreign);const blockedForeign=await db.$transaction(tx=>inspectOldAppRollbackReadiness(tx,{stopConfirmed:true,schedulesPausedConfirmed:true,policyScope:{connectionIds:ids,fromDate:at,toDate:at}}),{isolationLevel:"RepeatableRead"});
  assert.equal(blockedForeign.ready,false);assert(blockedForeign.reasons.includes("API_CURRENT_REMAINS"));assert.equal(hash(await db.googleCampaignDailyCost.findUniqueOrThrow({where:{id:foreign.id}})),foreignHash);
  console.log(JSON.stringify({kind:"PHASE10_MULTI_SOURCE_SCOPED_ROLLBACK",actualWriters:["META_AD","META_ADSET","GOOGLE_CAMPAIGN"],completeFixtureKeysPerKind:2,publishedVersions:2,restoredMetricRows:6,restoredLinks:6,restoredCoverage:3,staleManifestRejected:true,tamperRejections:3,ownedPolicyCASRestores:1,laterPolicyCASWrites:0,laterCsvRowsPreserved:2,featureOffOn:true,oldClientReturn:true,historicalApiPolicyPreserved:true,unownedApiCurrentPreservedAndBlocked:true,providerRequests:0,remoteWrites:0,wholeDatabaseRestore:false,actualImageSwitch:false,metaTransport:"SYNTHETIC_NORMALIZED_GRAPH_INTERFACE_NOT_LIVE_MCP"}));
 }finally{await old.$disconnect();await db.$disconnect();for(const name of Object.keys(process.env))if(!(name in saved))delete process.env[name];Object.assign(process.env,saved);}
});
