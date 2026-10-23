-- Existing version rows remain immutable. New multi-ad CSV aggregates store
-- unsupported adset reach as NULL; old multi-ad values are masked at read time.
ALTER TABLE "meta_adset_daily_metrics" ALTER COLUMN "reach" DROP NOT NULL;
ALTER TABLE "meta_adset_daily_metrics" ALTER COLUMN "reach" DROP DEFAULT;
