ALTER TABLE "coupang_manual_purchases"
ADD COLUMN "vat_krw" DECIMAL(14,2) NOT NULL DEFAULT 0;

UPDATE "coupang_manual_purchases"
SET "vat_krw" = COALESCE("sale_price_krw", 0) * "quantity" / 11,
    "total_cost_krw" = "vendor_fee_total_krw"
      + "coupang_sales_fee_krw"
      + "shipping_cost_krw"
      + (COALESCE("sale_price_krw", 0) * "quantity" / 11);
