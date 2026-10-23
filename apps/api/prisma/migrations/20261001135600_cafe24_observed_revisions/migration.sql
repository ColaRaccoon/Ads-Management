-- Observation-only hashes are separate from canonical API versions. A scan
-- checkpoint can advance only in the transaction that writes its revisions.
CREATE TABLE "cafe24_observed_order_revisions" (
  "connection_id" UUID NOT NULL,
  "order_key_hash" CHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL,
  "order_date" DATE NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "first_observed_at" TIMESTAMPTZ(3) NOT NULL,
  "last_observed_at" TIMESTAMPTZ(3) NOT NULL,
  "observation_id" UUID NOT NULL,
  "is_current" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "cafe24_observed_order_revisions_pkey"
    PRIMARY KEY ("connection_id", "order_key_hash", "revision"),
  CONSTRAINT "cafe24_observed_order_revisions_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "cafe24_observed_order_revisions_current_key"
  ON "cafe24_observed_order_revisions"("connection_id", "order_key_hash")
  WHERE "is_current" = true;
CREATE INDEX "cafe24_observed_order_revisions_day_idx"
  ON "cafe24_observed_order_revisions"("connection_id", "order_date", "is_current");

CREATE TABLE "cafe24_observed_day_checkpoints" (
  "connection_id" UUID NOT NULL,
  "order_date" DATE NOT NULL,
  "query_started_at" TIMESTAMPTZ(3) NOT NULL,
  "completed_at" TIMESTAMPTZ(3) NOT NULL,
  "observation_id" UUID NOT NULL,
  "key_version" INTEGER NOT NULL,
  "order_count" INTEGER NOT NULL,
  "item_count" INTEGER NOT NULL,
  "snapshot_hash" CHAR(64) NOT NULL,
  CONSTRAINT "cafe24_observed_day_checkpoints_pkey"
    PRIMARY KEY ("connection_id", "order_date"),
  CONSTRAINT "cafe24_observed_day_checkpoints_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "cafe24_observed_order_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_observed_order_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_observed_day_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_observed_day_checkpoints" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "cafe24_observed_order_revisions" FROM PUBLIC;
REVOKE ALL ON "cafe24_observed_day_checkpoints" FROM PUBLIC;
DO $$
DECLARE role_name text;
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'cafe24_observed_order_revisions', 'cafe24_observed_day_checkpoints'
  ] LOOP
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    FOREACH role_name IN ARRAY ARRAY[
      'meta_ads_stg_runtime','meta_ads_stg_migration',
      'meta_ads_prod_runtime','meta_ads_prod_migration'
    ] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I',
          table_name, role_name);
        EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)',
          table_name || '_' || role_name, table_name, role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
