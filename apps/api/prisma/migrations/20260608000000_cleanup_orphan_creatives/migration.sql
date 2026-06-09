-- Hide and clean creative records whose source ad metrics were deleted.

DELETE FROM "creative_change_logs" AS log
WHERE NOT EXISTS (
  SELECT 1
  FROM "meta_ad_daily_metrics" AS metric
  WHERE metric."creative_id" = log."creative_id"
);

DELETE FROM "creative_placements" AS placement
WHERE NOT EXISTS (
  SELECT 1
  FROM "meta_ad_daily_metrics" AS metric
  WHERE metric."creative_id" = placement."creative_id"
    AND metric."meta_campaign_id" = placement."meta_campaign_id"
    AND metric."meta_adset_id" = placement."meta_adset_id"
    AND metric."ad_name_snapshot" = placement."original_ad_name"
);

DELETE FROM "creative_aliases" AS alias
WHERE NOT EXISTS (
  SELECT 1
  FROM "meta_ad_daily_metrics" AS metric
  WHERE metric."creative_id" = alias."creative_id"
    AND metric."ad_name_snapshot" = alias."original_name"
);

UPDATE "meta_ads" AS ad
SET "creative_id" = NULL
WHERE ad."creative_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "meta_ad_daily_metrics" AS metric
    WHERE metric."creative_id" = ad."creative_id"
  );

DELETE FROM "creatives" AS creative
WHERE NOT EXISTS (
  SELECT 1
  FROM "meta_ad_daily_metrics" AS metric
  WHERE metric."creative_id" = creative."id"
);

UPDATE "creatives" AS creative
SET "is_active" = false,
    "updated_at" = CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM "meta_ad_daily_metrics" AS metric
  WHERE metric."creative_id" = creative."id"
    AND metric."is_current" = true
);

ALTER TABLE "creative_aliases"
  DROP CONSTRAINT IF EXISTS "creative_aliases_creative_id_fkey";

ALTER TABLE "creative_aliases"
  ADD CONSTRAINT "creative_aliases_creative_id_fkey"
  FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "creative_placements"
  DROP CONSTRAINT IF EXISTS "creative_placements_creative_id_fkey";

ALTER TABLE "creative_placements"
  ADD CONSTRAINT "creative_placements_creative_id_fkey"
  FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "creative_change_logs"
  DROP CONSTRAINT IF EXISTS "creative_change_logs_creative_id_fkey";

ALTER TABLE "creative_change_logs"
  ADD CONSTRAINT "creative_change_logs_creative_id_fkey"
  FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
