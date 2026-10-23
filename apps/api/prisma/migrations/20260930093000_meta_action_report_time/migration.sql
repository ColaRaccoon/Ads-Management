-- Normalized Meta API reports carry a reporting-time setting in addition to
-- attribution. Legacy CSV rows remain nullable for backward compatibility.
ALTER TABLE "meta_ad_daily_metrics" ADD COLUMN "action_report_time" VARCHAR(64);
ALTER TABLE "meta_adset_daily_metrics" ADD COLUMN "action_report_time" VARCHAR(64);
