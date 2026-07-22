ALTER TABLE "coupang_manual_purchases"
ADD COLUMN "sales_amount_krw" DECIMAL(14,2),
ADD COLUMN "other_cost_krw" DECIMAL(14,2) NOT NULL DEFAULT 0;
