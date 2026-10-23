// SQL is returned only to the protected PowerShell caller. This module never
// connects to a database, reads credentials, or executes a provider request.
import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export const CAFE='0c35defe-45fc-4a54-bc79-704df7bca5b1';
export const SOURCE='70a7c8cd00c2dd592f632dd35312e283011ef648c5926b5aac4273edb8cea6f2';
export const API='cb07068c268931053861ec770c4168470bf36a594c105270a26d0961c214aa74';
export const MIGRATION='0242d0a231ffe93fa35f1a94c5effaedb0f671a29a8a8d66b7a3b7d7aae7ad99';
export const TABLES=['cafe24_observed_epoch_day_checkpoints','cafe24_observed_epoch_order_revisions'];
export const HELD=['source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints'];
export const OP='20261021-cafe08-manual-a';
export const CONTINUATION_RECEIPT='cb70081771644edeb168eefc3742b6a364be3a468635f712c1084fabb0000f63';
export const sha=x=>createHash('sha256').update(x).digest('hex');
export const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
const fail=()=>{throw Error('CAFE08_CONTROLLER_REJECTED');};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(x);
const literal=x=>"'"+String(x).replaceAll("'","''")+"'";
const names=xs=>xs.map(literal).join(',');
export function validatePlan(p,now=Date.now(),expired=false){
 if(p?.kind!=='CAFE08_REMOTE_EXPLICIT_DAY_PLAN'||p.operationKey!==OP||p.connectionId!==CAFE||!['2026-10-16','2026-10-17'].includes(p.day)||p.keyVersion!==2||!uuid(p.operatorUserId)||!uuid(p.epochReference)||!uuid(p.policyId)||p.policyVersion!==5||p.primarySource!=='CSV'||p.sourceClosureSha256!==SOURCE||p.apiSourceSha256!==API||p.expectedDbRole!=='phase08_runtime'||p.eligibleSecretRollback!==false||p.requestKey!==`phase10-${OP}-${p.day}`||!/^[a-f0-9]{64}$/.test(p.baselineApprovalSha256??'')||!/^[a-f0-9]{32}$/.test(p.expectedPolicyMd5??'')||!Number.isFinite(Date.parse(p.preparedAt))||!Number.isFinite(Date.parse(p.executionDeadlineAt))||Date.parse(p.preparedAt)>now||Date.parse(p.executionDeadlineAt)-Date.parse(p.preparedAt)>700000||(!expired&&(now-Date.parse(p.preparedAt)>900000||Date.parse(p.executionDeadlineAt)<=now)))fail();
 if(canonical(p.approvedDays)!==canonical(['2026-10-16','2026-10-17']))fail();
 if(p.operationPreparedAt!==undefined||p.operationDeadlineAt!==undefined){const start=Date.parse(p.operationPreparedAt),end=Date.parse(p.operationDeadlineAt);if(!Number.isFinite(start)||!Number.isFinite(end)||start>now||end-start!==1500000||Date.parse(p.preparedAt)<start||Date.parse(p.executionDeadlineAt)>end||(!expired&&end<=now))fail();}
 return p;
}
export function nextDayPlan(p,day,now=Date.now()){
 if(!['2026-10-16','2026-10-17'].includes(day)||!Number.isFinite(Date.parse(p.operationDeadlineAt)))fail();
 const next={...p,day,requestKey:`phase10-${OP}-${day}`,preparedAt:new Date(now).toISOString(),executionDeadlineAt:new Date(Math.min(now+650000,Date.parse(p.operationDeadlineAt)-120000)).toISOString()};
 validatePlan(next,now);return next;
}
export function runtimeClosure(){
 const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v7',manifest=JSON.parse(readFileSync(root+'/source-content-manifest.json','utf8'));
 if(manifest.sourceContentSha256!==SOURCE||manifest.files.length!==495||new Set(manifest.files.map(f=>f.name)).size!==495||sha(JSON.stringify(manifest.files))!==SOURCE)fail();
 for(const f of manifest.files){if(typeof f.name!=='string'||path.isAbsolute(f.name)||f.name.split(/[\\/]/).includes('..')||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.size)||f.size<0)fail();for(const base of [process.cwd(),root]){const file=path.join(base,f.name);if(statSync(file).size!==f.size||sha(readFileSync(file))!==f.sha256)fail();}}
 const proof=readFileSync('C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/final-source.json');const parsed=JSON.parse(proof);if(parsed.status!=='PASS'||parsed.candidateSource!==SOURCE||parsed.filesMatchedCandidateAndWorkspace!==495||parsed.migrationCount!==52)fail();
 return{runtimeSourceSha256:SOURCE,runtimeFiles:495,migrations:52,freshRootProofSha256:sha(proof)};
}
export function migrationBytes(){const b=readFileSync('apps/api/prisma/migrations/20261020160000_cafe24_observation_epochs/migration.sql');if(sha(b)!==MIGRATION)fail();return b.toString('utf8');}
export function continuationBinding(){
 const raw=readFileSync('C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/cafe-oneoff-controller-v5/execute-c-result.json');if(raw.length>1048576||sha(raw)!==CONTINUATION_RECEIPT)fail();const r=JSON.parse(raw),s=r.cleanup?.snapshot;
 if(r.status!=='FAIL'||r.stage!=='EXECUTE_2026-10-16'||r.cleanup?.containVerified!==true||r.cleanup?.policiesRemoved!==true||r.cleanup?.protectedRowsVerified!==true||r.dayResults?.length!==1||r.dayResults[0].readCalls!==0||r.dayResults[0].runId!==null||s?.newCount!==2||s.newCatalog!=='690faef6638482b0b123fc2ed5014061'||s.newPolicies!==0||s.newGrants!==0||s.newNonownerGrants!==0||s.ownRuns!==0||s.login!==false||s.enabled!==false||s.backends!==0)fail();migrationBytes();return{receiptSha256:CONTINUATION_RECEIPT,snapshot:s};
}
export function assertContinuationSnapshot(s){const b=continuationBinding();assertSnapshot(s,{newTables:2});if(s.newRows!==0)fail();for(const k of Object.keys(b.snapshot))if(canonical(s[k])!==canonical(b.snapshot[k]))fail();return{receiptSha256:b.receiptSha256,newCatalogMd5:s.newCatalog,existingEpochRows:0};}
export function policyNames(){return TABLES.flatMap((_,i)=>['s','i','u','d'].map(c=>'phase10_cafe_oneoff_'+i+'_'+c));}
const BEGIN=`BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'; SET LOCAL search_path=phase08_meta_ads,pg_catalog; SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));`;
const IDENTITY=`IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL OR to_regnamespace('phase08_meta_ads') IS NULL THEN RAISE EXCEPTION 'ONEOFF_TARGET'; END IF;`;
const check=(condition,code)=>`IF NOT COALESCE((${condition}),false) THEN RAISE EXCEPTION '${code}'; END IF;`;
// Exclude only this new request's append-only records. Original CSV rows,
// previous run/audit rows and all other connections remain in the digest.
function protectedPredicate(p){
 const c=literal(CAFE),d="'2026-10-16','2026-10-17'",r=names(['2026-10-16','2026-10-17'].map(day=>`phase10-${OP}-${day}`)),o=literal(p.operatorUserId);
 return {
 source_connections:`x.id<>${c}::uuid`,
 sync_runs:`NOT(x.connection_id=${c}::uuid AND x.request_key IN(${r}) AND x.trigger::text='MANUAL' AND x.actor_user_id=${o}::uuid)`,
 run_units:`NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.id=x.run_id AND r.connection_id=${c}::uuid AND r.request_key IN(${r}))`,
 sync_leases:`x.connection_id<>${c}::uuid`,
 source_coverage:`NOT(x.connection_id=${c}::uuid AND x.data_kind::text='CAFE24_ORDER' AND x.metric_date IN(${d}))`,
 cafe24_order_api_versions:`NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.id=x.sync_run_id AND r.connection_id=${c}::uuid AND r.request_key IN(${r}))`,
 cafe24_order_lines:`NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.id=x.sync_run_id AND r.connection_id=${c}::uuid AND r.request_key IN(${r}))`,
 source_record_links:`NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.id=x.sync_run_id AND r.connection_id=${c}::uuid AND r.request_key IN(${r}))`,
 security_audit_events:`NOT(x.actor_user_id=${o}::uuid AND EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.connection_id=${c}::uuid AND r.request_key IN(${r}) AND (x.target_id=r.id::text OR x.target_id IN(r.id::text||':2026-10-16',r.id::text||':2026-10-17'))))`
 };
}
export function snapshotBody(p){
 validatePlan(p,Date.now(),true);const predicates=protectedPredicate(p),c=literal(CAFE),d=literal(p.day),policy=literal(p.policyId),op=literal(p.operatorUserId);
 const branches=Object.entries(predicates).map(([t,w])=>`WHEN ${literal(t)} THEN ${literal(w)}`).join(' ');
 return `DO $oneoff_snapshot$ DECLARE t record;n bigint;h text;pn bigint;ph text;w text;newrows bigint:=0;allrows jsonb:='[]';protectedrows jsonb:='[]';ledgers jsonb:='[]';q jsonb; BEGIN
 ${IDENTITY}
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' AND tablename NOT IN(${names(TABLES)}) ORDER BY tablename LOOP
 EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM phase08_meta_ads.%I x',t.tablename) INTO n,h;
 w:=CASE t.tablename ${branches} ELSE 'true' END;
 EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM phase08_meta_ads.%I x WHERE %s',t.tablename,w) INTO pn,ph;
 allrows:=allrows||jsonb_build_array(jsonb_build_object('table',t.tablename,'rows',n,'md5',h));protectedrows:=protectedrows||jsonb_build_array(jsonb_build_object('table',t.tablename,'rows',pn,'md5',ph));END LOOP;
 FOREACH w IN ARRAY ARRAY['phase08_meta_ads._prisma_migrations','public._prisma_migrations'] LOOP
 IF to_regclass(w) IS NULL THEN ledgers:=ledgers||jsonb_build_array(jsonb_build_object('relation',w,'exists',false));
 ELSE EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM %s x',w) INTO n,h;ledgers:=ledgers||jsonb_build_array(jsonb_build_object('relation',w,'exists',true,'rows',n,'md5',h));END IF;END LOOP;
 FOREACH w IN ARRAY ARRAY[${names(TABLES)}] LOOP IF to_regclass('phase08_meta_ads.'||w) IS NOT NULL THEN EXECUTE format('SELECT count(*) FROM phase08_meta_ads.%I',w) INTO n;newrows:=newrows+n;END IF;END LOOP;
 SELECT jsonb_build_object('migrationLedgers',ledgers,'newRows',newrows,
 'oldCount',jsonb_array_length(allrows),'whole',md5(allrows::text),'protected',md5(protectedrows::text),
 'catalog',(SELECT md5(jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',c.relacl::text,'owner',c.relowner,'attributes',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'def',pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(indexdef ORDER BY indexname) FROM pg_indexes i WHERE i.schemaname='phase08_meta_ads' AND i.tablename=c.relname)) ORDER BY c.relname)::text) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relname NOT IN(${names(TABLES)})),
 'oldPolicies',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY tablename,policyname)::text,'[]')) FROM pg_policies x WHERE schemaname='phase08_meta_ads' AND tablename NOT IN(${names(TABLES)})),
 'oldGrants',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY table_name,privilege_type)::text,'[]')) FROM information_schema.role_table_grants x WHERE table_schema='phase08_meta_ads' AND grantee='phase08_runtime' AND table_name NOT IN(${names(TABLES)})),
 'oldGrantCount',(SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='phase08_meta_ads' AND grantee='phase08_runtime' AND table_name NOT IN(${names(TABLES)})),
 'defaultAcl',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY defaclrole,defaclobjtype)::text,'[]')) FROM pg_default_acl x WHERE defaclnamespace='phase08_meta_ads'::regnamespace),
 'oldForced',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relname NOT IN(${names(TABLES)}) AND c.relrowsecurity AND c.relforcerowsecurity),
 'role',(SELECT to_jsonb(r)-'rolpassword'-'oid'-'rolcanlogin' FROM pg_roles r WHERE rolname='phase08_runtime'),
 'login',(SELECT rolcanlogin FROM pg_roles WHERE rolname='phase08_runtime'),
 'unsafeRole',(SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication FROM pg_roles WHERE rolname='phase08_runtime'),
 'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='phase08_runtime')),
 'heldGrants',(SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='phase08_meta_ads' AND grantee='phase08_runtime' AND table_name IN(${names(HELD)})),
 'backends',(SELECT count(*) FROM pg_stat_activity WHERE usename='phase08_runtime'),
 'leases',(SELECT count(*) FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()),
 'controls',jsonb_build_object('stopped',(SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton),'paused',(SELECT count(*) FROM daily_data_sync_ops.schedules WHERE paused),'jobs',(SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%'),'activeJobs',(SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active),'jobHash',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY jobid)::text,'[]')) FROM cron.job x),'settingsHash',(SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY singleton)::text) FROM daily_data_sync_ops.settings x),'schedulesHash',(SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text)::text) FROM daily_data_sync_ops.schedules x),'attemptsHash',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'[]')) FROM daily_data_sync_ops.attempts x),'callHash',(SELECT md5(pg_get_functiondef('daily_data_sync_ops.call(text,boolean)'::regprocedure)))),
 'storage',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'[]')) FROM storage.objects x WHERE bucket_id='meta-ads-phase08-isolated'),
 'connection',(SELECT md5(to_jsonb(x)::text) FROM phase08_meta_ads.source_connections x WHERE id=${c}::uuid),
 'connectionImmutable',(SELECT md5((to_jsonb(x)-'enabled'-'updated_at')::text) FROM phase08_meta_ads.source_connections x WHERE id=${c}::uuid),
 'connectionExact',(SELECT count(*) FROM phase08_meta_ads.source_connections WHERE id=${c}::uuid AND provider::text='CAFE24' AND external_account_id='didadi0729' AND shop_key='shop1' AND currency_code='KRW' AND time_zone='Asia/Seoul' AND access_state::text='READY'),
 'enabled',(SELECT enabled FROM phase08_meta_ads.source_connections WHERE id=${c}::uuid),
 'otherEnabled',(SELECT count(*) FROM phase08_meta_ads.source_connections WHERE id<>${c}::uuid AND enabled),
 'policy',(SELECT md5(to_jsonb(x)::text) FROM phase08_meta_ads.source_policies x WHERE id=${policy}::uuid AND connection_id=${c}::uuid AND data_kind::text='CAFE24_ORDER' AND primary_source::text='CSV' AND version=5 AND from_date<=${d}::date AND (to_date IS NULL OR to_date>${d}::date)),
 'operator',(SELECT count(*) FROM phase08_meta_ads.app_users WHERE id=${op}::uuid AND is_active AND deactivated_at IS NULL AND role::text='SUPER_ADMIN' AND auth_user_id IS NOT NULL),
 'ownRuns',(SELECT count(*) FROM phase08_meta_ads.sync_runs WHERE connection_id=${c}::uuid AND request_key IN(${names(['2026-10-16','2026-10-17'].map(day=>`phase10-${OP}-${day}`))})),
 'existingApiRows',(SELECT count(*) FROM phase08_meta_ads.cafe24_order_lines WHERE connection_id=${c}::uuid AND source::text='API' AND order_date IN('2026-10-16','2026-10-17'))+(SELECT count(*) FROM phase08_meta_ads.cafe24_order_api_versions WHERE connection_id=${c}::uuid AND order_date IN('2026-10-16','2026-10-17')),
 'unboundCurrentCsv',(SELECT count(*) FROM phase08_meta_ads.cafe24_order_lines WHERE connection_id IS NULL AND source::text='CSV' AND is_current AND order_date IN('2026-10-16','2026-10-17')),
 'newCount',(SELECT count(*) FROM pg_tables WHERE schemaname='phase08_meta_ads' AND tablename IN(${names(TABLES)})),
 'newForced',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relname IN(${names(TABLES)}) AND c.relrowsecurity AND c.relforcerowsecurity),
 'newCatalog',(SELECT md5(coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'owner',c.relowner,'attributes',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'def',pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid)) ORDER BY c.relname)::text,'[]')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relname IN(${names(TABLES)})),
 'fkExact',(SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class p ON p.oid=k.confrelid WHERE n.nspname='phase08_meta_ads' AND c.relname='cafe24_observed_epoch_order_revisions' AND p.relname='cafe24_observed_epoch_day_checkpoints' AND k.conname='cafe24_epoch_revisions_checkpoint_fkey' AND k.condeferrable AND k.condeferred AND k.confdeltype='r' AND k.confupdtype='c' AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY v(num,ord) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=v.num ORDER BY v.ord)=ARRAY['connection_id','key_version','order_date'] AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY v(num,ord) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=v.num ORDER BY v.ord)=ARRAY['connection_id','key_version','order_date']),
 'newPolicies',(SELECT count(*) FROM pg_policies WHERE schemaname='phase08_meta_ads' AND tablename IN(${names(TABLES)})),
 'newPolicyHash',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY tablename,policyname)::text,'[]')) FROM pg_policies x WHERE schemaname='phase08_meta_ads' AND tablename IN(${names(TABLES)})),
 'newGrants',(SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='phase08_meta_ads' AND grantee='phase08_runtime' AND table_name IN(${names(TABLES)})),
 'newNonownerGrants',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE n.nspname='phase08_meta_ads' AND c.relname IN(${names(TABLES)}) AND a.grantee<>c.relowner)
 ) INTO q;PERFORM set_config('oneoff.snapshot',q::text,true);END $oneoff_snapshot$;`;
}
export function assertSnapshot(s,{newTables=0,armed=false}={}){
 if(!s||s.oldCount!==68||s.oldForced!==68||s.oldGrantCount!==256||s.heldGrants!==0||s.unsafeRole!==false||s.memberships!==0||s.login!==armed||s.enabled!==armed||s.connectionExact!==1||s.otherEnabled!==0||s.operator!==1||s.newCount!==newTables||s.newForced!==newTables||s.fkExact!==(newTables===2?1:0)||s.newGrants!==(armed?8:0)||s.newPolicies!==(armed?8:0)||s.newNonownerGrants!==(armed?8:0)||s.controls?.stopped!==true||s.controls.paused!==3||s.controls.jobs!==149||s.controls.activeJobs!==0||s.leases!==0||s.backends!==0)fail();
 for(const k of ['whole','protected','catalog','oldPolicies','oldGrants','defaultAcl','storage','connection','policy'])if(!/^[a-f0-9]{32}$/.test(s[k]??''))fail();return true;
}
function beforeGuard(p,b,{whole=true,armed=false,newTables=0}={}){
 if(!b||!b.controls||typeof b.role!=='object')fail();for(const k of ['whole','protected','catalog','oldPolicies','oldGrants','defaultAcl','storage','connection','policy'])if(!/^[a-f0-9]{32}$/.test(b[k]??''))fail();
 const exact=['catalog','oldPolicies','oldGrants','defaultAcl','storage','controls','role','migrationLedgers','connectionImmutable',whole?'whole':'protected','policy'];
 return `DO $oneoff_guard$ DECLARE s jsonb:=current_setting('oneoff.snapshot')::jsonb;b jsonb:=${literal(canonical(b))}::jsonb;BEGIN ${IDENTITY}
 ${exact.map(k=>check(`s->${literal(k)}=b->${literal(k)}`,'ONEOFF_CAS_'+k.toUpperCase())).join('\n')}
 ${check(`(s->>'oldCount')::int=68 AND (s->>'oldForced')::int=68 AND (s->>'oldGrantCount')::int=256 AND (s->>'heldGrants')::int=0 AND (s->>'memberships')::int=0 AND NOT(s->>'unsafeRole')::boolean`,'ONEOFF_SECURITY')}
 ${check(`s->'controls'->>'stopped'='true' AND (s->'controls'->>'paused')::int=3 AND (s->'controls'->>'jobs')::int=149 AND (s->'controls'->>'activeJobs')::int=0`,'ONEOFF_HOLD')}
 ${check(`(s->>'newCount')::int=${newTables} AND (s->>'newForced')::int=${newTables} AND (s->>'newGrants')::int=${armed?8:0} AND (s->>'newPolicies')::int=${armed?8:0} AND (s->>'newNonownerGrants')::int=${armed?8:0}`,'ONEOFF_NEW_TABLES')}
 ${newTables===2?check(`(s->>'fkExact')::int=1${p.newCatalogMd5?` AND s->>'newCatalog'=${literal(p.newCatalogMd5)}`:''}`,'ONEOFF_NEW_CATALOG'):''}
 ${check(`s->>'login'='${armed}' AND s->>'enabled'='${armed}' AND (s->>'backends')::int=0 AND (s->>'leases')::int=0 AND (s->>'connectionExact')::int=1 AND (s->>'otherEnabled')::int=0 AND (s->>'operator')::int=1`,'ONEOFF_ACTORS')}
 ${check(`s->>'policy'=${literal(p.expectedPolicyMd5)}`,'ONEOFF_POLICY')}
 ${whole?check(`s->>'connection'=b->>'connection' AND (s->>'ownRuns')::int=0 AND (s->>'existingApiRows')::int=0 AND (s->>'unboundCurrentCsv')::int=0`,'ONEOFF_CONNECTION_CAS'):''}
 END $oneoff_guard$;`;
}
export function policySql(p){
 validatePlan(p);for(const k of ['keyCommitment','keyIdentityCommitment'])if(!/^[a-f0-9]{64}$/.test(p.approval?.[k]??''))fail();const write=`connection_id=${literal(CAFE)}::uuid AND key_version=2 AND epoch_reference=${literal(p.epochReference)}::uuid AND epoch_started_at=${literal(p.epochStartedAt)}::timestamptz AND key_commitment=${literal(p.approval.keyCommitment)} AND key_identity_commitment=${literal(p.approval.keyIdentityCommitment)} AND baseline_approval_sha256=${literal(p.baselineApprovalSha256)} AND source_closure_sha256=${literal(SOURCE)} AND order_date IN('2026-10-16','2026-10-17')`;
 return TABLES.map((t,i)=>`CREATE POLICY phase10_cafe_oneoff_${i}_s ON phase08_meta_ads.${t} FOR SELECT TO phase08_runtime USING(connection_id=${literal(CAFE)}::uuid);
 CREATE POLICY phase10_cafe_oneoff_${i}_i ON phase08_meta_ads.${t} FOR INSERT TO phase08_runtime WITH CHECK(${write});
 CREATE POLICY phase10_cafe_oneoff_${i}_u ON phase08_meta_ads.${t} FOR UPDATE TO phase08_runtime USING(${write}) WITH CHECK(${write});
 CREATE POLICY phase10_cafe_oneoff_${i}_d ON phase08_meta_ads.${t} FOR DELETE TO phase08_runtime USING(${write});
 GRANT SELECT,INSERT,UPDATE,DELETE ON phase08_meta_ads.${t} TO phase08_runtime;`).join('\n');
}
// SQL-layer guard, also exercised with synthetic native before-images. The
// production render entry additionally binds b to the immutable v5 receipt.
export function verify52Sql(p,b){return `${BEGIN}${snapshotBody(p)}${beforeGuard(p,b,{newTables:2})}DO $empty$ BEGIN ${check("(current_setting('oneoff.snapshot')::jsonb->>'newRows')::int=0",'ONEOFF_EPOCH_NOT_EMPTY')}END $empty$;SELECT current_setting('oneoff.snapshot')::json AS snapshot;COMMIT;`;}
export function renderSql(action,p,b=null){
 validatePlan(p,Date.now(),['Snapshot','Contain','Cleanup','Inspect'].includes(action));const body=snapshotBody(p);
 if(action==='Snapshot'||action==='Inspect')return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='30s'; SET LOCAL search_path=phase08_meta_ads,pg_catalog;${body} SELECT current_setting('oneoff.snapshot')::json AS snapshot;COMMIT;`;
 if(action==='Migrate')fail();
 if(action==='Verify52'){if(p.continuationResultSha256!==CONTINUATION_RECEIPT||p.newCatalogMd5!==b?.newCatalog)fail();assertContinuationSnapshot(b);return verify52Sql(p,b);}
 if(action==='Arm')return `${BEGIN}${body}${beforeGuard(p,b,{newTables:2})}${policySql(p)} ALTER ROLE phase08_runtime LOGIN;
 DO $arm$ DECLARE n int;BEGIN UPDATE phase08_meta_ads.source_connections s SET enabled=true,updated_at=clock_timestamp() WHERE id=${literal(CAFE)}::uuid AND NOT enabled AND md5(to_jsonb(s)::text)=${literal(b.connection)};GET DIAGNOSTICS n=ROW_COUNT;${check('n=1','ONEOFF_ARM_CAS')} END $arm$;
 ${body}${beforeGuard(p,b,{whole:false,armed:true,newTables:2})}SELECT current_setting('oneoff.snapshot')::json AS snapshot;COMMIT;`;
 if(action==='Contain')return `${BEGIN}DO $contain$ DECLARE t text;BEGIN ${IDENTITY}
 ALTER ROLE phase08_runtime NOLOGIN;
 UPDATE phase08_meta_ads.source_connections SET enabled=false,updated_at=CASE WHEN enabled THEN clock_timestamp() ELSE updated_at END WHERE id=${literal(CAFE)}::uuid AND provider::text='CAFE24' AND external_account_id='didadi0729' AND shop_key='shop1';
 FOREACH t IN ARRAY ARRAY[${names(TABLES)}] LOOP IF to_regclass('phase08_meta_ads.'||t) IS NOT NULL THEN EXECUTE format('REVOKE ALL ON TABLE phase08_meta_ads.%I FROM phase08_runtime',t);END IF;END LOOP;
 UPDATE phase08_meta_ads.sync_leases l SET expires_at=least(l.expires_at,clock_timestamp()),generation=l.generation+1,updated_at=clock_timestamp() WHERE l.connection_id=${literal(CAFE)}::uuid AND l.expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.id=l.owner_run_id AND r.connection_id=${literal(CAFE)}::uuid AND r.request_key IN(${names(['2026-10-16','2026-10-17'].map(day=>`phase10-${OP}-${day}`))}) AND r.actor_user_id=${literal(p.operatorUserId)}::uuid AND r.trigger::text='MANUAL');
 END $contain$; COMMIT;
 BEGIN;SET LOCAL statement_timeout='10s';DO $own_backends$ BEGIN ${IDENTITY}
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='phase08_runtime' AND backend_start<${literal(p.operationPreparedAt??p.preparedAt)}::timestamptz) OR (SELECT count(*) FROM pg_stat_activity WHERE usename='phase08_runtime')>3 THEN RAISE EXCEPTION 'ONEOFF_FOREIGN_BACKEND';END IF;
 PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='phase08_runtime' AND datname='postgres' AND backend_start>=${literal(p.operationPreparedAt??p.preparedAt)}::timestamptz AND pid<>pg_backend_pid();END $own_backends$;COMMIT;`;
 if(action==='Cleanup'){
  if(!/^[a-f0-9]{32}$/.test(p.armedPolicyMd5??''))fail();
  return `${BEGIN}${body}DO $cleanup$ DECLARE s jsonb:=current_setting('oneoff.snapshot')::jsonb;BEGIN ${IDENTITY}${check(`s->>'login'='false' AND s->>'enabled'='false' AND (s->>'backends')::int=0 AND (s->>'leases')::int=0 AND (s->>'newGrants')::int=0`,'ONEOFF_NOT_CONTAINED')}${check(`s->>'newPolicyHash'=${literal(p.armedPolicyMd5)} AND (s->>'newPolicies')::int=8`,'ONEOFF_POLICY_DRIFT')}END $cleanup$;
 ${TABLES.flatMap((t,i)=>['s','i','u','d'].map(k=>`DROP POLICY phase10_cafe_oneoff_${i}_${k} ON phase08_meta_ads.${t};`)).join('\n')}${body}${beforeGuard(p,b,{whole:false,newTables:2})}SELECT current_setting('oneoff.snapshot')::json AS snapshot;COMMIT;`;
 }
 fail();
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let text='';try{for await(const c of process.stdin){text+=c;if(Buffer.byteLength(text)>4194304)fail();}const w=JSON.parse(text);text='';
 if(w.action==='Validate'){validatePlan(w.plan);const binding=continuationBinding();if(w.plan.continuationResultSha256!==binding.receiptSha256||w.plan.newCatalogMd5!==binding.snapshot.newCatalog)fail();const closure=runtimeClosure();const {validateOneoffPlan}=await import('./phase10-cafe-oneoff-executor-v2-20261021.mjs');validateOneoffPlan(w.plan);process.stdout.write(JSON.stringify({validated:true,...closure,continuationReceiptSha256:binding.receiptSha256}));}
 else if(w.action==='AssertContinuation'){process.stdout.write(JSON.stringify(assertContinuationSnapshot(w.snapshot)));}
 else if(w.action==='NextDay'){process.stdout.write(JSON.stringify(nextDayPlan(w.plan,w.day)));}
 else if(w.action==='Assert'){assertSnapshot(w.snapshot,w.options);process.stdout.write('{"validated":true}');}
 else {const sql=renderSql(w.action,w.plan,w.before);process.stdout.write(sql);}}
 catch{process.stderr.write('CAFE08_CONTROLLER_REJECTED');process.exitCode=1;}finally{text='';}
}
