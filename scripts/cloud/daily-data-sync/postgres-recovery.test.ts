// Real isolated PostgreSQL with synthetic units; no provider API is called.
import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { Reflector } from "@nestjs/core";
import { Prisma, SourceDataKind, SourceKind, SyncTrigger } from "@prisma/client";
import { PrismaService } from "../../../apps/api/src/common/prisma.service";
import { HeavyOperationGate } from "../../../apps/api/src/common/heavy-operation";
import { SyncFoundationService } from "../../../apps/api/src/daily-sync/sync-foundation.service";
import { loadScheduledCheckpoint, saveScheduledCheckpoint } from "../../../apps/api/src/daily-sync/scheduled-checkpoint";
test('real PG duplicate trigger, manual heavy contention, crash checkpoint fencing and committed-unit finalization', async () => {
 const raw=process.env.DAILY_SYNC_08_RECOVERY_TEST_URL;
 assert(raw,'explicit isolated recovery URL required');
 const url=new URL(raw);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55433');
 assert.equal(url.pathname,'/phase08_recovery_20261012');assert.equal(url.searchParams.get('schema'),'meta_ads');
 process.env.DATABASE_URL=raw;process.env.DAILY_SYNC_FEATURE_ENABLED='true';
 const syntheticAccount=`phase08-synthetic-${randomBytes(4).toString('hex')}`;
 process.env.DAILY_SYNC_ALLOWED_ACCOUNTS=JSON.stringify([`GOOGLE/${syntheticAccount}/default`]);
 process.env.DAILY_SYNC_CHECKPOINT_KEY_B64=randomBytes(32).toString('base64');
 process.env.PRISMA_IDLE_DISCONNECT_MS='0';
 const prisma=new PrismaService();
 const heavy=new HeavyOperationGate({heavyOperationConcurrency:1} as any,new Reflector());
 const foundation=new SyncFoundationService(prisma,heavy);
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const end=Date.parse(`${day}T00:00:00Z`)-86400_000;
 const fromDate=new Date(end-6*86400_000).toISOString().slice(0,10),toDate=new Date(end).toISOString().slice(0,10);
 try {
  const connection=await prisma.sourceConnection.create({data:{provider:'GOOGLE',externalAccountId:syntheticAccount,shopKey:'default',displayName:'Synthetic phase08',currencyCode:'KRW',timeZone:'Asia/Seoul',enabled:true,accessState:'READY'}});
  await prisma.sourcePolicy.create({data:{connectionId:connection.id,dataKind:'GOOGLE_CAMPAIGN',fromDate:new Date(`${fromDate}Z`),primarySource:'API',version:1,effectiveAt:new Date(),reason:'SYNTHETIC_PHASE08'}});
  const request={connectionId:connection.id,fromDate,toDate,trigger:SyncTrigger.SCHEDULED,actorUserId:null,requestKey:`phase08:${randomBytes(12).toString('hex')}`};
  const first=await foundation.queueRun(request),duplicate=await foundation.queueRun(request);
  assert.equal(first.id,duplicate.id);
  const manual=heavy.tryAcquire();assert(manual);
  assert.equal(await foundation.claimRun(first.id,Date.now()+55_000),null);manual.release();
  const claim=await foundation.claimRun(first.id,Date.now()+55_000);assert(claim);
  assert.equal(await new SyncFoundationService(prisma,new HeavyOperationGate({heavyOperationConcurrency:1} as any,new Reflector())).claimRun(first.id),null);
  const state:any={version:1,connectionId:connection.id,day:fromDate,stage:'LIST_FIRST',syntheticMarker:'not-provider-data'};
  await foundation.beginScheduledUnit(claim,fromDate);
  await saveScheduledCheckpoint(prisma,claim,fromDate,state);
  assert.deepEqual(await loadScheduledCheckpoint(prisma,claim,fromDate),state);
  // A process died: its DB lease remains but expires; the next process resumes.
  await prisma.syncLease.update({where:{connectionId:connection.id},data:{expiresAt:new Date(0)}});claim.release();
  assert.equal(await foundation.prepareScheduledRetry(first.id,new Date(Date.now()+90_000)),true);
  const resumed=await foundation.claimRun(first.id,Date.now()+55_000);assert(resumed);assert(resumed.generation>claim.generation);
  await assert.rejects(saveScheduledCheckpoint(prisma,claim,fromDate,state));
  assert.deepEqual(await loadScheduledCheckpoint(prisma,resumed,fromDate),state);
  await foundation.beginScheduledUnit(resumed,fromDate);
  await foundation.publishUnit({runId:first.id,generation:resumed.generation,unitKey:fromDate,metricDate:new Date(`${fromDate}Z`),
   slices:[{dataKind:SourceDataKind.GOOGLE_CAMPAIGN,source:SourceKind.API,policyVersion:1,fetchedCount:0,pageCount:1,complete:true,totalAmount:new Prisma.Decimal(0)}],
   writeRows:async()=>({GOOGLE_CAMPAIGN:0})});
  await foundation.finishRun(resumed);resumed.release();
  assert.equal((await prisma.runUnit.findUniqueOrThrow({where:{runId_unitKey:{runId:first.id,unitKey:fromDate}}})).status,'SUCCEEDED');
  // Commit every remaining synthetic zero snapshot through the real writer
  // transaction; leave only the last run finalization unfinished.
  for(let index=1;index<7;index++) {
   const unitKey=new Date(Date.parse(`${fromDate}T00:00:00Z`)+index*86400_000).toISOString().slice(0,10);
   // Advance the synthetic retry clock without a wall-clock minute wait.
   await prisma.syncRun.update({where:{id:first.id},data:{nextAttemptAt:new Date(0)}});
   assert.equal(await foundation.prepareScheduledRetry(first.id,new Date(Date.now()+90_000)),true);
   const current=await foundation.claimRun(first.id,Date.now()+55_000);assert(current);
   await foundation.beginScheduledUnit(current,unitKey);
   await foundation.publishUnit({runId:first.id,generation:current.generation,unitKey,metricDate:new Date(`${unitKey}Z`),
    slices:[{dataKind:SourceDataKind.GOOGLE_CAMPAIGN,source:SourceKind.API,policyVersion:1,fetchedCount:0,pageCount:1,complete:true,totalAmount:new Prisma.Decimal(0)}],
    writeRows:async()=>({GOOGLE_CAMPAIGN:0})});
   if(index<6)await foundation.finishRun(current);
   current.release();
  }
  await prisma.syncLease.update({where:{connectionId:connection.id},data:{expiresAt:new Date(0)}});
  await foundation.prepareScheduledRetry(first.id,new Date(0));
  assert.equal((await prisma.syncRun.findUniqueOrThrow({where:{id:first.id}})).status,'SUCCEEDED');
  assert.equal((await prisma.runUnit.count({where:{runId:first.id,status:'SUCCEEDED'}})),7);
  assert.equal(await prisma.sourceCoverage.count({where:{connectionId:connection.id,lastSuccessRunId:first.id}}),7);
  console.log(JSON.stringify({state:'SYNTHETIC_REAL_PG_RECOVERY_PASS',database:'phase08_recovery_20261012',providerRequests:0,cases:6}));
 } finally {await prisma.$disconnect();delete process.env.DAILY_SYNC_CHECKPOINT_KEY_B64;}
});
