// Protected stdin/stdout only. No network, logging, token renewal or file writes.
import {createDecipheriv,randomUUID} from 'node:crypto';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {cafe08SnapshotSql} from './phase10-cafe-pair-renew-20261021.mjs';
import {CAFE,API,SOURCE,OP,sha,canonical,runtimeClosure,continuationBinding} from './phase10-cafe-oneoff-controller-v3-20261021.mjs';
import {databaseTarget,DATABASE_CERTIFICATE_PATH,keyCommitments,executorPins,validateOneoffPlan} from './phase10-cafe-oneoff-executor-v2-20261021.mjs';
import {DAYS,APPROVED,RAW_FIELDS,WIRE_FIELDS} from './phase10-cafe-epoch-live-transport-v2-20261021.mjs';
import {cafe24PaymentMethodCsvMap} from '../../../apps/api/src/daily-sync/sync-contract.ts';
const fail=()=>{throw Error('CAFE08_ONEOFF_INPUT_REJECTED');};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(x);
const b64=(x,n,max=n)=>{if(typeof x!=='string')fail();const b=Buffer.from(x,'base64');if(b.length<n||b.length>max||b.toString('base64')!==x)fail();return b;};
export const EVIDENCE=['DAILY_SYNC_CAFE24_APP_API_VERSION','DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT','DAILY_SYNC_CAFE24_SELLER_DROPDOWN','DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT','DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES','DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED','DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT','DAILY_SYNC_CAFE24_PAYMENT_METHOD_CSV_MAP','DAILY_SYNC_CAFE24_PAYMENT_METHOD_MAP_VERIFIED_AT'];
export function evidenceDiagnostic(v,now=Date.now()){
 const requiredSevenPresent=EVIDENCE.slice(0,7).every(n=>typeof v?.[n]==='string'&&v[n].length>0),a=v?.[EVIDENCE[7]],b=v?.[EVIDENCE[8]];
 const absent=!a&&!b,paired=typeof a==='string'&&a.length>0&&typeof b==='string'&&b.length>0;let existingPaymentContractAccepted=false;
 try{cafe24PaymentMethodCsvMap(absent?{}:{[EVIDENCE[7]]:a,[EVIDENCE[8]]:b},new Date(now));existingPaymentContractAccepted=true;}catch{}
 return{requiredSevenPresent,optionalMapPair:absent?'ABSENT':paired?'PRESENT':'MIXED_OR_INVALID',existingPaymentContractAccepted};
}
export function inputMetadataSql(operator){
 if(!uuid(operator?.appId)||!uuid(operator?.authId))fail();
 return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout='20s';
 SELECT current_database() db,current_user principal,
 (SELECT jsonb_build_object('id',id,'authId',auth_user_id,'active',is_active,'role',role,'deactivatedAt',deactivated_at) FROM phase08_meta_ads.app_users WHERE id='${operator.appId}'::uuid AND auth_user_id='${operator.authId}'::uuid) operator,
 (SELECT jsonb_agg(jsonb_build_object('id',id,'md5',md5(to_jsonb(p)::text)) ORDER BY id) FROM phase08_meta_ads.source_policies p WHERE connection_id='${CAFE}'::uuid AND data_kind::text='CAFE24_ORDER' AND primary_source::text='CSV' AND version=5 AND from_date<='2026-10-16'::date AND (to_date IS NULL OR to_date>'2026-10-17'::date)) policies,
 (SELECT count(*) FROM phase08_meta_ads.source_policies WHERE connection_id='${CAFE}'::uuid AND data_kind::text='CAFE24_ORDER' AND from_date<='2026-10-17'::date AND (to_date IS NULL OR to_date>'2026-10-16'::date)) overlapping;
 COMMIT;`;
}
export function normalizedDatabaseUrl(value){let u;try{u=new URL(value);}catch{fail();}const names=[...u.searchParams.keys()];if(new Set(names).size!==names.length)fail();u.searchParams.set('sslmode','require');u.searchParams.set('sslaccept','strict');u.searchParams.set('sslcert',DATABASE_CERTIFICATE_PATH);const normalized=u.toString();databaseTarget(normalized);return normalized;}
export function buildProtectedInput(input,{now=Date.now(),checkClosure=runtimeClosure}={}){
 let key,iv,tag,cipher,plain,obs,stage='IDENTITY';
 try{
  const v=input?.variables,s=input?.snapshot,c=s?.connection,m=input?.metadata,o=m?.operator;
  if(input?.holdsVerified!==true||s?.db!=='postgres'||s.principal!=='postgres'||s.heldGrants!==0||s.enabledConnections!==0||s.connectionCount!==3||s.runningRuns!==0||s.liveLeases!==0||c?.id!==CAFE||c.provider!=='CAFE24'||c.mall!=='didadi0729'||c.shop!=='shop1'||c.currency!=='KRW'||c.timezone!=='Asia/Seoul'||c.enabled!==false||c.accessState!=='READY'||!/^[a-f0-9]{32}$/.test(c.rowHash??'')||c.credentialRef!==`source_credentials:${CAFE}:CAFE24_REFRESH`||m?.db!=='postgres'||m.principal!=='postgres'||m.overlapping!==1||!uuid(o?.id)||!uuid(o?.authId)||o.active!==true||o.role!=='SUPER_ADMIN'||o.deactivatedAt!==null||o.id!==input.operator?.appId||o.authId!==input.operator?.authId||!Array.isArray(m.policies)||m.policies.length!==1||!uuid(m.policies[0].id)||!/^[a-f0-9]{32}$/.test(m.policies[0].md5??''))fail();
  stage='CONFIG';if(!v||v.DAILY_SYNC_FEATURE_ENABLED!=='false'||v.DAILY_SYNC_SCHEDULE_ENABLED!=='false'||v.DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED!=='true'||v.DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION!=='2'||v.DAILY_SYNC_ACTIVE_KEY_VERSION!=='2'||v.DAILY_SYNC_RETIRED_CREDENTIAL_KEY_VERSIONS!=='1'||Object.hasOwn(v,'DAILY_SYNC_CREDENTIAL_KEY_V1')||!Array.isArray(s.credentials)||s.credentials.length!==2||new Set(s.credentials.map(x=>x.kind)).size!==2)fail();
  stage='PAIR';
  for(const r of s.credentials)if(r.connectionId!==CAFE||r.keyVersion!==2||r.revision!==10||!['CAFE24_ACCESS','CAFE24_REFRESH'].includes(r.kind)||r.refreshOwner!==null||r.refreshUntil!==null||!Number.isFinite(Date.parse(r.expiresAt)))fail();
  stage='EXPIRY';const access=s.credentials.find(r=>r.kind==='CAFE24_ACCESS'),refresh=s.credentials.find(r=>r.kind==='CAFE24_REFRESH');if(Date.parse(access.expiresAt)<now+25*60000||Date.parse(refresh.expiresAt)<Date.parse(access.expiresAt)||Date.parse(c.credentialExpiresAt)!==Date.parse(refresh.expiresAt))fail();
  stage='KEY';
  obs=b64(v.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64,32);key=b64(v.DAILY_SYNC_CREDENTIAL_KEY_V2,32);
  for(const [name,value]of Object.entries(v))if((/^DAILY_SYNC_CREDENTIAL_KEY_V\d+$/.test(name)||name==='DAILY_SYNC_CHECKPOINT_KEY_B64')&&value===v.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64)fail();
  stage='ACCESS_AAD';iv=b64(access.ivB64,12);tag=b64(access.authTagB64,16);cipher=b64(access.ciphertextB64,20,8192);const d=createDecipheriv('aes-256-gcm',key,iv);d.setAAD(Buffer.from(CAFE+':CAFE24_ACCESS:2'));d.setAuthTag(tag);plain=Buffer.concat([d.update(cipher),d.final()]);if(plain.length<20||[...plain].some(x=>x<33||x>126))fail();
  stage='EVIDENCE';const diagnosis=evidenceDiagnostic(v,now),evidence=Object.fromEntries(EVIDENCE.filter(n=>typeof v[n]==='string'&&v[n].length>0).map(n=>[n,v[n]]));if(!diagnosis.requiredSevenPresent||!diagnosis.existingPaymentContractAccepted||diagnosis.optionalMapPair==='MIXED_OR_INVALID'||evidence.DAILY_SYNC_CAFE24_APP_API_VERSION!=='2026-09-01'||canonical(JSON.parse(evidence.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES).sort())!==canonical(APPROVED))fail();
  stage='CLOSURE';
  const closure=checkClosure();if(closure.runtimeSourceSha256!==SOURCE||closure.runtimeFiles!==495||closure.migrations!==52)fail();
  const epochReference=randomUUID(),epochStartedAt=new Date(now).toISOString(),observationKeyB64=obs.toString('base64');
  const approval={kind:'CAFE08_REMOTE_EXPLICIT_EPOCH_APPROVAL',operationKey:OP,connectionId:CAFE,keyVersion:2,epochReference,epochStartedAt,sourceClosureSha256:SOURCE,apiSourceSha256:API,approvedDays:DAYS,...keyCommitments(observationKeyB64),keyIndependenceVerified:true,operatorUserId:o.id,policyVersion:5,primarySource:'CSV',rawFields:RAW_FIELDS,wireFields:WIRE_FIELDS,canonicalTwoPassExactRequired:true,newManualRunsOnly:true,previousRunAndCheckpointMutationAllowed:false,runtimeAppsMustRemainStopped:true};
  stage='PLAN_CODE';const binding=continuationBinding(),databaseUrl=normalizedDatabaseUrl(v.DATABASE_URL),p={continuationResultSha256:binding.receiptSha256,newCatalogMd5:binding.snapshot.newCatalog,kind:'CAFE08_REMOTE_EXPLICIT_DAY_PLAN',operationKey:OP,connectionId:CAFE,keyVersion:2,epochReference,epochStartedAt,baselineApprovalSha256:sha(canonical(approval)),sourceClosureSha256:SOURCE,apiSourceSha256:API,approvedDays:DAYS,operatorUserId:o.id,policyVersion:5,primarySource:'CSV',access:plain.toString('ascii'),accessExpiresAt:access.expiresAt,observationKeyB64,keyIndependenceVerified:true,evidence,databaseUrl,databaseUrlSha256:sha(databaseUrl),day:DAYS[0],requestKey:`phase10-${OP}-${DAYS[0]}`,executionDeadlineAt:new Date(now+650000).toISOString(),preparedAt:new Date(now).toISOString(),operationPreparedAt:new Date(now).toISOString(),operationDeadlineAt:new Date(now+1500000).toISOString(),expectedConnectionMd5:c.rowHash,expectedPolicyMd5:m.policies[0].md5,policyId:m.policies[0].id,expectedDbRole:'phase08_runtime',eligibleSecretRollback:false,executorPins:executorPins(),approval,usedRequests:0,usedBytes:0,sourceClosureProof:closure};
  validateOneoffPlan(p,now);return p;
 }catch{throw Object.assign(Error('CAFE08_ONEOFF_INPUT_REJECTED'),{safeStage:stage});}finally{for(const b of [key,iv,tag,cipher,plain,obs])b?.fill(0);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let text='';try{for await(const c of process.stdin){text+=c;if(Buffer.byteLength(text)>4194304)fail();}const w=JSON.parse(text);text='';if(w.action==='CipherSql')process.stdout.write(cafe08SnapshotSql());else if(w.action==='MetadataSql')process.stdout.write(inputMetadataSql(w.operator));else if(w.action==='Build')process.stdout.write(JSON.stringify(buildProtectedInput(w.input)));else fail();}catch(e){process.stdout.write(JSON.stringify({kind:'CAFE08_ONEOFF_INPUT_SAFE_REJECTION',status:'FAIL',safeStage:['IDENTITY','CONFIG','PAIR','EXPIRY','KEY','ACCESS_AAD','EVIDENCE','CLOSURE','PLAN_CODE'].includes(e?.safeStage)?e.safeStage:'PLAN_CODE',rawErrorSuppressed:true}));process.exitCode=1;}finally{text='';}
}
