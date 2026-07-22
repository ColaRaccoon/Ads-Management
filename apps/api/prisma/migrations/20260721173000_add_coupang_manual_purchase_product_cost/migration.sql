-- Deployment contract:
--   1. Run this migration before deploying the application that writes product_cost_krw.
--   2. Deploy the new application immediately after migration success.
-- The already-applied 20260721000000 migration is intentionally left immutable;
-- Prisma's migration history/checksum is its exactly-once guard. Do not edit or
-- manually replay that earlier migration.
-- The final column intentionally has no DEFAULT. Once this migration commits,
-- an old application INSERT that omits product_cost_krw fails closed instead of
-- silently storing zero. Reads remain compatible during the deployment window.
--
-- Prisma records a successful migration and does not execute it again. A failed
-- run rolls back atomically. ADD COLUMN IF NOT EXISTS plus the NULL predicate also
-- make an operator-initiated SQL replay safe: already-backfilled totals are not
-- incremented a second time.
BEGIN;

LOCK TABLE "coupang_cost_rules" IN SHARE MODE;
LOCK TABLE "coupang_manual_purchases" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "coupang_manual_purchases"
ADD COLUMN IF NOT EXISTS "product_cost_krw" DECIMAL(14,2);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "coupang_manual_purchases" AS manual_purchase
    WHERE manual_purchase."product_cost_krw" IS NULL
      AND NOT EXISTS (
      SELECT 1
      FROM "coupang_cost_rules" AS rule
      WHERE rule."coupang_product_id" = manual_purchase."coupang_product_id"
        AND rule."effective_from" <= manual_purchase."purchase_date"
        AND (rule."effective_to" IS NULL OR rule."effective_to" >= manual_purchase."purchase_date")
    )
  ) THEN
    RAISE EXCEPTION 'Cannot backfill manual-purchase product cost: a dated cost rule is missing.';
  END IF;
END $$;

WITH selected_product_cost AS (
  SELECT
    manual_purchase."id",
    ROUND(COALESCE(cost_rule."product_cost_krw", 0) * manual_purchase."quantity", 2) AS "product_cost_krw"
  FROM "coupang_manual_purchases" AS manual_purchase
  LEFT JOIN LATERAL (
    SELECT rule."product_cost_krw"
    FROM "coupang_cost_rules" AS rule
    WHERE rule."coupang_product_id" = manual_purchase."coupang_product_id"
      AND rule."effective_from" <= manual_purchase."purchase_date"
      AND (rule."effective_to" IS NULL OR rule."effective_to" >= manual_purchase."purchase_date")
    ORDER BY
      CASE WHEN
        rule."supply_price_krw" <> 0 OR
        rule."product_cost_krw" <> 0 OR
        rule."sales_fee_rate" <> 0 OR
        rule."sales_fee_krw" <> 0 OR
        rule."seller_shipping_fee_krw" <> 0 OR
        rule."growth_inbound_fee_krw" <> 0 OR
        rule."growth_shipping_fee_krw" <> 0 OR
        rule."return_rate" <> 0 OR
        rule."return_cost_per_unit_krw" <> 0 OR
        rule."extra_cost_krw" <> 0
      THEN 1 ELSE 0 END DESC,
      rule."effective_from" DESC,
      rule."created_at" DESC,
      rule."id" DESC
    LIMIT 1
  ) AS cost_rule ON TRUE
)
UPDATE "coupang_manual_purchases" AS manual_purchase
SET
  "product_cost_krw" = selected_product_cost."product_cost_krw",
  "total_cost_krw" = manual_purchase."total_cost_krw" + selected_product_cost."product_cost_krw"
FROM selected_product_cost
WHERE manual_purchase."id" = selected_product_cost."id"
  AND manual_purchase."product_cost_krw" IS NULL;

ALTER TABLE "coupang_manual_purchases"
ALTER COLUMN "product_cost_krw" DROP DEFAULT,
ALTER COLUMN "product_cost_krw" SET NOT NULL;

COMMIT;
