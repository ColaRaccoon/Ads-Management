CREATE TABLE "product_change_logs" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "action_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "log_text" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_change_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_change_logs_product_id_action_date_idx"
  ON "product_change_logs"("product_id", "action_date");

CREATE INDEX "product_change_logs_action_date_idx"
  ON "product_change_logs"("action_date");

ALTER TABLE "product_change_logs"
  ADD CONSTRAINT "product_change_logs_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
