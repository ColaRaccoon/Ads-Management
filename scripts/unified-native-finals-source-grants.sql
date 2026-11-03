-- Prepared only; not executed. Additive delta from scripts/unified-stage11-reconcile-roles.sql.
-- Required by buildCoupangNativeProductProfitRows' explicit SELECT/WHERE/ORDER BY fields.
-- Existing table/column grants stay unchanged. No table-wide SELECT or write privilege is added.
-- coupang_sale_lines.row_number is used by ORDER BY; promotion.validation_status by WHERE.
-- The removed unused promotion->uploadBatch relation needs no additional upload-batch grant.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['coupang_products','coupang_cost_rules','coupang_sales_fee_rules','coupang_manual_purchases','coupang_sale_lines','coupang_ad_metrics','coupang_promotion_prices'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=('meta_ads.'||t)::regclass AND r.rolname=current_user) THEN
    RAISE EXCEPTION 'NATIVE_SOURCE_OWNER_CHANGED';
  END IF;
 END LOOP;
END $$;
GRANT SELECT ("created_at", "updated_at")
  ON TABLE "meta_ads"."coupang_products" TO meta_ads_unified_worker;
GRANT SELECT ("supply_price_krw", "created_at", "updated_at")
  ON TABLE "meta_ads"."coupang_cost_rules" TO meta_ads_unified_worker;
GRANT SELECT ("created_at", "updated_at")
  ON TABLE "meta_ads"."coupang_sales_fee_rules" TO meta_ads_unified_worker;
GRANT SELECT ("coupang_product_id", "sale_price_krw", "promotion_price_krw", "product_cost_krw",
  "coupang_sales_fee_krw", "shipping_cost_krw", "other_cost_krw", "created_at")
  ON TABLE "meta_ads"."coupang_manual_purchases" TO meta_ads_unified_worker;
GRANT SELECT ("coupang_product_id", "row_number")
  ON TABLE "meta_ads"."coupang_sale_lines" TO meta_ads_unified_worker;
GRANT SELECT ("spend_product_id", "conversion_product_id", "total_sales_quantity_1d")
  ON TABLE "meta_ads"."coupang_ad_metrics" TO meta_ads_unified_worker;
GRANT SELECT ("id", "coupang_product_id", "promotion_price_krw", "promotion_start_date", "promotion_end_date",
  "promotion_status", "validation_errors", "validation_status", "created_at")
  ON TABLE "meta_ads"."coupang_promotion_prices" TO meta_ads_unified_worker;
-- Same shared-workspace SELECT policy used for the existing source allowlist.
-- Do not disable, broaden or replace any existing policy.
DO $$
BEGIN
  IF (SELECT relrowsecurity FROM pg_class WHERE oid='meta_ads.coupang_promotion_prices'::regclass)
    AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='meta_ads'
      AND tablename='coupang_promotion_prices' AND policyname='unified_stage11_worker_source_select') THEN
    CREATE POLICY unified_stage11_worker_source_select ON meta_ads.coupang_promotion_prices
      FOR SELECT TO meta_ads_unified_worker USING (true);
  END IF;
END $$;
DO $$
DECLARE t text;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_class WHERE oid='meta_ads.coupang_promotion_prices'::regclass AND relrowsecurity)
  AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='meta_ads.coupang_promotion_prices'::regclass AND polname='unified_stage11_worker_source_select') THEN
  CREATE POLICY unified_stage11_worker_source_select ON meta_ads.coupang_promotion_prices FOR SELECT TO meta_ads_unified_worker USING(true);
 END IF;
 FOREACH t IN ARRAY ARRAY['coupang_products','coupang_cost_rules','coupang_sales_fee_rules','coupang_manual_purchases','coupang_sale_lines','coupang_ad_metrics','coupang_promotion_prices'] LOOP
  IF has_table_privilege('meta_ads_unified_worker','meta_ads.'||t,'SELECT') OR
     has_any_column_privilege('meta_ads_unified_worker','meta_ads.'||t,'INSERT') OR
     has_any_column_privilege('meta_ads_unified_worker','meta_ads.'||t,'UPDATE') OR
     has_table_privilege('meta_ads_unified_worker','meta_ads.'||t,'DELETE,TRUNCATE') OR
     has_any_column_privilege('meta_ads_unified_report','meta_ads.'||t,'SELECT') THEN
   RAISE EXCEPTION 'NATIVE_SOURCE_GRANTS_TOO_BROAD';
  END IF;
 END LOOP;
 IF has_column_privilege('meta_ads_unified_worker','meta_ads.source_connections','credential_ref','SELECT') OR
    has_column_privilege('meta_ads_unified_worker','meta_ads.source_connections','external_account_id','SELECT') THEN
  RAISE EXCEPTION 'NATIVE_SOURCE_PRIVATE_ACCESS';
 END IF;
END $$;
COMMIT;
