-- Store Meta video-play source counts. Display rates remain derived API values.
BEGIN;

ALTER TABLE "meta_ad_daily_metrics"
  ADD COLUMN "video_play_3s_count" INTEGER,
  ADD COLUMN "video_play_25_count" INTEGER,
  ADD COLUMN "video_play_50_count" INTEGER,
  ADD COLUMN "video_play_75_count" INTEGER,
  ADD COLUMN "video_play_100_count" INTEGER;

-- Backfill every import version from its preserved source row. A missing JSON key
-- means the metric was not collected. An empty cell becomes zero only when that
-- source row contains at least one non-empty video metric value.
WITH source AS (
  SELECT
    "id",
    "raw_row" ? '동영상 3초 이상 재생' AS "has_3s",
    "raw_row" ? '동영상 25% 재생' AS "has_25",
    "raw_row" ? '동영상 50% 재생' AS "has_50",
    "raw_row" ? '동영상 75% 재생' AS "has_75",
    "raw_row" ? '동영상 100% 재생' AS "has_100",
    NULLIF(BTRIM("raw_row" ->> '동영상 3초 이상 재생'), '') AS "raw_3s",
    NULLIF(BTRIM("raw_row" ->> '동영상 25% 재생'), '') AS "raw_25",
    NULLIF(BTRIM("raw_row" ->> '동영상 50% 재생'), '') AS "raw_50",
    NULLIF(BTRIM("raw_row" ->> '동영상 75% 재생'), '') AS "raw_75",
    NULLIF(BTRIM("raw_row" ->> '동영상 100% 재생'), '') AS "raw_100"
  FROM "meta_ad_daily_metrics"
), prepared AS (
  SELECT
    source.*,
    "raw_3s" IS NOT NULL OR
    "raw_25" IS NOT NULL OR
    "raw_50" IS NOT NULL OR
    "raw_75" IS NOT NULL OR
    "raw_100" IS NOT NULL AS "has_any_video_value"
  FROM source
), normalized AS (
  SELECT
    prepared.*,
    CASE WHEN "raw_3s" ~ '^[+]?[0-9][0-9,]*(\.[0-9]+)?$' AND LENGTH(REPLACE("raw_3s", ',', '')) <= 32 THEN REPLACE("raw_3s", ',', '')::numeric END AS "number_3s",
    CASE WHEN "raw_25" ~ '^[+]?[0-9][0-9,]*(\.[0-9]+)?$' AND LENGTH(REPLACE("raw_25", ',', '')) <= 32 THEN REPLACE("raw_25", ',', '')::numeric END AS "number_25",
    CASE WHEN "raw_50" ~ '^[+]?[0-9][0-9,]*(\.[0-9]+)?$' AND LENGTH(REPLACE("raw_50", ',', '')) <= 32 THEN REPLACE("raw_50", ',', '')::numeric END AS "number_50",
    CASE WHEN "raw_75" ~ '^[+]?[0-9][0-9,]*(\.[0-9]+)?$' AND LENGTH(REPLACE("raw_75", ',', '')) <= 32 THEN REPLACE("raw_75", ',', '')::numeric END AS "number_75",
    CASE WHEN "raw_100" ~ '^[+]?[0-9][0-9,]*(\.[0-9]+)?$' AND LENGTH(REPLACE("raw_100", ',', '')) <= 32 THEN REPLACE("raw_100", ',', '')::numeric END AS "number_100"
  FROM prepared
)
UPDATE "meta_ad_daily_metrics" AS metric
SET
  "video_play_3s_count" = CASE
    WHEN NOT normalized."has_3s" OR NOT normalized."has_any_video_value" THEN NULL
    WHEN normalized."raw_3s" IS NULL THEN 0
    WHEN TRUNC(normalized."number_3s") BETWEEN 0 AND 2147483647 THEN TRUNC(normalized."number_3s")::integer
    ELSE NULL
  END,
  "video_play_25_count" = CASE
    WHEN NOT normalized."has_25" OR NOT normalized."has_any_video_value" THEN NULL
    WHEN normalized."raw_25" IS NULL THEN 0
    WHEN TRUNC(normalized."number_25") BETWEEN 0 AND 2147483647 THEN TRUNC(normalized."number_25")::integer
    ELSE NULL
  END,
  "video_play_50_count" = CASE
    WHEN NOT normalized."has_50" OR NOT normalized."has_any_video_value" THEN NULL
    WHEN normalized."raw_50" IS NULL THEN 0
    WHEN TRUNC(normalized."number_50") BETWEEN 0 AND 2147483647 THEN TRUNC(normalized."number_50")::integer
    ELSE NULL
  END,
  "video_play_75_count" = CASE
    WHEN NOT normalized."has_75" OR NOT normalized."has_any_video_value" THEN NULL
    WHEN normalized."raw_75" IS NULL THEN 0
    WHEN TRUNC(normalized."number_75") BETWEEN 0 AND 2147483647 THEN TRUNC(normalized."number_75")::integer
    ELSE NULL
  END,
  "video_play_100_count" = CASE
    WHEN NOT normalized."has_100" OR NOT normalized."has_any_video_value" THEN NULL
    WHEN normalized."raw_100" IS NULL THEN 0
    WHEN TRUNC(normalized."number_100") BETWEEN 0 AND 2147483647 THEN TRUNC(normalized."number_100")::integer
    ELSE NULL
  END
FROM normalized
WHERE metric."id" = normalized."id";

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_video_play_3s_count_nonnegative_check"
    CHECK ("video_play_3s_count" IS NULL OR "video_play_3s_count" >= 0),
  ADD CONSTRAINT "meta_ad_daily_metrics_video_play_25_count_nonnegative_check"
    CHECK ("video_play_25_count" IS NULL OR "video_play_25_count" >= 0),
  ADD CONSTRAINT "meta_ad_daily_metrics_video_play_50_count_nonnegative_check"
    CHECK ("video_play_50_count" IS NULL OR "video_play_50_count" >= 0),
  ADD CONSTRAINT "meta_ad_daily_metrics_video_play_75_count_nonnegative_check"
    CHECK ("video_play_75_count" IS NULL OR "video_play_75_count" >= 0),
  ADD CONSTRAINT "meta_ad_daily_metrics_video_play_100_count_nonnegative_check"
    CHECK ("video_play_100_count" IS NULL OR "video_play_100_count" >= 0);

COMMIT;

-- Deployment audit queries (run before/after applying this migration as needed):
-- SELECT COUNT(*) FROM meta_ad_daily_metrics WHERE raw_row ?| ARRAY[
--   '동영상 3초 이상 재생', '동영상 25% 재생', '동영상 50% 재생',
--   '동영상 75% 재생', '동영상 100% 재생'
-- ];
-- For each header, inspect non-empty, invalid/negative, and out-of-Int-range
-- raw values before deployment. After migration, compare valid normalized raw
-- values to the five stored columns; invalid historical values intentionally
-- remain NULL so they cannot abort the additive migration.
