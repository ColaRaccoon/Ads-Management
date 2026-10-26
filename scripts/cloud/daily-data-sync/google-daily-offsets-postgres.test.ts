import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../../apps/api/src/common/prisma.service";
import { HeavyOperationGate } from "../../../apps/api/src/common/heavy-operation";
import { SyncFoundationService } from "../../../apps/api/src/daily-sync/sync-foundation.service";
import { GoogleCanonicalWriterService } from "../../../apps/api/src/daily-sync/google-canonical-writer.service";
import { occurrence } from "../../../apps/api/src/daily-sync/scheduled-occurrence";

// Dedicated, loopback-only disposable PostgreSQL with the real Prisma migrations.
const url=process.env.GOOGLE_OFFSETS_TEST_URL;
function assertLocal(){assert.equal(url,"postgresql://postgres@127.0.0.1:55437/postgres?schema=meta_ads");}
function sql(value:string){
 assertLocal();
 const out=spawnSync("docker",["exec","-i","google-schedule-test-20261026","psql","-X","-v","ON_ERROR_STOP=1","-U","postgres","-d","postgres"],{input:`SET search_path=meta_ads,pg_catalog,pg_temp;\n${value}`,encoding:"utf8"});
 assert.equal(out.status,0,out.stderr);return out.stdout;
}
const read=(file:string)=>readFileSync(`scripts/cloud/daily-data-sync/${file}`,"utf8").replaceAll("\r\n","\n");

test("real PostgreSQL upgrade preserves old jobs/policies and validates D-1/D-7 response dates",{skip:!url},()=>{
 const original=read("production-scheduler.sql"),meta=read("production-meta-daily.sql");
 const base=original.slice(original.indexOf("CREATE SCHEMA daily_data_sync_prod_ops;"),original.indexOf("-- Reads only our request IDs."));
 const upgrade=meta.slice(meta.indexOf("ALTER TABLE daily_data_sync_prod_ops.schedules"),meta.indexOf("CREATE OR REPLACE FUNCTION daily_data_sync_prod_ops.reap"));
 const reap=meta.match(/CREATE OR REPLACE FUNCTION daily_data_sync_prod_ops\.reap\(\)[\s\S]*?END \$fn\$;/)![0];
 const candidates=meta.match(/CREATE OR REPLACE FUNCTION daily_data_sync_prod_ops\.candidates\([\s\S]*?\$fn\$;/)![0];
 sql(`CREATE SCHEMA cron; CREATE SCHEMA net;
 CREATE TABLE cron.job(jobid int,jobname text,schedule text,active boolean,command text);
 INSERT INTO cron.job VALUES(1,'storage-renewal-daily','0 19 * * *',true,'synthetic storage'),(4,'daily-data-sync-prod-tick','* 17,18 * * *',true,'SELECT daily_data_sync_prod_ops.tick();');
 CREATE TABLE net._http_response(id bigint,status_code integer,content text,timed_out boolean,error_msg text);
 ${base}
 UPDATE daily_data_sync_prod_ops.schedules SET paused=false;
 UPDATE daily_data_sync_prod_ops.settings SET stopped=false;
 ${upgrade}
 ${reap}
 ${candidates}
 INSERT INTO meta_ads.source_connections(id,provider,external_account_id,shop_key,display_name,currency_code,time_zone,access_state,enabled,updated_at)
 VALUES('21b811a6-b9d7-44f5-8167-ce40198947b5','GOOGLE','1391592099','default','Synthetic Google','KRW','Asia/Seoul','READY',true,now());
 INSERT INTO meta_ads.source_policies(id,connection_id,data_kind,from_date,primary_source,version,reason)
 VALUES(gen_random_uuid(),'21b811a6-b9d7-44f5-8167-ce40198947b5','GOOGLE_CAMPAIGN','2026-10-23','API',1,'SYNTHETIC_BASELINE');`);
 // Exact reviewed production SQL, including preflight and preservation guards.
 sql(read("production-google-daily-offsets.sql"));
 sql(`DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM daily_data_sync_prod_ops.candidates('2026-10-30T17:05Z') WHERE key='prod-google') THEN RAISE EXCEPTION 'OLD_WEEKLY_ACTIVE'; END IF;
 IF (SELECT count(*) FROM daily_data_sync_prod_ops.schedules WHERE NOT paused AND provider='GOOGLE' AND cadence_days=1)<>2 THEN RAISE EXCEPTION 'TWO_DAILY_REQUIRED'; END IF;
 IF (SELECT count(*) FROM meta_ads.source_policies WHERE connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND from_date<='2026-10-20' AND to_date>'2026-10-20')<>1 THEN RAISE EXCEPTION 'INITIAL_D7_POLICY_MISSING'; END IF;
 END $$;
 INSERT INTO daily_data_sync_prod_ops.attempts(schedule_key,scheduled_for,request_id,status,safe_code)
 VALUES('prod-google-daily','2026-10-26T17:01Z',1,'HTTP_QUEUED','TEST'),('prod-google-recheck-d7','2026-10-26T17:04Z',2,'HTTP_QUEUED','TEST'),('prod-google-recheck-d7','2026-10-27T17:04Z',3,'HTTP_QUEUED','TEST'),('prod-meta','2026-10-30T17:02Z',4,'HTTP_QUEUED','TEST');
 INSERT INTO net._http_response VALUES
 (1,200,'{"scheduleKey":"prod-google-daily","scheduledFor":"2026-10-26T17:01:00.000Z","status":"SUCCEEDED","completedUnits":1,"totalUnits":1,"fromDate":"2026-10-26","toDate":"2026-10-26"}',false,null),
 (2,200,'{"scheduleKey":"prod-google-recheck-d7","scheduledFor":"2026-10-26T17:04:00.000Z","status":"SUCCEEDED","completedUnits":1,"totalUnits":1,"fromDate":"2026-10-20","toDate":"2026-10-20"}',false,null),
 (3,200,'{"scheduleKey":"prod-google-recheck-d7","scheduledFor":"2026-10-27T17:04:00.000Z","status":"SUCCEEDED","completedUnits":1,"totalUnits":1,"fromDate":"2026-10-27","toDate":"2026-10-27"}',false,null),
 (4,200,'{"scheduleKey":"prod-meta","scheduledFor":"2026-10-30T17:02:00.000Z","status":"SUCCEEDED","completedUnits":7,"totalUnits":7,"fromDate":"2026-10-24","toDate":"2026-10-30"}',false,null);
 SELECT daily_data_sync_prod_ops.reap();
 DO $$ BEGIN
 IF (SELECT count(*) FROM daily_data_sync_prod_ops.attempts WHERE request_id IN (1,2,4) AND status='SUCCEEDED')<>3 THEN RAISE EXCEPTION 'VALID_SCOPE_REJECTED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM daily_data_sync_prod_ops.attempts WHERE request_id=3 AND status='ACTION_REQUIRED' AND safe_code='INVALID_APP_RESPONSE') THEN RAISE EXCEPTION 'WRONG_DAY_ACCEPTED'; END IF;
 END $$;`);
});

test("real PostgreSQL D-1 then D-7 updates one current Google snapshot and keeps prior versions",{skip:!url},async t=>{
 assertLocal();const before={...process.env},id=randomUUID(),account=`9${BigInt(`0x${randomUUID().replaceAll("-","").slice(0,12)}`)}`;
 const daily={key:"test-google-daily",connectionId:id,anchorAt:"2026-10-26T17:01:00.000Z",windowMinutes:90,kind:"GOOGLE_DAILY"as const};
 const recheck={...daily,key:"test-google-recheck",anchorAt:"2026-10-26T17:04:00.000Z",kind:"GOOGLE_RECHECK_D7"as const};
 Object.assign(process.env,{DATABASE_URL:url,PRISMA_IDLE_DISCONNECT_MS:"0",DAILY_SYNC_FEATURE_ENABLED:"true",DAILY_SYNC_ALLOWED_ACCOUNTS:JSON.stringify([`GOOGLE/${account}/default`]),DAILY_SYNC_SCHEDULES:JSON.stringify([daily,recheck])});
 const db=new PrismaService(),foundation=new SyncFoundationService(db,new HeavyOperationGate({heavyOperationConcurrency:1}as any,new Reflector()));
 const writer=new GoogleCanonicalWriterService(foundation);
 t.mock.timers.enable({apis:["Date"],now:Date.parse("2026-10-26T17:05:00Z")});
 try {
  await db.sourceConnection.create({data:{id,provider:"GOOGLE",externalAccountId:account,shopKey:"default",displayName:"Synthetic offsets",currencyCode:"KRW",timeZone:"Asia/Seoul",enabled:true,accessState:"READY"}});
  await db.sourcePolicy.create({data:{connectionId:id,dataKind:"GOOGLE_CAMPAIGN",fromDate:new Date("2026-10-26Z"),primarySource:"API",version:1,reason:"SYNTHETIC_OFFSETS"}});
  const old=occurrence(daily,"GOOGLE","Asia/Seoul",daily.anchorAt);
  const first=await foundation.queueRun({...old,connectionId:id,trigger:"SCHEDULED",actorUserId:null});
  async function publish(runId:string,cost:bigint){const claim=await foundation.claimRun(runId,Date.now()+65000);assert(claim);try{await writer.publish({runId,connectionId:id,generation:claim.generation,metricDate:new Date("2026-10-26Z"),policyVersion:1,snapshot:{rows:[{campaignId:"123",campaignName:"Synthetic",channelType:"VIDEO",costMicros:cost,impressions:100n,clicks:2n}],pageCount:1,accountCostMicros:cost,currencyCode:"KRW",timeZone:"Asia/Seoul",requestId:null}});await foundation.finishRun(claim);}finally{claim.release();}}
  await publish(first.id,10_000_000n);
  t.mock.timers.setTime(Date.parse("2026-11-01T17:05:00Z"));
  const next=occurrence(recheck,"GOOGLE","Asia/Seoul","2026-11-01T17:04:00.000Z");
  assert.equal(old.toDate,next.toDate);
  const second=await foundation.queueRun({...next,connectionId:id,trigger:"SCHEDULED",actorUserId:null});
  await publish(second.id,20_000_000n);
  const rows=await db.googleCampaignDailyCost.findMany({where:{connectionId:id},orderBy:{version:"asc"}});
  assert.deepEqual(rows.map(r=>[r.version,r.isCurrent,r.costMicros]),[[1,false,10_000_000n],[2,true,20_000_000n]]);
  assert.equal(await db.sourceRecordLink.count({where:{connectionId:id,isCurrent:true}}),1);
  assert.equal(await db.syncRun.count({where:{connectionId:id,status:"SUCCEEDED"}}),2);
  assert.equal((await db.sourceCoverage.findFirstOrThrow({where:{connectionId:id}})).totalAmount?.toString(),"20");
 } finally {await db.$disconnect();process.env=before;t.mock.timers.reset();}
});
