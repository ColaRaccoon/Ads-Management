// Sensitive returns are for the protected parent only. No logging, filesystem,
// environment secret reads, automatic retries or application imports.
import {createDecipheriv,createCipheriv,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
export const CAFE08_ID='0c35defe-45fc-4a54-bc79-704df7bca5b1';
const fail=()=>{throw Error('CAFE08_RECOVERY_SAFE_REJECTED');};
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
const uuid=s=>{if(typeof s!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(s))fail();return s;};
const instant=s=>{if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))fail();return s;};
const canonical64=(s,n,max=n)=>{if(typeof s!=='string')fail();const b=Buffer.from(s,'base64');if(b.length<n||b.length>max||b.toString('base64')!==s)fail();return b;};
function open(row,key){const d=createDecipheriv('aes-256-gcm',key,canonical64(row.ivB64,12));d.setAAD(Buffer.from(`${CAFE08_ID}:${row.kind}:2`));d.setAuthTag(canonical64(row.authTagB64,16));return Buffer.concat([d.update(canonical64(row.ciphertextB64,20,8192)),d.final()]);}
function seal(token,key,kind){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(`${CAFE08_ID}:${kind}:2`));return{ivB64:iv.toString('base64'),ciphertextB64:Buffer.concat([c.update(token,'utf8'),c.final()]).toString('base64'),authTagB64:c.getAuthTag().toString('base64')};}
const same=(a,b)=>a.length===b.length&&timingSafeEqual(a,b);
export function cafe08SnapshotSql(){return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout=20000;
SELECT current_database() AS db,current_user AS principal,
(SELECT jsonb_build_object('id',id,'provider',provider,'mall',external_account_id,'shop',shop_key,'currency',currency_code,'timezone',time_zone,'enabled',enabled,'accessState',access_state,'credentialRef',credential_ref,'credentialExpiresAt',credential_expires_at,'rowHash',md5(to_jsonb(s)::text),'immutableHash',md5((to_jsonb(s)-'credential_expires_at'-'updated_at')::text)) FROM phase08_meta_ads.source_connections s WHERE id='${CAFE08_ID}') AS connection,
(SELECT jsonb_agg(jsonb_build_object('id',id,'connectionId',connection_id,'kind',kind,'keyVersion',key_version,'revision',revision,'expiresAt',expires_at,'refreshOwner',refresh_owner,'refreshUntil',refresh_until,'ciphertextB64',replace(encode(ciphertext,'base64'),chr(10),''),'ivB64',encode(iv,'base64'),'authTagB64',encode(auth_tag,'base64'),'rowHash',md5(to_jsonb(c)::text),'immutableHash',md5((to_jsonb(c)-'ciphertext'-'iv'-'auth_tag'-'expires_at'-'revision'-'updated_at')::text)) ORDER BY kind) FROM phase08_meta_ads.source_credentials c) AS credentials,
(SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints')) AS "heldGrants",
(SELECT count(*)::int FROM phase08_meta_ads.source_connections WHERE enabled) AS "enabledConnections",
(SELECT count(*)::int FROM phase08_meta_ads.source_connections) AS "connectionCount",
(SELECT md5(coalesce(string_agg(md5(to_jsonb(s)::text),'' ORDER BY md5(to_jsonb(s)::text)),'')) FROM phase08_meta_ads.source_connections s WHERE id<>'${CAFE08_ID}') AS "otherConnectionsDigest",
(SELECT count(*)::int FROM phase08_meta_ads.sync_runs WHERE status='RUNNING') AS "runningRuns",
(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS "liveLeases";
ROLLBACK;`;}
export function prepareCafe08Recovery(input,now=Date.now()){
 let key,refresh,access;try{
  const s=input?.snapshot,c=s?.connection;
  if(input.operationKey!=='20261020-cafe08-read-recovery-a'||s?.db!=='postgres'||s.principal!=='postgres'||s.heldGrants!==0||s.enabledConnections!==0||s.connectionCount!==3||!/^[a-f0-9]{32}$/.test(s.otherConnectionsDigest)||s.runningRuns!==0||s.liveLeases!==0||input.callbackRevision11Verified!==true||input.new08OAuthNoCloneLineageVerified!==true||input.holdsVerified!==true||input.activeKeyVersion!=='2'||input.retiredV1!=='1'||input.observationQuarantined!=='true')fail();
  if(c?.id!==CAFE08_ID||c.provider!=='CAFE24'||c.mall!=='didadi0729'||c.shop!=='shop1'||c.currency!=='KRW'||c.timezone!=='Asia/Seoul'||c.enabled!==false||c.accessState!=='READY'||c.credentialRef!==`source_credentials:${CAFE08_ID}:CAFE24_REFRESH`||!/^[a-f0-9]{32}$/.test(c.rowHash)||!/^[a-f0-9]{32}$/.test(c.immutableHash))fail();
  if(!/^[A-Za-z0-9]{8,128}$/.test(input.clientId??'')||typeof input.clientSecret!=='string'||input.clientSecret.length<1||input.clientSecret.length>512||input.callbackSecretMatchesBaseline!==true)fail();
  if(!Array.isArray(s.credentials)||s.credentials.length!==2||new Set(s.credentials.map(r=>r.kind)).size!==2)fail();
  key=canonical64(input.credentialKeyV2,32);
  for(const r of s.credentials){uuid(r.id);if(r.connectionId!==CAFE08_ID||!['CAFE24_ACCESS','CAFE24_REFRESH'].includes(r.kind)||r.keyVersion!==2||r.revision!==8||r.refreshOwner!==null||r.refreshUntil!==null||!/^[a-f0-9]{32}$/.test(r.rowHash)||!/^[a-f0-9]{32}$/.test(r.immutableHash))fail();instant(r.expiresAt);}
  const a=s.credentials.find(r=>r.kind==='CAFE24_ACCESS'),r=s.credentials.find(r=>r.kind==='CAFE24_REFRESH');
  if(Date.parse(a.expiresAt)>now||Date.parse(r.expiresAt)<=now+120000||Date.parse(c.credentialExpiresAt)!==Date.parse(r.expiresAt))fail();
  refresh=open(r,key);access=open(a,key);for(const b of [refresh,access])if([...b].some(n=>n<33||n>126))fail();
  return{eligibleSecretRollback:false,operationKey:input.operationKey,snapshot:s,credentialKeyV2:input.credentialKeyV2,clientId:input.clientId,clientSecret:input.clientSecret,refreshToken:refresh.toString('ascii'),preparedAt:new Date(now).toISOString(),expiresAt:new Date(now+15*60000).toISOString(),auditId:randomUUID(),proof:{callbackRevision11Verified:true,new08OAuthNoCloneLineageVerified:true},safeSummary:{preparedOnly:true,providerRequests:0,expectedCredentialRows:2,expectedBeforeRevision:8,expectedAfterRevision:9,keyVersion:2,maximumTokenPosts:1,maximumOrderGets:0,enabledRemainsFalse:true,clientSecretChanged:false,oldRefreshRestoreForbidden:true,rawValuesReturned:0}};
 }catch{fail();}finally{key?.fill(0);refresh?.fill(0);access?.fill(0);}
}
/** Return *unparsed* bounded provider bytes. Parent must DPAPI-seal this entire
 * result before calling finalize. Includes partial bytes on transport failure. */
export async function submitCafe08RefreshOnce(plan,{request=fetch,now=Date.now}={}){
 if(plan?.eligibleSecretRollback!==false||plan.operationKey!=='20261020-cafe08-read-recovery-a'||Date.parse(plan.expiresAt)<=now()||plan.proof?.callbackRevision11Verified!==true)fail();
 let status=null,bytes=0,chunks=[],reader,complete=false,category='TRANSPORT_OR_TIMEOUT';
 try{
  const response=await request('https://didadi0729.cafe24api.com/api/v2/oauth/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:`Basic ${Buffer.from(`${plan.clientId}:${plan.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:plan.refreshToken}).toString()});
  status=response.status;if(!response.body){category='BODY_ABSENT';throw Error();}reader=response.body.getReader();
  while(true){const part=await reader.read();if(part.done){complete=true;break;}if(bytes+part.value.byteLength>32768||chunks.length>=512){category='BODY_BOUND';await reader.cancel();throw Error();}bytes+=part.value.byteLength;chunks.push(Buffer.from(part.value));}
  category='RESPONSE_CAPTURED';
 }catch{}finally{try{reader?.releaseLock();}catch{}}
 const body=Buffer.concat(chunks);try{return{operationKey:plan.operationKey,requestSubmitted:true,httpStatus:status,complete,category,bodyB64:body.toString('base64'),bodyBytes:bytes,eligibleSecretRollback:false,providerPosts:1,receivedAt:new Date(now()).toISOString()};}finally{body.fill(0);chunks.forEach(b=>b.fill(0));}
}
function full68Guard(tables){if(!Array.isArray(tables)||tables.length!==68||new Set(tables.map(t=>t.table)).size!==68||tables.some(t=>!/^[a-z][a-z0-9_]{0,62}$/.test(t.table)||!Number.isSafeInteger(t.rows)||t.rows<0||!/^[a-f0-9]{32}$/.test(t.md5)))fail();return `FOR t IN SELECT * FROM jsonb_to_recordset(${q(JSON.stringify(tables))}::jsonb) AS x("table" text,rows bigint,md5 text) LOOP
EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(z)::text),'''' ORDER BY md5(to_jsonb(z)::text)),'''')) FROM phase08_meta_ads.%I z',t."table") INTO n,h;
IF n IS DISTINCT FROM t.rows OR h IS DISTINCT FROM t.md5 THEN RAISE EXCEPTION 'CAFE08_BEFORE68_CAS'; END IF;END LOOP;`;}
export function finalizeCafe08Recovery(plan,protectedResponse,tables,now=Date.now()){
 let raw,key,oldAccess,newAccess;try{
  if(plan?.operationKey!=='20261020-cafe08-read-recovery-a'||plan.eligibleSecretRollback!==false||protectedResponse?.operationKey!==plan.operationKey||protectedResponse.providerPosts!==1||protectedResponse.complete!==true||protectedResponse.httpStatus!==200||protectedResponse.eligibleSecretRollback!==false)fail();
  raw=canonical64(protectedResponse.bodyB64,1,32768);if(raw.length!==protectedResponse.bodyBytes)fail();const token=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(token.mall_id!=='didadi0729'||String(token.shop_no)!=='1'||token.client_id!==plan.clientId||token.token_type!=='Bearer'||!Array.isArray(token.scopes)||token.scopes.length!==1||token.scopes[0]!=='mall.read_order'||typeof token.user_id!=='string'||!/^[\x21-\x7e]{1,128}$/.test(token.user_id))fail();
  for(const name of ['access_token','refresh_token'])if(typeof token[name]!=='string'||!/^[\x21-\x7e]{20,8192}$/.test(token[name]))fail();
  const tokenInstant=value=>{if(typeof value==='string'&&!/(?:Z|[+-]\d\d:\d\d)$/.test(value))value+='+09:00';return new Date(instant(value)).toISOString();};
  const accessExpiry=tokenInstant(token.expires_at),refreshExpiry=tokenInstant(token.refresh_token_expires_at),issuedAt=tokenInstant(token.issued_at);
  if(Date.parse(accessExpiry)<now+11*60000||Date.parse(accessExpiry)>now+2*3600000+120000||Date.parse(refreshExpiry)<=Date.parse(accessExpiry)||Date.parse(refreshExpiry)>now+14*86400000+120000||Math.abs(Date.parse(issuedAt)-now)>120000||token.refresh_token===plan.refreshToken)fail();
  key=canonical64(plan.credentialKeyV2,32);oldAccess=open(plan.snapshot.credentials.find(row=>row.kind==='CAFE24_ACCESS'),key);newAccess=Buffer.from(token.access_token);if(same(oldAccess,newAccess))fail();const rows=plan.snapshot.credentials.map(before=>{const material=before.kind==='CAFE24_ACCESS'?token.access_token:token.refresh_token;return{before,next:{...seal(material,key,before.kind),expiresAt:before.kind==='CAFE24_ACCESS'?accessExpiry:refreshExpiry,revision:before.revision+1,keyVersion:2}};});
  const quotedId=q(CAFE08_ID),updates=rows.map(({before,next})=>`UPDATE source_credentials SET ciphertext=decode(${q(next.ciphertextB64)},'base64'),iv=decode(${q(next.ivB64)},'base64'),auth_tag=decode(${q(next.authTagB64)},'base64'),expires_at=${q(next.expiresAt)}::timestamptz,revision=revision+1,updated_at=clock_timestamp() WHERE id=${q(uuid(before.id))}::uuid AND connection_id=${quotedId}::uuid AND kind=${q(before.kind)} AND key_version=2 AND revision=8 AND refresh_owner IS NULL AND refresh_until IS NULL AND md5(to_jsonb(source_credentials)::text)=${q(before.rowHash)};GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION 'CAFE08_PAIR_CAS';END IF;`).join('\n');
  const preservedRows=rows.map(({before})=>`IF NOT EXISTS(SELECT 1 FROM source_credentials c WHERE id=${q(before.id)}::uuid AND revision=9 AND key_version=2 AND md5((to_jsonb(c)-'ciphertext'-'iv'-'auth_tag'-'expires_at'-'revision'-'updated_at')::text)=${q(before.immutableHash)}) THEN RAISE EXCEPTION 'CAFE08_IMMUTABLE_CREDENTIAL';END IF;`).join('\n');
  const sql=`BEGIN ISOLATION LEVEL SERIALIZABLE;SET LOCAL search_path=phase08_meta_ads,public;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
DO $cafe08$ DECLARE t record;n bigint;h text;BEGIN
IF current_database()<>'postgres' OR current_user<>'postgres' OR (SELECT rolcanlogin FROM pg_roles WHERE rolname='phase08_runtime') OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='phase08_runtime') OR NOT(SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) OR (SELECT count(*) FROM daily_data_sync_ops.schedules WHERE paused)<>3 OR EXISTS(SELECT 1 FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149 OR EXISTS(SELECT 1 FROM source_connections WHERE enabled) OR EXISTS(SELECT 1 FROM sync_leases WHERE expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM sync_runs WHERE status='RUNNING') OR EXISTS(SELECT 1 FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints')) THEN RAISE EXCEPTION 'CAFE08_HOLD';END IF;
IF (SELECT count(*) FROM pg_tables WHERE schemaname='phase08_meta_ads')<>68 THEN RAISE EXCEPTION 'CAFE08_TABLE_INVENTORY';END IF;
PERFORM 1 FROM source_connections WHERE id=${quotedId}::uuid FOR UPDATE;PERFORM 1 FROM source_credentials WHERE connection_id=${quotedId}::uuid ORDER BY kind FOR UPDATE;
${full68Guard(tables)}
IF (SELECT count(*) FROM source_credentials)<>2 OR NOT EXISTS(SELECT 1 FROM source_connections s WHERE id=${quotedId}::uuid AND NOT enabled AND provider='CAFE24' AND external_account_id='didadi0729' AND shop_key='shop1' AND credential_ref=${q(plan.snapshot.connection.credentialRef)} AND md5(to_jsonb(s)::text)=${q(plan.snapshot.connection.rowHash)}) THEN RAISE EXCEPTION 'CAFE08_OWNER';END IF;
${updates}
UPDATE source_connections SET credential_expires_at=${q(refreshExpiry)}::timestamptz,updated_at=clock_timestamp() WHERE id=${quotedId}::uuid AND NOT enabled;GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION 'CAFE08_CONNECTION';END IF;
${preservedRows}
IF NOT EXISTS(SELECT 1 FROM source_connections s WHERE id=${quotedId}::uuid AND NOT enabled AND md5((to_jsonb(s)-'credential_expires_at'-'updated_at')::text)=${q(plan.snapshot.connection.immutableHash)}) THEN RAISE EXCEPTION 'CAFE08_IMMUTABLE_CONNECTION';END IF;
IF (SELECT count(*) FROM source_connections)<>3 OR (SELECT md5(coalesce(string_agg(md5(to_jsonb(s)::text),'' ORDER BY md5(to_jsonb(s)::text)),'')) FROM source_connections s WHERE id<>${quotedId}::uuid)<>${q(plan.snapshot.otherConnectionsDigest)} THEN RAISE EXCEPTION 'CAFE08_OTHER_CONNECTIONS';END IF;
INSERT INTO security_audit_events(id,actor_type,actor_user_id,action,target_type,target_id,result,after_json) VALUES(${q(uuid(plan.auditId))}::uuid,'SYSTEM',NULL,'CAFE24_CREDENTIAL_ROTATED','SOURCE_CONNECTION',${quotedId},'SUCCESS',${q(JSON.stringify({operationKey:plan.operationKey,scope:'mall.read_order',keyVersion:2,beforeRevision:8,afterRevision:9,providerPosts:1,enabledRemainsFalse:true}))}::jsonb);
FOR t IN SELECT * FROM jsonb_to_recordset(${q(JSON.stringify(tables))}::jsonb) AS x("table" text,rows bigint,md5 text) LOOP
IF t."table" NOT IN('source_credentials','source_connections') THEN
IF t."table"='security_audit_events' THEN SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(z)::text),'' ORDER BY md5(to_jsonb(z)::text)),'')) INTO n,h FROM security_audit_events z WHERE id<>${q(plan.auditId)}::uuid;
ELSE EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(z)::text),'''' ORDER BY md5(to_jsonb(z)::text)),'''')) FROM phase08_meta_ads.%I z',t."table") INTO n,h;END IF;
IF n IS DISTINCT FROM t.rows OR h IS DISTINCT FROM t.md5 THEN RAISE EXCEPTION 'CAFE08_AFTER68_PRESERVATION';END IF;END IF;END LOOP;
END $cafe08$;COMMIT;SELECT 2::integer AS "credentialRows",1::integer AS "connectionRows",1::integer AS "auditRows",true AS "enabledRemainsFalse";`;
  return{operationKey:plan.operationKey,eligibleSecretRollback:false,mutationSql:sql,expectedRows:rows.map(({before,next})=>({id:before.id,connectionId:CAFE08_ID,kind:before.kind,immutableHash:before.immutableHash,...next})),responseValid:true,accessExpiry,refreshExpiry,safeSummary:{responseValidated:true,scopeExact:true,credentialRows:2,expectedRevision:9,keyVersion:2,issuedAtFresh:true,providerUserIdShapeValidated:true,previousProviderUserIdAvailable:false,previousProviderUserIdCompared:false,sharedClientSecretChanged:false,oldRefreshRestoreForbidden:true}};
 }catch{fail();}finally{raw?.fill(0);key?.fill(0);oldAccess?.fill(0);newAccess?.fill(0);}
}
export function verifyCafe08Recovery(prepared,snapshot,plan){let key;const buffers=[];try{
 if(snapshot.credentials?.length!==2||snapshot.connection?.id!==CAFE08_ID||snapshot.connection?.enabled!==false||snapshot.connection.immutableHash!==plan.snapshot.connection.immutableHash||snapshot.otherConnectionsDigest!==plan.snapshot.otherConnectionsDigest||snapshot.connection.credentialExpiresAt===null||Date.parse(snapshot.connection.credentialExpiresAt)!==Date.parse(prepared.refreshExpiry))fail();key=canonical64(plan.credentialKeyV2,32);
 for(const expected of prepared.expectedRows){const actual=snapshot.credentials.find(row=>row.kind===expected.kind);if(!actual||actual.id!==expected.id||actual.connectionId!==CAFE08_ID||actual.immutableHash!==expected.immutableHash||actual.keyVersion!==2||actual.revision!==9||actual.refreshOwner!==null||actual.refreshUntil!==null||Date.parse(actual.expiresAt)!==Date.parse(expected.expiresAt))fail();const a=open(actual,key),b=open(expected,key);buffers.push(a,b);if(!same(a,b))fail();}
 return{verified:true,credentialRows:2,keyVersion:2,revision:9,exactNewPairAuthenticatedDecryption:true,enabledRemainsFalse:true,rawValuesReturned:0};
 }catch{fail();}finally{key?.fill(0);buffers.forEach(b=>b.fill(0));}}
