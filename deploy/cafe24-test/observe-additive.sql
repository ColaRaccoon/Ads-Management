-- Apply only to the dedicated Cafe24 test PostgreSQL after verifying project,
-- environment, private database host and the existing four-table schema.
-- This script does not touch canonical business tables.
BEGIN;

CREATE TABLE "cafe24_observed_order_revisions" (
  "connection_id" UUID NOT NULL REFERENCES "source_connections"("id") ON DELETE RESTRICT,
  "order_key_hash" CHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL,
  "order_date" DATE NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "first_observed_at" TIMESTAMPTZ(3) NOT NULL,
  "last_observed_at" TIMESTAMPTZ(3) NOT NULL,
  "observation_id" UUID NOT NULL,
  "is_current" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "cafe24_observed_order_revisions_pkey"
    PRIMARY KEY ("connection_id", "order_key_hash", "revision")
);
CREATE UNIQUE INDEX "cafe24_observed_order_revisions_current_key"
  ON "cafe24_observed_order_revisions"("connection_id", "order_key_hash")
  WHERE "is_current" = true;
CREATE INDEX "cafe24_observed_order_revisions_day_idx"
  ON "cafe24_observed_order_revisions"("connection_id", "order_date", "is_current");

CREATE TABLE "cafe24_observed_day_checkpoints" (
  "connection_id" UUID NOT NULL REFERENCES "source_connections"("id") ON DELETE RESTRICT,
  "order_date" DATE NOT NULL,
  "query_started_at" TIMESTAMPTZ(3) NOT NULL,
  "completed_at" TIMESTAMPTZ(3) NOT NULL,
  "observation_id" UUID NOT NULL,
  "key_version" INTEGER NOT NULL,
  "order_count" INTEGER NOT NULL,
  "item_count" INTEGER NOT NULL,
  "snapshot_hash" CHAR(64) NOT NULL,
  CONSTRAINT "cafe24_observed_day_checkpoints_pkey"
    PRIMARY KEY ("connection_id", "order_date")
);

ALTER TABLE "cafe24_observed_order_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_observed_day_checkpoints" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "cafe24_observed_order_revisions", "cafe24_observed_day_checkpoints"
  FROM PUBLIC;
COMMIT;
