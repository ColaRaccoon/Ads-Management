-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "upload_status" AS ENUM ('PENDING', 'VALIDATING', 'VALIDATED', 'IMPORTED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "upload_level" AS ENUM ('ADSET', 'AD', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "conflict_policy" AS ENUM ('SKIP', 'OVERWRITE', 'NEW_VERSION');

-- CreateEnum
CREATE TYPE "row_validation_status" AS ENUM ('VALID', 'WARNING', 'ERROR', 'UNMATCHED');

-- CreateEnum
CREATE TYPE "match_type" AS ENUM ('CONTAINS', 'EXACT', 'REGEX', 'MANUAL');

-- CreateEnum
CREATE TYPE "match_source" AS ENUM ('RULE', 'MANUAL', 'INFERRED', 'UNMATCHED');

-- CreateEnum
CREATE TYPE "ad_stage" AS ENUM ('SC', 'CBO', 'ASC', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "decision_type" AS ENUM ('SCALE', 'KEEP', 'WATCH', 'STOP_CANDIDATE', 'SC_TO_CBO', 'CBO_TO_ASC', 'SC_TO_ASC', 'ASC_TO_SC', 'PROFIT', 'LOSS');

-- CreateEnum
CREATE TYPE "report_type" AS ENUM ('DAILY_HTML', 'PERIOD_XLSX', 'CHANGE_LOG_XLSX', 'CPA_RULE_XLSX');

-- CreateTable
CREATE TABLE "app_users" (
    "id" UUID NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "product_cost_rules" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sale_price_krw" DECIMAL(14,2) NOT NULL,
    "vat_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "product_cost_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "shipping_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "extra_cost_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fx_rate_krw_per_usd" DECIMAL(12,4) NOT NULL,
    "ad_cost_multiplier" DECIMAL(6,3) NOT NULL DEFAULT 1.100,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_cost_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_cpa_rules" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "target_ratio" DECIMAL(6,4) NOT NULL DEFAULT 0.8000,
    "watch_ratio" DECIMAL(6,4) NOT NULL DEFAULT 1.1000,
    "stop_ratio" DECIMAL(6,4) NOT NULL DEFAULT 1.2500,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_cpa_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_adsets" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'META',
    "external_adset_id" TEXT,
    "adset_name" TEXT NOT NULL,
    "adset_name_key" TEXT NOT NULL,
    "first_seen_on" DATE,
    "last_seen_on" DATE,
    "current_product_id" UUID,
    "current_stage" "ad_stage" NOT NULL DEFAULT 'UNKNOWN',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_adsets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adset_name_aliases" (
    "id" UUID NOT NULL,
    "meta_adset_id" UUID NOT NULL,
    "alias_name" TEXT NOT NULL,
    "alias_key" TEXT NOT NULL,
    "source" "match_source" NOT NULL DEFAULT 'INFERRED',
    "first_seen_on" DATE,
    "last_seen_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adset_name_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_match_rules" (
    "id" UUID NOT NULL,
    "match_type" "match_type" NOT NULL,
    "pattern" TEXT NOT NULL,
    "pattern_key" TEXT,
    "product_id" UUID NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" DATE,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_match_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adset_product_histories" (
    "id" UUID NOT NULL,
    "meta_adset_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source" "match_source" NOT NULL DEFAULT 'MANUAL',
    "match_rule_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adset_product_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adset_stage_histories" (
    "id" UUID NOT NULL,
    "meta_adset_id" UUID NOT NULL,
    "stage" "ad_stage" NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source" "match_source" NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adset_stage_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_batches" (
    "id" UUID NOT NULL,
    "original_filename" TEXT NOT NULL,
    "stored_file_path" TEXT,
    "file_hash_sha256" CHAR(64) NOT NULL,
    "report_start" DATE,
    "report_end" DATE,
    "level" "upload_level" NOT NULL DEFAULT 'ADSET',
    "column_schema" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "valid_row_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "conflict_policy" "conflict_policy" NOT NULL DEFAULT 'SKIP',
    "status" "upload_status" NOT NULL DEFAULT 'PENDING',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Seoul',
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validated_at" TIMESTAMP(3),
    "imported_at" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "upload_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_rows" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "source_row_hash" CHAR(64) NOT NULL,
    "raw_row" JSONB NOT NULL,
    "parsed_row" JSONB,
    "date_start" DATE,
    "date_end" DATE,
    "adset_name" TEXT,
    "adset_name_key" TEXT,
    "meta_adset_id" UUID,
    "product_id" UUID,
    "stage" "ad_stage" NOT NULL DEFAULT 'UNKNOWN',
    "product_match_source" "match_source" NOT NULL DEFAULT 'UNMATCHED',
    "product_match_rule_id" UUID,
    "validation_status" "row_validation_status" NOT NULL DEFAULT 'VALID',
    "validation_errors" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_row_errors" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "upload_row_id" UUID,
    "row_number" INTEGER,
    "column_name" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "error_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "raw_value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_row_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_adset_daily_metrics" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "upload_row_id" UUID,
    "meta_adset_id" UUID NOT NULL,
    "metric_date" DATE NOT NULL,
    "date_start" DATE NOT NULL,
    "date_end" DATE NOT NULL,
    "adset_name" TEXT NOT NULL,
    "adset_name_key" TEXT NOT NULL,
    "delivery_status" TEXT,
    "attribution_setting" TEXT,
    "result_count" INTEGER NOT NULL DEFAULT 0,
    "result_indicator" TEXT,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "frequency" DECIMAL(12,6),
    "cost_per_result_usd" DECIMAL(14,4),
    "adset_budget_label" TEXT,
    "adset_budget_type" TEXT,
    "spend_usd" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "end_status" TEXT,
    "start_date" DATE,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "cpm_usd" DECIMAL(14,4),
    "link_clicks" INTEGER NOT NULL DEFAULT 0,
    "shop_clicks" INTEGER NOT NULL DEFAULT 0,
    "cpc_link_usd" DECIMAL(14,4),
    "ctr_link_pct" DECIMAL(10,6),
    "clicks_all" INTEGER NOT NULL DEFAULT 0,
    "ctr_all_pct" DECIMAL(10,6),
    "cpc_all_usd" DECIMAL(14,4),
    "landing_page_views" INTEGER NOT NULL DEFAULT 0,
    "cost_per_landing_page_view_usd" DECIMAL(14,4),
    "product_id" UUID,
    "stage" "ad_stage" NOT NULL DEFAULT 'UNKNOWN',
    "product_match_source" "match_source" NOT NULL DEFAULT 'UNMATCHED',
    "stage_match_source" "match_source" NOT NULL DEFAULT 'UNMATCHED',
    "product_match_rule_id" UUID,
    "import_version" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "superseded_by_metric_id" UUID,
    "raw_row" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_adset_daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_runs" (
    "id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "compare_type" TEXT,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DONE',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_logs" (
    "id" UUID NOT NULL,
    "decision_run_id" UUID,
    "decision_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "scope_type" TEXT NOT NULL,
    "product_id" UUID,
    "meta_adset_id" UUID,
    "stage" "ad_stage",
    "decision" "decision_type" NOT NULL,
    "severity" SMALLINT NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL,
    "recommended_action" TEXT,
    "metrics_snapshot" JSONB NOT NULL,
    "rule_snapshot" JSONB NOT NULL DEFAULT '{}',
    "is_auto" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_logs" (
    "id" UUID NOT NULL,
    "action_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action_type" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "product_id" UUID,
    "meta_adset_id" UUID,
    "stage_from" "ad_stage",
    "stage_to" "ad_stage",
    "previous_value" JSONB,
    "new_value" JSONB,
    "reason" TEXT NOT NULL,
    "related_decision_id" UUID,
    "next_check_date" DATE,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "report_type" "report_type" NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "file_path" TEXT,
    "file_hash_sha256" CHAR(64),
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "description" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_users_email_key" ON "app_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE INDEX "product_cost_rules_product_id_effective_from_effective_to_idx" ON "product_cost_rules"("product_id", "effective_from", "effective_to");

-- CreateIndex
CREATE INDEX "product_cpa_rules_product_id_effective_from_effective_to_idx" ON "product_cpa_rules"("product_id", "effective_from", "effective_to");

-- CreateIndex
CREATE INDEX "meta_adsets_platform_external_adset_id_idx" ON "meta_adsets"("platform", "external_adset_id");

-- CreateIndex
CREATE INDEX "meta_adsets_platform_adset_name_key_idx" ON "meta_adsets"("platform", "adset_name_key");

-- CreateIndex
CREATE UNIQUE INDEX "adset_name_aliases_alias_key_key" ON "adset_name_aliases"("alias_key");

-- CreateIndex
CREATE INDEX "product_match_rules_is_active_priority_idx" ON "product_match_rules"("is_active", "priority");

-- CreateIndex
CREATE INDEX "adset_product_histories_meta_adset_id_effective_from_effect_idx" ON "adset_product_histories"("meta_adset_id", "effective_from", "effective_to");

-- CreateIndex
CREATE INDEX "adset_stage_histories_meta_adset_id_effective_from_effectiv_idx" ON "adset_stage_histories"("meta_adset_id", "effective_from", "effective_to");

-- CreateIndex
CREATE UNIQUE INDEX "upload_batches_file_hash_sha256_key" ON "upload_batches"("file_hash_sha256");

-- CreateIndex
CREATE INDEX "upload_batches_report_start_report_end_idx" ON "upload_batches"("report_start", "report_end");

-- CreateIndex
CREATE INDEX "upload_rows_upload_batch_id_validation_status_idx" ON "upload_rows"("upload_batch_id", "validation_status");

-- CreateIndex
CREATE UNIQUE INDEX "upload_rows_upload_batch_id_row_number_key" ON "upload_rows"("upload_batch_id", "row_number");

-- CreateIndex
CREATE INDEX "upload_row_errors_upload_batch_id_severity_idx" ON "upload_row_errors"("upload_batch_id", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "meta_adset_daily_metrics_upload_row_id_key" ON "meta_adset_daily_metrics"("upload_row_id");

-- CreateIndex
CREATE INDEX "meta_adset_daily_metrics_metric_date_idx" ON "meta_adset_daily_metrics"("metric_date");

-- CreateIndex
CREATE INDEX "meta_adset_daily_metrics_product_id_metric_date_idx" ON "meta_adset_daily_metrics"("product_id", "metric_date");

-- CreateIndex
CREATE INDEX "meta_adset_daily_metrics_stage_metric_date_idx" ON "meta_adset_daily_metrics"("stage", "metric_date");

-- CreateIndex
CREATE UNIQUE INDEX "meta_adset_daily_metrics_metric_date_meta_adset_id_import_v_key" ON "meta_adset_daily_metrics"("metric_date", "meta_adset_id", "import_version");

-- CreateIndex
CREATE INDEX "decision_logs_period_start_period_end_decision_idx" ON "decision_logs"("period_start", "period_end", "decision");

-- CreateIndex
CREATE INDEX "decision_logs_product_id_decision_date_idx" ON "decision_logs"("product_id", "decision_date");

-- CreateIndex
CREATE INDEX "decision_logs_meta_adset_id_decision_date_idx" ON "decision_logs"("meta_adset_id", "decision_date");

-- CreateIndex
CREATE INDEX "change_logs_action_date_action_type_idx" ON "change_logs"("action_date", "action_type");

-- CreateIndex
CREATE INDEX "report_exports_report_type_period_start_period_end_idx" ON "report_exports"("report_type", "period_start", "period_end");

-- AddForeignKey
ALTER TABLE "product_cost_rules" ADD CONSTRAINT "product_cost_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_cpa_rules" ADD CONSTRAINT "product_cpa_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_adsets" ADD CONSTRAINT "meta_adsets_current_product_id_fkey" FOREIGN KEY ("current_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adset_name_aliases" ADD CONSTRAINT "adset_name_aliases_meta_adset_id_fkey" FOREIGN KEY ("meta_adset_id") REFERENCES "meta_adsets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_match_rules" ADD CONSTRAINT "product_match_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adset_product_histories" ADD CONSTRAINT "adset_product_histories_meta_adset_id_fkey" FOREIGN KEY ("meta_adset_id") REFERENCES "meta_adsets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adset_product_histories" ADD CONSTRAINT "adset_product_histories_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adset_product_histories" ADD CONSTRAINT "adset_product_histories_match_rule_id_fkey" FOREIGN KEY ("match_rule_id") REFERENCES "product_match_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adset_stage_histories" ADD CONSTRAINT "adset_stage_histories_meta_adset_id_fkey" FOREIGN KEY ("meta_adset_id") REFERENCES "meta_adsets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_rows" ADD CONSTRAINT "upload_rows_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "upload_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_rows" ADD CONSTRAINT "upload_rows_meta_adset_id_fkey" FOREIGN KEY ("meta_adset_id") REFERENCES "meta_adsets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_rows" ADD CONSTRAINT "upload_rows_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_rows" ADD CONSTRAINT "upload_rows_product_match_rule_id_fkey" FOREIGN KEY ("product_match_rule_id") REFERENCES "product_match_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_row_errors" ADD CONSTRAINT "upload_row_errors_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "upload_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_row_errors" ADD CONSTRAINT "upload_row_errors_upload_row_id_fkey" FOREIGN KEY ("upload_row_id") REFERENCES "upload_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_adset_daily_metrics" ADD CONSTRAINT "meta_adset_daily_metrics_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "upload_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_adset_daily_metrics" ADD CONSTRAINT "meta_adset_daily_metrics_upload_row_id_fkey" FOREIGN KEY ("upload_row_id") REFERENCES "upload_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_adset_daily_metrics" ADD CONSTRAINT "meta_adset_daily_metrics_meta_adset_id_fkey" FOREIGN KEY ("meta_adset_id") REFERENCES "meta_adsets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_adset_daily_metrics" ADD CONSTRAINT "meta_adset_daily_metrics_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_adset_daily_metrics" ADD CONSTRAINT "meta_adset_daily_metrics_product_match_rule_id_fkey" FOREIGN KEY ("product_match_rule_id") REFERENCES "product_match_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_logs" ADD CONSTRAINT "decision_logs_decision_run_id_fkey" FOREIGN KEY ("decision_run_id") REFERENCES "decision_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_logs" ADD CONSTRAINT "decision_logs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_logs" ADD CONSTRAINT "decision_logs_meta_adset_id_fkey" FOREIGN KEY ("meta_adset_id") REFERENCES "meta_adsets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_meta_adset_id_fkey" FOREIGN KEY ("meta_adset_id") REFERENCES "meta_adsets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_related_decision_id_fkey" FOREIGN KEY ("related_decision_id") REFERENCES "decision_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial indexes required by the implementation plan. These cannot be
-- represented directly in Prisma schema, so they live in migration SQL.
CREATE UNIQUE INDEX "meta_adsets_platform_external_adset_id_not_null_uidx"
  ON "meta_adsets"("platform", "external_adset_id")
  WHERE "external_adset_id" IS NOT NULL;

CREATE UNIQUE INDEX "meta_adsets_platform_adset_name_key_no_external_uidx"
  ON "meta_adsets"("platform", "adset_name_key")
  WHERE "external_adset_id" IS NULL;

CREATE UNIQUE INDEX "meta_adset_daily_metrics_current_metric_uidx"
  ON "meta_adset_daily_metrics"("metric_date", "meta_adset_id")
  WHERE "is_current" = true;

CREATE INDEX "meta_adset_daily_metrics_metric_date_current_idx"
  ON "meta_adset_daily_metrics"("metric_date")
  WHERE "is_current" = true;

CREATE INDEX "meta_adset_daily_metrics_product_metric_date_current_idx"
  ON "meta_adset_daily_metrics"("product_id", "metric_date")
  WHERE "is_current" = true;

CREATE INDEX "meta_adset_daily_metrics_stage_metric_date_current_idx"
  ON "meta_adset_daily_metrics"("stage", "metric_date")
  WHERE "is_current" = true;

CREATE INDEX "meta_adset_daily_metrics_unmatched_current_idx"
  ON "meta_adset_daily_metrics"("metric_date")
  WHERE "is_current" = true AND "product_id" IS NULL;

CREATE INDEX "upload_rows_unmatched_idx"
  ON "upload_rows"("upload_batch_id", "row_number")
  WHERE "validation_status" = 'UNMATCHED';

CREATE INDEX "change_logs_next_check_date_idx"
  ON "change_logs"("next_check_date")
  WHERE "next_check_date" IS NOT NULL;


