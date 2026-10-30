import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,openSync,closeSync,unlinkSync,renameSync} from 'node:fs';
import {PrismaClient} from '@prisma/client';
import {isDeepStrictEqual} from 'node:util';
import {UnifiedRuntimePrisma} from '../apps/api/src/unified-performance/runtime-prisma';
import {UnifiedManagementRepository,managementVersions} from '../apps/api/src/unified-performance/management.repository';
import {UnifiedManagementService,configurationRule,ruleName} from '../apps/api/src/unified-performance/management.service';
import {normalizeProductName,resolveProductName} from '../apps/api/src/unified-performance/domain/product-name-resolver';
import {UnifiedAggregationRepository} from '../apps/api/src/unified-performance/aggregation.repository';
import {UnifiedAggregationWorker,aggregationWorkerDatabaseUrl} from '../apps/api/src/unified-performance/aggregation.worker';
import {UnifiedReportRepository} from '../apps/api/src/unified-performance/report.repository';
import {UnifiedReportService} from '../apps/api/src/unified-performance/report.service';
import {MetaPerformanceAdapter} from '../apps/api/src/unified-performance/adapters/meta.adapter';
import {GooglePerformanceAdapter} from '../apps/api/src/unified-performance/adapters/google.adapter';
import {Cafe24PerformanceAdapter} from '../apps/api/src/unified-performance/adapters/cafe24.adapter';
import {CoupangPerformanceAdapter} from '../apps/api/src/unified-performance/adapters/coupang.adapter';
import {NaverPerformanceAdapter} from '../apps/api/src/unified-performance/adapters/naver.adapter';
import {permissionsForRole} from '../apps/api/src/auth/role-permissions';
import {CONTRACT_VERSION,type SourceAdapter} from '../apps/api/src/unified-performance/types';
import type {PrismaService} from '../apps/api/src/common/prisma.service';

const dir='docs/product-performance/research/';
const reason='사용자 요청: 플랫폼의 기존 동일 제품명 자동 연결. 네이버 이름 차이 신규 추정 연결 제외, 판매단위·과거 원가·기존 확정 별칭·원천 보존';
export async function runProductsMaintenance(args:Record<string,string>){
 assert(Object.keys(args).every(k=>['action','plan-sha','offset','limit','job','phase'].includes(k)));
 assert(['products-preview','products-apply','products-rules-preview','products-rules-apply','products-retire','products-queue','products-work','products-inspect','products-retry'].includes(args.action));
 assert(args.phase===undefined||['native','names','final'].includes(args.phase));const namesPhase=['names','final'].includes(args.phase),prefix=args.phase==='final'?'products-final':namesPhase?'products-names':'products',key=args.phase==='final'?'stage11-products-final-v1':namesPhase?'stage11-products-names-v1':'stage11-products-native-v1';
 const raw=readFileSync(dir+`11-${prefix}-plan.json`,'utf8').replace(/\r\n/g,'\n');assert.equal(createHash('sha256').update(raw).digest('hex'),args['plan-sha']);
 const plan=JSON.parse(raw);assert.equal(plan.kind,namesPhase?'NATIVE_PRODUCT_TITLE_NAMES_ALL_HISTORY':'EXACT_NATIVE_PRODUCTS_ALL_HISTORY');assert(plan.products.length<200&&plan.partitions.length<1500);
 assert.equal(JSON.parse(readFileSync(dir+'11-runtime-role-check.json','utf8')).status,'PASS');
 const identity=JSON.parse(readFileSync(dir+'11-operator-identity.json','utf8')).rows;assert(identity.is_active&&identity.role==='SUPER_ADMIN');
 const currentIdentity=JSON.parse(readFileSync(dir+'11-products-operator-identity.json','utf8')).rows;assert(currentIdentity.is_active&&currentIdentity.role==='SUPER_ADMIN');assert.equal(currentIdentity.id,identity.id);
 const actor={id:identity.id,permissions:permissionsForRole(identity.role)};
 process.env.UNIFIED_PERFORMANCE_ENABLED='true';process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS='5ba1d3cf-7aee-4cd1-aecd-d44352f665dd,78f8cb08-ffe3-481a-94d7-be87ae93ed79';
 const client=new UnifiedRuntimePrisma(),prisma=client as unknown as PrismaService,management=new UnifiedManagementRepository(prisma);
 const config=new UnifiedManagementService(management),reports=new UnifiedReportService(new UnifiedReportRepository(management),new UnifiedAggregationRepository(prisma));
 const evidence:any={stage:11,operation:args.action,planSha256:args['plan-sha'],observedAt:new Date().toISOString(),sourceWrites:0,scope:'CLI maintenance for the browser-verified active administrator, not an HTTP authentication proof',status:'RUNNING'};
 const output=dir+`11-${prefix}-${args.action.replace('products-','')}${args.action==='products-work'?'-'+args.offset:''}.json`,persist=()=>writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
 let workerClient:PrismaClient|undefined,queueLock:number|undefined;const queueLockPath=dir+`11-${prefix}-queue.lock`;
 try{
  await client.onModuleInit();let snapshot=await management.snapshot();
  const normalizedPayloads=new Map<any,unknown>((plan.nameRules??[]).map((p:any)=>[p,configurationRule({...p,productId:snapshot.products.find(x=>x.canonicalName===p.canonicalName)?.id,reason},p.canonicalName).payload]));
  const plannedRuleMatches=(r:any,p:any)=>r.kind==='NAME'&&snapshot.products.find(x=>x.id===r.productId)?.canonicalName===p.canonicalName&&r.platform===p.platform&&r.scopeKey===null&&r.active&&r.validFrom.toISOString().slice(0,10)===p.validFrom&&r.validTo===null&&isDeepStrictEqual(r.payload,normalizedPayloads.get(p));
  if(namesPhase){assert(plan.nameRules.length<400);const extras=snapshot.rules.filter(r=>!plan.baselineRules.some((b:any)=>b.id===r.id));assert(extras.every(r=>plan.nameRules.some((p:any)=>plannedRuleMatches(r,p))));assert.equal(new Set(extras.map(r=>plan.nameRules.findIndex((p:any)=>plannedRuleMatches(r,p)))).size,extras.length);}else assert.equal(snapshot.rules.length,plan.baselineRules.length);
  for(const before of plan.baselineRules){const current=snapshot.rules.find(r=>r.id===before.id)!;assert(current);assert.equal(current.version,before.version);assert.deepEqual(current.payload,before.payload);assert.equal(current.platform,before.platform);assert.equal(current.scopeKey,before.scopeKey);assert.equal(current.validFrom.toISOString().slice(0,10),before.validFrom);}
  const expectedNames=new Set(plan.products.map((p:any)=>normalizeProductName(p.canonicalName)));
  assert(snapshot.products.every(p=>expectedNames.has(p.normalizedName)));
  for(const before of plan.baselineProducts){const current=snapshot.products.find(p=>p.id===before.id)!;assert.equal(current.version,before.version);assert.equal(current.canonicalName,before.canonicalName);assert.equal(current.active,before.active);}
  if(args.action==='products-rules-preview'||args.action==='products-rules-apply'){
   assert(namesPhase);evidence.rules=[];
   for(const p of plan.nameRules){const existing=snapshot.rules.find(r=>plannedRuleMatches(r,p));if(existing){evidence.rules.push({platform:p.platform,productName:p.canonicalName,id:existing.id,action:'UNCHANGED'});continue;}
    const product=snapshot.products.find(r=>r.canonicalName===p.canonicalName);assert(product?.active);assert(['META','GOOGLE','CAFE24'].includes(p.platform));
    const {canonicalName,...spec}=p,input={...spec,productId:product.id,reason:reason+'; source title contains a literal existing name; preserve qualified names and existing matches'};
    const preview=await config.previewRule(input);assert(preview.canSave);
    if(args.action==='products-rules-apply'){const saved=await config.saveRule(input,actor);evidence.rules.push({platform:p.platform,productName:p.canonicalName,id:saved.rule.id,action:'CREATED'});snapshot=await management.snapshot();}else evidence.rules.push({platform:p.platform,productName:p.canonicalName,action:'PREVIEW_ONLY'});persist();
   }
   evidence.literalTitleReview=plan.review;evidence.naverOrCoupangRulesCreated=0;evidence.saleUnitOrCostChanges=0;
  }else if(args.action==='products-preview'||args.action==='products-apply'){
   assert(!namesPhase);
   evidence.products=[];const existing=new Map(snapshot.products.map(p=>[p.normalizedName,p]));
   for(const p of plan.products){
    const old=existing.get(normalizeProductName(p.canonicalName));if(old){assert.equal(old.active,true);evidence.products.push({name:p.canonicalName,id:old.id,action:'UNCHANGED'});continue;}
    const input={canonicalName:p.canonicalName,active:true,reason},preview=await config.previewProduct(input);assert(preview.canSave);
    if(args.action==='products-apply'){const saved=await config.saveProduct(input,actor);evidence.products.push({name:p.canonicalName,id:saved.product.id,action:'CREATED'});existing.set(saved.product.normalizedName,saved.product);}else evidence.products.push({name:p.canonicalName,action:'PREVIEW_ONLY'});
    persist();
   }
   // Canonical product exact-name matching is built in. Duplicating 124 EXACT
   // NAME rules would change no result and add work to every source row.
   const catalog=plan.products.map((p:any)=>({canonicalName:p.canonicalName,active:true}));
   const rules=snapshot.rules.filter(r=>r.kind==='NAME').map(r=>ruleName(r,snapshot.products.find(p=>p.id===r.productId)!.canonicalName));
   evidence.exactChecks=0;
   for(const p of catalog)for(const platform of ['META','CAFE24','GOOGLE','COUPANG','NAVER'] as const){const result=resolveProductName({originalName:p.canonicalName,platform,scopeKey:'PREVIEW',businessDate:plan.from,nameField:'canonical_name'},catalog,rules,'EXACT_CATALOG_PREVIEW');assert.equal(result.canonicalProductName,p.canonicalName);assert.equal(result.matchStatus,'MATCHED');evidence.exactChecks++;}
   evidence.naverExclusions=plan.naverDecisions.filter((n:any)=>n.decision==='EXCLUDED_DIFFERENT_NAME');
   for(const n of evidence.naverExclusions){const r=resolveProductName({originalName:n.sourceName,platform:'NAVER',scopeKey:n.scopeKey,businessDate:plan.from,nameField:'sales_unit_name'},catalog,rules,'EXACT_CATALOG_PREVIEW');assert.equal(r.matchStatus,'UNMATCHED');}
   evidence.implicitExactNameMatching=true;evidence.saleUnitOrCostChanges=0;
  }else{
   assert.equal(snapshot.products.length,plan.products.length);assert(snapshot.products.every(p=>p.active));
   const configurationVersion=managementVersions(snapshot.products,snapshot.rules).configurationVersion;
   if(namesPhase)assert.equal(snapshot.rules.length,plan.baselineRules.length+plan.nameRules.length);
   const queuePath=dir+`11-${prefix}-queue.json`;
   if(args.action==='products-retire'){
    assert.equal(args.phase,'final');const superseded=JSON.parse(readFileSync(dir+'11-products-names-queue.json','utf8'));assert.equal(superseded.status,'PASS');assert.notEqual(superseded.configurationVersion,configurationVersion);assert.equal(superseded.jobs.length,plan.partitions.length);const supersededPlan=readFileSync(dir+'11-products-names-plan.json','utf8').replace(/\r\n/g,'\n');assert.equal(superseded.planSha256,createHash('sha256').update(supersededPlan).digest('hex'));const signedPartitions=new Set(plan.partitions.map((p:any)=>[p.platform,p.scopeKey,p.date].join('/')));assert.equal(new Set(superseded.jobs.map((j:any)=>[j.platform,j.scopeKey,j.date].join('/'))).size,signedPartitions.size);assert(superseded.jobs.every((j:any)=>/^[a-f0-9-]{36}$/.test(j.jobId)&&signedPartitions.has([j.platform,j.scopeKey,j.date].join('/'))));
    const states=await client.unifiedAggregationRun.findMany({where:{id:{in:superseded.jobs.map((j:any)=>j.jobId)}},select:{id:true,status:true,attempts:true,leaseExpiresAt:true}});assert.equal(states.length,plan.partitions.length);assert(!states.some(s=>s.status==='STAGING'&&s.leaseExpiresAt&&s.leaseExpiresAt>new Date()),'ACTIVE_SUPERSEDED_JOB_REQUIRES_COMPLETION');
    workerClient=new PrismaClient({datasourceUrl:aggregationWorkerDatabaseUrl()});const [role]=await workerClient.$queryRaw<Array<{rolsuper:boolean;rolbypassrls:boolean;rolcreatedb:boolean;rolcreaterole:boolean;owns:bigint}>>`SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,(SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;assert(role&&!Object.values(role).some(Boolean));
    const repository=new UnifiedAggregationRepository(workerClient as unknown as PrismaService);evidence.superseded=[];for(const s of states.filter(s=>s.status==='STAGING')){const claim=await repository.claim(s.id);assert(claim);assert(await repository.fail(claim,'CONFIGURATION_SUPERSEDED'));evidence.superseded.push(s.id);persist();}evidence.financialOrSourceReads=0;
   }else if(args.action==='products-queue'){
    Object.assign(evidence,{configurationVersion,jobs:[],requests:[]});
    for(const [i,r] of plan.ranges.entries()){
     const result=await reports.rebuild({expectedContractVersion:CONTRACT_VERSION,idempotencyKey:`${key}-${i}`,from:r.from,to:r.to,platforms:[r.platform],scopeKeys:[r.scopeKey],reason},actor);
     evidence.requests.push({...r,index:i,jobs:result.jobs.length});evidence.jobs.push(...result.jobs);persist();
    }
    assert.equal(evidence.jobs.length,plan.partitions.length);evidence.status='PASS';writeFileSync(queuePath,JSON.stringify(evidence,null,2)+'\n');
   }else{
    // Separate date workers share a manifest: serialize retries and replace it atomically.
    if(args.action==='products-retry'){for(let attempt=0;attempt<40;attempt++){try{queueLock=openSync(queueLockPath,'wx');break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await new Promise(resolve=>setTimeout(resolve,250));}}assert(queueLock!==undefined,'PRODUCTS_QUEUE_LOCK_BUSY');}
    const queue=JSON.parse(readFileSync(queuePath,'utf8'));assert.equal(queue.status,'PASS');assert.equal(queue.planSha256,args['plan-sha']);assert.equal(queue.configurationVersion,configurationVersion);
    const partitions=new Set(plan.partitions.map((p:any)=>[p.platform,p.scopeKey,p.date].join('/')));assert.equal(new Set(queue.jobs.map((j:any)=>j.jobId)).size,plan.partitions.length);assert.equal(new Set(queue.jobs.map((j:any)=>[j.platform,j.scopeKey,j.date].join('/'))).size,partitions.size);for(const j of queue.jobs){assert(/^[a-f0-9-]{36}$/.test(j.jobId));assert(partitions.has([j.platform,j.scopeKey,j.date].join('/')));}
    if(args.action==='products-retry'){
     const i=queue.jobs.findIndex((j:any)=>j.jobId===args.job);assert(i>=0);const old=queue.jobs[i],state=await client.unifiedAggregationRun.findUniqueOrThrow({where:{id:old.jobId},select:{status:true}});assert.equal(state.status,'FAILED');
     const retry=await reports.rebuild({expectedContractVersion:CONTRACT_VERSION,idempotencyKey:`${key}-retry-${old.jobId}`,from:old.date,to:old.date,platforms:[old.platform],scopeKeys:[old.scopeKey],reason:reason+'; failed run retained'},actor);assert.equal(retry.jobs.length,1);
     const replacement={...retry.jobs[0],platform:old.platform,scopeKey:old.scopeKey,date:old.date};queue.jobs[i]=replacement;(queue.retries??=[]).push({oldJobId:old.jobId,newJobId:replacement.jobId,platform:old.platform,scopeKey:old.scopeKey,date:old.date});const temporary=queuePath+'.'+process.pid+'.tmp';writeFileSync(temporary,JSON.stringify(queue,null,2)+'\n');renameSync(temporary,queuePath);evidence.replacement=queue.retries.at(-1);
    }else if(args.action==='products-work'){
     const offset=Number(args.offset),limit=Number(args.limit);assert(Number.isInteger(offset)&&offset>=0&&offset<queue.jobs.length);assert(Number.isInteger(limit)&&limit>0&&limit<=25);
     workerClient=new PrismaClient({datasourceUrl:aggregationWorkerDatabaseUrl()});
     const [role]=await workerClient.$queryRaw<Array<{rolsuper:boolean;rolbypassrls:boolean;rolcreatedb:boolean;rolcreaterole:boolean;owns:bigint}>>`SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,(SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;assert(role&&!Object.values(role).some(Boolean));
     const wp=workerClient as unknown as PrismaService,wm=new UnifiedManagementRepository(wp),repository=new UnifiedAggregationRepository(wp);
     const safeFailure=(error:unknown)=>{const e=error as any,m=String(e?.message??'');return {errorClass:e?.constructor?.name,prismaCode:/^P\d{4}$/.test(e?.code??'')?e.code:null,databaseCode:/^[A-Z0-9]{5}$/.test(e?.meta?.code??'')?e.meta.code:null,transactionExpired:/transaction.*(?:expired|closed)/i.test(m),conservationFailure:m==='AGGREGATION_REPORT_CONSERVATION_FAILED'};};
     const observedRepository={claim:repository.claim.bind(repository),heartbeat:repository.heartbeat.bind(repository),fail:repository.fail.bind(repository),stageAndPublish:async(...values:Parameters<UnifiedAggregationRepository['stageAndPublish']>)=>{try{return await repository.stageAndPublish(...values);}catch(error){evidence.publicationFailure=safeFailure(error);persist();throw error;}}};
     const adapters={META:new MetaPerformanceAdapter(wp,wm),GOOGLE:new GooglePerformanceAdapter(wp,wm),CAFE24:new Cafe24PerformanceAdapter(wp,wm),COUPANG:new CoupangPerformanceAdapter(wm),NAVER:new NaverPerformanceAdapter(wm)};
     const observedAdapters=Object.fromEntries(Object.entries(adapters).map(([platform,adapter])=>[platform,{platform:adapter.platform,read:async(request:Parameters<SourceAdapter['read']>[0])=>{try{const batch=await adapter.read(request);const issues=[...new Set(batch.coverage.flatMap(c=>c.quality.issues))].filter(x=>/^[A-Z0-9_]+$/.test(x));if(issues.some(x=>/(?:READ|NORMALIZATION)_FAILED/.test(x))){evidence.sourceFailure={platform,issues};persist();}return batch;}catch(error){evidence.sourceFailure={platform,...safeFailure(error)};persist();throw error;}}}])) as Record<keyof typeof adapters,SourceAdapter>;
     const worker=new UnifiedAggregationWorker(observedRepository,wm,observedAdapters);
     evidence.offset=offset;evidence.outcomes=[];persist();
     for(const j of queue.jobs.slice(offset,offset+limit)){const claimed=await worker.runOne(j.jobId);const state=await client.unifiedAggregationRun.findUniqueOrThrow({where:{id:j.jobId},select:{id:true,status:true,attempts:true,issues:true}});evidence.outcomes.push({...state,platform:j.platform,scopeKey:j.scopeKey,date:j.date,claimed:!!claimed});persist();assert.equal(state.status,'PUBLISHED',`PRODUCTS_JOB_NOT_PUBLISHED:${j.jobId}`);}
    }else{
     const states=await client.unifiedAggregationRun.findMany({where:{id:{in:queue.jobs.map((j:any)=>j.jobId)}},select:{id:true,status:true,platform:true,scopeKey:true,businessDate:true,issues:true}});assert.equal(states.length,queue.jobs.length);assert(states.every(r=>r.status==='PUBLISHED'));evidence.jobs=states;evidence.counts={PUBLISHED:states.length};
     evidence.samples=[];
     for(const productName of ['풀업바','러닝조끼','자이로볼']){
      const result:any=await reports.read('summary',{from:'2026-09-29',to:'2026-10-28',platforms:['META','GOOGLE','NAVER','COUPANG','CAFE24'],productName},actor);
      assert(!result.warnings.includes('CONFIGURATION_CHANGED_REBUILD_RECOMMENDED'));
      evidence.samples.push({productName,knownTotals:result.knownTotals,completeTotals:result.completeTotals,byMarketplace:result.byMarketplace,byMedium:result.byMedium,snapshotHash:result.snapshotHash});
     }
    }
   }
  }
  evidence.status='PASS';
 }catch(error){const e=error as any,m=String(e.message??'');evidence.status='FAIL';evidence.errorClass=e.constructor?.name;evidence.errorCode=/^P\d{4}$/.test(e.code??'')?e.code:null;evidence.safeReason=/^[A-Z][A-Z0-9_]{3,120}$/.test(m)?m:null;evidence.transactionExpired=/transaction.*(?:expired|closed)/i.test(m);evidence.failedJobId=m.match(/PRODUCTS_JOB_NOT_PUBLISHED:([a-f0-9-]{36})/)?.[1]??null;process.exitCode=1;
 }finally{if(queueLock!==undefined){closeSync(queueLock);unlinkSync(queueLockPath);}await workerClient?.$disconnect();await client.onModuleDestroy();persist();console.log(JSON.stringify({status:evidence.status,operation:args.action,products:evidence.products?.length,jobs:evidence.jobs?.length,processed:evidence.outcomes?.length,sourceWrites:0}));}
}
