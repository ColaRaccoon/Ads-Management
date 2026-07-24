-- Run the PRE-MIGRATION section and retain its output before applying
-- 20260724010000_remove_coupang_manual_purchase_vat.

-- PRE-MIGRATION
SELECT
  COUNT(*) AS total_rows,
  SUM("quantity") AS total_quantity,
  SUM("sales_amount_krw") AS total_manual_sales_krw,
  SUM("vendor_fee_total_krw") AS total_vendor_fee_krw,
  SUM("vat_krw") AS legacy_manual_vat_krw,
  SUM("total_cost_krw") AS legacy_total_cost_krw,
  SUM("total_cost_krw" - "vendor_fee_total_krw")
    AS predicted_profit_increase_krw,
  COUNT(*) FILTER (
    WHERE "total_cost_krw"
      IS DISTINCT FROM ROUND("vendor_fee_total_krw" + "vat_krw", 2)
  ) AS legacy_total_mismatch_rows
FROM "coupang_manual_purchases";

-- Run the POST-MIGRATION statements separately after the migration.

-- POST-MIGRATION
SELECT
  COUNT(*) AS total_rows,
  SUM("quantity") AS total_quantity,
  SUM("sales_amount_krw") AS total_manual_sales_krw,
  SUM("vendor_fee_total_krw") AS total_vendor_fee_krw,
  SUM("total_cost_krw") AS total_cost_krw,
  COUNT(*) FILTER (
    WHERE "total_cost_krw"
      IS DISTINCT FROM ROUND("vendor_fee_total_krw", 2)
  ) AS total_cost_mismatch_rows
FROM "coupang_manual_purchases";

SELECT COUNT(*) AS vat_column_count
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'coupang_manual_purchases'
  AND column_name = 'vat_krw';

-- Expected after migration:
-- total_cost_mismatch_rows = 0
-- vat_column_count = 0
