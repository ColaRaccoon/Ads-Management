CREATE TABLE "cafe24_upload_batches" (
    "id" UUID NOT NULL,
    "original_filename" TEXT NOT NULL,
    "stored_file_path" TEXT,
    "file_hash_sha256" CHAR(64) NOT NULL,
    "order_start" DATE,
    "order_end" DATE,
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

    CONSTRAINT "cafe24_upload_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cafe24_product_rules" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "product_numbers" JSONB NOT NULL DEFAULT '[]',
    "product_name_aliases" JSONB NOT NULL DEFAULT '[]',
    "option_include_keywords" JSONB NOT NULL DEFAULT '[]',
    "option_exclude_keywords" JSONB NOT NULL DEFAULT '[]',
    "ad_cost_source_product_id" UUID,
    "roas_group" TEXT,
    "sale_price_krw_override" DECIMAL(14,2),
    "product_cost_krw_override" DECIMAL(14,2),
    "shipping_krw_override" DECIMAL(14,2),
    "extra_cost_krw_override" DECIMAL(14,2),
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" DATE,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cafe24_product_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cafe24_order_lines" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "source_row_hash" CHAR(64) NOT NULL,
    "order_line_key" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "line_order_no" TEXT NOT NULL,
    "product_no" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "option_name" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "sale_price_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_paid_krw" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "payment_method" TEXT,
    "ordered_at" TIMESTAMP(3),
    "order_date" DATE,
    "product_id" UUID,
    "cafe24_product_rule_id" UUID,
    "match_source" "match_source" NOT NULL DEFAULT 'UNMATCHED',
    "validation_status" "row_validation_status" NOT NULL DEFAULT 'VALID',
    "validation_errors" JSONB NOT NULL DEFAULT '[]',
    "import_version" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "superseded_by_order_line_id" UUID,
    "raw_row" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cafe24_order_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cafe24_upload_row_errors" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "order_line_id" UUID,
    "row_number" INTEGER,
    "column_name" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "error_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "raw_value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cafe24_upload_row_errors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cafe24_upload_batches_file_hash_sha256_key"
  ON "cafe24_upload_batches"("file_hash_sha256");

CREATE INDEX "cafe24_upload_batches_order_start_order_end_idx"
  ON "cafe24_upload_batches"("order_start", "order_end");

CREATE INDEX "cafe24_product_rules_is_active_priority_idx"
  ON "cafe24_product_rules"("is_active", "priority");

CREATE INDEX "cafe24_product_rules_product_id_idx"
  ON "cafe24_product_rules"("product_id");

CREATE INDEX "cafe24_product_rules_ad_cost_source_product_id_idx"
  ON "cafe24_product_rules"("ad_cost_source_product_id");

CREATE UNIQUE INDEX "cafe24_order_lines_upload_batch_id_row_number_key"
  ON "cafe24_order_lines"("upload_batch_id", "row_number");

CREATE INDEX "cafe24_order_lines_order_date_idx"
  ON "cafe24_order_lines"("order_date");

CREATE INDEX "cafe24_order_lines_product_id_order_date_idx"
  ON "cafe24_order_lines"("product_id", "order_date");

CREATE INDEX "cafe24_order_lines_product_no_idx"
  ON "cafe24_order_lines"("product_no");

CREATE INDEX "cafe24_order_lines_cafe24_product_rule_id_idx"
  ON "cafe24_order_lines"("cafe24_product_rule_id");

CREATE INDEX "cafe24_order_lines_order_line_key_idx"
  ON "cafe24_order_lines"("order_line_key");

CREATE INDEX "cafe24_order_lines_order_line_key_is_current_idx"
  ON "cafe24_order_lines"("order_line_key", "is_current");

CREATE INDEX "cafe24_order_lines_is_current_order_date_idx"
  ON "cafe24_order_lines"("is_current", "order_date");

CREATE INDEX "cafe24_order_lines_superseded_by_order_line_id_idx"
  ON "cafe24_order_lines"("superseded_by_order_line_id");

CREATE UNIQUE INDEX "cafe24_order_lines_current_order_line_key_key"
  ON "cafe24_order_lines"("order_line_key")
  WHERE "is_current" = true;

CREATE INDEX "cafe24_upload_row_errors_upload_batch_id_severity_idx"
  ON "cafe24_upload_row_errors"("upload_batch_id", "severity");

CREATE INDEX "cafe24_upload_row_errors_order_line_id_idx"
  ON "cafe24_upload_row_errors"("order_line_id");

ALTER TABLE "cafe24_product_rules"
  ADD CONSTRAINT "cafe24_product_rules_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cafe24_product_rules"
  ADD CONSTRAINT "cafe24_product_rules_ad_cost_source_product_id_fkey"
  FOREIGN KEY ("ad_cost_source_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cafe24_order_lines"
  ADD CONSTRAINT "cafe24_order_lines_upload_batch_id_fkey"
  FOREIGN KEY ("upload_batch_id") REFERENCES "cafe24_upload_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cafe24_order_lines"
  ADD CONSTRAINT "cafe24_order_lines_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cafe24_order_lines"
  ADD CONSTRAINT "cafe24_order_lines_cafe24_product_rule_id_fkey"
  FOREIGN KEY ("cafe24_product_rule_id") REFERENCES "cafe24_product_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cafe24_order_lines"
  ADD CONSTRAINT "cafe24_order_lines_superseded_by_order_line_id_fkey"
  FOREIGN KEY ("superseded_by_order_line_id") REFERENCES "cafe24_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cafe24_upload_row_errors"
  ADD CONSTRAINT "cafe24_upload_row_errors_upload_batch_id_fkey"
  FOREIGN KEY ("upload_batch_id") REFERENCES "cafe24_upload_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cafe24_upload_row_errors"
  ADD CONSTRAINT "cafe24_upload_row_errors_order_line_id_fkey"
  FOREIGN KEY ("order_line_id") REFERENCES "cafe24_order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
