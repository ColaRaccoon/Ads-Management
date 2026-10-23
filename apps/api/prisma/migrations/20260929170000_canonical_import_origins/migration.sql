-- API rows live in the existing canonical business tables without pretending to
-- have an uploaded file. Existing CSV rows keep their batch FK and semantics.
ALTER TABLE "cafe24_order_lines"
  ALTER COLUMN "upload_batch_id" DROP NOT NULL,
  ALTER COLUMN "row_number" DROP NOT NULL,
  ALTER COLUMN "source_row_hash" DROP NOT NULL,
  ADD COLUMN "connection_id" UUID,
  ADD COLUMN "sync_run_id" UUID,
  ADD COLUMN "source" "SourceKind" NOT NULL DEFAULT 'CSV',
  ADD COLUMN "provider_updated_at" TIMESTAMPTZ(3);

ALTER TABLE "meta_ad_daily_metrics"
  ALTER COLUMN "upload_batch_id" DROP NOT NULL,
  ALTER COLUMN "raw_row" DROP NOT NULL,
  ADD COLUMN "connection_id" UUID,
  ADD COLUMN "sync_run_id" UUID,
  ADD COLUMN "source" "SourceKind" NOT NULL DEFAULT 'CSV',
  ADD COLUMN "source_revision" VARCHAR(256);

ALTER TABLE "meta_adset_daily_metrics"
  ALTER COLUMN "upload_batch_id" DROP NOT NULL,
  ALTER COLUMN "raw_row" DROP NOT NULL,
  ADD COLUMN "connection_id" UUID,
  ADD COLUMN "sync_run_id" UUID,
  ADD COLUMN "source" "SourceKind" NOT NULL DEFAULT 'CSV',
  ADD COLUMN "source_revision" VARCHAR(256);

ALTER TABLE "meta_campaigns" ADD COLUMN "connection_id" UUID;
ALTER TABLE "meta_adsets" ADD COLUMN "connection_id" UUID;
ALTER TABLE "meta_ads" ADD COLUMN "connection_id" UUID;
ALTER TABLE "creative_placements" ADD COLUMN "connection_id" UUID;
ALTER TABLE "meta_campaigns" ADD CONSTRAINT "meta_campaigns_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT;
ALTER TABLE "meta_adsets" ADD CONSTRAINT "meta_adsets_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT;
ALTER TABLE "meta_ads" ADD CONSTRAINT "meta_ads_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT;
ALTER TABLE "creative_placements" ADD CONSTRAINT "creative_placements_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT;

ALTER TABLE "cafe24_order_lines"
  ADD CONSTRAINT "cafe24_order_lines_origin_check" CHECK (
    ("source" = 'CSV' AND "upload_batch_id" IS NOT NULL AND "row_number" IS NOT NULL AND "source_row_hash" IS NOT NULL AND "sync_run_id" IS NULL)
    OR ("source" = 'API' AND "upload_batch_id" IS NULL AND "row_number" IS NULL AND "source_row_hash" IS NULL AND "raw_row" IS NULL AND "connection_id" IS NOT NULL AND "sync_run_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "cafe24_order_lines_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "cafe24_order_lines_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT;

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_origin_check" CHECK (
    ("source" = 'CSV' AND "upload_batch_id" IS NOT NULL AND "sync_run_id" IS NULL)
    OR ("source" = 'API' AND "upload_batch_id" IS NULL AND "upload_row_id" IS NULL AND "raw_row" IS NULL AND "connection_id" IS NOT NULL AND "sync_run_id" IS NOT NULL AND "source_revision" IS NOT NULL)
  ),
  ADD CONSTRAINT "meta_ad_daily_metrics_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "meta_ad_daily_metrics_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT;

ALTER TABLE "meta_adset_daily_metrics"
  ADD CONSTRAINT "meta_adset_daily_metrics_origin_check" CHECK (
    ("source" = 'CSV' AND "upload_batch_id" IS NOT NULL AND "sync_run_id" IS NULL)
    OR ("source" = 'API' AND "upload_batch_id" IS NULL AND "upload_row_id" IS NULL AND "raw_row" IS NULL AND "connection_id" IS NOT NULL AND "sync_run_id" IS NOT NULL AND "source_revision" IS NOT NULL)
  ),
  ADD CONSTRAINT "meta_adset_daily_metrics_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "meta_adset_daily_metrics_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT;

CREATE INDEX "cafe24_order_lines_connection_id_order_date_idx" ON "cafe24_order_lines"("connection_id", "order_date");
CREATE INDEX "meta_ad_daily_metrics_connection_id_metric_date_idx" ON "meta_ad_daily_metrics"("connection_id", "metric_date");
CREATE INDEX "meta_adset_daily_metrics_connection_id_metric_date_idx" ON "meta_adset_daily_metrics"("connection_id", "metric_date");

-- Both sources retain their own current pointer. SourcePolicy chooses the
-- visible pointer; rollback therefore exposes the retained CSV version.
DROP INDEX "cafe24_order_lines_current_order_line_key_key";
CREATE UNIQUE INDEX "cafe24_order_lines_csv_legacy_current_key" ON "cafe24_order_lines"("order_line_key")
  WHERE "source" = 'CSV' AND "connection_id" IS NULL AND "is_current" = true;
CREATE UNIQUE INDEX "cafe24_order_lines_csv_account_current_key" ON "cafe24_order_lines"("connection_id", "order_line_key")
  WHERE "source" = 'CSV' AND "connection_id" IS NOT NULL AND "is_current" = true;
CREATE UNIQUE INDEX "cafe24_order_lines_api_current_key" ON "cafe24_order_lines"("connection_id", "order_line_key")
  WHERE "source" = 'API' AND "is_current" = true;
CREATE UNIQUE INDEX "cafe24_order_lines_api_version_key" ON "cafe24_order_lines"("connection_id", "order_line_key", "import_version")
  WHERE "source" = 'API';

DROP INDEX "meta_ad_daily_metrics_metric_date_meta_campaign_id_meta_adset_id_ad_identity_key_import_version_key";
DROP INDEX "meta_ad_daily_metrics_current_metric_uidx";
CREATE UNIQUE INDEX "meta_ad_daily_metrics_csv_legacy_version_key" ON "meta_ad_daily_metrics"("metric_date", "meta_campaign_id", "meta_adset_id", "ad_identity_key", "import_version")
  WHERE "source" = 'CSV' AND "connection_id" IS NULL;
CREATE UNIQUE INDEX "meta_ad_daily_metrics_csv_account_version_key" ON "meta_ad_daily_metrics"("connection_id", "metric_date", "meta_campaign_id", "meta_adset_id", "ad_identity_key", "import_version")
  WHERE "source" = 'CSV' AND "connection_id" IS NOT NULL;
CREATE UNIQUE INDEX "meta_ad_daily_metrics_api_version_key" ON "meta_ad_daily_metrics"("connection_id", "metric_date", "meta_campaign_id", "meta_adset_id", "ad_identity_key", "import_version")
  WHERE "source" = 'API';
CREATE UNIQUE INDEX "meta_ad_daily_metrics_csv_legacy_current_key" ON "meta_ad_daily_metrics"("metric_date", "meta_campaign_id", "meta_adset_id", "ad_identity_key")
  WHERE "source" = 'CSV' AND "connection_id" IS NULL AND "is_current" = true;
CREATE UNIQUE INDEX "meta_ad_daily_metrics_csv_account_current_key" ON "meta_ad_daily_metrics"("connection_id", "metric_date", "meta_campaign_id", "meta_adset_id", "ad_identity_key")
  WHERE "source" = 'CSV' AND "connection_id" IS NOT NULL AND "is_current" = true;
CREATE UNIQUE INDEX "meta_ad_daily_metrics_api_current_key" ON "meta_ad_daily_metrics"("connection_id", "metric_date", "meta_campaign_id", "meta_adset_id", "ad_identity_key")
  WHERE "source" = 'API' AND "is_current" = true;

DROP INDEX "meta_adset_daily_metrics_metric_date_meta_adset_id_import_v_key";
DROP INDEX "meta_adset_daily_metrics_current_metric_uidx";
CREATE UNIQUE INDEX "meta_adset_daily_metrics_csv_legacy_version_key" ON "meta_adset_daily_metrics"("metric_date", "meta_adset_id", "import_version")
  WHERE "source" = 'CSV' AND "connection_id" IS NULL;
CREATE UNIQUE INDEX "meta_adset_daily_metrics_csv_account_version_key" ON "meta_adset_daily_metrics"("connection_id", "metric_date", "meta_adset_id", "import_version")
  WHERE "source" = 'CSV' AND "connection_id" IS NOT NULL;
CREATE UNIQUE INDEX "meta_adset_daily_metrics_api_version_key" ON "meta_adset_daily_metrics"("connection_id", "metric_date", "meta_adset_id", "import_version")
  WHERE "source" = 'API';
CREATE UNIQUE INDEX "meta_adset_daily_metrics_csv_legacy_current_key" ON "meta_adset_daily_metrics"("metric_date", "meta_adset_id")
  WHERE "source" = 'CSV' AND "connection_id" IS NULL AND "is_current" = true;
CREATE UNIQUE INDEX "meta_adset_daily_metrics_csv_account_current_key" ON "meta_adset_daily_metrics"("connection_id", "metric_date", "meta_adset_id")
  WHERE "source" = 'CSV' AND "connection_id" IS NOT NULL AND "is_current" = true;
CREATE UNIQUE INDEX "meta_adset_daily_metrics_api_current_key" ON "meta_adset_daily_metrics"("connection_id", "metric_date", "meta_adset_id")
  WHERE "source" = 'API' AND "is_current" = true;

DROP INDEX "meta_campaigns_platform_meta_campaign_id_key";
CREATE UNIQUE INDEX "meta_campaigns_legacy_key" ON "meta_campaigns"("platform", "meta_campaign_id")
  WHERE "connection_id" IS NULL;
CREATE UNIQUE INDEX "meta_campaigns_account_key" ON "meta_campaigns"("connection_id", "platform", "meta_campaign_id")
  WHERE "connection_id" IS NOT NULL;
DROP INDEX "meta_ads_platform_meta_campaign_id_meta_adset_id_ad_identity_key_key";
CREATE UNIQUE INDEX "meta_ads_legacy_key" ON "meta_ads"("platform", "meta_campaign_id", "meta_adset_id", "ad_identity_key")
  WHERE "connection_id" IS NULL;
CREATE UNIQUE INDEX "meta_ads_account_key" ON "meta_ads"("connection_id", "platform", "meta_campaign_id", "meta_adset_id", "ad_identity_key")
  WHERE "connection_id" IS NOT NULL;
CREATE UNIQUE INDEX "meta_adsets_account_external_key" ON "meta_adsets"("connection_id", "platform", "external_adset_id")
  WHERE "connection_id" IS NOT NULL AND "external_adset_id" IS NOT NULL;
DROP INDEX "creative_placements_creative_id_meta_campaign_id_meta_adset_id_original_ad_name_key";
CREATE UNIQUE INDEX "creative_placements_legacy_key" ON "creative_placements"("creative_id", "meta_campaign_id", "meta_adset_id", "original_ad_name")
  WHERE "connection_id" IS NULL;
CREATE UNIQUE INDEX "creative_placements_account_key" ON "creative_placements"("connection_id", "creative_id", "meta_campaign_id", "meta_adset_id", "original_ad_name")
  WHERE "connection_id" IS NOT NULL;
CREATE INDEX "creative_placements_connection_id_creative_id_idx" ON "creative_placements"("connection_id", "creative_id");
