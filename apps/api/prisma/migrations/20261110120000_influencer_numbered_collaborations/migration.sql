BEGIN;

ALTER TABLE influencer_collaborations
  ADD COLUMN manager_name text,
  ADD COLUMN product_id uuid REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN numbering_required boolean NOT NULL DEFAULT false;
CREATE INDEX influencer_collaborations_product_id_idx ON influencer_collaborations(product_id);

ALTER TABLE influencer_daily_performances
  ADD COLUMN scope text NOT NULL DEFAULT 'NICKNAME',
  ADD COLUMN source_creative_id uuid,
  ADD COLUMN delivered boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT influencer_daily_scope_check CHECK (scope IN ('NICKNAME', 'MATERIAL')),
  DROP CONSTRAINT influencer_daily_performances_pkey,
  ADD PRIMARY KEY (metric_date, scope, influencer_key, creative_key);
DROP INDEX influencer_daily_performances_name_date_idx;
CREATE INDEX influencer_daily_performances_name_date_idx
  ON influencer_daily_performances (scope, influencer_key, metric_date);
CREATE INDEX influencer_daily_performances_source_creative_id_idx ON influencer_daily_performances(source_creative_id);

CREATE TABLE influencer_material_assignments (
  creative_id uuid PRIMARY KEY,
  collaboration_id uuid NOT NULL REFERENCES influencer_collaborations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  creative_name text NOT NULL,
  material_no text NOT NULL
);
CREATE INDEX influencer_material_assignments_collaboration_id_idx ON influencer_material_assignments(collaboration_id);

CREATE TABLE influencer_collaboration_days (
  collaboration_id uuid NOT NULL REFERENCES influencer_collaborations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  metric_date date NOT NULL,
  ad_spend_krw decimal(24,6),
  ad_margin_krw decimal(24,6),
  creative_count integer NOT NULL,
  PRIMARY KEY (collaboration_id, metric_date)
);
CREATE INDEX influencer_collaboration_days_metric_date_collaboration_id_idx
  ON influencer_collaboration_days(metric_date, collaboration_id);

ALTER TABLE influencer_material_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE influencer_collaboration_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON influencer_material_assignments, influencer_collaboration_days FROM PUBLIC;
DO $$
DECLARE
  role_name text;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['influencer_material_assignments', 'influencer_collaboration_days'] LOOP
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    FOREACH role_name IN ARRAY ARRAY['meta_ads_stg_runtime', 'meta_ads_stg_migration',
        'meta_ads_prod_runtime', 'meta_ads_prod_migration', 'phase08_runtime'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, role_name);
        EXECUTE format('GRANT SELECT, INSERT, DELETE ON TABLE %I TO %I', table_name, role_name);
        EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)',
          role_name || '_influencer_access', table_name, role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- The new worker revisits each day independently of retries scheduled by the old release.
ALTER TABLE influencer_projection_days ADD COLUMN numbering_attempted boolean NOT NULL DEFAULT false;

COMMIT;
