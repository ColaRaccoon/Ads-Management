-- Additive, quarantined observation storage only. No V1/other table is altered.
CREATE TABLE "cafe24_observed_epoch_day_checkpoints" (
  "connection_id" UUID NOT NULL REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "key_version" INTEGER NOT NULL CHECK ("key_version" BETWEEN 2 AND 99),
  "epoch_reference" UUID NOT NULL,
  "epoch_started_at" TIMESTAMPTZ(3) NOT NULL,
  "key_commitment" CHAR(64) NOT NULL CHECK ("key_commitment" ~ '^[a-f0-9]{64}$'),
  "key_identity_commitment" CHAR(64) NOT NULL CHECK ("key_identity_commitment" ~ '^[a-f0-9]{64}$'),
  "baseline_approval_sha256" CHAR(64) NOT NULL CHECK ("baseline_approval_sha256" ~ '^[a-f0-9]{64}$'),
  "source_closure_sha256" CHAR(64) NOT NULL CHECK ("source_closure_sha256" ~ '^[a-f0-9]{64}$'),
  "order_date" DATE NOT NULL,
  "query_started_at" TIMESTAMPTZ(3) NOT NULL,
  "completed_at" TIMESTAMPTZ(3) NOT NULL,
  "observation_id" UUID NOT NULL,
  "checkpoint_revision" INTEGER NOT NULL CHECK ("checkpoint_revision" > 0),
  "order_count" INTEGER NOT NULL CHECK ("order_count" BETWEEN 0 AND 1000),
  "item_count" INTEGER NOT NULL CHECK ("item_count" >= "order_count"),
  "snapshot_hash" CHAR(64) NOT NULL CHECK ("snapshot_hash" ~ '^[a-f0-9]{64}$'),
  "integrity_hash" CHAR(64) NOT NULL CHECK ("integrity_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "cafe24_epoch_days_time_check" CHECK ("epoch_started_at" <= "query_started_at" AND "query_started_at" <= "completed_at"),
  CONSTRAINT "cafe24_epoch_days_pkey" PRIMARY KEY ("connection_id", "key_version", "order_date")
);
CREATE TABLE "cafe24_observed_epoch_order_revisions" (
  "connection_id" UUID NOT NULL REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "key_version" INTEGER NOT NULL CHECK ("key_version" BETWEEN 2 AND 99),
  "epoch_reference" UUID NOT NULL,
  "epoch_started_at" TIMESTAMPTZ(3) NOT NULL,
  "key_commitment" CHAR(64) NOT NULL CHECK ("key_commitment" ~ '^[a-f0-9]{64}$'),
  "key_identity_commitment" CHAR(64) NOT NULL CHECK ("key_identity_commitment" ~ '^[a-f0-9]{64}$'),
  "baseline_approval_sha256" CHAR(64) NOT NULL CHECK ("baseline_approval_sha256" ~ '^[a-f0-9]{64}$'),
  "source_closure_sha256" CHAR(64) NOT NULL CHECK ("source_closure_sha256" ~ '^[a-f0-9]{64}$'),
  "order_key_hash" CHAR(64) NOT NULL CHECK ("order_key_hash" ~ '^[a-f0-9]{64}$'),
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "order_date" DATE NOT NULL,
  "content_hash" CHAR(64) NOT NULL CHECK ("content_hash" ~ '^[a-f0-9]{64}$'),
  "first_observed_at" TIMESTAMPTZ(3) NOT NULL,
  "last_observed_at" TIMESTAMPTZ(3) NOT NULL,
  "observation_id" UUID NOT NULL,
  "is_current" BOOLEAN NOT NULL DEFAULT true,
  "integrity_hash" CHAR(64) NOT NULL CHECK ("integrity_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "cafe24_epoch_revisions_time_check" CHECK ("epoch_started_at" <= "first_observed_at" AND "first_observed_at" <= "last_observed_at"),
  CONSTRAINT "cafe24_epoch_revisions_pkey" PRIMARY KEY ("connection_id", "key_version", "order_key_hash", "revision"),
  CONSTRAINT "cafe24_epoch_revisions_checkpoint_fkey" FOREIGN KEY ("connection_id", "key_version", "order_date")
    REFERENCES "cafe24_observed_epoch_day_checkpoints"("connection_id", "key_version", "order_date")
    ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX "cafe24_epoch_days_scope_idx" ON "cafe24_observed_epoch_day_checkpoints"("connection_id", "key_version", "epoch_reference");
CREATE INDEX "cafe24_epoch_revisions_day_idx" ON "cafe24_observed_epoch_order_revisions"("connection_id", "key_version", "epoch_reference", "order_date", "is_current");
CREATE UNIQUE INDEX "cafe24_epoch_revisions_current_key" ON "cafe24_observed_epoch_order_revisions"("connection_id", "key_version", "order_key_hash") WHERE "is_current";
-- Remove inherited ALTER DEFAULT PRIVILEGES grants too, scoped to these new tables.
DO $$
DECLARE table_name TEXT; granted RECORD;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['cafe24_observed_epoch_day_checkpoints', 'cafe24_observed_epoch_order_revisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
    FOR granted IN SELECT DISTINCT roles.rolname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      JOIN pg_roles roles ON roles.oid = a.grantee
      WHERE n.nspname = current_schema() AND c.relname = table_name AND a.grantee <> c.relowner
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, granted.rolname);
    END LOOP;
  END LOOP;
END $$;
