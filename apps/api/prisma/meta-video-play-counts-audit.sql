-- Read-only deployment audit for the Meta video-play count migration.
-- Run section 1 before migration and section 2 after migration.

-- 1) Header coverage and values that cannot be safely backfilled.
WITH video_headers(header_name) AS (
  VALUES
    ('동영상 3초 이상 재생'),
    ('동영상 25% 재생'),
    ('동영상 50% 재생'),
    ('동영상 75% 재생'),
    ('동영상 100% 재생')
), source AS (
  SELECT
    metric.id,
    header.header_name,
    metric.raw_row ? header.header_name AS has_header,
    NULLIF(BTRIM(metric.raw_row ->> header.header_name), '') AS raw_value
  FROM meta_ad_daily_metrics AS metric
  CROSS JOIN video_headers AS header
), parsed AS (
  SELECT
    source.*,
    CASE
      WHEN raw_value ~ '^[+-]?[0-9][0-9,]*(\.[0-9]+)?$'
        AND LENGTH(REPLACE(raw_value, ',', '')) <= 32
        THEN REPLACE(raw_value, ',', '')::numeric
      ELSE NULL
    END AS numeric_value
  FROM source
)
SELECT
  header_name,
  COUNT(*) FILTER (WHERE has_header) AS rows_with_header,
  COUNT(*) FILTER (WHERE has_header AND raw_value IS NOT NULL) AS rows_with_nonempty_value,
  COUNT(*) FILTER (WHERE raw_value IS NOT NULL AND numeric_value IS NULL) AS invalid_value_count,
  COUNT(*) FILTER (WHERE numeric_value < 0) AS negative_value_count,
  COUNT(*) FILTER (WHERE numeric_value > 2147483647) AS out_of_integer_range_count
FROM parsed
GROUP BY header_name
ORDER BY header_name;

-- Overall rows carrying at least one video header key.
SELECT COUNT(*) AS rows_with_any_video_header
FROM meta_ad_daily_metrics
WHERE raw_row ?| ARRAY[
  '동영상 3초 이상 재생',
  '동영상 25% 재생',
  '동영상 50% 재생',
  '동영상 75% 재생',
  '동영상 100% 재생'
];

-- 2) Post-migration mismatch count. Invalid historical values are expected to
-- remain NULL and are included in the expected-value rules below.
WITH video_headers(header_name, column_name) AS (
  VALUES
    ('동영상 3초 이상 재생', 'video_play_3s_count'),
    ('동영상 25% 재생', 'video_play_25_count'),
    ('동영상 50% 재생', 'video_play_50_count'),
    ('동영상 75% 재생', 'video_play_75_count'),
    ('동영상 100% 재생', 'video_play_100_count')
), source AS (
  SELECT
    metric.*,
    header.header_name,
    header.column_name,
    metric.raw_row ? header.header_name AS has_header,
    NULLIF(BTRIM(metric.raw_row ->> header.header_name), '') AS raw_value,
    EXISTS (
      SELECT 1
      FROM jsonb_each_text(metric.raw_row) AS entry(key, value)
      WHERE entry.key IN (
        '동영상 3초 이상 재생',
        '동영상 25% 재생',
        '동영상 50% 재생',
        '동영상 75% 재생',
        '동영상 100% 재생'
      )
      AND BTRIM(entry.value) <> ''
    ) AS has_any_video_value
  FROM meta_ad_daily_metrics AS metric
  CROSS JOIN video_headers AS header
), normalized AS (
  SELECT
    source.*,
    CASE
      WHEN raw_value ~ '^[+]?[0-9][0-9,]*(\.[0-9]+)?$'
        AND LENGTH(REPLACE(raw_value, ',', '')) <= 32
        THEN REPLACE(raw_value, ',', '')::numeric
      ELSE NULL
    END AS numeric_value
  FROM source
), compared AS (
  SELECT
    header_name,
    CASE
      WHEN NOT has_header OR NOT has_any_video_value THEN NULL
      WHEN raw_value IS NULL THEN 0
      WHEN TRUNC(numeric_value) BETWEEN 0 AND 2147483647 THEN TRUNC(numeric_value)::integer
      ELSE NULL
    END AS expected_value,
    CASE column_name
      WHEN 'video_play_3s_count' THEN video_play_3s_count
      WHEN 'video_play_25_count' THEN video_play_25_count
      WHEN 'video_play_50_count' THEN video_play_50_count
      WHEN 'video_play_75_count' THEN video_play_75_count
      WHEN 'video_play_100_count' THEN video_play_100_count
    END AS actual_value
  FROM normalized
)
SELECT
  header_name,
  COUNT(*) FILTER (WHERE expected_value IS DISTINCT FROM actual_value) AS mismatch_count
FROM compared
GROUP BY header_name
ORDER BY header_name;
