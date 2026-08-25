-- Security step 7 data minimization.
-- These four bounded statements intentionally exclude Meta upload/raw metric
-- tables whose source provenance remains part of the existing product contract.
-- Apply during a maintenance window when these tables are large: each UPDATE
-- can take row locks and generate WAL proportional to the rows still carrying
-- raw source data.

UPDATE "cafe24_order_lines"
SET "raw_row" = NULL
WHERE "raw_row" IS NOT NULL;

UPDATE "coupang_sale_lines"
SET "raw_row" = NULL
WHERE "raw_row" IS NOT NULL;

UPDATE "coupang_ad_metrics"
SET "raw_row" = NULL
WHERE "raw_row" IS NOT NULL;

UPDATE "coupang_promotion_prices"
SET "raw_row" = NULL
WHERE "raw_row" IS NOT NULL;
