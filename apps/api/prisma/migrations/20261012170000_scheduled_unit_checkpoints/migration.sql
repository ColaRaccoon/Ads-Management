-- Local/staging only. Stores only AES-GCM protected provider allowlist fields.
CREATE TABLE "sync_unit_checkpoints" (
  "run_id" UUID NOT NULL REFERENCES "sync_runs"("id") ON DELETE CASCADE,
  "unit_key" VARCHAR(256) NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "iv" BYTEA NOT NULL CHECK (octet_length("iv") = 12),
  "auth_tag" BYTEA NOT NULL CHECK (octet_length("auth_tag") = 16),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "expires_at" TIMESTAMPTZ NOT NULL,
  PRIMARY KEY ("run_id", "unit_key")
);
REVOKE ALL ON TABLE "sync_unit_checkpoints" FROM PUBLIC;
ALTER TABLE "sync_unit_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_unit_checkpoints" FORCE ROW LEVEL SECURITY;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE sync_unit_checkpoints FROM %I', role_name);
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['meta_ads_stg_runtime','meta_ads_stg_migration',
      'meta_ads_prod_runtime','meta_ads_prod_migration'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE sync_unit_checkpoints TO %I', role_name);
      EXECUTE format('CREATE POLICY %I ON sync_unit_checkpoints FOR ALL TO %I USING (true) WITH CHECK (true)',
        'sync_unit_checkpoints_' || role_name, role_name);
    END IF;
  END LOOP;
END $$;
