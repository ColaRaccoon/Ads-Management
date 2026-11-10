BEGIN;

ALTER TABLE influencer_daily_performances ADD COLUMN number_key text;
CREATE INDEX influencer_daily_performances_number_date_idx
  ON influencer_daily_performances(scope, number_key, metric_date);

-- Revisit historical source days without allowing the old worker to mark them complete.
ALTER TABLE influencer_projection_days ADD COLUMN number_matching_attempted boolean NOT NULL DEFAULT false;

CREATE TABLE influencer_number_reservations (
  number_key text PRIMARY KEY,
  material_no text NOT NULL CHECK (material_no ~ '^[0-9]{1,16}$'),
  collaboration_id uuid NOT NULL REFERENCES influencer_collaborations(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX influencer_number_reservations_collaboration_id_idx ON influencer_number_reservations(collaboration_id);

-- Carry forward the saved numbers. The primary key rejects ambiguous ownership rather than choosing a collaboration.
WITH previous_numbers AS (
  SELECT a.collaboration_id, c.product_id,
    substring(normalize(a.material_no, NFKC) FROM '([0-9]+)(?:번소재)?$') AS material_no
  FROM influencer_material_assignments a JOIN influencer_collaborations c ON c.id = a.collaboration_id
), reservations AS (
  SELECT collaboration_id, product_id::text || ':' || regexp_replace(material_no, '^0+(?=[0-9])', '') AS number_key, material_no
  FROM previous_numbers
)
INSERT INTO influencer_number_reservations (collaboration_id, number_key, material_no)
SELECT DISTINCT ON (collaboration_id, number_key) collaboration_id, number_key, material_no
FROM reservations ORDER BY collaboration_id, number_key, length(material_no) DESC, material_no;

ALTER TABLE influencer_number_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON influencer_number_reservations FROM PUBLIC;
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE influencer_number_reservations FROM %I', role_name);
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['meta_ads_stg_runtime', 'meta_ads_stg_migration',
      'meta_ads_prod_runtime', 'meta_ads_prod_migration', 'phase08_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE influencer_number_reservations FROM %I', role_name);
      EXECUTE format('GRANT SELECT, INSERT, DELETE ON TABLE influencer_number_reservations TO %I', role_name);
      EXECUTE format('CREATE POLICY %I ON influencer_number_reservations FOR ALL TO %I USING (true) WITH CHECK (true)',
        role_name || '_influencer_access', role_name);
    END IF;
  END LOOP;
END $$;

COMMIT;
