// Pure fixed-target diagnostic SQL. The root operator submits it; this module never connects.
export function schedulerTransportDiagnosticSql() {
 return `BEGIN READ ONLY;
SET LOCAL statement_timeout=15000;
DO $guard$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
 OR to_regnamespace('storage_renewal_ops') IS NOT NULL
 OR (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')<>68
 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 THEN RAISE EXCEPTION 'PHASE08_DIAGNOSTIC_IDENTITY_REJECTED'; END IF;
END $guard$;
DO $diagnostic$
DECLARE step text; safe_state text; secret text; headers extensions.http_header[];
 results jsonb:='[]'::jsonb; okay boolean;
BEGIN
 FOREACH step IN ARRAY ARRAY['VAULT_LOOKUP','TIMEOUT_MS','CONNECTTIMEOUT_MS','FOLLOWLOCATION','HEADER_BUILD','RESET_OPTIONS'] LOOP
  safe_state:=NULL;okay:=false;
  BEGIN
   CASE step
    WHEN 'VAULT_LOOKUP' THEN
     SELECT decrypted_secret INTO STRICT secret FROM vault.decrypted_secrets WHERE name='daily_data_sync_08_machine';
     okay:=secret IS NOT NULL AND length(secret)>=32;secret:=NULL;
    WHEN 'TIMEOUT_MS' THEN okay:=extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','85000');
    WHEN 'CONNECTTIMEOUT_MS' THEN okay:=extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS','15000');
    WHEN 'FOLLOWLOCATION' THEN okay:=extensions.http_set_curlopt('CURLOPT_FOLLOWLOCATION','0');
    WHEN 'HEADER_BUILD' THEN
     headers:=ARRAY[extensions.http_header('x-daily-sync-token','SYNTHETIC_DIAGNOSTIC_NO_CREDENTIAL'),extensions.http_header('x-daily-sync-target','phase08-full-app')];
     okay:=cardinality(headers)=2;headers:=NULL;
    WHEN 'RESET_OPTIONS' THEN okay:=extensions.http_reset_curlopt();
   END CASE;
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS safe_state=RETURNED_SQLSTATE;
   secret:=NULL;headers:=NULL;
  END;
  results:=results||jsonb_build_array(jsonb_build_object('stage',step,'passed',okay,'sqlState',safe_state));
 END LOOP;
 PERFORM set_config('daily_data_sync.transport_diagnostic',results::text,true);
END $diagnostic$;
SELECT current_setting('daily_data_sync.transport_diagnostic')::jsonb AS diagnostics,
 false AS application_http_called,false AS provider_called,false AS database_rows_written;
ROLLBACK;`;
}
