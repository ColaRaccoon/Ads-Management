ALTER TABLE "meta_ads"."meta_ad_daily_metrics"
  ADD COLUMN "current_metadata" JSONB,
  ADD COLUMN "metadata_observed_at" TIMESTAMPTZ(6);
ALTER TABLE "meta_ads"."meta_adset_daily_metrics"
  ADD COLUMN "current_metadata" JSONB,
  ADD COLUMN "metadata_observed_at" TIMESTAMPTZ(6);
