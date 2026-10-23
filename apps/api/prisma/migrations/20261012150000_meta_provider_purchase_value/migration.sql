-- Separate provider-attributed purchase value from product-price revenue and margin.
ALTER TABLE "meta_ad_daily_metrics" ADD COLUMN "purchase_value_usd" DECIMAL(14,4);
ALTER TABLE "meta_adset_daily_metrics" ADD COLUMN "purchase_count" INTEGER;
ALTER TABLE "meta_adset_daily_metrics" ADD COLUMN "purchase_value_usd" DECIMAL(14,4);
