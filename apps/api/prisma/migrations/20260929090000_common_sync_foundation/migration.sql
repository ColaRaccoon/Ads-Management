-- CreateEnum
CREATE TYPE "SourceProvider" AS ENUM ('GOOGLE', 'META', 'CAFE24');

-- CreateEnum
CREATE TYPE "SourceDataKind" AS ENUM ('GOOGLE_CAMPAIGN', 'META_AD', 'META_ADSET', 'CAFE24_ORDER');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('CSV', 'API');

-- CreateEnum
CREATE TYPE "SourceAccessState" AS ENUM ('PENDING', 'READY', 'REAUTH_REQUIRED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'BACKFILL', 'RETRY');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'ACTION_REQUIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunUnitStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ACTION_REQUIRED');

-- CreateEnum
CREATE TYPE "SourceCoverageState" AS ENUM ('NOT_CONNECTED', 'NOT_COLLECTED', 'RUNNING', 'COMPLETE_ZERO', 'COMPLETE_NONZERO', 'PARTIAL', 'FAILED', 'STALE', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "SourceBindingMethod" AS ENUM ('EXACT_ID', 'REVIEWED_LEGACY');

-- CreateTable
CREATE TABLE "source_connections" (
    "id" UUID NOT NULL,
    "provider" "SourceProvider" NOT NULL,
    "external_account_id" VARCHAR(256) NOT NULL,
    "shop_key" VARCHAR(256) NOT NULL DEFAULT 'default',
    "display_name" VARCHAR(256) NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "time_zone" VARCHAR(128) NOT NULL,
    "credential_ref" VARCHAR(256),
    "credential_expires_at" TIMESTAMPTZ(3),
    "access_state" "SourceAccessState" NOT NULL DEFAULT 'PENDING',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "source_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_policies" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "data_kind" "SourceDataKind" NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE,
    "primary_source" "SourceKind" NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL,
    "changed_by_user_id" UUID,
    "reason" VARCHAR(256) NOT NULL,

    CONSTRAINT "source_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "trigger" "SyncTrigger" NOT NULL,
    "request_key" VARCHAR(256) NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "status" "SyncRunStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "rows_fetched" INTEGER NOT NULL DEFAULT 0,
    "rows_published" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "deadline_at" TIMESTAMPTZ(3),
    "next_attempt_at" TIMESTAMPTZ(3),
    "safe_error_code" VARCHAR(64),
    "provider_request_id" VARCHAR(256),
    "actor_user_id" UUID,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_units" (
    "run_id" UUID NOT NULL,
    "unit_key" VARCHAR(256) NOT NULL,
    "status" "RunUnitStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "fetched_count" INTEGER NOT NULL DEFAULT 0,
    "published_count" INTEGER NOT NULL DEFAULT 0,
    "checkpoint_value" VARCHAR(512),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "run_units_pkey" PRIMARY KEY ("run_id","unit_key")
);

-- CreateTable
CREATE TABLE "sync_leases" (
    "connection_id" UUID NOT NULL,
    "owner_run_id" UUID NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_leases_pkey" PRIMARY KEY ("connection_id")
);

-- CreateTable
CREATE TABLE "source_coverage" (
    "connection_id" UUID NOT NULL,
    "data_kind" "SourceDataKind" NOT NULL,
    "metric_date" DATE NOT NULL,
    "source" "SourceKind" NOT NULL,
    "state" "SourceCoverageState" NOT NULL DEFAULT 'NOT_COLLECTED',
    "last_attempt_run_id" UUID,
    "last_success_run_id" UUID,
    "last_success_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "row_count" INTEGER,
    "total_amount" DECIMAL(24,6),
    "reconciliation_status" VARCHAR(64),
    "warning_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "source_coverage_pkey" PRIMARY KEY ("connection_id","data_kind","metric_date")
);

-- CreateTable
CREATE TABLE "google_campaign_daily_costs" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "metric_date" DATE NOT NULL,
    "campaign_id" VARCHAR(256) NOT NULL,
    "campaign_name" VARCHAR(256) NOT NULL,
    "channel_type" VARCHAR(64) NOT NULL,
    "cost_micros" BIGINT NOT NULL,
    "impressions" BIGINT NOT NULL,
    "clicks" BIGINT NOT NULL,
    "conversion_count" DECIMAL(18,6),
    "conversion_value" DECIMAL(18,6),
    "source" "SourceKind" NOT NULL,
    "sync_run_id" UUID NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "google_campaign_daily_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_record_links" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "data_kind" "SourceDataKind" NOT NULL,
    "canonical_key_hash" CHAR(64) NOT NULL,
    "source" "SourceKind" NOT NULL,
    "record_table" VARCHAR(64) NOT NULL,
    "record_id" UUID NOT NULL,
    "sync_run_id" UUID,
    "version" INTEGER NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "bound_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "binding_method" "SourceBindingMethod" NOT NULL,

    CONSTRAINT "source_record_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cafe24_order_api_versions" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "canonical_key_hash" CHAR(64) NOT NULL,
    "order_no" VARCHAR(256) NOT NULL,
    "line_order_no" VARCHAR(256) NOT NULL,
    "product_no" VARCHAR(256) NOT NULL,
    "option_name" VARCHAR(256) NOT NULL,
    "ordered_at" TIMESTAMPTZ(3) NOT NULL,
    "order_date" DATE NOT NULL,
    "provider_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "sale_price_krw" DECIMAL(18,2) NOT NULL,
    "total_order_krw" DECIMAL(18,2),
    "total_paid_krw" DECIMAL(18,2) NOT NULL,
    "payment_method" VARCHAR(256) NOT NULL DEFAULT '',
    "order_status" VARCHAR(64),
    "line_status" VARCHAR(64),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_amount_krw" DECIMAL(18,2),
    "refunded_at" TIMESTAMPTZ(3),
    "refund_amount_krw" DECIMAL(18,2),
    "discount_amount_krw" DECIMAL(18,2),
    "coupon_amount_krw" DECIMAL(18,2),
    "version" INTEGER NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "sync_run_id" UUID NOT NULL,

    CONSTRAINT "cafe24_order_api_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_credentials" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "refresh_owner" UUID,
    "refresh_until" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "source_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_connections_provider_external_account_id_shop_key_key" ON "source_connections"("provider", "external_account_id", "shop_key");

-- CreateIndex
CREATE INDEX "source_policies_connection_id_data_kind_from_date_idx" ON "source_policies"("connection_id", "data_kind", "from_date");

-- CreateIndex
CREATE INDEX "sync_runs_status_next_attempt_at_idx" ON "sync_runs"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "sync_runs_connection_id_request_key_key" ON "sync_runs"("connection_id", "request_key");

-- CreateIndex
CREATE INDEX "source_coverage_metric_date_state_idx" ON "source_coverage"("metric_date", "state");

-- CreateIndex
CREATE INDEX "google_campaign_daily_costs_connection_id_metric_date_idx" ON "google_campaign_daily_costs"("connection_id", "metric_date");

-- CreateIndex
CREATE UNIQUE INDEX "google_campaign_daily_costs_connection_id_metric_date_campa_key" ON "google_campaign_daily_costs"("connection_id", "metric_date", "campaign_id", "version");

-- CreateIndex
CREATE INDEX "source_record_links_connection_id_data_kind_canonical_key_h_idx" ON "source_record_links"("connection_id", "data_kind", "canonical_key_hash", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "source_record_links_connection_id_data_kind_source_record_t_key" ON "source_record_links"("connection_id", "data_kind", "source", "record_table", "record_id");

-- CreateIndex
CREATE INDEX "cafe24_order_api_versions_connection_id_order_date_idx" ON "cafe24_order_api_versions"("connection_id", "order_date");

-- CreateIndex
CREATE UNIQUE INDEX "cafe24_order_api_versions_connection_id_canonical_key_hash__key" ON "cafe24_order_api_versions"("connection_id", "canonical_key_hash", "version");

-- CreateIndex
CREATE UNIQUE INDEX "source_credentials_connection_id_kind_key" ON "source_credentials"("connection_id", "kind");

-- AddForeignKey
ALTER TABLE "source_policies" ADD CONSTRAINT "source_policies_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_units" ADD CONSTRAINT "run_units_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_leases" ADD CONSTRAINT "sync_leases_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_campaign_daily_costs" ADD CONSTRAINT "google_campaign_daily_costs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_record_links" ADD CONSTRAINT "source_record_links_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cafe24_order_api_versions" ADD CONSTRAINT "cafe24_order_api_versions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_credentials" ADD CONSTRAINT "source_credentials_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Contract invariants which Prisma cannot express. All new objects are additive.
ALTER TABLE "source_policies" ADD CONSTRAINT "source_policies_date_range_check" CHECK ("to_date" IS NULL OR "to_date" > "from_date");
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_date_range_check" CHECK ("to_date" >= "from_date" AND "to_date" < "from_date" + 31);
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_count_check" CHECK ("attempt_count" >= 0 AND "rows_fetched" >= 0 AND "rows_published" >= 0);
ALTER TABLE "run_units" ADD CONSTRAINT "run_units_count_check" CHECK ("attempts" >= 0 AND "fetched_count" >= 0 AND "published_count" >= 0);
ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_count_check" CHECK ("row_count" IS NULL OR "row_count" >= 0);
ALTER TABLE "google_campaign_daily_costs" ADD CONSTRAINT "google_campaign_daily_costs_nonnegative_check" CHECK ("cost_micros" >= 0 AND "impressions" >= 0 AND "clicks" >= 0 AND "version" > 0);
ALTER TABLE "cafe24_order_api_versions" ADD CONSTRAINT "cafe24_order_api_versions_nonnegative_check" CHECK ("quantity" >= 0 AND "sale_price_krw" >= 0 AND "total_paid_krw" >= 0 AND "version" > 0);
ALTER TABLE "source_credentials" ADD CONSTRAINT "source_credentials_kind_check" CHECK ("kind" IN ('CAFE24_REFRESH', 'CAFE24_ACCESS'));
ALTER TABLE "source_credentials" ADD CONSTRAINT "source_credentials_revision_check" CHECK ("revision" > 0 AND "key_version" > 0);
ALTER TABLE "source_record_links" ADD CONSTRAINT "source_record_links_table_check" CHECK ("record_table" IN ('cafe24_order_lines', 'meta_ad_daily_metrics', 'meta_adset_daily_metrics', 'google_campaign_daily_costs', 'cafe24_order_api_versions'));

ALTER TABLE "source_policies" ADD CONSTRAINT "source_policies_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "app_users"("id") ON DELETE RESTRICT;
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id") ON DELETE RESTRICT;
ALTER TABLE "sync_leases" ADD CONSTRAINT "sync_leases_owner_run_id_fkey" FOREIGN KEY ("owner_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT;
ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_last_attempt_run_id_fkey" FOREIGN KEY ("last_attempt_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT;
ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_last_success_run_id_fkey" FOREIGN KEY ("last_success_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT;
ALTER TABLE "google_campaign_daily_costs" ADD CONSTRAINT "google_campaign_daily_costs_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT;
ALTER TABLE "source_record_links" ADD CONSTRAINT "source_record_links_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT;
ALTER TABLE "cafe24_order_api_versions" ADD CONSTRAINT "cafe24_order_api_versions_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "google_campaign_daily_costs_one_current"
  ON "google_campaign_daily_costs" ("connection_id", "metric_date", "campaign_id") WHERE "is_current";
CREATE UNIQUE INDEX "cafe24_order_api_versions_one_current"
  ON "cafe24_order_api_versions" ("connection_id", "canonical_key_hash") WHERE "is_current";

-- Locking the parent connection serializes policy inserts for that account.
CREATE FUNCTION "source_policies_reject_overlap"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The parent-row lock serializes writers only with a fresh READ COMMITTED
  -- snapshot. Refuse fixed-snapshot isolation rather than permit an overlap.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'source policy writes require read committed isolation' USING ERRCODE = '25000';
  END IF;
  PERFORM 1 FROM "source_connections" WHERE "id" = NEW."connection_id" FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "source_policies" p
    WHERE p."connection_id" = NEW."connection_id" AND p."data_kind" = NEW."data_kind"
      AND p."id" <> NEW."id"
      AND p."from_date" < COALESCE(NEW."to_date", 'infinity'::date)
      AND NEW."from_date" < COALESCE(p."to_date", 'infinity'::date)
  ) THEN
    RAISE EXCEPTION 'source policy overlap' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "source_policies_reject_overlap_trigger"
  BEFORE INSERT OR UPDATE OF "connection_id", "data_kind", "from_date", "to_date"
  ON "source_policies" FOR EACH ROW EXECUTE FUNCTION "source_policies_reject_overlap"();

-- No Data API/browser role gains access. Runtime and migration roles are
-- granted explicitly when provisioned; no new role is created by migration.
DO $$
DECLARE table_name text;
DECLARE role_name text;
DECLARE type_name text;
BEGIN
  FOREACH type_name IN ARRAY ARRAY[
    'SourceProvider','SourceDataKind','SourceKind','SourceAccessState',
    'SyncTrigger','SyncRunStatus','RunUnitStatus','SourceCoverageState','SourceBindingMethod'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TYPE %I FROM PUBLIC', type_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TYPE %I FROM %I', type_name, role_name);
      END IF;
    END LOOP;
    FOREACH role_name IN ARRAY ARRAY[
      'meta_ads_stg_runtime','meta_ads_stg_migration',
      'meta_ads_prod_runtime','meta_ads_prod_migration'
    ] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('GRANT USAGE ON TYPE %I TO %I', type_name, role_name);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'source_connections','source_policies','sync_runs','run_units','sync_leases',
    'source_coverage','google_campaign_daily_costs','source_record_links',
    'cafe24_order_api_versions','source_credentials'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
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
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', table_name, role_name);
        EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)',
          table_name || '_' || role_name, table_name, role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
