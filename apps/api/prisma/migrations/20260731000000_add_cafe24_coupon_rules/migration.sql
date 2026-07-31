CREATE TYPE "cafe24_coupon_scope" AS ENUM ('GLOBAL', 'PRODUCT');

ALTER TABLE "cafe24_order_lines"
  ADD COLUMN "total_order_krw" DECIMAL(14,2);

CREATE TABLE "cafe24_coupon_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "cafe24_coupon_scope" NOT NULL,
    "product_id" UUID,
    "discount_krw" DECIMAL(14,2) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cafe24_coupon_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cafe24_coupon_rules_discount_krw_check"
      CHECK ("discount_krw" > 0),
    CONSTRAINT "cafe24_coupon_rules_valid_range_check"
      CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
    CONSTRAINT "cafe24_coupon_rules_scope_product_check"
      CHECK (
        ("scope" = 'GLOBAL' AND "product_id" IS NULL)
        OR
        ("scope" = 'PRODUCT' AND "product_id" IS NOT NULL)
      )
);

CREATE INDEX "cafe24_coupon_rules_active_dates_idx"
  ON "cafe24_coupon_rules"("is_active", "valid_from", "valid_to");

CREATE INDEX "cafe24_coupon_rules_product_active_dates_idx"
  ON "cafe24_coupon_rules"("product_id", "is_active", "valid_from", "valid_to");

CREATE INDEX "cafe24_coupon_rules_discount_krw_idx"
  ON "cafe24_coupon_rules"("discount_krw");

ALTER TABLE "cafe24_coupon_rules"
  ADD CONSTRAINT "cafe24_coupon_rules_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
