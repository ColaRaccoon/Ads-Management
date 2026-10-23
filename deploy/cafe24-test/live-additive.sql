-- Review-only DDL: sixteen new 06 tables and the existing audit actor CHECK/FK.
-- All existing rows and the single credential store are preserved. The root executor must first verify the exact
-- isolated Railway project/environment/callback/Postgres service and the
-- read-only existing-six-table integrity baseline. No token dump is required:
-- additive DDL runs atomically and failure rolls back the entire transaction.
-- Never apply full application migrations to the callback database.
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE inventory TEXT[];
        actor_check TEXT;
BEGIN
  SELECT array_agg(table_name ORDER BY table_name) INTO inventory
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
  IF inventory IS DISTINCT FROM ARRAY[
    'cafe24_oauth_attempts', 'cafe24_observed_day_checkpoints',
    'cafe24_observed_order_revisions', 'security_audit_events',
    'source_connections', 'source_credentials'
  ]::TEXT[] THEN RAISE EXCEPTION 'CAFE24_LIVE_EXISTING_TABLE_INVENTORY_MISMATCH'; END IF;
  IF (SELECT COUNT(*) FROM source_connections) <> 1 OR
     NOT EXISTS (SELECT 1 FROM source_connections WHERE provider::TEXT = 'CAFE24'
       AND external_account_id = 'didadi0729' AND shop_key = 'shop1'
       AND currency_code = 'KRW' AND time_zone = 'Asia/Seoul'
       AND enabled = false AND access_state::TEXT = 'READY') THEN
    RAISE EXCEPTION 'CAFE24_LIVE_EXISTING_CONNECTION_MISMATCH';
  END IF;
  IF (SELECT COUNT(*) FROM source_credentials) <> 2 OR
     EXISTS (SELECT 1 FROM source_credentials c LEFT JOIN source_connections s
       ON s.id = c.connection_id WHERE s.id IS NULL OR
       c.kind NOT IN ('CAFE24_ACCESS','CAFE24_REFRESH') OR
       c.revision < 1 OR c.key_version < 1 OR c.refresh_owner IS NOT NULL OR
       c.refresh_until IS NOT NULL) THEN
    RAISE EXCEPTION 'CAFE24_LIVE_EXISTING_CREDENTIAL_OWNER_MISMATCH';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO actor_check FROM pg_constraint
    WHERE conrelid='public.security_audit_events'::regclass AND contype='c'
      AND conname='security_audit_events_system_only_check';
  IF actor_check IS DISTINCT FROM
    'CHECK (((actor_type = ''SYSTEM''::security_audit_actor_type) AND (actor_user_id IS NULL)))' THEN
    RAISE EXCEPTION 'CAFE24_LIVE_EXISTING_AUDIT_ACTOR_CHECK_MISMATCH';
  END IF;
END $$;

CREATE TYPE "upload_status" AS ENUM ('PENDING', 'VALIDATING', 'VALIDATED', 'IMPORTED', 'PARTIAL', 'FAILED', 'CANCELLED');

CREATE TYPE "conflict_policy" AS ENUM ('SKIP', 'OVERWRITE', 'NEW_VERSION');

CREATE TYPE "row_validation_status" AS ENUM ('VALID', 'WARNING', 'ERROR', 'UNMATCHED');

CREATE TYPE "match_source" AS ENUM ('RULE', 'MANUAL', 'INFERRED', 'UNMATCHED');

CREATE TYPE "exchange_rate_fallback_type" AS ENUM ('EXACT', 'PREVIOUS_AVAILABLE', 'LATEST_AVAILABLE', 'MANUAL');

CREATE TYPE "cafe24_coupon_scope" AS ENUM ('GLOBAL', 'PRODUCT');

CREATE TYPE "app_role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'USER', 'GUEST');

CREATE TYPE "invite_status" AS ENUM ('PENDING_PROVIDER', 'INVITED', 'VERIFIED_PENDING_PASSWORD', 'ACTIVE', 'RECONCILE_REQUIRED', 'CANCELLED');

CREATE TYPE "SourceDataKind" AS ENUM ('GOOGLE_CAMPAIGN', 'META_AD', 'META_ADSET', 'CAFE24_ORDER');

CREATE TYPE "SourceKind" AS ENUM ('CSV', 'API');

CREATE TYPE "SyncTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'BACKFILL', 'RETRY');

CREATE TYPE "SyncRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'ACTION_REQUIRED', 'CANCELLED');

CREATE TYPE "RunUnitStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ACTION_REQUIRED');

CREATE TYPE "SourceCoverageState" AS ENUM ('NOT_CONNECTED', 'NOT_COLLECTED', 'RUNNING', 'COMPLETE_ZERO', 'COMPLETE_NONZERO', 'PARTIAL', 'FAILED', 'STALE', 'UNSUPPORTED');

CREATE TYPE "SourceBindingMethod" AS ENUM ('EXACT_ID', 'REVIEWED_LEGACY');

CREATE TABLE "app_users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64),
    "normalized_username" VARCHAR(64),
    "email" TEXT,
    "normalized_email" TEXT,
    "name" TEXT NOT NULL,
    "role" "app_role" NOT NULL DEFAULT 'GUEST',
    "invite_status" "invite_status" NOT NULL DEFAULT 'PENDING_PROVIDER',
    "auth_user_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "deactivated_at" TIMESTAMP(3),
    "authz_version" INTEGER NOT NULL DEFAULT 1,
    "invited_at" TIMESTAMP(3),
    "invited_by" UUID,
    "invitation_request_id" UUID,
    "invitation_error_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "sku" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_cost_rules" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sale_price_krw" DECIMAL(14,2) NOT NULL,
    "vat_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "product_cost_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "shipping_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "extra_cost_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fx_rate_krw_per_usd" DECIMAL(12,4) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_cost_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "rate_date" DATE NOT NULL,
    "source_date" DATE NOT NULL,
    "base_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "quote_currency" VARCHAR(3) NOT NULL DEFAULT 'KRW',
    "rate" DECIMAL(14,6) NOT NULL,
    "provider" VARCHAR(32) NOT NULL DEFAULT 'KOREA_EXIM',
    "provider_payload" JSONB,
    "fallback_type" "exchange_rate_fallback_type" NOT NULL DEFAULT 'EXACT',
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cafe24_upload_batches" (
    "id" UUID NOT NULL,
    "original_filename" TEXT NOT NULL,
    "stored_file_path" TEXT,
    "file_hash_sha256" CHAR(64) NOT NULL,
    "order_start" DATE,
    "order_end" DATE,
    "column_schema" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "valid_row_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "conflict_policy" "conflict_policy" NOT NULL DEFAULT 'SKIP',
    "status" "upload_status" NOT NULL DEFAULT 'PENDING',
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validated_at" TIMESTAMP(3),
    "imported_at" TIMESTAMP(3),

    CONSTRAINT "cafe24_upload_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cafe24_order_lines" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID,
    "connection_id" UUID,
    "sync_run_id" UUID,
    "source" "SourceKind" NOT NULL DEFAULT 'CSV',
    "provider_updated_at" TIMESTAMPTZ(3),
    "row_number" INTEGER,
    "source_row_hash" CHAR(64),
    "order_line_key" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "line_order_no" TEXT NOT NULL,
    "product_no" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "option_name" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "sale_price_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_order_krw" DECIMAL(14,2),
    "total_paid_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_paid_input_source" VARCHAR(64),
    "payment_method" TEXT,
    "provider_payment_codes" JSONB,
    "provider_coupon_signal" BOOLEAN,
    "actual_order_price_krw" DECIMAL(18,2),
    "actual_payment_krw" DECIMAL(18,2),
    "actual_shipping_fee_krw" DECIMAL(18,2),
    "initial_order_price_krw" DECIMAL(18,2),
    "initial_payment_krw" DECIMAL(18,2),
    "initial_shipping_fee_krw" DECIMAL(18,2),
    "ordered_at" TIMESTAMP(3),
    "order_date" DATE,
    "product_id" UUID,
    "cafe24_product_rule_id" UUID,
    "match_source" "match_source" NOT NULL DEFAULT 'UNMATCHED',
    "validation_status" "row_validation_status" NOT NULL DEFAULT 'VALID',
    "validation_errors" JSONB NOT NULL DEFAULT '[]',
    "import_version" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "superseded_by_order_line_id" UUID,
    "raw_row" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cafe24_order_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cafe24_coupon_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "cafe24_coupon_scope" NOT NULL,
    "product_id" UUID,
    "discount_krw" DECIMAL(14,2) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cafe24_coupon_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cafe24_product_rules" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "product_numbers" JSONB NOT NULL DEFAULT '[]',
    "product_name_aliases" JSONB NOT NULL DEFAULT '[]',
    "option_include_keywords" JSONB NOT NULL DEFAULT '[]',
    "option_exclude_keywords" JSONB NOT NULL DEFAULT '[]',
    "ad_cost_source_product_id" UUID,
    "roas_group" TEXT,
    "sale_price_krw_override" DECIMAL(14,2),
    "product_cost_krw_override" DECIMAL(14,2),
    "shipping_krw_override" DECIMAL(14,2),
    "extra_cost_krw_override" DECIMAL(14,2),
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" DATE,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cafe24_product_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cafe24_upload_row_errors" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "order_line_id" UUID,
    "row_number" INTEGER,
    "column_name" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "error_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "raw_value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cafe24_upload_row_errors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "source_policies" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "data_kind" "SourceDataKind" NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE,
    "primary_source" "SourceKind" NOT NULL,
    "coupon_input_source" VARCHAR(64),
    "effective_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL,
    "changed_by_user_id" UUID,
    "reason" VARCHAR(256) NOT NULL,

    CONSTRAINT "source_policies_pkey" PRIMARY KEY ("id")
);

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

CREATE TABLE "sync_leases" (
    "connection_id" UUID NOT NULL,
    "owner_run_id" UUID NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_leases_pkey" PRIMARY KEY ("connection_id")
);

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
    "warning_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "source_coverage_pkey" PRIMARY KEY ("connection_id","data_kind","metric_date")
);

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

CREATE TABLE "cafe24_order_api_versions" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "canonical_key_hash" CHAR(64) NOT NULL,
    "order_no" VARCHAR(256) NOT NULL,
    "line_order_no" VARCHAR(256) NOT NULL,
    "product_no" VARCHAR(256) NOT NULL,
    "option_name" VARCHAR(514) NOT NULL,
    "ordered_at" TIMESTAMPTZ(3) NOT NULL,
    "order_date" DATE NOT NULL,
    "provider_updated_at" TIMESTAMPTZ(3),
    "fetched_at" TIMESTAMPTZ(3),
    "content_fingerprint" CHAR(64),
    "fingerprint_key_version" INTEGER,
    "quantity" DECIMAL(14,4) NOT NULL,
    "sale_price_krw" DECIMAL(18,2) NOT NULL,
    "total_order_krw" DECIMAL(18,2),
    "total_paid_krw" DECIMAL(18,2) NOT NULL,
    "total_paid_input_source" VARCHAR(64),
    "payment_method" VARCHAR(256),
    "provider_payment_codes" JSONB,
    "provider_coupon_signal" BOOLEAN,
    "actual_order_price_krw" DECIMAL(18,2),
    "actual_payment_krw" DECIMAL(18,2),
    "actual_shipping_fee_krw" DECIMAL(18,2),
    "initial_order_price_krw" DECIMAL(18,2),
    "initial_payment_krw" DECIMAL(18,2),
    "initial_shipping_fee_krw" DECIMAL(18,2),
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

CREATE UNIQUE INDEX "app_users_username_key" ON "app_users"("username");

CREATE UNIQUE INDEX "app_users_normalized_username_key" ON "app_users"("normalized_username");

CREATE UNIQUE INDEX "app_users_email_key" ON "app_users"("email");

CREATE UNIQUE INDEX "app_users_normalized_email_key" ON "app_users"("normalized_email");

CREATE UNIQUE INDEX "app_users_auth_user_id_key" ON "app_users"("auth_user_id");

CREATE UNIQUE INDEX "app_users_invitation_request_id_key" ON "app_users"("invitation_request_id");

CREATE INDEX "app_users_invited_by_idx" ON "app_users"("invited_by");

CREATE INDEX "app_users_invite_status_created_at_idx" ON "app_users"("invite_status", "created_at");

CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

CREATE INDEX "product_cost_rules_product_id_effective_from_effective_to_idx" ON "product_cost_rules"("product_id", "effective_from", "effective_to");

CREATE INDEX "exchange_rates_base_currency_quote_currency_rate_date_idx" ON "exchange_rates"("base_currency", "quote_currency", "rate_date");

CREATE UNIQUE INDEX "exchange_rates_rate_date_base_currency_quote_currency_provi_key" ON "exchange_rates"("rate_date", "base_currency", "quote_currency", "provider");

CREATE UNIQUE INDEX "cafe24_upload_batches_file_hash_sha256_key" ON "cafe24_upload_batches"("file_hash_sha256");

CREATE INDEX "cafe24_upload_batches_order_start_order_end_idx" ON "cafe24_upload_batches"("order_start", "order_end");

CREATE INDEX "cafe24_upload_batches_uploaded_by_idx" ON "cafe24_upload_batches"("uploaded_by");

CREATE INDEX "cafe24_order_lines_order_date_idx" ON "cafe24_order_lines"("order_date");

CREATE INDEX "cafe24_order_lines_product_id_order_date_idx" ON "cafe24_order_lines"("product_id", "order_date");

CREATE INDEX "cafe24_order_lines_product_no_idx" ON "cafe24_order_lines"("product_no");

CREATE INDEX "cafe24_order_lines_cafe24_product_rule_id_idx" ON "cafe24_order_lines"("cafe24_product_rule_id");

CREATE INDEX "cafe24_order_lines_order_line_key_idx" ON "cafe24_order_lines"("order_line_key");

CREATE INDEX "cafe24_order_lines_order_line_key_is_current_idx" ON "cafe24_order_lines"("order_line_key", "is_current");

CREATE INDEX "cafe24_order_lines_is_current_order_date_idx" ON "cafe24_order_lines"("is_current", "order_date");

CREATE INDEX "cafe24_order_lines_superseded_by_order_line_id_idx" ON "cafe24_order_lines"("superseded_by_order_line_id");

CREATE UNIQUE INDEX "cafe24_order_lines_upload_batch_id_row_number_key" ON "cafe24_order_lines"("upload_batch_id", "row_number");

CREATE INDEX "cafe24_coupon_rules_active_dates_idx" ON "cafe24_coupon_rules"("is_active", "valid_from", "valid_to");

CREATE INDEX "cafe24_coupon_rules_product_active_dates_idx" ON "cafe24_coupon_rules"("product_id", "is_active", "valid_from", "valid_to");

CREATE INDEX "cafe24_coupon_rules_discount_krw_idx" ON "cafe24_coupon_rules"("discount_krw");

CREATE INDEX "cafe24_product_rules_is_active_priority_idx" ON "cafe24_product_rules"("is_active", "priority");

CREATE INDEX "cafe24_product_rules_product_id_idx" ON "cafe24_product_rules"("product_id");

CREATE INDEX "cafe24_product_rules_ad_cost_source_product_id_idx" ON "cafe24_product_rules"("ad_cost_source_product_id");

CREATE INDEX "cafe24_upload_row_errors_upload_batch_id_severity_idx" ON "cafe24_upload_row_errors"("upload_batch_id", "severity");

CREATE INDEX "cafe24_upload_row_errors_order_line_id_idx" ON "cafe24_upload_row_errors"("order_line_id");

CREATE INDEX "source_policies_connection_id_data_kind_from_date_idx" ON "source_policies"("connection_id", "data_kind", "from_date");

CREATE INDEX "sync_runs_status_next_attempt_at_idx" ON "sync_runs"("status", "next_attempt_at");

CREATE UNIQUE INDEX "sync_runs_connection_id_request_key_key" ON "sync_runs"("connection_id", "request_key");

CREATE INDEX "source_coverage_metric_date_state_idx" ON "source_coverage"("metric_date", "state");

CREATE INDEX "source_record_links_connection_id_data_kind_canonical_key_h_idx" ON "source_record_links"("connection_id", "data_kind", "canonical_key_hash", "is_current");

CREATE UNIQUE INDEX "source_record_links_connection_id_data_kind_source_record_t_key" ON "source_record_links"("connection_id", "data_kind", "source", "record_table", "record_id");

CREATE INDEX "cafe24_order_api_versions_connection_id_order_date_idx" ON "cafe24_order_api_versions"("connection_id", "order_date");

CREATE UNIQUE INDEX "cafe24_order_api_versions_connection_id_canonical_key_hash__key" ON "cafe24_order_api_versions"("connection_id", "canonical_key_hash", "version");

ALTER TABLE "app_users" ADD CONSTRAINT "app_users_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_cost_rules" ADD CONSTRAINT "product_cost_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cafe24_upload_batches" ADD CONSTRAINT "cafe24_upload_batches_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cafe24_order_lines" ADD CONSTRAINT "cafe24_order_lines_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "cafe24_upload_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cafe24_order_lines" ADD CONSTRAINT "cafe24_order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cafe24_order_lines" ADD CONSTRAINT "cafe24_order_lines_cafe24_product_rule_id_fkey" FOREIGN KEY ("cafe24_product_rule_id") REFERENCES "cafe24_product_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cafe24_order_lines" ADD CONSTRAINT "cafe24_order_lines_superseded_by_order_line_id_fkey" FOREIGN KEY ("superseded_by_order_line_id") REFERENCES "cafe24_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cafe24_coupon_rules" ADD CONSTRAINT "cafe24_coupon_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cafe24_product_rules" ADD CONSTRAINT "cafe24_product_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cafe24_product_rules" ADD CONSTRAINT "cafe24_product_rules_ad_cost_source_product_id_fkey" FOREIGN KEY ("ad_cost_source_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cafe24_upload_row_errors" ADD CONSTRAINT "cafe24_upload_row_errors_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "cafe24_upload_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cafe24_upload_row_errors" ADD CONSTRAINT "cafe24_upload_row_errors_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "cafe24_order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "source_policies" ADD CONSTRAINT "source_policies_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_policies" ADD CONSTRAINT "source_policies_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "run_units" ADD CONSTRAINT "run_units_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sync_leases" ADD CONSTRAINT "sync_leases_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sync_leases" ADD CONSTRAINT "sync_leases_owner_run_id_fkey" FOREIGN KEY ("owner_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_last_attempt_run_id_fkey" FOREIGN KEY ("last_attempt_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_last_success_run_id_fkey" FOREIGN KEY ("last_success_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_record_links" ADD CONSTRAINT "source_record_links_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_record_links" ADD CONSTRAINT "source_record_links_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cafe24_order_api_versions" ADD CONSTRAINT "cafe24_order_api_versions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cafe24_order_api_versions" ADD CONSTRAINT "cafe24_order_api_versions_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Retain the same canonical origin/current/lease constraints as the application.
-- The narrow OAuth receiver used SYSTEM-only audits. Actual common CSV/policy
-- services retain their USER actor semantics, so the verified old constraint is
-- explicitly replaced in this atomic DDL. Existing audit rows remain unchanged.
ALTER TABLE security_audit_events DROP CONSTRAINT security_audit_events_system_only_check,
  ADD CONSTRAINT security_audit_events_system_or_user_check CHECK (
    (actor_type = 'SYSTEM' AND actor_user_id IS NULL) OR
    (actor_type = 'USER' AND actor_user_id IS NOT NULL)),
  ADD CONSTRAINT security_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id)
    REFERENCES app_users(id) ON DELETE RESTRICT;
ALTER TABLE source_policies ADD CONSTRAINT source_policies_date_range_check
  CHECK (to_date IS NULL OR to_date > from_date),
  ADD CONSTRAINT phase06_source_policy_kind CHECK (data_kind::TEXT = 'CAFE24_ORDER');
ALTER TABLE sync_runs ADD CONSTRAINT phase06_sync_one_day_check
  CHECK (to_date = from_date AND trigger::TEXT = 'MANUAL'),
  ADD CONSTRAINT sync_runs_count_check
  CHECK (attempt_count >= 0 AND rows_fetched >= 0 AND rows_published >= 0);
ALTER TABLE run_units ADD CONSTRAINT run_units_count_check
  CHECK (attempts >= 0 AND fetched_count >= 0 AND published_count >= 0);
ALTER TABLE source_coverage ADD CONSTRAINT source_coverage_count_check
  CHECK (row_count IS NULL OR row_count >= 0),
  ADD CONSTRAINT phase06_coverage_kind CHECK (data_kind::TEXT = 'CAFE24_ORDER');
ALTER TABLE source_record_links ADD CONSTRAINT phase06_source_record_kind
  CHECK (data_kind::TEXT = 'CAFE24_ORDER' AND record_table = 'cafe24_order_lines');
ALTER TABLE cafe24_order_api_versions ADD CONSTRAINT cafe24_order_api_versions_nonnegative_check
  CHECK (quantity >= 0 AND sale_price_krw >= 0 AND total_paid_krw >= 0 AND version > 0),
  ADD CONSTRAINT cafe24_day_fingerprint_pair
  CHECK ((content_fingerprint IS NULL AND fingerprint_key_version IS NULL) OR
    (content_fingerprint IS NOT NULL AND fetched_at IS NOT NULL AND
     fingerprint_key_version BETWEEN 1 AND 99));
ALTER TABLE cafe24_order_lines ADD CONSTRAINT cafe24_order_lines_origin_check CHECK (
  (source::TEXT = 'CSV' AND upload_batch_id IS NOT NULL AND row_number IS NOT NULL
    AND source_row_hash IS NOT NULL AND sync_run_id IS NULL) OR
  (source::TEXT = 'API' AND upload_batch_id IS NULL AND row_number IS NULL
    AND source_row_hash IS NULL AND raw_row IS NULL AND connection_id IS NOT NULL
    AND sync_run_id IS NOT NULL)),
  ADD CONSTRAINT cafe24_order_lines_connection_id_fkey FOREIGN KEY (connection_id)
    REFERENCES source_connections(id) ON DELETE RESTRICT,
  ADD CONSTRAINT cafe24_order_lines_sync_run_id_fkey FOREIGN KEY (sync_run_id)
    REFERENCES sync_runs(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX cafe24_order_api_versions_one_current
  ON cafe24_order_api_versions (connection_id, canonical_key_hash) WHERE is_current;
CREATE UNIQUE INDEX cafe24_order_lines_csv_legacy_current_key ON cafe24_order_lines (order_line_key)
  WHERE source = 'CSV' AND connection_id IS NULL AND is_current;
CREATE UNIQUE INDEX cafe24_order_lines_csv_account_current_key ON cafe24_order_lines (connection_id, order_line_key)
  WHERE source = 'CSV' AND connection_id IS NOT NULL AND is_current;
CREATE UNIQUE INDEX cafe24_order_lines_api_current_key ON cafe24_order_lines (connection_id, order_line_key)
  WHERE source = 'API' AND is_current;
CREATE UNIQUE INDEX cafe24_order_lines_api_version_key ON cafe24_order_lines (connection_id, order_line_key, import_version)
  WHERE source = 'API';
CREATE FUNCTION phase06_guard_policy_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM source_connections WHERE id = NEW.connection_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM source_policies p WHERE p.connection_id = NEW.connection_id
    AND p.data_kind = NEW.data_kind AND p.id <> NEW.id
    AND p.from_date < COALESCE(NEW.to_date, 'infinity'::DATE)
    AND COALESCE(p.to_date, 'infinity'::DATE) > NEW.from_date) THEN
    RAISE EXCEPTION 'CAFE24_LIVE_POLICY_OVERLAP';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER phase06_source_policy_overlap BEFORE INSERT OR UPDATE ON source_policies
  FOR EACH ROW EXECUTE FUNCTION phase06_guard_policy_overlap();

ALTER TABLE "app_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_cost_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_upload_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_coupon_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_product_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_upload_row_errors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_leases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_coverage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_record_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cafe24_order_api_versions" ENABLE ROW LEVEL SECURITY;
COMMIT;
