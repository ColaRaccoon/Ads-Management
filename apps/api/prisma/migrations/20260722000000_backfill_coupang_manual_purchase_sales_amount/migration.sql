-- Backfill only legacy rows whose sales snapshot is still absent. The stored
-- unit-price snapshots are immutable audit facts; current product rules and
-- current promotions must not be used to reconstruct historical purchases.
UPDATE "coupang_manual_purchases"
SET "sales_amount_krw" = COALESCE(
  "sale_price_krw",
  "promotion_price_krw",
  "base_sale_price_krw"
) * "quantity"
WHERE "sales_amount_krw" IS NULL
  AND COALESCE("sale_price_krw", "promotion_price_krw", "base_sale_price_krw") IS NOT NULL;

-- Rows with no usable stored price intentionally remain NULL. The API marks
-- only their manual-purchase calculation area incomplete instead of inventing
-- a zero amount or recalculating the past from today's rules.
