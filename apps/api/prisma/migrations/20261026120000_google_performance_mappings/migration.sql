-- Additive Google-only state. No changes to collected facts or legacy mappings.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE google_performance_mappings (
  id uuid PRIMARY KEY,
  kind varchar(16) NOT NULL CHECK (kind IN ('CAMPAIGN','SALE')),
  connection_id uuid NOT NULL REFERENCES source_connections(id) ON DELETE RESTRICT,
  identity_key varchar(64) NOT NULL,
  campaign_id varchar(256),
  product_no varchar(256),
  option_name varchar(1024) NOT NULL DEFAULT '',
  product_id uuid REFERENCES products(id) ON DELETE RESTRICT,
  start_date date NOT NULL,
  end_date date,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL,
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK ((kind='CAMPAIGN' AND campaign_id IS NOT NULL AND product_no IS NULL AND option_name='')
    OR (kind='SALE' AND product_no IS NOT NULL AND campaign_id IS NULL)),
  CONSTRAINT google_mapping_no_overlap EXCLUDE USING gist
    (connection_id WITH =, kind WITH =, identity_key WITH =, daterange(start_date, end_date, '[]') WITH &&)
);
CREATE INDEX google_performance_mappings_connection_id_kind_identity_key_s_idx
  ON google_performance_mappings(connection_id,kind,identity_key,start_date);
CREATE INDEX google_performance_mappings_product_id_start_date_idx ON google_performance_mappings(product_id,start_date);
CREATE TABLE google_mapping_audits (
  id uuid PRIMARY KEY,
  mapping_id uuid NOT NULL REFERENCES google_performance_mappings(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  before jsonb,
  after jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX google_mapping_audits_mapping_id_created_at_idx ON google_mapping_audits(mapping_id,created_at);
CREATE INDEX google_mapping_audits_actor_user_id_idx ON google_mapping_audits(actor_user_id);
ALTER TABLE google_performance_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_mapping_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_performance_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE google_mapping_audits FORCE ROW LEVEL SECURITY;
DO $$
DECLARE table_name text; role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['google_performance_mappings','google_mapping_audits'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    FOREACH role_name IN ARRAY ARRAY['meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_prod_runtime','meta_ads_prod_migration'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        -- Remove broader default table privileges before granting this feature's minimum.
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, role_name);
        EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO %I', table_name, role_name);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO %I USING (true)', table_name || '_' || role_name || '_s', table_name, role_name);
        EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO %I WITH CHECK (true)', table_name || '_' || role_name || '_i', table_name, role_name);
        IF table_name='google_performance_mappings' THEN
          EXECUTE format('GRANT UPDATE ON TABLE %I TO %I', table_name, role_name);
          EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO %I USING (true) WITH CHECK (true)', table_name || '_' || role_name || '_u', table_name, role_name);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END $$;
