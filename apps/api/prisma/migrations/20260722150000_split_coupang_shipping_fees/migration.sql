-- Existing values came from the margin sheet's "하나로 배송비" column.
-- Rename the column so those values keep their actual meaning, then add a
-- separate nullable seller-shipping field. NULL means "not configured yet";
-- zero remains a valid explicit setting.
ALTER TABLE "coupang_cost_rules"
  RENAME COLUMN "seller_shipping_fee_krw" TO "hanaro_shipping_fee_krw";

ALTER TABLE "coupang_cost_rules"
  ALTER COLUMN "hanaro_shipping_fee_krw" DROP DEFAULT,
  ALTER COLUMN "hanaro_shipping_fee_krw" DROP NOT NULL;

ALTER TABLE "coupang_cost_rules"
  ADD COLUMN "seller_shipping_fee_krw" DECIMAL(14,2);
