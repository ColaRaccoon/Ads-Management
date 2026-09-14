-- Upgrade the initial pg_net transport without changing business data.
-- Managed pg_net tables have provider-owned PUBLIC grants that postgres cannot revoke.
-- Use synchronous HTTP in the isolated cron worker so credentials never enter that queue.
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;
-- statement-break --
CREATE SEQUENCE storage_renewal_ops.request_ids START WITH 1000000;
-- statement-break --
ALTER TABLE storage_renewal_ops.requests ADD COLUMN http_status integer, ADD COLUMN result jsonb;
-- statement-break --
CREATE OR REPLACE FUNCTION storage_renewal_ops.invoke(mode text) RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE call_secret text; request_id bigint; response extensions.http_response;
BEGIN
  IF mode NOT IN ('renew','check') OR mode IS NULL THEN RAISE EXCEPTION 'INVALID_MODE'; END IF;
  SELECT decrypted_secret INTO STRICT call_secret FROM vault.decrypted_secrets WHERE name='storage_renewal_call_secret';
  PERFORM extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','90000');
  SELECT * INTO response FROM extensions.http((
    'POST','https://iygjmosbelbosfxidqxv.supabase.co/functions/v1/storage-renewal',
    ARRAY[extensions.http_header('Authorization','Bearer '||call_secret)],
    'application/json',jsonb_build_object('mode',mode)::text
  )::extensions.http_request);
  PERFORM extensions.http_reset_curlopt();
  PERFORM storage_renewal_ops.assert_response(response.status,response.content::jsonb,mode);
  request_id:=nextval('storage_renewal_ops.request_ids');
  INSERT INTO storage_renewal_ops.requests(id,mode,http_status,result)
    VALUES(request_id,mode,response.status,response.content::jsonb);
  RETURN request_id;
EXCEPTION WHEN OTHERS THEN
  -- Do not propagate transport diagnostics which might include request details.
  RAISE EXCEPTION 'STORAGE_RENEWAL_FAILED_INSPECT_EDGE_AND_RAILWAY';
END $$;
-- statement-break --
CREATE OR REPLACE FUNCTION storage_renewal_ops.audit() RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE mode_name text; req storage_renewal_ops.requests;
BEGIN
  FOREACH mode_name IN ARRAY ARRAY['renew','check'] LOOP
    SELECT * INTO req FROM storage_renewal_ops.requests WHERE mode=mode_name ORDER BY requested_at DESC LIMIT 1;
    IF req.id IS NULL OR req.requested_at<now()-interval '2 hours' THEN RAISE EXCEPTION 'STORAGE_RENEWAL_RUN_MISSING'; END IF;
    PERFORM extensions.http_reset_curlopt();
  PERFORM storage_renewal_ops.assert_response(req.http_status,req.result,mode_name);
  END LOOP;
  RETURN 'STORAGE_RENEWAL_AND_APPLICATION_HEALTHY';
END $$;
