import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {PrismaClient,Prisma} from '@prisma/client';
import {UnifiedRuntimePrisma} from '../apps/api/src/unified-performance/runtime-prisma';
import {UnifiedManagementRepository} from '../apps/api/src/unified-performance/management.repository';
import {UnifiedManagementService,ruleName,configurationRule} from '../apps/api/src/unified-performance/management.service';
import {resolveProductName} from '../apps/api/src/unified-performance/domain/product-name-resolver';
import {UnifiedAggregationRepository} from '../apps/api/src/unified-performance/aggregation.repository';
import {UnifiedAggregationWorker,aggregationWorkerDatabaseUrl} from '../apps/api/src/unified-performance/aggregation.worker';
import {UnifiedReportRepository,snapshotStatement} from '../apps/api/src/unified-performance/report.repository';
import {parseReportQuery} from '../apps/api/src/unified-performance/report-query';
import {UnifiedReportService} from '../apps/api/src/unified-performance/report.service';
import {MetaPerformanceAdapter} from '../apps/api/src/unified-performance/adapters/meta.adapter';
import {GooglePerformanceAdapter} from '../apps/api/src/unified-performance/adapters/google.adapter';
import {Cafe24PerformanceAdapter} from '../apps/api/src/unified-performance/adapters/cafe24.adapter';
import {CoupangPerformanceAdapter} from '../apps/api/src/unified-performance/adapters/coupang.adapter';
import {NaverPerformanceAdapter} from '../apps/api/src/unified-performance/adapters/naver.adapter';
import {permissionsForRole} from '../apps/api/src/auth/role-permissions';
import type {PrismaService} from '../apps/api/src/common/prisma.service';
import {CONTRACT_VERSION} from '../apps/api/src/unified-performance/types';

const dir='docs/product-performance/research/';
const reason='사용자 요청: 저장된 모든 기간·플랫폼의 풀업바 이름 분류와 재집계; 기존 날짜별 원가·원천·수집 설정 보존';
export async function runHistoricalMaintenance(args:Record<string,string>){
 assert(Object.keys(args).every(k=>['action','plan-sha','plan-name','key','offset','limit','job'].includes(k)));
 assert(['history-preview','history-apply','history-queue','history-work','history-inspect','history-retry','history-profile'].includes(args.action));
 assert(/^[a-z0-9-]{1,40}$/.test(args.key));assert(/^[a-f0-9]{64}$/.test(args['plan-sha']));
 assert(args['plan-name']===undefined||args['plan-name']==='latest');
 // Node writes plans as LF. Git's Windows checkout may restore CRLF; sign the
 // original LF text so an evidence checkout remains usable without re-signing.
 const raw=readFileSync(dir+`11-all-history-plan${args['plan-name']==='latest'?'-latest':''}.json`,'utf8');assert.equal(createHash('sha256').update(raw.replace(/\r\n/g,'\n')).digest('hex'),args['plan-sha']);
 const plan=JSON.parse(raw);assert.equal(plan.kind,'ALL_STORED_PULLUP_HISTORY');assert.equal(plan.canonicalProduct,'풀업바');assert(plan.partitions.length<=2000);
 assert.equal(JSON.parse(readFileSync(dir+'11-runtime-role-check.json','utf8')).status,'PASS');
 const identity=JSON.parse(readFileSync(dir+'11-operator-identity.json','utf8')).rows;assert(identity.is_active&&identity.role==='SUPER_ADMIN');
 const actor={id:identity.id,permissions:permissionsForRole(identity.role)};
 process.env.UNIFIED_PERFORMANCE_ENABLED='true';process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS='5ba1d3cf-7aee-4cd1-aecd-d44352f665dd,78f8cb08-ffe3-481a-94d7-be87ae93ed79';
 const client=new UnifiedRuntimePrisma(),prisma=client as unknown as PrismaService;
 const management=new UnifiedManagementRepository(prisma),configuration=new UnifiedManagementService(management);
 const reports=new UnifiedReportService(new UnifiedReportRepository(management),new UnifiedAggregationRepository(prisma));
 const evidence:any={stage:11,operation:args.action,key:args.key,planSha256:args['plan-sha'],observedAt:new Date().toISOString(),sourceWrites:0,
  authBoundary:'CLI maintenance on behalf of browser-verified active administrator; not an HTTP authentication test',status:'RUNNING'};
 const output=dir+`11-${args.action}-${args.key}${args.action==='history-work'?'-'+args.offset:''}.json`;
 const persist=()=>writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
 let workerClient:PrismaClient|undefined;
 try{
  await client.onModuleInit();const snapshot=await management.snapshot();assert.equal(snapshot.products.length,1);assert.equal(snapshot.products[0].canonicalName,'풀업바');assert.equal(snapshot.rules.length,2);
  const name=snapshot.rules.find(r=>r.kind==='NAME')!,unit=snapshot.rules.find(r=>r.kind==='SALE_UNIT')!;
  assert.equal(name.id,plan.baselineRules.name.id);assert.equal(unit.id,plan.baselineRules.unit.id);assert.equal(unit.version,1);assert.deepEqual(unit.payload,plan.baselineRules.unit.payload);
  assert.equal(unit.validFrom.toISOString().slice(0,10),plan.baselineRules.unit.validFrom);
  const applied=name.platform===null&&name.scopeKey===null&&name.validFrom.toISOString().slice(0,10)===plan.proposedNameRule.validFrom;
  if(applied){assert.deepEqual(name.payload,configurationRule({...plan.proposedNameRule,reason},'풀업바').payload);assert.equal(name.active,true);}
  else{assert.equal(name.version,2);assert.deepEqual(name.payload,plan.baselineRules.name.payload);}
  if(args.action==='history-profile'){
   evidence.profiles=[];
   for(const input of [{from:'2026-09-29',to:'2026-10-28'},{from:'2026-05-13',to:'2026-10-29'}]){
    const query=parseReportQuery({...input,platforms:['META','GOOGLE','NAVER','COUPANG','CAFE24'],productName:'풀업바'});
    const statement=snapshotStatement(query,query.from,{legacyPlatforms:'META,CAFE24',naverStoreIds:process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS!});
    const result:any=await client.$transaction(async tx=>{await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);return tx.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`);},{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,timeout:20000});
    const report=result[0]['QUERY PLAN'][0],nodes:any[]=[];
    const visit=(p:any)=>{nodes.push({type:p['Node Type'],relation:p['Relation Name'],cte:p['CTE Name'],index:p['Index Name'],rows:p['Actual Rows'],loops:p['Actual Loops'],time:p['Actual Total Time'],cost:p['Total Cost']});for(const c of p.Plans??[])visit(c);};visit(report.Plan);
    const started=Date.now();const frame:any=await client.$transaction(async tx=>{await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);return tx.$queryRaw(statement);},{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,timeout:20000});
    const transferMs=Date.now()-started,frameBytes=Buffer.byteLength(JSON.stringify(frame));
    const decoded=typeof frame[0].frame==='string'?JSON.parse(frame[0].frame):frame[0].frame;
    let textObjectEquivalent:boolean|undefined;
    if(input.from==='2026-09-29'){
     const original:any=await client.$transaction(async tx=>{await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);return tx.$queryRaw(Prisma.sql`SELECT f.frame::jsonb AS frame FROM (${statement}) f`);},{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,timeout:20000});
     assert.deepEqual(decoded,original[0].frame);textObjectEquivalent=true;
    }
    const fieldBytes=Object.fromEntries(Object.entries(decoded).map(([k,v])=>[k,Buffer.byteLength(JSON.stringify(v))]));
    evidence.profiles.push({input,executionMs:report['Execution Time'],planningMs:report['Planning Time'],jit:report.JIT,transferMs,frameBytes,fieldBytes,textObjectEquivalent,nodes});persist();
   }
  }
  else if(args.action==='history-preview'||args.action==='history-apply'){
   const input={...plan.proposedNameRule,reason,expectedVersion:name.version};
   const preview=await configuration.previewRule({...input,id:name.id,samples:plan.samples});
   evidence.preview={canSave:preview.canSave,affectedRange:preview.affectedRange,samples:preview.samples,versions:preview.versions};assert(preview.canSave);
   // Management's combined unit preview only considers unified units. Historical
   // platform readers also resolve their existing dated source cost/unit rules.
   const reviewedName=ruleName({id:name.id,...preview.after} as any,'풀업바');
   evidence.nameOnlySamples=plan.samples.map((s:any)=>resolveProductName(s,[{canonicalName:'풀업바',active:true}],[reviewedName],'HISTORICAL_NAME_PREVIEW'));
   assert(evidence.nameOnlySamples.every((s:any)=>s.canonicalProductName==='풀업바'&&s.matchStatus==='MATCHED'));
   evidence.unitPreviewScope='Unified-only unit preview; actual platform legacy dated units are verified by worker/source replay';
   if(args.action==='history-apply'&&!applied)evidence.saved=await configuration.saveRule({...input,expectedConfigurationVersion:preview.versions.configurationVersion},actor,name.id);
   evidence.alreadyApplied=applied;evidence.saleUnitAndLegacyCostsUnchanged=true;
  }else{
   assert(applied,'Apply reviewed historical name rule before queuing or processing');
   if(args.action==='history-queue'){
    evidence.requests=[];evidence.jobs=[];
    for(const [index,range]of plan.ranges.entries()){
     const response=await reports.rebuild({from:range.from,to:range.to,platforms:[range.platform],scopeKeys:[range.scopeKey],productNames:['풀업바'],
      reason,expectedContractVersion:CONTRACT_VERSION,idempotencyKey:`${args.key}-${index}`},actor);
     evidence.requests.push({index,platform:range.platform,scopeKey:range.scopeKey,from:range.from,to:range.to,jobs:response.jobs.length});
     evidence.jobs.push(...response.jobs);persist();
    }
    assert.equal(evidence.jobs.length,plan.partitions.length);
   }else{
    const queue=JSON.parse(readFileSync(dir+`11-history-queue-${args.key}.json`,'utf8'));assert.equal(queue.planSha256,args['plan-sha']);assert.equal(queue.status,'PASS');
    const expected=new Set(plan.partitions.map((p:any)=>`${p.platform}/${p.scopeKey}/${p.date}`));
    for(const job of queue.jobs){assert(/^[a-f0-9-]{36}$/.test(job.jobId));assert(expected.has(`${job.platform}/${job.scopeKey}/${job.date}`));}
    if(args.action==='history-retry'){
     assert(/^[a-f0-9-]{36}$/.test(args.job));const index=queue.jobs.findIndex((j:any)=>j.jobId===args.job);assert(index>=0);
     const old=queue.jobs[index],state=await client.unifiedAggregationRun.findUniqueOrThrow({where:{id:old.jobId},select:{status:true}});assert.equal(state.status,'FAILED');
     const retry=await reports.rebuild({from:old.date,to:old.date,platforms:[old.platform],scopeKeys:[old.scopeKey],productNames:['풀업바'],reason:reason+'; 실패 이력을 보존한 동일 날짜 재요청',
      expectedContractVersion:CONTRACT_VERSION,idempotencyKey:`${args.key}-retry-${old.jobId}`},actor);assert.equal(retry.jobs.length,1);
     queue.retries??=[];const replacement=retry.jobs[0];queue.retries.push({previousJobId:old.jobId,replacementJobId:replacement.jobId,date:old.date,platform:old.platform,observedAt:new Date().toISOString()});
     queue.jobs[index]=replacement;writeFileSync(dir+`11-history-queue-${args.key}.json`,JSON.stringify(queue,null,2)+'\n');evidence.replacement=queue.retries.at(-1);
    }else if(args.action==='history-work'){
     const offset=Number(args.offset),limit=Number(args.limit);assert(Number.isInteger(offset)&&offset>=0&&offset<queue.jobs.length);assert(Number.isInteger(limit)&&limit>=1&&limit<=25);
     const selected=queue.jobs.slice(offset,offset+limit);workerClient=new PrismaClient({datasourceUrl:aggregationWorkerDatabaseUrl()});
     const [role]=await workerClient.$queryRaw<Array<{rolsuper:boolean;rolbypassrls:boolean;rolcreatedb:boolean;rolcreaterole:boolean;owns:bigint}>>`SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,(SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
     assert(role&&!Object.values(role).some(Boolean));
     const wp=workerClient as unknown as PrismaService,wm=new UnifiedManagementRepository(wp);
     const repository=new UnifiedAggregationRepository(wp);
     const observedRepository={claim:repository.claim.bind(repository),heartbeat:repository.heartbeat.bind(repository),fail:repository.fail.bind(repository),
      stageAndPublish:async(...values:Parameters<UnifiedAggregationRepository['stageAndPublish']>)=>{try{return await repository.stageAndPublish(...values);}catch(error){
       const e=error as any,message=String(e.message??'');evidence.publicationFailure={errorClass:e.constructor?.name,prismaCode:/^P\d{4}$/.test(e.code??'')?e.code:null,
        databaseCode:/^[A-Z0-9]{5}$/.test(e.meta?.code??'')?e.meta.code:null,transactionExpired:/transaction.*(?:expired|closed)/i.test(message),
        duplicateLogicalSource:message==='Duplicate selected logical source fact.',conservationFailure:message==='AGGREGATION_REPORT_CONSERVATION_FAILED',
        target:Array.isArray(e.meta?.target)?e.meta.target.filter((x:unknown)=>typeof x==='string'&&/^[a-z0-9_]+$/i.test(x)):null};persist();throw error;}}};
     const worker=new UnifiedAggregationWorker(observedRepository,wm,{META:new MetaPerformanceAdapter(wp,wm),GOOGLE:new GooglePerformanceAdapter(wp,wm),CAFE24:new Cafe24PerformanceAdapter(wp,wm),COUPANG:new CoupangPerformanceAdapter(wm),NAVER:new NaverPerformanceAdapter(wm)});
     evidence.offset=offset;evidence.outcomes=[];
     for(const job of selected){const outcome=await worker.runOne(job.jobId);const state=await client.unifiedAggregationRun.findUniqueOrThrow({where:{id:job.jobId},select:{id:true,status:true,attempts:true,issues:true}});
      evidence.outcomes.push({platform:job.platform,scopeKey:job.scopeKey,date:job.date,...state,claimed:!!outcome});persist();assert.equal(state.status,'PUBLISHED',`HISTORY_JOB_NOT_PUBLISHED:${job.jobId}`);}
    }else{
     const states=await client.unifiedAggregationRun.findMany({where:{id:{in:queue.jobs.map((j:any)=>j.jobId)}},select:{id:true,platform:true,scopeKey:true,businessDate:true,status:true,attempts:true,issues:true}});
     evidence.jobs=states;evidence.counts=states.reduce((a:any,s)=>({...a,[s.status]:(a[s.status]??0)+1}),{});
     assert.equal(states.length,queue.jobs.length);assert(states.every(s=>s.status==='PUBLISHED'));
     const input={from:plan.proposedNameRule.validFrom,to:plan.partitions.map((p:any)=>p.date).sort().at(-1),platforms:['META','GOOGLE','NAVER','COUPANG','CAFE24'],productName:'풀업바'};
     const summary:any=await reports.read('summary',input,actor);
     const options:any=await reports.read('options',input,actor);
     evidence.options={productNames:options.products,scopes:options.scopes,selection:options.selection};
     evidence.summary={selection:summary.selection,snapshotHash:summary.snapshotHash,knownTotals:summary.knownTotals,completeTotals:summary.completeTotals,byMedium:summary.byMedium,
      byMarketplace:summary.byMarketplace,warnings:summary.warnings,scopeBalances:summary.scopeBalances,publishedPartitions:summary.publishedRunIdsBySource};
     const items:any[]=[];let cursor:string|undefined;
     do{const page:any=await reports.read('timeseries',{...input,...(cursor?{cursor}:{})},actor);assert.equal(page.snapshotHash,summary.snapshotHash);items.push(...page.items.map((b:any)=>({date:b.date,knownTotals:b.knownTotals,completeTotals:b.completeTotals,byMedium:b.byMedium})));cursor=page.nextCursor??undefined;}while(cursor);
     evidence.timeseries={total:items.length,knownPeriods:Object.fromEntries(['revenue','adSpend','profitBeforeAds','estimatedProfit'].map(k=>[k,items.filter(b=>b.knownTotals[k]!==null).length])),items};
    }
   }
  }
  evidence.status='PASS';
 }catch(error){evidence.status='FAIL';evidence.errorClass=(error as any).constructor?.name;evidence.errorCode=(error as any).code??null;
  const message=String((error as any).message??'');evidence.failedJobId=message.match(/HISTORY_JOB_NOT_PUBLISHED:([a-f0-9-]{36})/)?.[1]??null;
  evidence.permissionObject=message.match(/permission denied for (?:schema|table|function) ["']?([a-z0-9_]+)/i)?.[1]??null;
  evidence.transactionExpired=/transaction.*(?:expired|closed)/i.test(message);process.exitCode=1;
 }finally{await workerClient?.$disconnect();await client.onModuleDestroy();persist();console.log(JSON.stringify({status:evidence.status,operation:args.action,offset:evidence.offset,processed:evidence.outcomes?.length,jobs:evidence.jobs?.length,sourceWrites:0}));}
}
