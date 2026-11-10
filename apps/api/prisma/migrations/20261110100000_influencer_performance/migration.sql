BEGIN;

CREATE TABLE influencer_collaborations (
  id uuid PRIMARY KEY,
  influencer_name text NOT NULL CHECK (btrim(influencer_name) <> ''),
  influencer_key text NOT NULL CHECK (btrim(influencer_key) <> ''),
  fee_krw decimal(24,6) NOT NULL CHECK (fee_krw >= 0 AND fee_krw = trunc(fee_krw)),
  start_date date NOT NULL,
  end_date date CHECK (end_date >= start_date),
  note text,
  version uuid NOT NULL,
  ad_spend_krw decimal(24,6) DEFAULT 0,
  ad_margin_krw decimal(24,6) DEFAULT 0,
  net_performance_krw decimal(24,6),
  data_through date,
  aggregated_at timestamp(3),
  creative_count integer NOT NULL DEFAULT 0,
  creative_totals jsonb NOT NULL DEFAULT '[]',
  needs_backfill boolean NOT NULL DEFAULT true,
  last_job_at timestamp(3),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL
);
CREATE INDEX influencer_collaborations_name_date_idx ON influencer_collaborations (influencer_key, start_date);
CREATE INDEX influencer_collaborations_list_idx ON influencer_collaborations (created_at, id);
CREATE INDEX influencer_collaborations_backfill_idx ON influencer_collaborations (needs_backfill, last_job_at, id);

CREATE TABLE influencer_projection_days (
  metric_date date PRIMARY KEY,
  next_check_at timestamp(3) NOT NULL,
  last_source_change_at timestamptz(3)
);
CREATE INDEX influencer_projection_days_due_idx ON influencer_projection_days (next_check_at, metric_date DESC);

CREATE TABLE influencer_daily_performances (
  metric_date date NOT NULL,
  influencer_key text NOT NULL,
  creative_key text NOT NULL,
  creative_name text NOT NULL,
  ad_spend_krw decimal(24,6),
  ad_margin_krw decimal(24,6),
  has_api boolean NOT NULL,
  attribution_context text NOT NULL,
  mixed_attribution boolean NOT NULL,
  PRIMARY KEY (metric_date, influencer_key, creative_key)
);
CREATE INDEX influencer_daily_performances_name_date_idx ON influencer_daily_performances (influencer_key, metric_date);

DO $$
DECLARE
  table_name text;
  role_name text;
  verbs text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['influencer_collaborations', 'influencer_projection_days', 'influencer_daily_performances'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    FOREACH role_name IN ARRAY ARRAY['meta_ads_stg_runtime', 'meta_ads_stg_migration',
        'meta_ads_prod_runtime', 'meta_ads_prod_migration', 'phase08_runtime'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        verbs := CASE table_name WHEN 'influencer_daily_performances' THEN 'SELECT, INSERT, DELETE'
          ELSE 'SELECT, INSERT, UPDATE' END;
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, role_name);
        EXECUTE format('GRANT %s ON TABLE %I TO %I', verbs, table_name, role_name);
        EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)',
          role_name || '_influencer_access', table_name, role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
