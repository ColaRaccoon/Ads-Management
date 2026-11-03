-- Scheduling metadata only. Unchanged and failed checks advance the historical
-- inspection cursor without modifying immutable runs, publications or sources.
CREATE TABLE meta_ads.unified_reconciliation_checks (
  platform varchar(16) NOT NULL,
  scope_key varchar(256) NOT NULL,
  business_date date NOT NULL,
  last_checked_at timestamptz(3) NOT NULL,
  last_outcome varchar(16) NOT NULL,
  PRIMARY KEY (platform, scope_key, business_date),
  CONSTRAINT unified_reconciliation_check_platform CHECK (platform IN ('META','GOOGLE','CAFE24','COUPANG','NAVER')),
  CONSTRAINT unified_reconciliation_check_scope CHECK (btrim(scope_key)<>''),
  CONSTRAINT unified_reconciliation_check_outcome CHECK (last_outcome IN ('UNCHANGED','PUBLISHED','QUEUED','UNAVAILABLE','FAILED'))
);
CREATE INDEX unified_reconciliation_checks_oldest_idx
  ON meta_ads.unified_reconciliation_checks(platform,scope_key,last_checked_at,business_date);
ALTER TABLE meta_ads.unified_reconciliation_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ads.unified_reconciliation_checks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE meta_ads.unified_reconciliation_checks FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','meta_ads_app','meta_ads_unified_report','meta_ads_unified_runtime','meta_ads_unified_worker',
    'meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_prod_runtime','meta_ads_prod_migration'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE meta_ads.unified_reconciliation_checks FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='meta_ads_unified_worker') THEN
    GRANT SELECT,INSERT,UPDATE ON TABLE meta_ads.unified_reconciliation_checks TO meta_ads_unified_worker;
    CREATE POLICY unified_reconciliation_checks_worker ON meta_ads.unified_reconciliation_checks
      FOR ALL TO meta_ads_unified_worker USING (true) WITH CHECK (true);
  END IF;
END $$;
