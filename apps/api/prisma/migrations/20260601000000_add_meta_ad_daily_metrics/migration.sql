-- Add campaign/ad masters and ad-level daily metrics as the new Meta source of truth.

ALTER TABLE "meta_adsets" ADD COLUMN "campaign_ref_id" UUID;

CREATE TABLE "meta_campaigns" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'META',
    "meta_campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT NOT NULL,
    "first_seen_on" DATE,
    "last_seen_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meta_ads" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'META',
    "campaign_ref_id" UUID NOT NULL,
    "meta_adset_ref_id" UUID NOT NULL,
    "meta_campaign_id" TEXT NOT NULL,
    "meta_adset_id" TEXT NOT NULL,
    "meta_ad_id" TEXT,
    "synthetic_ad_key" TEXT NOT NULL,
    "ad_identity_key" TEXT NOT NULL,
    "ad_name" TEXT NOT NULL,
    "first_seen_on" DATE,
    "last_seen_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_ads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meta_ad_daily_metrics" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "upload_row_id" UUID,
    "campaign_ref_id" UUID NOT NULL,
    "meta_adset_ref_id" UUID NOT NULL,
    "meta_ad_ref_id" UUID NOT NULL,
    "metric_date" DATE NOT NULL,
    "date_start" DATE NOT NULL,
    "date_end" DATE NOT NULL,
    "meta_campaign_id" TEXT NOT NULL,
    "campaign_name_snapshot" TEXT NOT NULL,
    "meta_adset_id" TEXT NOT NULL,
    "adset_name_snapshot" TEXT NOT NULL,
    "meta_ad_id" TEXT,
    "synthetic_ad_key" TEXT NOT NULL,
    "ad_identity_key" TEXT NOT NULL,
    "ad_name_snapshot" TEXT NOT NULL,
    "ad_delivery_status" TEXT,
    "attribution_setting" TEXT,
    "result_indicator" TEXT,
    "result_count" INTEGER NOT NULL DEFAULT 0,
    "purchase_count" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "frequency" DECIMAL(12,6),
    "cost_per_result_usd" DECIMAL(14,4),
    "adset_budget_label" TEXT,
    "adset_budget_type" TEXT,
    "spend_usd" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "end_status" TEXT,
    "quality_ranking" TEXT,
    "engagement_rate_ranking" TEXT,
    "conversion_rate_ranking" TEXT,
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

    CONSTRAINT "meta_ad_daily_metrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meta_campaigns_platform_meta_campaign_id_key"
  ON "meta_campaigns"("platform", "meta_campaign_id");

CREATE INDEX "meta_campaigns_platform_campaign_name_idx"
  ON "meta_campaigns"("platform", "campaign_name");

CREATE UNIQUE INDEX "meta_ads_platform_meta_campaign_id_meta_adset_id_ad_identity_key_key"
  ON "meta_ads"("platform", "meta_campaign_id", "meta_adset_id", "ad_identity_key");

CREATE INDEX "meta_ads_platform_meta_ad_id_idx"
  ON "meta_ads"("platform", "meta_ad_id");

CREATE INDEX "meta_ads_campaign_ref_id_idx"
  ON "meta_ads"("campaign_ref_id");

CREATE INDEX "meta_ads_meta_adset_ref_id_idx"
  ON "meta_ads"("meta_adset_ref_id");

CREATE INDEX "meta_ads_ad_name_idx"
  ON "meta_ads"("ad_name");

CREATE UNIQUE INDEX "meta_ad_daily_metrics_upload_row_id_key"
  ON "meta_ad_daily_metrics"("upload_row_id");

CREATE UNIQUE INDEX "meta_ad_daily_metrics_metric_date_meta_campaign_id_meta_adset_id_ad_identity_key_import_version_key"
  ON "meta_ad_daily_metrics"("metric_date", "meta_campaign_id", "meta_adset_id", "ad_identity_key", "import_version");

CREATE INDEX "meta_ad_daily_metrics_metric_date_idx"
  ON "meta_ad_daily_metrics"("metric_date");

CREATE INDEX "meta_ad_daily_metrics_meta_campaign_id_metric_date_idx"
  ON "meta_ad_daily_metrics"("meta_campaign_id", "metric_date");

CREATE INDEX "meta_ad_daily_metrics_meta_adset_id_metric_date_idx"
  ON "meta_ad_daily_metrics"("meta_adset_id", "metric_date");

CREATE INDEX "meta_ad_daily_metrics_ad_name_snapshot_metric_date_idx"
  ON "meta_ad_daily_metrics"("ad_name_snapshot", "metric_date");

CREATE INDEX "meta_ad_daily_metrics_product_id_metric_date_idx"
  ON "meta_ad_daily_metrics"("product_id", "metric_date");

CREATE INDEX "meta_ad_daily_metrics_stage_metric_date_idx"
  ON "meta_ad_daily_metrics"("stage", "metric_date");

CREATE UNIQUE INDEX "meta_ad_daily_metrics_current_metric_uidx"
  ON "meta_ad_daily_metrics"("metric_date", "meta_campaign_id", "meta_adset_id", "ad_identity_key")
  WHERE "is_current" = true;

CREATE INDEX "meta_ad_daily_metrics_metric_date_current_idx"
  ON "meta_ad_daily_metrics"("metric_date")
  WHERE "is_current" = true;

ALTER TABLE "meta_adsets"
  ADD CONSTRAINT "meta_adsets_campaign_ref_id_fkey"
  FOREIGN KEY ("campaign_ref_id") REFERENCES "meta_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "meta_ads"
  ADD CONSTRAINT "meta_ads_campaign_ref_id_fkey"
  FOREIGN KEY ("campaign_ref_id") REFERENCES "meta_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "meta_ads"
  ADD CONSTRAINT "meta_ads_meta_adset_ref_id_fkey"
  FOREIGN KEY ("meta_adset_ref_id") REFERENCES "meta_adsets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_upload_batch_id_fkey"
  FOREIGN KEY ("upload_batch_id") REFERENCES "upload_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_upload_row_id_fkey"
  FOREIGN KEY ("upload_row_id") REFERENCES "upload_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_campaign_ref_id_fkey"
  FOREIGN KEY ("campaign_ref_id") REFERENCES "meta_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_meta_adset_ref_id_fkey"
  FOREIGN KEY ("meta_adset_ref_id") REFERENCES "meta_adsets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_meta_ad_ref_id_fkey"
  FOREIGN KEY ("meta_ad_ref_id") REFERENCES "meta_ads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_product_match_rule_id_fkey"
  FOREIGN KEY ("product_match_rule_id") REFERENCES "product_match_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
