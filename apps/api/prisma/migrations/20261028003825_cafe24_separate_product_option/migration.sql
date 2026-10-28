-- Keep legacy display/identity fields intact; raw option values come only from
-- provider fields or a dedicated CSV column, never by splitting display text.
ALTER TABLE "cafe24_order_lines" ADD COLUMN "option_value" VARCHAR(256);
ALTER TABLE "cafe24_order_api_versions" ADD COLUMN "option_value" VARCHAR(256);
ALTER TABLE "cafe24_product_rules"
  ADD COLUMN "match_target" VARCHAR(32) NOT NULL DEFAULT 'LEGACY_COMBINED',
  ADD COLUMN "product_name_include_keywords" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "product_name_exclude_keywords" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "cafe24_product_rules" ADD CONSTRAINT "cafe24_rule_match_target_check"
  CHECK ("match_target" IN ('LEGACY_COMBINED', 'SEPARATE'));
