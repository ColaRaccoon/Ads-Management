// Pure, non-secret SQL plan. Never receives the machine token itself.
// Execution requires a separately verified new-service identity and paused install.
export function vaultBootstrapSql({ machineSha256, expiresAt }, now = Date.now()) {
  if (typeof machineSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(machineSha256) ||
      typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) ||
      new Date(expiresAt).toISOString() !== expiresAt ||
      Date.parse(expiresAt) <= now || Date.parse(expiresAt) > now + 300_000)
    throw new Error('PHASE08_VAULT_PLAN_REJECTED');
  return `BEGIN;
DO $guard$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR
    to_regnamespace('storage_renewal_ops') IS NOT NULL OR
    to_regprocedure('daily_data_sync_ops.bootstrap_machine(text)') IS NOT NULL OR
    has_schema_privilege('phase08_runtime','daily_data_sync_ops','USAGE') OR
    (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 THEN RAISE EXCEPTION 'PHASE08_VAULT_SETUP_REJECTED'; END IF;
END $guard$;
CREATE FUNCTION daily_data_sync_ops.bootstrap_machine(p_secret text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE cfg daily_data_sync_ops.settings;
BEGIN
 IF session_user::text<>'phase08_runtime' OR current_database()<>'postgres' OR
    pg_catalog.clock_timestamp()>='${expiresAt}'::pg_catalog.timestamptz OR
    pg_catalog.current_setting('log_statement')<>'ddl' OR
    pg_catalog.current_setting('pgaudit.log',true) IS DISTINCT FROM 'none' OR
    pg_catalog.current_setting('pgaudit.log_parameter',true) IS DISTINCT FROM 'off' OR
    pg_catalog.current_setting('log_parameter_max_length_on_error')<>'0' OR
    p_secret IS NULL OR p_secret !~ '^[A-Za-z0-9+/]{43}=$'
 THEN RAISE EXCEPTION 'PHASE08_VAULT_INPUT_REJECTED'; END IF;
 IF pg_catalog.octet_length(pg_catalog.decode(p_secret,'base64'))<>32 OR
    pg_catalog.encode(pg_catalog.decode(p_secret,'base64'),'base64')<>p_secret OR
    pg_catalog.encode(extensions.digest(p_secret,'sha256'),'hex')<>'${machineSha256}'
 THEN RAISE EXCEPTION 'PHASE08_VAULT_INPUT_REJECTED'; END IF;
 SELECT * INTO STRICT cfg FROM daily_data_sync_ops.settings WHERE singleton FOR UPDATE;
 IF NOT cfg.stopped OR cfg.target_id<>'phase08-full-app' OR
    cfg.origin<>'https://phase08-daily-data-sync-production.up.railway.app' OR
    (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR
    EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE NOT paused) OR
    EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts) OR
    EXISTS(SELECT 1 FROM vault.secrets WHERE name='daily_data_sync_08_machine') OR
    (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3 OR
    (SELECT count(*) FROM phase08_meta_ads.source_connections WHERE enabled AND access_state='READY'
       AND time_zone='Asia/Seoul' AND
       ((id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900'::pg_catalog.uuid AND provider='GOOGLE'
          AND external_account_id='1391592099' AND shop_key='default' AND currency_code='KRW') OR
        (id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'::pg_catalog.uuid AND provider='META'
          AND external_account_id='2138525300002203' AND shop_key='default' AND currency_code='USD') OR
        (id='0c35defe-45fc-4a54-bc79-704df7bca5b1'::pg_catalog.uuid AND provider='CAFE24'
          AND external_account_id='didadi0729' AND shop_key='shop1' AND currency_code='KRW')))<>3 OR
    EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs) OR
    EXISTS(SELECT 1 FROM phase08_meta_ads.source_coverage) OR
    EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>pg_catalog.clock_timestamp()) OR
    (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68 OR
    (SELECT count(*) FROM phase08_meta_ads.source_policies)<>4 OR
    NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_policies
      WHERE connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1'::pg_catalog.uuid
        AND data_kind='CAFE24_ORDER' AND primary_source='CSV' AND version=1 AND to_date IS NULL
        AND reason='CAFE24_SCHEDULED_API_ONLY_BOOTSTRAP')
 THEN RAISE EXCEPTION 'PHASE08_VAULT_STATE_REJECTED'; END IF;
 PERFORM vault.create_secret(p_secret,'daily_data_sync_08_machine','phase08 isolated machine only');
 p_secret:=NULL;
 REVOKE EXECUTE ON FUNCTION daily_data_sync_ops.bootstrap_machine(text) FROM phase08_runtime;
 REVOKE USAGE ON SCHEMA daily_data_sync_ops FROM phase08_runtime;
 INSERT INTO phase08_meta_ads.security_audit_events
   (id,actor_type,action,target_type,target_id,result,after_json)
 VALUES(pg_catalog.gen_random_uuid(),'SYSTEM','DAILY_SYNC_MACHINE_VAULT_CREATED',
   'DAILY_SYNC_SCHEDULER','phase08-full-app','SUCCESS',
   '{"setup":"VAULT_MACHINE","temporaryAccessRevoked":true}'::pg_catalog.jsonb);
 RETURN 'PHASE08_MACHINE_VAULT_CREATED';
END $fn$;
REVOKE ALL ON FUNCTION daily_data_sync_ops.bootstrap_machine(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA daily_data_sync_ops TO phase08_runtime;
GRANT EXECUTE ON FUNCTION daily_data_sync_ops.bootstrap_machine(text) TO phase08_runtime;
COMMIT;`;
}

// The token is supplied only through the caller's protected memory and a bound parameter.
// No error text, SQL, token, or returned driver diagnostics may reach logs.
export async function bindMachineVault(client, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(token) ||
      Buffer.from(token,'base64').length !== 32 || Buffer.from(token,'base64').toString('base64') !== token)
    throw new Error('PHASE08_VAULT_BIND_REJECTED');
  try {
    const rows = await client.$queryRawUnsafe(
      'SELECT daily_data_sync_ops.bootstrap_machine($1::text) AS state', token);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].state !== 'PHASE08_MACHINE_VAULT_CREATED')
      throw new Error('outcome');
    return { state: 'PHASE08_MACHINE_VAULT_CREATED', secretValuesReturned: 0 };
  } catch { throw new Error('PHASE08_VAULT_BIND_FAILED_INSPECT_BEFORE_RETRY'); }
}
