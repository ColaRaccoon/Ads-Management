CREATE TABLE "cafe24_sweep_states" (
  "connection_id" UUID NOT NULL,
  "earliest_order_date" DATE NOT NULL,
  "historical_cursor" INTEGER NOT NULL DEFAULT 0,
  "last_success_started_at" TIMESTAMPTZ(3),
  "active_sweep_id" UUID,
  "active_started_at" TIMESTAMPTZ(3),
  "active_plan" JSONB,
  "active_run_index" INTEGER NOT NULL DEFAULT 0,
  "active_attempt" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cafe24_sweep_states_pkey" PRIMARY KEY ("connection_id"),
  CONSTRAINT "cafe24_sweep_states_connection_id_fkey" FOREIGN KEY ("connection_id")
    REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "cafe24_sweep_states_active_consistency" CHECK
    (("active_sweep_id" IS NULL AND "active_started_at" IS NULL AND "active_plan" IS NULL)
      OR ("active_sweep_id" IS NOT NULL AND "active_started_at" IS NOT NULL AND "active_plan" IS NOT NULL))
);
ALTER TABLE "cafe24_sweep_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_sweep_states" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "cafe24_sweep_states" FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE "cafe24_sweep_states" FROM %I', role_name);
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY[
    'meta_ads_stg_runtime','meta_ads_stg_migration',
    'meta_ads_prod_runtime','meta_ads_prod_migration'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "cafe24_sweep_states" TO %I', role_name);
      EXECUTE format('CREATE POLICY %I ON "cafe24_sweep_states" FOR ALL TO %I USING (true) WITH CHECK (true)',
        'cafe24_sweep_states_' || role_name, role_name);
    END IF;
  END LOOP;
END $$;
