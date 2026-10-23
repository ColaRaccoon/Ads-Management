CREATE TABLE "cafe24_oauth_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "connection_id" UUID NOT NULL,
  "state_hash" CHAR(64) NOT NULL,
  "actor_user_id" UUID,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cafe24_oauth_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cafe24_oauth_attempts_connection_id_fkey" FOREIGN KEY ("connection_id")
    REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "cafe24_oauth_attempts_state_hash_key" ON "cafe24_oauth_attempts"("state_hash");
CREATE INDEX "cafe24_oauth_attempts_connection_id_expires_at_idx" ON "cafe24_oauth_attempts"("connection_id", "expires_at");
ALTER TABLE "cafe24_oauth_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_oauth_attempts" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "cafe24_oauth_attempts" FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE "cafe24_oauth_attempts" FROM %I', role_name);
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY[
    'meta_ads_stg_runtime','meta_ads_stg_migration',
    'meta_ads_prod_runtime','meta_ads_prod_migration'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "cafe24_oauth_attempts" TO %I', role_name);
      EXECUTE format('CREATE POLICY %I ON "cafe24_oauth_attempts" FOR ALL TO %I USING (true) WITH CHECK (true)',
        'cafe24_oauth_attempts_' || role_name, role_name);
    END IF;
  END LOOP;
END $$;
