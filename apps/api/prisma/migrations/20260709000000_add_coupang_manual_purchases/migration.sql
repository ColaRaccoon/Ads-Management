-- CreateTable
CREATE TABLE "coupang_manual_purchases" (
    "id" UUID NOT NULL,
    "purchase_date" DATE NOT NULL,
    "coupang_product_id" UUID NOT NULL,
    "coupang_product_rule_id" UUID,
    "product_display_name" TEXT NOT NULL,
    "rule_display_name" TEXT,
    "sale_method" TEXT,
    "quantity" INTEGER NOT NULL,
    "vendor_fee_per_unit_krw" DECIMAL(14,2) NOT NULL,
    "vendor_fee_total_krw" DECIMAL(14,2) NOT NULL,
    "sale_price_krw" DECIMAL(14,2),
    "base_sale_price_krw" DECIMAL(14,2),
    "promotion_price_krw" DECIMAL(14,2),
    "price_source" VARCHAR(32),
    "coupang_sales_fee_krw" DECIMAL(14,2) NOT NULL,
    "shipping_cost_krw" DECIMAL(14,2) NOT NULL,
    "total_cost_krw" DECIMAL(14,2) NOT NULL,
    "memo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupang_manual_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coupang_manual_purchases_purchase_date_coupang_product_id_key"
ON "coupang_manual_purchases"("purchase_date", "coupang_product_id");

-- CreateIndex
CREATE INDEX "coupang_manual_purchases_purchase_date_idx" ON "coupang_manual_purchases"("purchase_date");

-- CreateIndex
CREATE INDEX "coupang_manual_purchases_coupang_product_id_purchase_date_idx"
ON "coupang_manual_purchases"("coupang_product_id", "purchase_date");

-- CreateIndex
CREATE INDEX "coupang_manual_purchases_coupang_product_rule_id_idx"
ON "coupang_manual_purchases"("coupang_product_rule_id");

-- AddForeignKey
ALTER TABLE "coupang_manual_purchases" ADD CONSTRAINT "coupang_manual_purchases_coupang_product_id_fkey"
FOREIGN KEY ("coupang_product_id") REFERENCES "coupang_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_manual_purchases" ADD CONSTRAINT "coupang_manual_purchases_coupang_product_rule_id_fkey"
FOREIGN KEY ("coupang_product_rule_id") REFERENCES "coupang_product_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- InsertDefaultSetting
INSERT INTO "app_settings" ("key", "value_json", "description", "updated_at")
VALUES (
  'coupang_manual_purchase_vendor_fee_per_unit_krw',
  '3182'::jsonb,
  'Default vendor fee per Coupang manual purchase unit',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
