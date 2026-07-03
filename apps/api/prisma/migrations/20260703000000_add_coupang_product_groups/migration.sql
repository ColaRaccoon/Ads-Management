-- CreateTable
CREATE TABLE "coupang_product_groups" (
    "id" UUID NOT NULL,
    "standard_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupang_product_groups_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "coupang_products" ADD COLUMN "group_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "coupang_product_groups_standard_name_key" ON "coupang_product_groups"("standard_name");

-- CreateIndex
CREATE INDEX "coupang_product_groups_is_active_sort_order_idx" ON "coupang_product_groups"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "coupang_products_group_id_idx" ON "coupang_products"("group_id");

-- AddForeignKey
ALTER TABLE "coupang_products" ADD CONSTRAINT "coupang_products_group_id_fkey"
FOREIGN KEY ("group_id") REFERENCES "coupang_product_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
