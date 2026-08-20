-- Store the Meta "add to cart" source count. The displayed conversion rate is
-- derived as add-to-cart count / reach, after aggregating rows by creative/day.
BEGIN;

ALTER TABLE "meta_ad_daily_metrics"
  ADD COLUMN "add_to_cart_count" INTEGER;

-- Preserve the distinction between an old CSV without this column (NULL) and a
-- new CSV with an empty cell (0). Invalid historical values remain NULL.
WITH source AS (
  SELECT
    "id",
    "raw_row" ? '장바구니에 담기' AS "has_add_to_cart_column",
    NULLIF(BTRIM("raw_row" ->> '장바구니에 담기'), '') AS "raw_add_to_cart"
  FROM "meta_ad_daily_metrics"
), normalized AS (
  SELECT
    source.*,
    CASE
      WHEN "raw_add_to_cart" ~ '^[+]?[0-9][0-9,]*(\.[0-9]+)?$'
        AND LENGTH(REPLACE("raw_add_to_cart", ',', '')) <= 32
      THEN REPLACE("raw_add_to_cart", ',', '')::numeric
    END AS "number_add_to_cart"
  FROM source
)
UPDATE "meta_ad_daily_metrics" AS metric
SET "add_to_cart_count" = CASE
  WHEN NOT normalized."has_add_to_cart_column" THEN NULL
  WHEN normalized."raw_add_to_cart" IS NULL THEN 0
  WHEN TRUNC(normalized."number_add_to_cart") BETWEEN 0 AND 2147483647
    THEN TRUNC(normalized."number_add_to_cart")::integer
  ELSE NULL
END
FROM normalized
WHERE metric."id" = normalized."id";

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_add_to_cart_count_nonnegative_check"
    CHECK ("add_to_cart_count" IS NULL OR "add_to_cart_count" >= 0);

COMMIT;
