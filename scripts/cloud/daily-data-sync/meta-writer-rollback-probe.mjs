// Root-only, explicitly authorized transient writes, ALWAYS rolled back. Not a publish or collection.
import 'reflect-metadata';
import {PrismaClient} from '@prisma/client';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {assertBusinessDatabaseTarget} from './seed-isolated-business-config.mjs';
import {loadMetaDiagnosticReplay} from './meta-failed-day-diagnostic.mjs';
import {CanonicalApiWriterService} from '../../../apps/api/src/daily-sync/canonical-api-writer.service.ts';
import {MetaEntityWriterService} from '../../../apps/api/src/uploads/meta-entity-writer.service.ts';
import {MetaMetricVersionService} from '../../../apps/api/src/uploads/meta-metric-version.service.ts';
import {MappingsService} from '../../../apps/api/src/mappings/mappings.service.ts';
import {safeMetaRuntimeFailureDiagnostic} from '../../../apps/api/src/daily-sync/meta-failure-diagnostic.ts';
const PROJECT='ehnfrrmbkvlsbpvqcvkr',CONNECTION='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',DAY='2026-10-08';
const requestKey='schedule:phase08-meta:'+createHash('sha256').update('2026-10-15T01:02:00.000Z').digest('hex');
const SENTINEL=Object.freeze({rollback:true});
const fail=()=>{throw Error('PHASE08_META_ROLLBACK_PROBE_REJECTED');};
const digest=(table,where='true')=>`(SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text),'' ORDER BY md5(to_jsonb(x)::text)),'')) FROM ${table} x WHERE ${where})`;
export const META_ROLLBACK_FINGERPRINT_SQL=`SELECT md5(jsonb_build_array(${[
 ...['creatives','creative_aliases','creative_placements','creative_change_logs','meta_campaigns','meta_adsets','meta_ads','meta_ad_daily_metrics','meta_adset_daily_metrics'].map(t=>digest(t)),
 ...['source_connections','source_credentials','source_policies','source_coverage','source_record_links','sync_leases'].map(t=>digest(t,`${t==='source_connections'?'id':'connection_id'}='${CONNECTION}'::uuid`)),
 digest('sync_runs',`connection_id='${CONNECTION}'::uuid`),digest('run_units',`run_id IN(SELECT id FROM sync_runs WHERE connection_id='${CONNECTION}'::uuid)`),
 digest('sync_unit_checkpoints',`run_id IN(SELECT id FROM sync_runs WHERE connection_id='${CONNECTION}'::uuid)`),
 digest('security_audit_events',`target_id='${CONNECTION}' OR after_json->>'connectionId'='${CONNECTION}' OR before_json->>'connectionId'='${CONNECTION}' OR EXISTS(SELECT 1 FROM sync_runs r WHERE r.connection_id='${CONNECTION}'::uuid AND (x.target_id=r.id::text OR x.target_id LIKE r.id::text||':%'))`)
 ].join(',')})::text) AS digest`;
const identitySql=`SELECT current_database() AS database,current_user AS role,current_schema() AS schema,current_setting('transaction_read_only') AS readonly,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables, (current_setting('log_statement') IN ('none','ddl') AND coalesce(current_setting('pgaudit.log',true),'none') IN ('none','') AND current_setting('log_parameter_max_length_on_error')='0' AND current_setting('log_min_duration_statement')='-1' AND coalesce(current_setting('log_min_duration_sample',true),'-1')='-1' AND current_setting('log_duration')='off') AS logging_safe`;
export async function runMetaRollbackProbe(input,{factory=(url,onQuery)=>{const db=new PrismaClient({datasourceUrl:url,log:[{emit:'event',level:'query'}]});db.$on('query',()=>onQuery());return db;},loadSnapshot=loadMetaDiagnosticReplay,makeWriter=(db,foundation)=>new CanonicalApiWriterService(db,foundation,new MappingsService(db),new MetaEntityWriterService(db),new MetaMetricVersionService(db))}={}){
 let db,stage='INPUT',queries=0,start=0,elapsed=0,callbackEntered=false,callbackCompleted=false,writeRowsCalls=0,probeRunCreated=false,originalFailure=null,beforeDigest,afterDigest,binding,policies;
 const oldEnv={...process.env};
 try{
  if(input?.projectRef!==PROJECT||input.mode!=='ROLLBACK_WRITER_DIAGNOSTIC'||input.classification!=='MANUAL_DIAGNOSTIC'||input.day!==DAY||input.pausedMetaVerified!==true||typeof input.pausedObservedAt!=='string'||Math.abs(Date.now()-Date.parse(input.pausedObservedAt))>60000||!Number.isFinite(Date.parse(input.pausedObservedAt))||input.env?.SUPABASE_DATABASE_PROJECT_REF!==PROJECT||input.env.SUPABASE_DATABASE_SCHEMA!=='phase08_meta_ads'||input.env.SUPABASE_DATABASE_RUNTIME_USER!=='phase08_runtime'||input.env.DAILY_SYNC_META_TRANSPORT!=='MCP'||input.env.DAILY_SYNC_FEATURE_ENABLED!=='true'||input.env.DAILY_SYNC_META_MCP_USE_CASE!=='OWN_ACCOUNT_INTERNAL_REPORTING'||input.env.PHASE08_META_CONNECTION_ID!==CONNECTION)fail();
  const url=assertBusinessDatabaseTarget({projectRef:PROJECT,freshVerified:true,databaseUrl:input.databaseUrl});
  for(const key of ['DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_META_TRANSPORT','DAILY_SYNC_META_MCP_USE_CASE'])process.env[key]=input.env[key];
  stage='CAPTURE';const snapshot=await loadSnapshot(input);if(snapshot.ads.length!==55||snapshot.adsets.length!==13)fail();
  db=factory(url,()=>queries++);stage='BASELINE';
  const baseline=async(checkFailure)=>db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5000'");
   const identity=await tx.$queryRawUnsafe(identitySql);if(identity.length!==1||identity[0].database!=='postgres'||identity[0].role!=='phase08_runtime'||identity[0].schema!=='phase08_meta_ads'||identity[0].readonly!=='on'||identity[0].tables!==68||identity[0].logging_safe!==true)fail();
   if(checkFailure){
    const r=await tx.syncRun.findUnique({where:{connectionId_requestKey:{connectionId:CONNECTION,requestKey}},include:{units:true}});
    const u=r?.units.find(x=>x.unitKey===DAY);
    if(!r||r.trigger!=='SCHEDULED'||r.status!=='FAILED'||r.safeErrorCode!=='PROVIDER_UNAVAILABLE'||r.rowsPublished!==0||r.units.length!==7||u?.status!=='FAILED'||u.attempts!==2||u.fetchedCount!==0||u.publishedCount!==0||r.units.some(x=>x.unitKey!==DAY&&(x.status!=='QUEUED'||x.attempts!==0))||await tx.syncLease.count({where:{connectionId:CONNECTION,expiresAt:{gt:new Date()}}}))fail();
    binding=await tx.sourceConnection.findUnique({where:{id:CONNECTION}});if(!binding||binding.provider!=='META'||binding.externalAccountId!=='2138525300002203'||binding.shopKey!=='default'||binding.currencyCode!=='USD'||binding.timeZone!=='Asia/Seoul'||binding.enabled!==true||binding.accessState!=='READY'||binding.credentialRef!==input.env.DAILY_SYNC_META_CREDENTIAL_REF||binding.credentialExpiresAt?.getTime()<=Date.now()+7*86400000)fail();
    policies=await tx.sourcePolicy.findMany({where:{connectionId:CONNECTION,dataKind:{in:['META_AD','META_ADSET']},primarySource:'API',fromDate:{lte:new Date(DAY+'T00:00:00Z')},OR:[{toDate:null},{toDate:{gt:new Date(DAY+'T00:00:00Z')}}]}});if(policies.length!==2||!policies.some(p=>p.dataKind==='META_AD')||!policies.some(p=>p.dataKind==='META_ADSET'))fail();
   }
   const rows=await tx.$queryRawUnsafe(META_ROLLBACK_FINGERPRINT_SQL);if(rows.length!==1||typeof rows[0].digest!=='string'||!/^[a-f0-9]{32}$/.test(rows[0].digest))fail();return rows[0].digest;
  },{timeout:12000,maxWait:1000});
  beforeDigest=await baseline(true);let writesStart=queries;
  const spy={publishUnit:async payload=>{
   if(++writeRowsCalls!==1||payload.unitKey!==DAY||payload.slices.length!==2||payload.slices.some(s=>s.source!=='API'||s.complete!==true))fail();
   stage='WRITER_TRANSACTION';start=Date.now();
   try{await db.$transaction(async tx=>{
    // Serialize with any manual canonical operation. The original runner remains paused.
    await tx.$queryRawUnsafe('SELECT id FROM source_connections WHERE id=$1::uuid FOR UPDATE',CONNECTION);
    if(await tx.syncLease.count({where:{connectionId:CONNECTION,expiresAt:{gt:new Date()}}}))fail();
    const current=await tx.syncRun.findUnique({where:{connectionId_requestKey:{connectionId:CONNECTION,requestKey}},include:{units:true}});if(current?.status!=='FAILED'||current.safeErrorCode!=='PROVIDER_UNAVAILABLE'||current.units.find(x=>x.unitKey===DAY)?.attempts!==2||current.rowsPublished!==0)fail();
    await tx.syncRun.create({data:{id:payload.runId,connectionId:CONNECTION,trigger:'SCHEDULED',requestKey:'manual-rollback-probe:'+payload.runId,fromDate:new Date(DAY+'T00:00:00Z'),toDate:new Date('2026-10-14T00:00:00Z'),status:'RUNNING',deadlineAt:new Date(Date.now()+55000)}});probeRunCreated=true;
    callbackEntered=true;await payload.writeRows(tx);callbackCompleted=true;throw SENTINEL;
   },{timeout:5000,maxWait:1000,isolationLevel:'ReadCommitted'});}catch(error){if(error!==SENTINEL)originalFailure=safeMetaRuntimeFailureDiagnostic(error,'META_PUBLISH');}finally{elapsed=Date.now()-start;}
  }};
  stage='WRITER_VALIDATE';await makeWriter(db,spy).publishMetaDay({runId:randomUUID(),connectionId:CONNECTION,generation:1n,metricDate:new Date(DAY+'T00:00:00Z'),pageCount:snapshot.pageCount,adPolicyVersion:policies.find(p=>p.dataKind==='META_AD').version,adsetPolicyVersion:policies.find(p=>p.dataKind==='META_ADSET').version,expectedCredentialRef:binding.credentialRef,expectedCredentialExpiresAt:binding.credentialExpiresAt,expectedMetaTransport:'MCP',ads:snapshot.ads,adsets:snapshot.adsets});
  const writerQueryCount=queries-writesStart;stage='VERIFY_ROLLBACK';afterDigest=await baseline(false);if(beforeDigest!==afterDigest||writeRowsCalls!==1)fail();
  return {state:'PHASE08_META_WRITER_ROLLBACK_DIAGNOSTIC',classification:'MANUAL_DIAGNOSTIC_TRANSIENT_WRITES_ROLLED_BACK',day:DAY,transactionTimeoutMs:5000,elapsedMs:elapsed,writerQueryCount,probeRunCreated,callbackEntered,callbackCompleted,diagnosticCode:originalFailure,rollbackVerified:true,originalAttemptsChanged:false,providerRequests:0,committedWrites:0,normalPublishEvidence:false,foundationPublishFencingExecuted:false,coveragePublicationExecuted:false,pausedMetaExternallyAttested:true,rawValuesReturned:0};
 }catch(error){throw Object.assign(Error('PHASE08_META_WRITER_ROLLBACK_FAILED'),{safeStage:['INPUT','CAPTURE','BASELINE','WRITER_VALIDATE','WRITER_TRANSACTION','VERIFY_ROLLBACK'].includes(stage)?stage:'INPUT',diagnosticCode:safeMetaRuntimeFailureDiagnostic(error,'META_PUBLISH')});}
 finally{if(db)await Promise.race([db.$disconnect().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,500))]);for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);if(input?.env){for(const key of Object.keys(input.env))delete input.env[key];}if(input){input.captureKeyB64=null;input.databaseUrl=null;}}
}
export function safeMetaRollbackFailure(error){return {state:'PHASE08_META_WRITER_ROLLBACK_FAILED',stage:['INPUT','CAPTURE','BASELINE','WRITER_VALIDATE','WRITER_TRANSACTION','VERIFY_ROLLBACK'].includes(error?.safeStage)?error.safeStage:'INPUT',diagnosticCode:typeof error?.diagnosticCode==='string'&&/^META_PUBLISH_(?:PRISMA_P(?:1000|1001|1002|1008|1011|1017|2000|2002|2003|2009|2010|2021|2022|2023|2024|2028|2034)|PRISMA_VALIDATION|OTHER|PROVIDER|HTTP)$/.test(error.diagnosticCode)?error.diagnosticCode:'META_PUBLISH_OTHER',rollbackVerified:false,providerRequests:0,inspectBeforeRetry:true,rawErrorSuppressed:true};}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let input;const hard=setTimeout(()=>{process.stdout.write(JSON.stringify({state:'PHASE08_META_WRITER_ROLLBACK_FAILED',stage:'HARD_TIMEOUT',rollbackVerified:false,providerRequests:0,inspectBeforeRetry:true,rawErrorSuppressed:true}));process.exit(1);},60000);try{let raw='';for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>2500000)fail();}input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(await runMetaRollbackProbe(input)),()=>process.exit(0));}catch(error){process.stdout.write(JSON.stringify(safeMetaRollbackFailure(error)),()=>process.exit(1));}finally{clearTimeout(hard);input=null;}}
