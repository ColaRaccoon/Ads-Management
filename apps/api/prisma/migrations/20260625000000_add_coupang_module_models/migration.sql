-- CreateEnum
CREATE TYPE "coupang_upload_source_type" AS ENUM ('SALES', 'ADS', 'MARGIN', 'PRICE_TEXT', 'BUNDLE');

-- CreateTable
CREATE TABLE "coupang_products" (
    "id" UUID NOT NULL,
    "standard_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupang_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupang_product_rules" (
    "id" UUID NOT NULL,
    "coupang_product_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "include_keywords" JSONB NOT NULL DEFAULT '[]',
    "exclude_keywords" JSONB NOT NULL DEFAULT '[]',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "sale_method" TEXT,
    "ad_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" DATE,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupang_product_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupang_cost_rules" (
    "id" UUID NOT NULL,
    "coupang_product_id" UUID NOT NULL,
    "sale_price_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "supply_price_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "product_cost_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sales_fee_rate" DECIMAL(8,6) NOT NULL DEFAULT 0,
    "sales_fee_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "seller_shipping_fee_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "growth_inbound_fee_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "growth_shipping_fee_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "return_rate" DECIMAL(8,6) NOT NULL DEFAULT 0,
    "return_cost_per_unit_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "extra_cost_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "effective_from" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" DATE,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupang_cost_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupang_upload_batches" (
    "id" UUID NOT NULL,
    "source_type" "coupang_upload_source_type" NOT NULL,
    "original_filename" TEXT NOT NULL,
    "stored_file_path" TEXT,
    "file_hash_sha256" CHAR(64) NOT NULL,
    "data_start" DATE,
    "data_end" DATE,
    "column_schema" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "valid_row_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "conflict_policy" "conflict_policy" NOT NULL DEFAULT 'SKIP',
    "status" "upload_status" NOT NULL DEFAULT 'PENDING',
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validated_at" TIMESTAMP(3),
    "imported_at" TIMESTAMP(3),

    CONSTRAINT "coupang_upload_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupang_sale_lines" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "source_row_hash" CHAR(64) NOT NULL,
    "sale_line_key" TEXT NOT NULL,
    "sale_date" DATE,
    "option_id" TEXT,
    "option_name" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "registered_product_id" TEXT,
    "category" TEXT,
    "sale_method" TEXT,
    "sales_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "order_count" INTEGER NOT NULL DEFAULT 0,
    "sales_quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "total_sales_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_sales_quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "cancel_amount_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cancel_quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "instant_cancel_quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "net_sales_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "coupang_product_id" UUID,
    "coupang_product_rule_id" UUID,
    "match_source" "match_source" NOT NULL DEFAULT 'UNMATCHED',
    "validation_status" "row_validation_status" NOT NULL DEFAULT 'VALID',
    "validation_errors" JSONB NOT NULL DEFAULT '[]',
    "import_version" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "raw_row" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupang_ad_metrics" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "source_row_hash" CHAR(64) NOT NULL,
    "ad_metric_key" TEXT NOT NULL,
    "metric_date" DATE NOT NULL,
    "campaign_name" TEXT,
    "ad_group_name" TEXT,
    "ad_execution_option_id" TEXT,
    "ad_execution_product_name" TEXT NOT NULL,
    "conversion_option_id" TEXT,
    "conversion_product_name" TEXT NOT NULL,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "ad_spend_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_orders_1d" INTEGER NOT NULL DEFAULT 0,
    "direct_orders_1d" INTEGER NOT NULL DEFAULT 0,
    "indirect_orders_1d" INTEGER NOT NULL DEFAULT 0,
    "total_conversion_sales_1d_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "direct_conversion_sales_1d_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "indirect_conversion_sales_1d_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_sales_quantity_1d" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "direct_sales_quantity_1d" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "indirect_sales_quantity_1d" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "spend_product_id" UUID,
    "spend_product_rule_id" UUID,
    "conversion_product_id" UUID,
    "conversion_product_rule_id" UUID,
    "spend_match_source" "match_source" NOT NULL DEFAULT 'UNMATCHED',
    "conversion_match_source" "match_source" NOT NULL DEFAULT 'UNMATCHED',
    "validation_status" "row_validation_status" NOT NULL DEFAULT 'VALID',
    "validation_errors" JSONB NOT NULL DEFAULT '[]',
    "import_version" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "raw_row" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_ad_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupang_upload_row_errors" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "sale_line_id" UUID,
    "ad_metric_id" UUID,
    "row_number" INTEGER,
    "source_type" "coupang_upload_source_type" NOT NULL,
    "column_name" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "error_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "raw_value" TEXT,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_upload_row_errors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coupang_products_standard_name_key" ON "coupang_products"("standard_name");
CREATE INDEX "coupang_products_is_active_sort_order_idx" ON "coupang_products"("is_active", "sort_order");
CREATE INDEX "coupang_product_rules_is_active_priority_idx" ON "coupang_product_rules"("is_active", "priority");
CREATE INDEX "coupang_product_rules_coupang_product_id_idx" ON "coupang_product_rules"("coupang_product_id");
CREATE INDEX "coupang_cost_rules_coupang_product_id_effective_from_effect_idx" ON "coupang_cost_rules"("coupang_product_id", "effective_from", "effective_to");
CREATE UNIQUE INDEX "coupang_upload_batches_file_hash_sha256_key" ON "coupang_upload_batches"("file_hash_sha256");
CREATE INDEX "coupang_upload_batches_source_type_data_start_data_end_idx" ON "coupang_upload_batches"("source_type", "data_start", "data_end");
CREATE INDEX "coupang_sale_lines_sale_date_idx" ON "coupang_sale_lines"("sale_date");
CREATE INDEX "coupang_sale_lines_coupang_product_id_sale_date_idx" ON "coupang_sale_lines"("coupang_product_id", "sale_date");
CREATE INDEX "coupang_sale_lines_coupang_product_rule_id_idx" ON "coupang_sale_lines"("coupang_product_rule_id");
CREATE INDEX "coupang_sale_lines_sale_line_key_is_current_idx" ON "coupang_sale_lines"("sale_line_key", "is_current");
CREATE INDEX "coupang_sale_lines_is_current_sale_date_idx" ON "coupang_sale_lines"("is_current", "sale_date");
CREATE UNIQUE INDEX "coupang_sale_lines_upload_batch_id_row_number_key" ON "coupang_sale_lines"("upload_batch_id", "row_number");
CREATE INDEX "coupang_ad_metrics_metric_date_idx" ON "coupang_ad_metrics"("metric_date");
CREATE INDEX "coupang_ad_metrics_spend_product_id_metric_date_idx" ON "coupang_ad_metrics"("spend_product_id", "metric_date");
CREATE INDEX "coupang_ad_metrics_conversion_product_id_metric_date_idx" ON "coupang_ad_metrics"("conversion_product_id", "metric_date");
CREATE INDEX "coupang_ad_metrics_ad_metric_key_is_current_idx" ON "coupang_ad_metrics"("ad_metric_key", "is_current");
CREATE INDEX "coupang_ad_metrics_is_current_metric_date_idx" ON "coupang_ad_metrics"("is_current", "metric_date");
CREATE UNIQUE INDEX "coupang_ad_metrics_upload_batch_id_row_number_key" ON "coupang_ad_metrics"("upload_batch_id", "row_number");
CREATE INDEX "coupang_upload_row_errors_upload_batch_id_severity_idx" ON "coupang_upload_row_errors"("upload_batch_id", "severity");
CREATE INDEX "coupang_upload_row_errors_sale_line_id_idx" ON "coupang_upload_row_errors"("sale_line_id");
CREATE INDEX "coupang_upload_row_errors_ad_metric_id_idx" ON "coupang_upload_row_errors"("ad_metric_id");

-- AddForeignKey
ALTER TABLE "coupang_product_rules" ADD CONSTRAINT "coupang_product_rules_coupang_product_id_fkey" FOREIGN KEY ("coupang_product_id") REFERENCES "coupang_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupang_cost_rules" ADD CONSTRAINT "coupang_cost_rules_coupang_product_id_fkey" FOREIGN KEY ("coupang_product_id") REFERENCES "coupang_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupang_sale_lines" ADD CONSTRAINT "coupang_sale_lines_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "coupang_upload_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupang_sale_lines" ADD CONSTRAINT "coupang_sale_lines_coupang_product_id_fkey" FOREIGN KEY ("coupang_product_id") REFERENCES "coupang_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coupang_sale_lines" ADD CONSTRAINT "coupang_sale_lines_coupang_product_rule_id_fkey" FOREIGN KEY ("coupang_product_rule_id") REFERENCES "coupang_product_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coupang_ad_metrics" ADD CONSTRAINT "coupang_ad_metrics_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "coupang_upload_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupang_ad_metrics" ADD CONSTRAINT "coupang_ad_metrics_spend_product_id_fkey" FOREIGN KEY ("spend_product_id") REFERENCES "coupang_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coupang_ad_metrics" ADD CONSTRAINT "coupang_ad_metrics_spend_product_rule_id_fkey" FOREIGN KEY ("spend_product_rule_id") REFERENCES "coupang_product_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coupang_ad_metrics" ADD CONSTRAINT "coupang_ad_metrics_conversion_product_id_fkey" FOREIGN KEY ("conversion_product_id") REFERENCES "coupang_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coupang_ad_metrics" ADD CONSTRAINT "coupang_ad_metrics_conversion_product_rule_id_fkey" FOREIGN KEY ("conversion_product_rule_id") REFERENCES "coupang_product_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coupang_upload_row_errors" ADD CONSTRAINT "coupang_upload_row_errors_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "coupang_upload_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupang_upload_row_errors" ADD CONSTRAINT "coupang_upload_row_errors_sale_line_id_fkey" FOREIGN KEY ("sale_line_id") REFERENCES "coupang_sale_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupang_upload_row_errors" ADD CONSTRAINT "coupang_upload_row_errors_ad_metric_id_fkey" FOREIGN KEY ("ad_metric_id") REFERENCES "coupang_ad_metrics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
