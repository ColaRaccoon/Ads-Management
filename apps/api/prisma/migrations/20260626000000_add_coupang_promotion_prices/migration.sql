-- AlterEnum
ALTER TYPE "coupang_upload_source_type" ADD VALUE IF NOT EXISTS 'PROMOTION';

-- AlterTable
ALTER TABLE "coupang_upload_row_errors" ADD COLUMN "promotion_price_id" UUID;

-- CreateTable
CREATE TABLE "coupang_promotion_prices" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "source_row_hash" CHAR(64) NOT NULL,
    "source_promotion_id" TEXT,
    "option_id" TEXT,
    "product_text" TEXT NOT NULL,
    "raw_product_name" TEXT,
    "raw_option_name" TEXT,
    "original_sale_price_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "promotion_price_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "promotion_quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "promotion_status" TEXT,
    "shipping_type" TEXT,
    "exposure_area" TEXT,
    "sale_method" TEXT,
    "sales_amount_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "order_quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "promotion_start_date" DATE NOT NULL,
    "promotion_end_date" DATE NOT NULL,
    "requested_at" TIMESTAMP(3),
    "raw_start_at" TEXT,
    "raw_end_at" TEXT,
    "coupang_product_id" UUID,
    "coupang_product_rule_id" UUID,
    "match_source" "match_source" NOT NULL DEFAULT 'UNMATCHED',
    "validation_status" "row_validation_status" NOT NULL DEFAULT 'VALID',
    "validation_errors" JSONB NOT NULL DEFAULT '[]',
    "raw_row" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_promotion_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coupang_promotion_prices_upload_batch_id_row_number_key" ON "coupang_promotion_prices"("upload_batch_id", "row_number");
CREATE INDEX "coupang_promotion_prices_coupang_product_id_promotion_s_idx" ON "coupang_promotion_prices"("coupang_product_id", "promotion_start_date", "promotion_end_date");
CREATE INDEX "coupang_promotion_prices_coupang_product_rule_id_idx" ON "coupang_promotion_prices"("coupang_product_rule_id");
CREATE INDEX "coupang_promotion_prices_promotion_start_date_promotio_idx" ON "coupang_promotion_prices"("promotion_start_date", "promotion_end_date");
CREATE INDEX "coupang_promotion_prices_validation_status_idx" ON "coupang_promotion_prices"("validation_status");
CREATE INDEX "coupang_promotion_prices_option_id_idx" ON "coupang_promotion_prices"("option_id");
CREATE INDEX "coupang_upload_row_errors_promotion_price_id_idx" ON "coupang_upload_row_errors"("promotion_price_id");

-- AddForeignKey
ALTER TABLE "coupang_promotion_prices" ADD CONSTRAINT "coupang_promotion_prices_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "coupang_upload_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupang_promotion_prices" ADD CONSTRAINT "coupang_promotion_prices_coupang_product_id_fkey" FOREIGN KEY ("coupang_product_id") REFERENCES "coupang_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coupang_promotion_prices" ADD CONSTRAINT "coupang_promotion_prices_coupang_product_rule_id_fkey" FOREIGN KEY ("coupang_product_rule_id") REFERENCES "coupang_product_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coupang_upload_row_errors" ADD CONSTRAINT "coupang_upload_row_errors_promotion_price_id_fkey" FOREIGN KEY ("promotion_price_id") REFERENCES "coupang_promotion_prices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
