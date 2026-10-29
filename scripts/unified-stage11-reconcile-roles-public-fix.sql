-- Parent-only corrective grant: existing17 public source tables are owned by patima_app.
-- Caller wrapper temporarily enables SET for patima_app and exactly restores its grantor rows.
-- No source DML, RLS, membership, credential or existing application privilege change here.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $$
BEGIN
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relname IN ('stores','order_items','order_source_signatures','products','canonical_sales_units','sales_unit_cost_settings','sales_unit_cost_snapshots','sales_unit_cost_snapshot_entries','ad_excel_uploads','ad_campaign_daily_costs','daily_fake_purchases','daily_store_summaries','daily_sales_unit_profits','order_sync_states','operations','order_sync_batch_items','order_sync_batches') AND r.rolname='patima_app' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)<>17 THEN RAISE EXCEPTION 'STAGE11_PUBLIC_SOURCE_OWNERSHIP_CHANGED'; END IF;
END $$;
SET LOCAL ROLE patima_app;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."stores" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."order_items" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."order_source_signatures" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."products" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."canonical_sales_units" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."sales_unit_cost_settings" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."sales_unit_cost_snapshots" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."sales_unit_cost_snapshot_entries" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."ad_excel_uploads" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."ad_campaign_daily_costs" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."daily_fake_purchases" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."daily_store_summaries" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."daily_sales_unit_profits" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload","updated_at") ON TABLE "public"."order_sync_states" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload") ON TABLE "public"."operations" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload") ON TABLE "public"."order_sync_batch_items" TO meta_ads_unified_worker;
GRANT SELECT ("id","payload") ON TABLE "public"."order_sync_batches" TO meta_ads_unified_worker;
RESET ROLE;
DO $verify_access$
DECLARE spec record; target_table regclass; required_column text;
BEGIN
 FOR spec IN SELECT * FROM (VALUES ('public','stores',ARRAY['id','payload','updated_at']::text[]),('public','order_items',ARRAY['id','payload','updated_at']::text[]),('public','order_source_signatures',ARRAY['id','payload','updated_at']::text[]),('public','products',ARRAY['id','payload','updated_at']::text[]),('public','canonical_sales_units',ARRAY['id','payload','updated_at']::text[]),('public','sales_unit_cost_settings',ARRAY['id','payload','updated_at']::text[]),('public','sales_unit_cost_snapshots',ARRAY['id','payload','updated_at']::text[]),('public','sales_unit_cost_snapshot_entries',ARRAY['id','payload','updated_at']::text[]),('public','ad_excel_uploads',ARRAY['id','payload','updated_at']::text[]),('public','ad_campaign_daily_costs',ARRAY['id','payload','updated_at']::text[]),('public','daily_fake_purchases',ARRAY['id','payload','updated_at']::text[]),('public','daily_store_summaries',ARRAY['id','payload','updated_at']::text[]),('public','daily_sales_unit_profits',ARRAY['id','payload','updated_at']::text[]),('public','order_sync_states',ARRAY['id','payload','updated_at']::text[]),('public','operations',ARRAY['id','payload']::text[]),('public','order_sync_batch_items',ARRAY['id','payload']::text[]),('public','order_sync_batches',ARRAY['id','payload']::text[])) AS required(schema_name,table_name,columns) LOOP
  target_table:=to_regclass(format('%I.%I',spec.schema_name,spec.table_name));
  IF target_table IS NULL OR NOT has_schema_privilege('meta_ads_unified_worker',spec.schema_name,'USAGE') THEN RAISE EXCEPTION 'STAGE11_SOURCE_SCHEMA_OR_TABLE_MISSING: %.%',spec.schema_name,spec.table_name; END IF;
  FOREACH required_column IN ARRAY spec.columns LOOP
   IF NOT has_column_privilege('meta_ads_unified_worker',target_table,required_column,'SELECT') THEN RAISE EXCEPTION 'STAGE11_SOURCE_SELECT_NOT_GRANTED: %.%',spec.schema_name,spec.table_name; END IF;
  END LOOP;
  IF has_table_privilege('meta_ads_unified_worker',target_table,'INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=target_table AND a.attnum>0 AND NOT a.attisdropped AND (has_column_privilege('meta_ads_unified_worker',target_table,a.attnum,'INSERT') OR has_column_privilege('meta_ads_unified_worker',target_table,a.attnum,'UPDATE'))) THEN RAISE EXCEPTION 'STAGE11_SOURCE_DML_LEAK: %.%',spec.schema_name,spec.table_name; END IF;

 END LOOP;
END $verify_access$;
COMMIT;
