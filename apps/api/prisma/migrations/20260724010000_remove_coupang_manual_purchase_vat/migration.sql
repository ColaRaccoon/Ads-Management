BEGIN;

LOCK TABLE "coupang_manual_purchases" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "coupang_manual_purchases"
    WHERE "vendor_fee_total_krw" IS NULL
       OR "vendor_fee_total_krw" < 0
       OR ROUND("vendor_fee_total_krw", 2) > 999999999999.99
  ) THEN
    RAISE EXCEPTION
      'Cannot remove manual-purchase VAT: invalid vendor fee snapshot exists.';
  END IF;
END $$;

UPDATE "coupang_manual_purchases"
SET "total_cost_krw" = ROUND("vendor_fee_total_krw", 2);

ALTER TABLE "coupang_manual_purchases"
DROP COLUMN "vat_krw";

COMMIT;
