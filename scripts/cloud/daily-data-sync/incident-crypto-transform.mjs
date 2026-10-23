// Protected-parent library. This file never reads environment secrets, performs
// network I/O, writes files, or prints. Sensitive returns stay in parent memory.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const PROJECT='ehnfrrmbkvlsbpvqcvkr',SCHEMA='phase08_meta_ads',ROLE='phase08_runtime';
const CAFE='0c35defe-45fc-4a54-bc79-704df7bca5b1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=()=>{throw Error('INCIDENT_CRYPTO_SAFE_REJECTED');};
const same=(a,b)=>a.length===b.length&&timingSafeEqual(a,b);
function bytes(value,length,max=length){
 if(typeof value!=='string'||value.length>Math.ceil(max/3)*4)fail();
 const out=Buffer.from(value,'base64');if(out.toString('base64')!==value||out.length<length||out.length>max)fail();return out;
}
function instant(value){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)||!Number.isFinite(Date.parse(value)))fail();return value;
}
const integer=(value,min=1,max=2147483646)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail();return value;};
const uuid=value=>{if(typeof value!=='string'||!UUID.test(value))fail();return value;};
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const binary=value=>`decode(${quote(value)},'base64')`;
const timestamp=value=>`${quote(instant(value))}::timestamptz`;
const hex=value=>createHash('sha256').update(value).digest('hex');
function open(row,key,aad){
 let plaintext;
 try{
  const cipher=createDecipheriv('aes-256-gcm',key,bytes(row.ivB64,12));
  cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(bytes(row.authTagB64,16));
  plaintext=Buffer.concat([cipher.update(bytes(row.ciphertextB64,1,8*1024*1024)),cipher.final()]);
  return plaintext;
 }catch{plaintext?.fill(0);return fail();}
}
function seal(plaintext,key,aad){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));
 return {ciphertextB64:Buffer.concat([cipher.update(plaintext),cipher.final()]).toString('base64'),ivB64:iv.toString('base64'),authTagB64:cipher.getAuthTag().toString('base64')};
}
function rewrap(row,oldKey,newKey,oldAad,newAad){
 const plain=open(row,oldKey,oldAad);
 try{const next=seal(plain,newKey,newAad),verified=open(next,newKey,newAad);try{if(!same(plain,verified))fail();}finally{verified.fill(0);}return next;}
 finally{plain.fill(0);}
}
/** Three fresh independent secrets; capture only in protected parent memory. */
export function createIncidentCryptoKeys(){return{credentialV2:randomBytes(32).toString('base64'),checkpoint:randomBytes(32).toString('base64'),observationV2:randomBytes(32).toString('base64')};}

/** Names/counts/booleans are the only public diagnostic surface. The SQL and
 * environment update contain protected material and must never reach a tool
 * response, console, raw exception, or unencrypted file. */
export function prepareIncidentCryptoTransform(input){
 const material=[];let safeStage='INPUT';
 try{
  if(input?.projectRef!==PROJECT||input.schema!==SCHEMA||input.runtimeRole!==ROLE||input.connectionId!==CAFE||
    input.protectedSnapshotVerified!==true||!/^20261019-[a-z0-9-]{3,48}$/.test(input.operationKey??''))fail();
  safeStage='KEYS';const key=value=>{const result=bytes(value,32);material.push(result);return result;};
  const oldCredential=key(input.oldKeys?.credentialV1),oldCheckpoint=key(input.oldKeys?.checkpoint);
  const credential=key(input.newKeys?.credentialV2),checkpoint=key(input.newKeys?.checkpoint),observation=key(input.newKeys?.observationV2);
  const oldObservation=Buffer.from(hkdfSync('sha256',oldCredential,Buffer.from('cafe24-observation-v1'),Buffer.from('order-revision'),32));material.push(oldObservation);
  const nextKeys=[credential,checkpoint,observation];
  if(nextKeys.some(k=>[oldCredential,oldCheckpoint,oldObservation].some(old=>same(k,old)))||
    nextKeys.some((k,i)=>nextKeys.some((other,j)=>j!==i&&same(k,other)))||nextKeys.some(k=>new Set(k).size<16))fail();
  safeStage='SNAPSHOT';const credentials=input.snapshot?.credentials,checkpoints=input.snapshot?.checkpoints;
  if(!Array.isArray(credentials)||credentials.length!==2||!Array.isArray(checkpoints)||checkpoints.length>32)fail();
  if(new Set(credentials.map(r=>r.kind)).size!==2||new Set(credentials.map(r=>r.id)).size!==2)fail();
  safeStage='CREDENTIALS';const credentialRows=credentials.map(row=>{
   uuid(row.id);if(row.connectionId!==CAFE||!['CAFE24_ACCESS','CAFE24_REFRESH'].includes(row.kind)||row.keyVersion!==1||row.refreshOwner!==null||row.refreshUntil!==null)fail();
   integer(row.revision);instant(row.expiresAt);bytes(row.ciphertextB64,1,8192);bytes(row.ivB64,12);bytes(row.authTagB64,16);
   const next=rewrap(row,oldCredential,credential,`${CAFE}:${row.kind}:1`,`${CAFE}:${row.kind}:2`);
   return{before:row,next};
  });
  safeStage='CHECKPOINTS';let totalBytes=0;
  const checkpointRows=checkpoints.map(row=>{
   uuid(row.runId);uuid(row.connectionId);integer(row.revision);instant(row.expiresAt);
   if(typeof row.unitKey!=='string'||!/^[A-Za-z0-9:_-]{1,256}$/.test(row.unitKey))fail();
   const raw=bytes(row.ciphertextB64,1,8*1024*1024);totalBytes+=raw.length;
   if(totalBytes>8*1024*1024||row.checkpointValue!==hex(raw))fail();
   bytes(row.ivB64,12);bytes(row.authTagB64,16);
   const aad=`${row.connectionId}:${row.runId}:${row.unitKey}`;
   return{before:row,next:rewrap(row,oldCheckpoint,checkpoint,aad,aad)};
  });
  if(new Set(checkpoints.map(r=>`${r.runId}:${r.unitKey}`)).size!==checkpoints.length)fail();
  safeStage='SQL';const credentialGuards=credentialRows.map(({before:r})=>`EXISTS(SELECT 1 FROM source_credentials WHERE id=${quote(r.id)}::uuid AND connection_id=${quote(CAFE)}::uuid AND kind=${quote(r.kind)} AND key_version=1 AND revision=${r.revision} AND refresh_owner IS NULL AND refresh_until IS NULL AND expires_at=${timestamp(r.expiresAt)} AND ciphertext=${binary(r.ciphertextB64)} AND iv=${binary(r.ivB64)} AND auth_tag=${binary(r.authTagB64)})`);
  const checkpointGuards=checkpointRows.map(({before:r})=>`EXISTS(SELECT 1 FROM sync_unit_checkpoints c JOIN sync_runs s ON s.id=c.run_id JOIN run_units u ON u.run_id=c.run_id AND u.unit_key=c.unit_key WHERE c.run_id=${quote(r.runId)}::uuid AND c.unit_key=${quote(r.unitKey)} AND s.connection_id=${quote(r.connectionId)}::uuid AND c.revision=${r.revision} AND c.expires_at=${timestamp(r.expiresAt)} AND c.ciphertext=${binary(r.ciphertextB64)} AND c.iv=${binary(r.ivB64)} AND c.auth_tag=${binary(r.authTagB64)} AND u.checkpoint_value=${quote(r.checkpointValue)})`);
  const updates=credentialRows.map(({before:r,next:n})=>`UPDATE source_credentials SET ciphertext=${binary(n.ciphertextB64)},iv=${binary(n.ivB64)},auth_tag=${binary(n.authTagB64)},key_version=2,revision=revision+1 WHERE id=${quote(r.id)}::uuid AND key_version=1 AND revision=${r.revision}; GET DIAGNOSTICS touched = ROW_COUNT; IF touched<>1 THEN RAISE EXCEPTION 'INCIDENT_CRYPTO_CAS_REJECTED'; END IF;`);
  for(const {before:r,next:n}of checkpointRows){
   updates.push(`UPDATE sync_unit_checkpoints SET ciphertext=${binary(n.ciphertextB64)},iv=${binary(n.ivB64)},auth_tag=${binary(n.authTagB64)},revision=revision+1 WHERE run_id=${quote(r.runId)}::uuid AND unit_key=${quote(r.unitKey)} AND revision=${r.revision}; GET DIAGNOSTICS touched = ROW_COUNT; IF touched<>1 THEN RAISE EXCEPTION 'INCIDENT_CRYPTO_CAS_REJECTED'; END IF;`);
   updates.push(`UPDATE run_units SET checkpoint_value=${quote(hex(Buffer.from(n.ciphertextB64,'base64')))} WHERE run_id=${quote(r.runId)}::uuid AND unit_key=${quote(r.unitKey)} AND checkpoint_value=${quote(r.checkpointValue)}; GET DIAGNOSTICS touched = ROW_COUNT; IF touched<>1 THEN RAISE EXCEPTION 'INCIDENT_CRYPTO_CAS_REJECTED'; END IF;`);
  }
  const preserveTables=['cafe24_order_lines','cafe24_order_api_versions','source_record_links','source_coverage','source_policies','products','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints'];
  // Hash entire existing rows server-side; no business/raw identifier is
  // returned. Per-row hashes bound aggregation memory even for large CSV sets.
  const digestSql=preserveTables.map(table=>`SELECT ${quote(table)} AS name,encode(sha256(convert_to(coalesce(string_agg(digest,'' ORDER BY digest),''),'UTF8')),'hex') AS digest FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest FROM ${table} t) r`).join(' UNION ALL ');
  const preserved=`SELECT jsonb_object_agg(name,digest) FROM (${digestSql}) hashes`;
  const mutationSql=`BEGIN;
SET LOCAL statement_timeout='30000'; SET LOCAL lock_timeout='2000'; SET LOCAL search_path=phase08_meta_ads,pg_catalog;
LOCK TABLE source_connections,source_credentials,sync_leases,sync_runs,sync_unit_checkpoints,run_units,cafe24_observed_order_revisions,cafe24_observed_day_checkpoints IN SHARE ROW EXCLUSIVE MODE;
DO $incident_crypto$
DECLARE touched integer; before_digest jsonb; after_digest jsonb;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR current_schema()<>'phase08_meta_ads' OR
 (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r')<>68 OR
 (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68 OR
 NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='phase08_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) OR
 EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='phase08_runtime') OR
 EXISTS(SELECT 1 FROM sync_leases WHERE expires_at>clock_timestamp()) OR
 EXISTS(SELECT 1 FROM sync_runs WHERE status::text='RUNNING') OR
 NOT EXISTS(SELECT 1 FROM source_connections WHERE id='${CAFE}'::uuid AND provider::text='CAFE24' AND external_account_id='didadi0729' AND shop_key='shop1' AND enabled=false) OR
 has_table_privilege('phase08_runtime','cafe24_observed_order_revisions','SELECT,INSERT,UPDATE,DELETE') OR
 has_table_privilege('phase08_runtime','cafe24_observed_day_checkpoints','SELECT,INSERT,UPDATE,DELETE') OR
 EXISTS(SELECT 1 FROM security_audit_events WHERE action='INCIDENT_CRYPTO_REWRAPPED' AND target_id=${quote(input.operationKey)}) OR
 (SELECT count(*) FROM source_credentials)<>2 OR (SELECT count(*) FROM sync_unit_checkpoints)<>${checkpointRows.length} OR
 NOT (${[...credentialGuards,...checkpointGuards].join(' AND ')})
 THEN RAISE EXCEPTION 'INCIDENT_CRYPTO_GUARD_REJECTED'; END IF;
 SELECT (${preserved}) INTO before_digest;
 ${updates.join('\n ')}
 SELECT (${preserved}) INTO after_digest;
 IF before_digest IS DISTINCT FROM after_digest OR (SELECT count(*) FROM source_credentials WHERE key_version=2)<>2 OR EXISTS(SELECT 1 FROM source_credentials WHERE key_version=1)
 THEN RAISE EXCEPTION 'INCIDENT_CRYPTO_PRESERVATION_REJECTED'; END IF;
 INSERT INTO security_audit_events(id,actor_type,action,target_type,target_id,result,before_json,after_json)
 VALUES('${randomUUID()}'::uuid,'SYSTEM','INCIDENT_CRYPTO_REWRAPPED','ISOLATED_CRYPTO',${quote(input.operationKey)},'SUCCESS',
 '{"credentialKeyVersion":1}'::jsonb,'{"credentialKeyVersion":2,"credentialRows":2,"checkpointRows":${checkpointRows.length},"observationBaselineQuarantined":true,"providerRevoked":false}'::jsonb);
END $incident_crypto$;
COMMIT;
SELECT 2::integer AS "credentialRowsReencrypted",${checkpointRows.length}::integer AS "checkpointRowsReencrypted",true AS "businessRowsPreserved",true AS "observationBaselinePreserved",false AS "providerCredentialsRevoked";`;
  return {mutationSql,environmentUpdate:{set:{DAILY_SYNC_CREDENTIAL_KEY_V2:input.newKeys.credentialV2,DAILY_SYNC_ACTIVE_KEY_VERSION:'2',DAILY_SYNC_RETIRED_CREDENTIAL_KEY_VERSIONS:'1',
   DAILY_SYNC_CHECKPOINT_KEY_B64:input.newKeys.checkpoint,DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64:input.newKeys.observationV2,DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION:'2',DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED:'true'},remove:['DAILY_SYNC_CREDENTIAL_KEY_V1']},
   safeSummary:{preparedOnly:true,mutationExecuted:false,credentialRowsReencrypted:2,checkpointRowsReencrypted:checkpointRows.length,independentNewKeys:3,oldDerivedObservationSecretReused:false,oldCredentialKeyRemovalPlanned:true,observationBaselinePreservationPlanned:true,observationUseQuarantineRequired:true,providerCredentialsRevoked:false,providerRequests:0}};
 }catch{throw Object.assign(Error('INCIDENT_CRYPTO_SAFE_REJECTED'),{safeStage});}finally{for(const key of material)key.fill(0);}
}

/** Execute only through the protected management caller; the result includes
 * ciphertext but no plaintext/key. Capture in memory, never tool output. */
export function incidentCryptoSnapshotSql(){return `WITH bounds AS (
 SELECT (SELECT count(*)=2 AND coalesce(max(octet_length(ciphertext)),0)<=8192 FROM phase08_meta_ads.source_credentials) AS credential_ok,
 (SELECT count(*)<=32 AND coalesce(sum(octet_length(ciphertext)),0)<=8388608 FROM phase08_meta_ads.sync_unit_checkpoints) AS checkpoint_ok
)
SELECT CASE WHEN credential_ok THEN
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'connectionId',connection_id,'kind',kind,'keyVersion',key_version,'revision',revision,'ciphertextB64',replace(encode(ciphertext,'base64'),chr(10),''),'ivB64',encode(iv,'base64'),'authTagB64',encode(auth_tag,'base64'),'expiresAt',expires_at,'refreshOwner',refresh_owner,'refreshUntil',refresh_until) ORDER BY kind),'[]'::jsonb) FROM phase08_meta_ads.source_credentials) ELSE NULL END AS credentials,
 CASE WHEN checkpoint_ok THEN
 (SELECT coalesce(jsonb_agg(jsonb_build_object('runId',c.run_id,'unitKey',c.unit_key,'connectionId',r.connection_id,'revision',c.revision,'expiresAt',c.expires_at,'ciphertextB64',replace(encode(c.ciphertext,'base64'),chr(10),''),'ivB64',encode(c.iv,'base64'),'authTagB64',encode(c.auth_tag,'base64'),'checkpointValue',u.checkpoint_value) ORDER BY c.run_id,c.unit_key),'[]'::jsonb) FROM phase08_meta_ads.sync_unit_checkpoints c JOIN phase08_meta_ads.sync_runs r ON r.id=c.run_id LEFT JOIN phase08_meta_ads.run_units u ON u.run_id=c.run_id AND u.unit_key=c.unit_key) ELSE NULL END AS checkpoints FROM bounds;`;}
