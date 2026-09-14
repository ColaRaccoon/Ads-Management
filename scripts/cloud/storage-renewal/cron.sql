-- Fresh installation only. Existing production installation is already complete.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
-- statement-break --
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;
-- statement-break --
CREATE SCHEMA storage_renewal_ops;
-- statement-break --
REVOKE ALL ON SCHEMA storage_renewal_ops FROM PUBLIC, anon, authenticated;
-- statement-break --
CREATE SEQUENCE storage_renewal_ops.request_ids START WITH 1000000;
-- statement-break --
CREATE TABLE storage_renewal_ops.requests (id bigint PRIMARY KEY, mode text NOT NULL CHECK (mode IN ('renew','check')), requested_at timestamptz NOT NULL DEFAULT now(), http_status integer, result jsonb);
-- statement-break --
REVOKE ALL ON storage_renewal_ops.requests FROM PUBLIC, anon, authenticated;
-- statement-break --

CREATE FUNCTION storage_renewal_ops.assert_response(http_status integer, body jsonb, mode text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF http_status IS DISTINCT FROM 200 OR body IS NULL OR
     NOT COALESCE((mode='check' AND body->>'state'='HEALTHY' AND body->>'readinessVerified'='true') OR
       (mode='renew' AND body->>'state' IN ('HEALTHY','DEPLOYMENT_REQUESTED')),false) OR
     COALESCE((body->>'expiresAt')::bigint,0)<extract(epoch from now())+2*86400 THEN
    RAISE EXCEPTION 'STORAGE_RENEWAL_HTTP_OR_APP_CHECK_FAILED';
  END IF;
END $$;

-- statement-break --

REVOKE ALL ON FUNCTION storage_renewal_ops.assert_response(integer,jsonb,text) FROM PUBLIC, anon, authenticated;

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


-- statement-break --

REVOKE ALL ON FUNCTION storage_renewal_ops.invoke(text) FROM PUBLIC, anon, authenticated;

-- statement-break --

REVOKE ALL ON FUNCTION storage_renewal_ops.audit() FROM PUBLIC, anon, authenticated;

-- statement-break --

SELECT cron.schedule('storage-renewal-daily','0 19 * * *',$job$SELECT storage_renewal_ops.invoke('renew')$job$);

-- statement-break --

SELECT cron.schedule('storage-renewal-verify','15 19 * * *',$job$SELECT storage_renewal_ops.invoke('check')$job$);

-- statement-break --

SELECT cron.schedule('storage-renewal-audit','20 19 * * *',$job$SELECT storage_renewal_ops.audit()$job$);
