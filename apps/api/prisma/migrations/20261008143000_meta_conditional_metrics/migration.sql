-- Additive compatibility: preserve existing CSV defaults and stored measurements.
ALTER TABLE "meta_ads"."meta_ad_daily_metrics"
  ALTER COLUMN "result_count" DROP NOT NULL,
  ALTER COLUMN "purchase_count" DROP NOT NULL,
  ALTER COLUMN "shop_clicks" DROP NOT NULL,
  ALTER COLUMN "landing_page_views" DROP NOT NULL,
  ADD COLUMN "attribution_windows" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "metric_unavailable_reasons" JSONB;
ALTER TABLE "meta_ads"."meta_adset_daily_metrics"
  ALTER COLUMN "result_count" DROP NOT NULL,
  ALTER COLUMN "shop_clicks" DROP NOT NULL,
  ALTER COLUMN "landing_page_views" DROP NOT NULL,
  ADD COLUMN "attribution_windows" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "metric_unavailable_reasons" JSONB;
