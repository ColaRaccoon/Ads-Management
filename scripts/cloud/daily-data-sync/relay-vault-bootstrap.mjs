import {createHash} from 'node:crypto';
export function relayVaultBootstrapSql({userpwdSha256,expiresAt},now=Date.now()) {
 if(typeof userpwdSha256!=='string'||!/^[a-f0-9]{64}$/.test(userpwdSha256)||typeof expiresAt!=='string'||new Date(expiresAt).toISOString()!==expiresAt||Date.parse(expiresAt)<=now||Date.parse(expiresAt)>now+300000)throw new Error('PHASE08_RELAY_VAULT_PLAN_REJECTED');
 return `BEGIN;
SET LOCAL statement_timeout=15000;
DO $guard$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
 OR to_regprocedure('daily_data_sync_ops.bootstrap_relay(text)') IS NOT NULL
 OR has_schema_privilege('phase08_runtime','daily_data_sync_ops','USAGE')
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 THEN RAISE EXCEPTION 'PHASE08_RELAY_VAULT_SETUP_REJECTED'; END IF; END $guard$;
CREATE FUNCTION daily_data_sync_ops.bootstrap_relay(p_userpwd text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF session_user::text<>'phase08_runtime' OR current_database()<>'postgres' OR clock_timestamp()>='${expiresAt}'::timestamptz
 OR current_setting('log_statement')<>'ddl' OR current_setting('pgaudit.log',true) IS DISTINCT FROM 'none'
 OR current_setting('pgaudit.log_parameter',true) IS DISTINCT FROM 'off' OR current_setting('log_parameter_max_length_on_error')<>'0'
 OR current_setting('log_min_messages') NOT IN ('info','notice','warning','error','log','fatal','panic')
 OR current_setting('client_min_messages') NOT IN ('info','notice','warning','error')
 OR p_userpwd IS NULL OR p_userpwd !~ '^phase08-scheduler:[A-Za-z0-9+/]{43}=$'
 THEN RAISE EXCEPTION 'PHASE08_RELAY_VAULT_INPUT_REJECTED'; END IF;
 IF octet_length(decode(split_part(p_userpwd,':',2),'base64'))<>32
 OR encode(decode(split_part(p_userpwd,':',2),'base64'),'base64')<>split_part(p_userpwd,':',2)
 OR encode(extensions.digest(p_userpwd,'sha256'),'hex')<>'${userpwdSha256}'
 THEN RAISE EXCEPTION 'PHASE08_RELAY_VAULT_INPUT_REJECTED'; END IF;
 PERFORM singleton FROM daily_data_sync_ops.settings WHERE singleton FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND NOT stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE paused)
 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149 OR EXISTS(SELECT 1 FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND NOT active)
 OR (SELECT count(*) FROM daily_data_sync_ops.attempts)<>152
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections WHERE enabled AND access_state='READY' AND time_zone='Asia/Seoul' AND ((id='0c35defe-45fc-4a54-bc79-704df7bca5b1'::uuid AND provider='CAFE24' AND external_account_id='didadi0729' AND shop_key='shop1' AND currency_code='KRW') OR (id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900'::uuid AND provider='GOOGLE' AND external_account_id='1391592099' AND shop_key='default' AND currency_code='KRW') OR (id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'::uuid AND provider='META' AND external_account_id='2138525300002203' AND shop_key='default' AND currency_code='USD')))<>3
 OR (SELECT count(*) FROM phase08_meta_ads.source_policies)<>4
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs) OR EXISTS(SELECT 1 FROM phase08_meta_ads.source_coverage)
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases) OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_unit_checkpoints)
 OR (SELECT count(*) FROM vault.secrets WHERE name='daily_data_sync_08_machine')<>1
 OR EXISTS(SELECT 1 FROM vault.secrets WHERE name='daily_data_sync_08_relay_userpwd')
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.security_audit_events WHERE action='DAILY_SYNC_RELAY_VAULT_CREATED')
 THEN RAISE EXCEPTION 'PHASE08_RELAY_VAULT_STATE_REJECTED'; END IF;
 PERFORM vault.create_secret(p_userpwd,'daily_data_sync_08_relay_userpwd','phase08 relay Basic only');p_userpwd:=NULL;
 REVOKE EXECUTE ON FUNCTION daily_data_sync_ops.bootstrap_relay(text) FROM phase08_runtime;
 REVOKE USAGE ON SCHEMA daily_data_sync_ops FROM phase08_runtime;
 INSERT INTO phase08_meta_ads.security_audit_events(id,actor_type,action,target_type,target_id,result,after_json)
 VALUES(gen_random_uuid(),'SYSTEM','DAILY_SYNC_RELAY_VAULT_CREATED','DAILY_SYNC_SCHEDULER','phase08-full-app','SUCCESS','{"setup":"RELAY_BASIC","temporaryAccessRevoked":true}'::jsonb);
 RETURN 'PHASE08_RELAY_VAULT_CREATED';
END $fn$;
REVOKE ALL ON FUNCTION daily_data_sync_ops.bootstrap_relay(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA daily_data_sync_ops TO phase08_runtime;
GRANT EXECUTE ON FUNCTION daily_data_sync_ops.bootstrap_relay(text) TO phase08_runtime;
COMMIT;`;
}
export function assertRelayUserpwd(value) {
 if(typeof value!=='string'||!/^phase08-scheduler:[A-Za-z0-9+/]{43}=$/.test(value))throw new Error('PHASE08_RELAY_VAULT_BIND_REJECTED');
 const encoded=value.slice('phase08-scheduler:'.length),bytes=Buffer.from(encoded,'base64');
 try{if(bytes.length!==32||bytes.toString('base64')!==encoded)throw new Error('PHASE08_RELAY_VAULT_BIND_REJECTED');}finally{bytes.fill(0);}
}
export async function bindRelayVault(client,userpwd) {
 assertRelayUserpwd(userpwd);
 try{const rows=await client.$queryRawUnsafe('SELECT daily_data_sync_ops.bootstrap_relay($1::text) AS state',userpwd);
 if(!Array.isArray(rows)||rows.length!==1||rows[0].state!=='PHASE08_RELAY_VAULT_CREATED')throw new Error('outcome');return {state:'PHASE08_RELAY_VAULT_CREATED',secretValuesReturned:0};
 }catch{throw new Error('PHASE08_RELAY_VAULT_BIND_FAILED_INSPECT_BEFORE_RETRY');}
}
export function relayVaultFunctionBody(sql) {
 const marker='AS $fn$',start=sql.indexOf(marker),end=sql.indexOf('\nEND $fn$;',start);
 if(start<0||end<0)throw new Error('PHASE08_RELAY_VAULT_PLAN_REJECTED');return sql.slice(start+marker.length,end+'\nEND '.length);
}
export function relayVaultDropSql(expectedSourceSha256) {
 if(typeof expectedSourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSourceSha256))throw new Error('PHASE08_RELAY_VAULT_DROP_REJECTED');
 return `BEGIN; DO $guard$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR (SELECT encode(extensions.digest(p.prosrc,'sha256'),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('daily_data_sync_ops.bootstrap_relay(text)')) IS DISTINCT FROM '${expectedSourceSha256}' THEN RAISE EXCEPTION 'PHASE08_RELAY_VAULT_DROP_REJECTED'; END IF; END $guard$; REVOKE EXECUTE ON FUNCTION daily_data_sync_ops.bootstrap_relay(text) FROM phase08_runtime; REVOKE USAGE ON SCHEMA daily_data_sync_ops FROM phase08_runtime; DROP FUNCTION daily_data_sync_ops.bootstrap_relay(text); COMMIT;`;
}
export const relayVaultBodySha256=sql=>createHash('sha256').update(relayVaultFunctionBody(sql)).digest('hex');
