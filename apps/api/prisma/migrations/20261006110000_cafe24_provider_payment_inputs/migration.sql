-- Keep Cafe24 provider inputs separate from the legacy CSV calculation inputs.
-- A missing payment code or nested amount is unknown, never an implicit zero.
ALTER TABLE "cafe24_order_lines"
  ADD COLUMN "total_paid_input_source" VARCHAR(64),
  ADD COLUMN "provider_payment_codes" JSONB,
  ADD COLUMN "provider_coupon_signal" BOOLEAN,
  ADD COLUMN "actual_order_price_krw" DECIMAL(18,2),
  ADD COLUMN "actual_payment_krw" DECIMAL(18,2),
  ADD COLUMN "actual_shipping_fee_krw" DECIMAL(18,2),
  ADD COLUMN "initial_order_price_krw" DECIMAL(18,2),
  ADD COLUMN "initial_payment_krw" DECIMAL(18,2),
  ADD COLUMN "initial_shipping_fee_krw" DECIMAL(18,2);

ALTER TABLE "cafe24_order_api_versions"
  ALTER COLUMN "payment_method" DROP NOT NULL,
  ALTER COLUMN "payment_method" DROP DEFAULT,
  ADD COLUMN "total_paid_input_source" VARCHAR(64),
  ADD COLUMN "provider_payment_codes" JSONB,
  ADD COLUMN "provider_coupon_signal" BOOLEAN,
  ADD COLUMN "actual_order_price_krw" DECIMAL(18,2),
  ADD COLUMN "actual_payment_krw" DECIMAL(18,2),
  ADD COLUMN "actual_shipping_fee_krw" DECIMAL(18,2),
  ADD COLUMN "initial_order_price_krw" DECIMAL(18,2),
  ADD COLUMN "initial_payment_krw" DECIMAL(18,2),
  ADD COLUMN "initial_shipping_fee_krw" DECIMAL(18,2);

ALTER TABLE "source_policies"
  ADD COLUMN "coupon_input_source" VARCHAR(64);
