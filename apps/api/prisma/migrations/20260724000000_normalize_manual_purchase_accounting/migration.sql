BEGIN;

LOCK TABLE "coupang_manual_purchases" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "coupang_manual_purchases"
    WHERE "quantity" < 0
       OR (
         "quantity" > 0
         AND ("base_sale_price_krw" IS NULL OR "base_sale_price_krw" <= 0)
       )
  ) THEN
    RAISE EXCEPTION 'Cannot normalize manual purchases: purchased rows require a positive base sale price snapshot and quantity cannot be negative.';
  END IF;
END $$;

UPDATE "coupang_manual_purchases"
SET
  "sales_amount_krw" = CASE
    WHEN "quantity" = 0 THEN 0
    ELSE ROUND("base_sale_price_krw" * "quantity", 2)
  END,
  "sale_price_krw" = "base_sale_price_krw",
  "promotion_price_krw" = NULL,
  "price_source" = CASE
    WHEN "base_sale_price_krw" > 0 THEN 'BASE'
    ELSE NULL
  END,
  "product_cost_krw" = 0,
  "coupang_sales_fee_krw" = 0,
  "sales_fee_rate_applied" = 0,
  "shipping_cost_krw" = 0,
  "vat_krw" = CASE
    WHEN "quantity" = 0 THEN 0
    ELSE ROUND("base_sale_price_krw" * "quantity" / 11, 2)
  END,
  "other_cost_krw" = 0,
  "total_cost_krw" = ROUND(
    "vendor_fee_total_krw" + CASE
      WHEN "quantity" = 0 THEN 0
      ELSE ROUND("base_sale_price_krw" * "quantity" / 11, 2)
    END,
    2
  );

COMMIT;
