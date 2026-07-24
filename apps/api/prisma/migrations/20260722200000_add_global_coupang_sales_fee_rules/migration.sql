BEGIN;

LOCK TABLE "coupang_manual_purchases" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE "coupang_sales_fee_rules" (
  "id" UUID NOT NULL,
  "sales_fee_rate" DECIMAL(8,6) NOT NULL,
  "effective_from" DATE NOT NULL,
  "effective_to" DATE,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "coupang_sales_fee_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "coupang_sales_fee_rules_sales_fee_rate_check"
    CHECK ("sales_fee_rate" >= 0 AND "sales_fee_rate" <= 1),
  CONSTRAINT "coupang_sales_fee_rules_effective_range_check"
    CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);

CREATE INDEX "coupang_sales_fee_rules_effective_from_effective_to_idx"
  ON "coupang_sales_fee_rules"("effective_from", "effective_to");

CREATE UNIQUE INDEX "coupang_sales_fee_rules_effective_from_key"
  ON "coupang_sales_fee_rules"("effective_from");

-- The product owner selected one historical global value: 11.88%.
-- Start at the earliest date that can participate in a Coupang calculation.
INSERT INTO "coupang_sales_fee_rules" (
  "id", "sales_fee_rate", "effective_from", "effective_to", "note", "updated_at"
)
SELECT
  gen_random_uuid(),
  0.1188,
  COALESCE(
    LEAST(
      COALESCE((SELECT MIN("sale_date") FROM "coupang_sale_lines"), CURRENT_DATE),
      COALESCE((SELECT MIN("metric_date") FROM "coupang_ad_metrics"), CURRENT_DATE),
      COALESCE((SELECT MIN("purchase_date") FROM "coupang_manual_purchases"), CURRENT_DATE),
      COALESCE((SELECT MIN("effective_from") FROM "coupang_cost_rules"), CURRENT_DATE)
    ),
    CURRENT_DATE
  ),
  NULL,
  'Initial global Coupang sales fee rate (11.88%)',
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "coupang_sales_fee_rules");

ALTER TABLE "coupang_manual_purchases"
  ADD COLUMN "sales_fee_rate_applied" DECIMAL(8,6) NOT NULL DEFAULT 0.1188;

ALTER TABLE "coupang_manual_purchases"
  ADD CONSTRAINT "coupang_manual_purchases_sales_fee_rate_applied_check"
  CHECK ("sales_fee_rate_applied" >= 0 AND "sales_fee_rate_applied" <= 1);

-- Recalculate immutable manual-purchase snapshots from their stored sales
-- amount. The total is rebuilt from components so its invariant stays exact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "coupang_manual_purchases"
    WHERE COALESCE("sales_amount_krw", "sale_price_krw" * "quantity") IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot backfill Coupang sales fees: a manual purchase has no sales amount or sale price snapshot.';
  END IF;
END $$;

WITH resolved_purchase_rates AS (
  SELECT
    purchase."id",
    rule."sales_fee_rate",
    COALESCE(purchase."sales_amount_krw", purchase."sale_price_krw" * purchase."quantity") AS "resolved_sales_amount_krw"
  FROM "coupang_manual_purchases" AS purchase
  JOIN LATERAL (
    SELECT "sales_fee_rate"
    FROM "coupang_sales_fee_rules"
    WHERE "effective_from" <= purchase."purchase_date"
      AND ("effective_to" IS NULL OR "effective_to" >= purchase."purchase_date")
    ORDER BY "effective_from" DESC, "created_at" DESC
    LIMIT 1
  ) AS rule ON TRUE
)
UPDATE "coupang_manual_purchases" AS purchase
SET
  "sales_fee_rate_applied" = resolved."sales_fee_rate",
  "coupang_sales_fee_krw" = ROUND(
    resolved."resolved_sales_amount_krw" * resolved."sales_fee_rate",
    2
  ),
  "total_cost_krw" = ROUND(
    purchase."product_cost_krw"
      + purchase."vendor_fee_total_krw"
      + resolved."resolved_sales_amount_krw" * resolved."sales_fee_rate"
      + purchase."shipping_cost_krw"
      + purchase."vat_krw"
      + purchase."other_cost_krw",
    2
  )
FROM resolved_purchase_rates AS resolved
WHERE resolved."id" = purchase."id";

ALTER TABLE "coupang_manual_purchases"
  ALTER COLUMN "sales_fee_rate_applied" DROP DEFAULT;

COMMIT;
