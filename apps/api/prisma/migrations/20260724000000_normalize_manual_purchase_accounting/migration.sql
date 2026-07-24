BEGIN;

LOCK TABLE "coupang_manual_purchases" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "coupang_manual_purchases"
    WHERE "base_sale_price_krw" IS NULL
       OR "base_sale_price_krw" <= 0
       OR "quantity" < 1
  ) THEN
    RAISE EXCEPTION 'Cannot normalize manual purchases: every row requires a positive base sale price snapshot and quantity.';
  END IF;
END $$;

UPDATE "coupang_manual_purchases"
SET
  "sales_amount_krw" = ROUND("base_sale_price_krw" * "quantity", 2),
  "sale_price_krw" = "base_sale_price_krw",
  "promotion_price_krw" = NULL,
  "price_source" = 'BASE',
  "product_cost_krw" = 0,
  "coupang_sales_fee_krw" = 0,
  "sales_fee_rate_applied" = 0,
  "shipping_cost_krw" = 0,
  "vat_krw" = ROUND("base_sale_price_krw" * "quantity" / 11, 2),
  "other_cost_krw" = 0,
  "total_cost_krw" = ROUND(
    "vendor_fee_total_krw" + ROUND("base_sale_price_krw" * "quantity" / 11, 2),
    2
  );

COMMIT;
