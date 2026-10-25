// Disposable loopback PostgreSQL and synthetic provider rows only.
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../../apps/api/src/common/prisma.service";
import { HeavyOperationGate } from "../../../apps/api/src/common/heavy-operation";
import { SyncFoundationService } from "../../../apps/api/src/daily-sync/sync-foundation.service";
import { CanonicalApiWriterService } from "../../../apps/api/src/daily-sync/canonical-api-writer.service";
import { MappingsService } from "../../../apps/api/src/mappings/mappings.service";
import { MetaEntityWriterService } from "../../../apps/api/src/uploads/meta-entity-writer.service";
import { MetaMetricVersionService } from "../../../apps/api/src/uploads/meta-metric-version.service";
import { CreativeNameParser } from "../../../apps/api/src/domain/creative-name-parser";
import { occurrence } from "../../../apps/api/src/daily-sync/scheduled-occurrence";
import { validatedMetaApiDays } from "../../../apps/api/src/common/meta-source-read-coverage";
const raw=process.env.META_DAILY_TEST_URL;
test("real PG daily -> changed weekly -> repeated manual preserves history and selects one current adset cost",{skip:!raw},async t=>{
 assert(raw);const url=new URL(raw);assert.equal(url.hostname,"127.0.0.1");assert.equal(url.port,"55436");assert.equal(url.pathname,"/meta_daily_proof");
 // Keep this synthetic fixture after its same-day 02:03 anchor even when CI
 // runs just after midnight. No production clock or provider is involved.
 const localClock=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Seoul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date());
 if(localClock<"02:04")t.mock.timers.enable({apis:["Date"],now:Date.now()+3*3600000});
 const before={...process.env};const id=randomUUID(),account=`local-meta-${randomUUID()}`,ref=`synthetic:${randomUUID()}`,expiry=new Date(Date.now()+30*86400000);
 const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const daily={key:"local-meta-daily",connectionId:id,anchorAt:new Date(today+"T02:03:00+09:00").toISOString(),windowMinutes:100,kind:"META_DAILY"as const};
 const weekly={key:"local-meta-weekly",connectionId:id,anchorAt:new Date(today+"T02:02:00+09:00").toISOString(),windowMinutes:90};
 Object.assign(process.env,{DATABASE_URL:raw,DAILY_SYNC_FEATURE_ENABLED:"true",DAILY_SYNC_ALLOWED_ACCOUNTS:JSON.stringify([`META/${account}/default`]),DAILY_SYNC_SCHEDULES:JSON.stringify([weekly,daily]),PRISMA_IDLE_DISCONNECT_MS:"0"});
 const db=new PrismaService();const foundation=new SyncFoundationService(db,new HeavyOperationGate({heavyOperationConcurrency:1}as any,new Reflector()));
 const writer=new CanonicalApiWriterService(db,foundation,new MappingsService(db),new MetaEntityWriterService(db),new MetaMetricVersionService(db));
 try{
  const actor=await db.appUser.create({data:{name:"Synthetic daily proof",role:"SUPER_ADMIN",inviteStatus:"ACTIVE"}});
  await db.sourceConnection.create({data:{id,provider:"META",externalAccountId:account,shopKey:"default",displayName:"Synthetic Meta",currencyCode:"USD",timeZone:"Asia/Seoul",enabled:true,accessState:"READY",credentialRef:ref,credentialExpiresAt:expiry}});
  const d=occurrence(daily,"META","Asia/Seoul",daily.anchorAt),w=occurrence(weekly,"META","Asia/Seoul",weekly.anchorAt),day=d.toDate,date=new Date(day+"Z");
  for(const dataKind of ["META_AD","META_ADSET"]as const)await db.sourcePolicy.create({data:{connectionId:id,dataKind,primarySource:"API",fromDate:new Date(w.fromDate+"Z"),version:1,reason:"SYNTHETIC_DAILY_WEEKLY"}});
  const metrics=async()=>{const sets=await db.metaAdsetDailyMetric.findMany({where:{connectionId:id,metricDate:date,source:"API",isCurrent:true}});const ads=await db.metaAdDailyMetric.count({where:{connectionId:id,metricDate:date,source:"API",isCurrent:true}});return{sets:sets.length,ads,spend:sets.reduce((sum,r)=>sum+Number(r.spendUsd),0)};};
  async function publish(runId:string,claim:any,at:Date,version:number,zero=false){const base=(i:number)=>({campaignId:`10${i}`,campaignName:`Synthetic ${i}`,adsetId:`20${i}`,adsetName:`Synthetic set ${i}`,sourceRevision:`synthetic-${version}-${i}`,spendUsd:String(version*i),impressions:"100",inlineLinkClicks:0,purchaseCount:null,resultCount:0,reach:100,attributionSetting:"7d_click",actionReportTime:"conversion",attributionWindows:["7d_click"],metricUnavailableReasons:{},shopClicks:0,landingPageViews:0,clicksAll:0});const sets=zero?[]:[1,2].map(base);const ads=sets.map((s,i)=>{const adName=`1024_Synthetic${i}_01_IG`;return{...s,purchaseCount:0,adId:`30${i}`,adName,creative:new CreativeNameParser().parse(adName),videoPlay3sCount:0,videoPlay25Count:0,videoPlay50Count:0,videoPlay75Count:0,videoPlay100Count:0,addToCartCount:0};});await writer.publishMetaDay({runId,connectionId:id,generation:claim.generation,metricDate:at,pageCount:1,adPolicyVersion:1,adsetPolicyVersion:1,expectedCredentialRef:ref,expectedCredentialExpiresAt:expiry,ads:ads as any,adsets:sets as any});}
  const dailyRun=await foundation.queueRun({connectionId:id,fromDate:d.fromDate,toDate:d.toDate,trigger:"SCHEDULED",actorUserId:null,requestKey:d.requestKey});const first=await foundation.claimRun(dailyRun.id,Date.now()+65000);assert(first);try{await publish(dailyRun.id,first,date,1);await foundation.finishRun(first);}finally{first.release();}assert.deepEqual(await metrics(),{sets:2,ads:2,spend:3});
  const weeklyRun=await foundation.queueRun({connectionId:id,fromDate:w.fromDate,toDate:w.toDate,trigger:"SCHEDULED",actorUserId:null,requestKey:w.requestKey});const second=await foundation.claimRun(weeklyRun.id,Date.now()+120000);assert(second);try{for(let offset=0;offset<7;offset++){const at=new Date(Date.parse(w.fromDate+"Z")+offset*86400000);await publish(weeklyRun.id,second,at,2,offset!==6);}await foundation.finishRun(second);}finally{second.release();}assert.deepEqual(await metrics(),{sets:2,ads:2,spend:6});
  assert.equal((await db.syncRun.findUniqueOrThrow({where:{id:dailyRun.id}})).status,"SUCCEEDED");assert.equal((await db.syncRun.findUniqueOrThrow({where:{id:weeklyRun.id}})).status,"SUCCEEDED");assert.equal(await db.runUnit.count({where:{runId:weeklyRun.id,status:"SUCCEEDED"}}),7);
  const manual=await foundation.queueRun({connectionId:id,fromDate:day,toDate:day,trigger:"MANUAL",actorUserId:actor.id,requestKey:`manual:${randomUUID()}`});const third=await foundation.claimRun(manual.id,Date.now()+65000);assert(third);try{await publish(manual.id,third,date,2);await foundation.finishRun(third);}finally{third.release();}assert.deepEqual(await metrics(),{sets:2,ads:2,spend:6});
  for(const kind of ["META_AD","META_ADSET"]as const)assert.equal((await validatedMetaApiDays(db,kind,[id],date,date)).size,1);
  assert.equal(await db.sourceRecordLink.count({where:{connectionId:id,source:"API",isCurrent:true}}),4);
  console.log(JSON.stringify({localPostgres:true,syntheticProvider:true,realProviderRequests:0,dailyUnits:1,weeklyUnits:7,dailyCost:3,correctedCost:6,repeatedCost:6,currentAds:2,currentAdsets:2,currentLinks:4,priorRunPreserved:true,readCoverageVerified:true}));
 }finally{await db.$disconnect();process.env=before;t.mock.timers.reset();}
});
