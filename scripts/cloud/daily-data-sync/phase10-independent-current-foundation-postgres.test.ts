// Dedicated fresh synthetic cluster only; never accepts shared 05-09 fixtures.
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Reflector} from '@nestjs/core';
import {Prisma,SourceDataKind,SourceKind,SyncTrigger} from '@prisma/client';
import {PrismaService} from '../../../apps/api/src/common/prisma.service';
import {HeavyOperationGate} from '../../../apps/api/src/common/heavy-operation';
import {SyncFoundationService,metaPublicationTransactionOptions} from '../../../apps/api/src/daily-sync/sync-foundation.service';

test('current Meta budget reserves pool and final-fence margin, capped at30s without changing other providers',()=>{
 const now=Date.parse('2026-10-20T00:00:00Z');
 assert.deepEqual(metaPublicationTransactionOptions(new Date(now+65000),now),{timeout:30000,maxWait:2000});
 assert.deepEqual(metaPublicationTransactionOptions(new Date(now+10000),now),{timeout:7500,maxWait:2000});
 for(const value of [now+2500,now-1,NaN])assert.throws(()=>metaPublicationTransactionOptions(new Date(value),now));
});

test('current actual foundation uses fresh PG: writer/final-fence rollback, initial-fence rejection, exactzero and idempotence',async()=>{
 const raw=process.env.PHASE10_INDEPENDENT_SYNTHETIC_URL;
 assert(raw,'fresh dedicated harness must provide its URL; no skip');
 const u=new URL(raw);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55437');
 assert.equal(u.pathname,'/phase10_independent_20261020');assert.equal(u.searchParams.get('schema'),'meta_ads');
 const previous={...process.env},account=`independent-${randomUUID()}`;
 Object.assign(process.env,{DATABASE_URL:raw,DAILY_SYNC_FEATURE_ENABLED:'true',PRISMA_IDLE_DISCONNECT_MS:'0',DAILY_SYNC_ALLOWED_ACCOUNTS:JSON.stringify([`META/${account}/default`])});
 const prisma=new PrismaService();const heavy=new HeavyOperationGate({heavyOperationConcurrency:1} as any,new Reflector());
 const foundation=new SyncFoundationService(prisma,heavy);let claim:Awaited<ReturnType<typeof foundation.claimRun>>=null;
 try{
  const id=await prisma.$queryRaw<Array<{db:string;principal:string}>>(Prisma.sql`SELECT current_database() AS db,current_user AS principal`);
  assert.deepEqual(id,[{db:'phase10_independent_20261020',principal:'phase10_independent'}]);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const end=Date.parse(`${today}T00:00:00Z`)-86400000;
  const fromDate=new Date(end-6*86400000).toISOString().slice(0,10),toDate=new Date(end).toISOString().slice(0,10);
  const c=await prisma.sourceConnection.create({data:{provider:'META',externalAccountId:account,shopKey:'default',displayName:'Independent synthetic',currencyCode:'USD',timeZone:'Asia/Seoul',enabled:true,accessState:'READY',credentialExpiresAt:new Date(Date.now()+3600000)}});
  for(const dataKind of [SourceDataKind.META_AD,SourceDataKind.META_ADSET])await prisma.sourcePolicy.create({data:{connectionId:c.id,dataKind,fromDate:new Date(`${fromDate}Z`),primarySource:'API',version:1,effectiveAt:new Date(),reason:'INDEPENDENT_SYNTHETIC'}});
  const run=await foundation.queueRun({connectionId:c.id,fromDate,toDate,trigger:SyncTrigger.SCHEDULED,actorUserId:null,requestKey:`independent:${randomUUID()}`});
  claim=await foundation.claimRun(run.id,Date.now()+65000);assert(claim);await foundation.beginScheduledUnit(claim,fromDate);
  const header={runId:run.id,generation:claim.generation,unitKey:fromDate,metricDate:new Date(`${fromDate}Z`),slices:[SourceDataKind.META_AD,SourceDataKind.META_ADSET].map(dataKind=>({dataKind,source:SourceKind.API,policyVersion:1,fetchedCount:0,pageCount:1,complete:true,totalAmount:new Prisma.Decimal(0)}))};
  const snapshot=async()=>({coverage:await prisma.sourceCoverage.count({where:{connectionId:c.id}}),audits:await prisma.securityAuditEvent.count({where:{action:'SYNC_UNIT_PUBLISHED',targetId:`${run.id}:${fromDate}`}}),unit:await prisma.runUnit.findUniqueOrThrow({where:{runId_unitKey:{runId:run.id,unitKey:fromDate}}}),run:await prisma.syncRun.findUniqueOrThrow({where:{id:run.id}})});
  const initial=await snapshot();let calls=0;
  await assert.rejects(foundation.publishUnit({...header,generation:claim.generation+1n,writeRows:async()=>{calls++;return {META_AD:0,META_ADSET:0};}}));
  assert.equal(calls,0);assert.deepEqual(await snapshot(),initial);
  const code=`independent-writer-${randomUUID()}`;
  await assert.rejects(foundation.publishUnit({...header,writeRows:async tx=>{calls++;await tx.product.create({data:{code,name:'Synthetic',displayName:'Synthetic'}});throw Error('SYNTHETIC_WRITER_FAILURE');}}),/SYNTHETIC_WRITER_FAILURE/);
  assert.equal(await prisma.product.count({where:{code}}),0);assert.deepEqual(await snapshot(),initial);
  const fenceCode=`independent-fence-${randomUUID()}`;const leaseBefore=await prisma.syncLease.findUniqueOrThrow({where:{connectionId:c.id}});
  await assert.rejects(foundation.publishUnit({...header,writeRows:async tx=>{calls++;await tx.product.create({data:{code:fenceCode,name:'Synthetic',displayName:'Synthetic'}});await tx.syncLease.update({where:{connectionId:c.id},data:{expiresAt:new Date(0)}});return {META_AD:0,META_ADSET:0};}}));
  assert.equal(await prisma.product.count({where:{code:fenceCode}}),0);assert.deepEqual(await snapshot(),initial);
  assert.deepEqual(await prisma.syncLease.findUniqueOrThrow({where:{connectionId:c.id}}),leaseBefore);
  const result=await foundation.publishUnit({...header,writeRows:async()=>{calls++;return {META_AD:0,META_ADSET:0};}});assert.equal(result.published,0);
  const coverage=await prisma.sourceCoverage.findMany({where:{connectionId:c.id},orderBy:{dataKind:'asc'}});assert.equal(coverage.length,2);
  assert.deepEqual(coverage.map(x=>x.dataKind),['META_AD','META_ADSET']);
  for(const row of coverage){assert.equal(row.state,'COMPLETE_ZERO');assert.equal(row.rowCount,0);assert.equal(row.lastSuccessRunId,run.id);assert.equal(row.lastAttemptRunId,run.id);assert.equal(row.totalAmount?.toString(),'0');}
  const completed=await snapshot();assert.equal(completed.audits,1);assert.equal(completed.unit.status,'SUCCEEDED');
  assert.equal((await foundation.publishUnit({...header,writeRows:async()=>{throw Error('DUPLICATE_MUST_NOT_WRITE');}})).published,0);
  assert.deepEqual(await snapshot(),completed);assert.equal(calls,3);
  console.log(JSON.stringify({kind:'PHASE10_INDEPENDENT_CURRENT_FOUNDATION_ACTUAL_PG',scenarios:5,initialFenceRejectsBeforeWriter:true,writerFaultRollback:true,finalFenceRollback:true,exactMetaZeroPair:true,idempotentNoAuditOrWriterDuplicate:true,remoteRequests:0}));
 }finally{claim?.release();await prisma.$disconnect();for(const key of ['DATABASE_URL','DAILY_SYNC_FEATURE_ENABLED','PRISMA_IDLE_DISCONNECT_MS','DAILY_SYNC_ALLOWED_ACCOUNTS']){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});
