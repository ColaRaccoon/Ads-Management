CREATE TABLE "coupang_daily_report_categories" (
    "id" UUID NOT NULL,
    "standard_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupang_daily_report_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "coupang_daily_report_category_products" (
    "category_id" UUID NOT NULL,
    "coupang_product_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_daily_report_category_products_pkey" PRIMARY KEY ("category_id","coupang_product_id")
);

CREATE UNIQUE INDEX "coupang_daily_report_categories_standard_name_key"
ON "coupang_daily_report_categories"("standard_name");

CREATE INDEX "coupang_daily_report_categories_is_active_sort_order_idx"
ON "coupang_daily_report_categories"("is_active", "sort_order");

CREATE INDEX "coupang_daily_report_category_products_coupang_product_id_idx"
ON "coupang_daily_report_category_products"("coupang_product_id");

ALTER TABLE "coupang_daily_report_category_products"
ADD CONSTRAINT "coupang_daily_report_category_products_category_id_fkey"
FOREIGN KEY ("category_id") REFERENCES "coupang_daily_report_categories"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "coupang_daily_report_category_products"
ADD CONSTRAINT "coupang_daily_report_category_products_coupang_product_id_fkey"
FOREIGN KEY ("coupang_product_id") REFERENCES "coupang_products"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
