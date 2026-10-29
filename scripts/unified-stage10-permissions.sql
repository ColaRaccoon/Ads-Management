-- Stage10 isolated role rehearsal; execute as migration owner AFTER all migrations.
-- This file does not create login/passwords or grant role membership.
-- Stage11 must map these three pre-created non-owner roles to real web/config/worker
-- connections and verify inherited grants/RLS/allowed accounts before activation.
-- No source table or credential table grant is included. Real worker source SELECT
-- allowlists remain an activation prerequisite; do not use this as full runtime proof.
-- App PermissionGuard enforces data.read/products.manage/mappings.manage/operations.run.
-- The shared app connection's RLS is not per-user/account tenant isolation.
BEGIN;
DO $$
DECLARE
  config_role text := 'unified_stage07_config';
  viewer_role text := 'unified_stage07_viewer';
  worker_role text := 'unified_stage07_worker';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[config_role, viewer_role, worker_role] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=t AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole)
      THEN RAISE EXCEPTION 'Role must exist with NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE: %', t; END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tableowner=t)
      THEN RAISE EXCEPTION 'Runtime role must not own tables: %', t; END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA meta_ads TO %I', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['unified_products','unified_rules','unified_mapping_audits'] LOOP
    EXECUTE format('GRANT SELECT ON meta_ads.%I TO %I,%I,%I',t,config_role,viewer_role,worker_role);
    EXECUTE format('CREATE POLICY stage10_config_read ON meta_ads.%I FOR SELECT TO %I,%I,%I USING (true)',t,config_role,viewer_role,worker_role);
    EXECUTE format('GRANT INSERT ON meta_ads.%I TO %I',t,config_role);
    EXECUTE format('CREATE POLICY stage10_config_insert ON meta_ads.%I FOR INSERT TO %I WITH CHECK (true)',t,config_role);
    IF t <> 'unified_mapping_audits' THEN
      EXECUTE format('GRANT UPDATE ON meta_ads.%I TO %I',t,config_role);
      EXECUTE format('CREATE POLICY stage10_config_update ON meta_ads.%I FOR UPDATE TO %I USING (true) WITH CHECK (true)',t,config_role);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['unified_aggregation_runs','unified_source_publications','unified_daily_facts','unified_source_coverage','unified_product_match_results'] LOOP
    EXECUTE format('GRANT SELECT ON meta_ads.%I TO %I,%I',t,config_role,viewer_role);
    EXECUTE format('CREATE POLICY stage10_report_read ON meta_ads.%I FOR SELECT TO %I,%I USING (true)',t,config_role,viewer_role);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON meta_ads.%I TO %I',t,worker_role);
    EXECUTE format('CREATE POLICY stage10_worker ON meta_ads.%I TO %I USING (true) WITH CHECK (true)',t,worker_role);
  END LOOP;
  EXECUTE format('GRANT INSERT ON meta_ads.unified_aggregation_runs TO %I',config_role);
  EXECUTE format($policy$CREATE POLICY stage10_queue ON meta_ads.unified_aggregation_runs FOR INSERT TO %I WITH CHECK (
    status='STAGING' AND lease_token IS NULL AND lease_expires_at IS NULL AND attempts=0
    AND completed_at IS NULL AND published_at IS NULL AND source_fingerprint IS NULL
    AND requested_by IS NOT NULL AND reason IS NOT NULL AND btrim(reason)<>''
    AND versions='{}'::jsonb AND control_totals='[]'::jsonb AND issues='[]'::jsonb
    AND checkpoint->>'phase'='QUEUED')$policy$,config_role);
  -- Explicit reader metadata projection excludes credential_ref and external IDs.
  -- Existing inherited/table-level grants must be audited separately at activation.
  EXECUTE format('GRANT SELECT(id,provider,display_name,currency_code,time_zone) ON meta_ads.source_connections TO %I,%I,%I',config_role,viewer_role,worker_role);
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relname='source_connections' AND c.relrowsecurity) THEN
    EXECUTE format('CREATE POLICY stage10_connections ON meta_ads.source_connections FOR SELECT TO %I,%I,%I USING (true)',config_role,viewer_role,worker_role);
  END IF;
END $$;
COMMIT;
