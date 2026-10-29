-- Stage11 operational-role proposal. Parent is the sole mutation executor.
-- No password, membership, credential grant, source DML or existing RLS policy change.
-- report is the feature-only configuration/report/queue connection. Legacy app keeps its separate role.
-- USING(true) means current shared workspace, not per-user/store DB tenant isolation.
-- App data.read/products.manage/mappings.manage/operations.run and store allowlists remain mandatory.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $roles$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['meta_ads_unified_report','meta_ads_unified_worker'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',role_name);
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit)) OR EXISTS(SELECT 1 FROM pg_tables WHERE tableowner=role_name) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=role_name)) THEN
   RAISE EXCEPTION 'Feature runtime role must be non-owner, non-privileged, NOINHERIT and without memberships: %',role_name;
  END IF;
 END LOOP;
END $roles$;
GRANT USAGE ON SCHEMA meta_ads TO meta_ads_unified_report,meta_ads_unified_worker;
SET LOCAL ROLE meta_ads_app;
-- RI triggers run as the referenced table owner and use SELECT ... FOR KEY SHARE.
-- Keep FORCE RLS and no owner policy; only parent key reads/row-lock permission are restored.
GRANT SELECT(id),UPDATE(id) ON TABLE meta_ads.unified_products TO meta_ads_app;
GRANT SELECT(id,source_system,platform,scope_key,business_date),UPDATE(id) ON TABLE meta_ads.unified_aggregation_runs TO meta_ads_app;
DO $$
BEGIN
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='meta_ads' AND c.relname IN ('unified_products','unified_aggregation_runs') AND r.rolname='meta_ads_app' AND c.relrowsecurity AND c.relforcerowsecurity)<>2 THEN
  RAISE EXCEPTION 'STAGE11_FK_PARENT_OWNER_OR_FORCE_RLS_CHANGED';
 END IF;
END $$;
DO $$
BEGIN
 IF NOT has_column_privilege('meta_ads_app','meta_ads.unified_products','id','SELECT') OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_products','id','UPDATE')
 OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','id','SELECT') OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','id','UPDATE')
 OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','source_system','SELECT') OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','platform','SELECT')
 OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','scope_key','SELECT') OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','business_date','SELECT') THEN
  RAISE EXCEPTION 'STAGE11_FK_PARENT_MINIMUM_PRIVILEGES_NOT_GRANTED';
 END IF;
 IF has_table_privilege('meta_ads_app','meta_ads.unified_products','SELECT,UPDATE') OR has_table_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','SELECT,UPDATE') THEN
  RAISE EXCEPTION 'STAGE11_FK_PARENT_BROAD_PRIVILEGE_REQUIRES_REVIEW';
 END IF;
END $$;
GRANT SELECT,INSERT,UPDATE ON meta_ads.unified_products,meta_ads.unified_rules TO meta_ads_unified_report;
GRANT SELECT,INSERT ON meta_ads.unified_mapping_audits TO meta_ads_unified_report;
GRANT SELECT ON meta_ads.unified_aggregation_runs,meta_ads.unified_source_publications,meta_ads.unified_daily_facts,meta_ads.unified_source_coverage TO meta_ads_unified_report;
GRANT INSERT ON meta_ads.unified_aggregation_runs TO meta_ads_unified_report;
GRANT SELECT,INSERT,UPDATE,DELETE ON meta_ads.unified_aggregation_runs,meta_ads.unified_source_publications,meta_ads.unified_daily_facts,meta_ads.unified_source_coverage,meta_ads.unified_product_match_results TO meta_ads_unified_worker;
GRANT SELECT(id,provider,display_name,currency_code,time_zone) ON meta_ads.source_connections TO meta_ads_unified_report;
GRANT SELECT ("currency_code","display_name","id","provider","time_zone") ON TABLE "meta_ads"."source_connections" TO meta_ads_unified_worker;
GRANT SELECT ("changed_by_user_id","connection_id","coupon_input_source","data_kind","effective_at","from_date","id","primary_source","reason","to_date","version") ON TABLE "meta_ads"."source_policies" TO meta_ads_unified_worker;
GRANT SELECT ("connection_id","data_kind","last_attempt_at","last_attempt_run_id","last_success_at","last_success_run_id","metric_date","reconciliation_status","row_count","source","state","total_amount","warning_codes") ON TABLE "meta_ads"."source_coverage" TO meta_ads_unified_worker;
GRANT SELECT ("binding_method","bound_at","canonical_key_hash","connection_id","data_kind","id","is_current","record_id","record_table","source","sync_run_id","version") ON TABLE "meta_ads"."source_record_links" TO meta_ads_unified_worker;
GRANT SELECT ("connection_id","id") ON TABLE "meta_ads"."sync_runs" TO meta_ads_unified_worker;
GRANT SELECT ("attempts","checkpoint_value","completed_at","fetched_count","published_count","run_id","status","unit_key") ON TABLE "meta_ads"."run_units" TO meta_ads_unified_worker;
GRANT SELECT ("adset_name","connection_id","created_at","id","import_version","is_current","meta_adset_id","metric_date","purchase_value_usd","source","source_revision","spend_usd","sync_run_id","updated_at","upload_batch_id") ON TABLE "meta_ads"."meta_adset_daily_metrics" TO meta_ads_unified_worker;
GRANT SELECT ("campaign_id","campaign_name","connection_id","conversion_value","cost_micros","fetched_at","id","is_current","metric_date","source","sync_run_id","version") ON TABLE "meta_ads"."google_campaign_daily_costs" TO meta_ads_unified_worker;
GRANT SELECT ("base_currency","fallback_type","id","provider","quote_currency","rate","rate_date","source_date") ON TABLE "meta_ads"."exchange_rates" TO meta_ads_unified_worker;
GRANT SELECT ("display_name","id","is_active") ON TABLE "meta_ads"."products" TO meta_ads_unified_worker;
GRANT SELECT ("created_at","effective_from","effective_to","extra_cost_krw","fx_rate_krw_per_usd","id","note","product_cost_krw","product_id","sale_price_krw","shipping_krw","updated_at","vat_krw") ON TABLE "meta_ads"."product_cost_rules" TO meta_ads_unified_worker;
GRANT SELECT ("actual_order_price_krw","actual_shipping_fee_krw","cafe24_product_rule_id","connection_id","created_at","id","import_version","is_current","match_source","option_name","option_value","order_date","order_line_key","order_no","payment_method","product_id","product_name","product_no","provider_coupon_signal","provider_updated_at","quantity","sale_price_krw","source","source_row_hash","sync_run_id","total_order_krw","total_paid_krw","upload_batch_id","validation_status") ON TABLE "meta_ads"."cafe24_order_lines" TO meta_ads_unified_worker;
GRANT SELECT ("id","imported_at","order_end","order_start","row_count","status") ON TABLE "meta_ads"."cafe24_upload_batches" TO meta_ads_unified_worker;
GRANT SELECT ("ad_cost_source_product_id","created_at","display_name","extra_cost_krw_override","id","is_active","match_target","note","option_exclude_keywords","option_include_keywords","priority","product_cost_krw_override","product_id","product_name_aliases","product_name_exclude_keywords","product_name_include_keywords","product_numbers","roas_group","sale_price_krw_override","shipping_krw_override","updated_at","valid_from","valid_to") ON TABLE "meta_ads"."cafe24_product_rules" TO meta_ads_unified_worker;
GRANT SELECT ("created_at","discount_krw","id","is_active","name","note","priority","product_id","scope","updated_at","valid_from","valid_to") ON TABLE "meta_ads"."cafe24_coupon_rules" TO meta_ads_unified_worker;
GRANT SELECT ("campaign_id","connection_id","created_at","end_date","extra_cost_krw_override","id","identity_key","kind","option_name","option_scope","product_cost_krw_override","product_id","product_no","sale_price_krw_override","sale_unit_label","shipping_krw_override","start_date","updated_at") ON TABLE "meta_ads"."google_performance_mappings" TO meta_ads_unified_worker;
GRANT SELECT ("canonical_key_hash","connection_id","content_fingerprint","fetched_at","fingerprint_key_version","id","is_current","order_date","version") ON TABLE "meta_ads"."cafe24_order_api_versions" TO meta_ads_unified_worker;
GRANT SELECT ("display_name","id","is_active","standard_name") ON TABLE "meta_ads"."coupang_products" TO meta_ads_unified_worker;
GRANT SELECT ("ad_enabled","coupang_product_id","display_name","exclude_keywords","id","include_keywords","is_active","valid_from","valid_to") ON TABLE "meta_ads"."coupang_product_rules" TO meta_ads_unified_worker;
GRANT SELECT ("coupang_product_id","effective_from","effective_to","extra_cost_krw","growth_inbound_fee_krw","growth_shipping_fee_krw","hanaro_shipping_fee_krw","id","product_cost_krw","return_cost_per_unit_krw","return_rate","sale_price_krw","seller_shipping_fee_krw") ON TABLE "meta_ads"."coupang_cost_rules" TO meta_ads_unified_worker;
GRANT SELECT ("effective_from","effective_to","id","sales_fee_rate") ON TABLE "meta_ads"."coupang_sales_fee_rules" TO meta_ads_unified_worker;
GRANT SELECT ("base_sale_price_krw","id","product_display_name","purchase_date","quantity","rule_display_name","sale_method","sales_amount_krw","total_cost_krw","updated_at","vendor_fee_total_krw") ON TABLE "meta_ads"."coupang_manual_purchases" TO meta_ads_unified_worker;
GRANT SELECT ("id","imported_at","source_type","status") ON TABLE "meta_ads"."coupang_upload_batches" TO meta_ads_unified_worker;
GRANT SELECT ("cancel_amount_krw","created_at","id","import_version","is_current","net_sales_krw","option_name","order_count","product_name","sale_date","sale_line_key","sale_method","sales_krw","sales_quantity","source_row_hash","upload_batch_id","validation_status") ON TABLE "meta_ads"."coupang_sale_lines" TO meta_ads_unified_worker;
GRANT SELECT ("ad_execution_product_name","ad_group_name","ad_metric_key","ad_name","ad_spend_krw","campaign_name","created_at","id","import_version","is_current","metric_date","source_row_hash","total_conversion_sales_1d_krw","upload_batch_id","validation_status") ON TABLE "meta_ads"."coupang_ad_metrics" TO meta_ads_unified_worker;
GRANT SELECT ("active","canonical_name","created_at","id","normalized_name","updated_at","version") ON TABLE "meta_ads"."unified_products" TO meta_ads_unified_worker;
GRANT SELECT ("active","created_at","id","identity_key","kind","payload","platform","product_id","scope_key","updated_at","valid_from","valid_to","version") ON TABLE "meta_ads"."unified_rules" TO meta_ads_unified_worker;
DO $policies$
DECLARE t text; src record;
BEGIN
 FOREACH t IN ARRAY ARRAY['unified_products','unified_rules'] LOOP
  EXECUTE format('CREATE POLICY unified_stage11_report_config_select ON meta_ads.%I FOR SELECT TO meta_ads_unified_report USING(true)',t);
  EXECUTE format('CREATE POLICY unified_stage11_report_config_insert ON meta_ads.%I FOR INSERT TO meta_ads_unified_report WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY unified_stage11_report_config_update ON meta_ads.%I FOR UPDATE TO meta_ads_unified_report USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY unified_stage11_worker_config_select ON meta_ads.%I FOR SELECT TO meta_ads_unified_worker USING(true)',t);
 END LOOP;
 CREATE POLICY unified_stage11_report_audit_select ON meta_ads.unified_mapping_audits FOR SELECT TO meta_ads_unified_report USING(true);
 CREATE POLICY unified_stage11_report_audit_insert ON meta_ads.unified_mapping_audits FOR INSERT TO meta_ads_unified_report WITH CHECK(true);
 FOREACH t IN ARRAY ARRAY['unified_aggregation_runs','unified_source_publications','unified_daily_facts','unified_source_coverage'] LOOP
  EXECUTE format('CREATE POLICY unified_stage11_report_select ON meta_ads.%I FOR SELECT TO meta_ads_unified_report USING(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['unified_aggregation_runs','unified_source_publications','unified_daily_facts','unified_source_coverage','unified_product_match_results'] LOOP
  EXECUTE format('CREATE POLICY unified_stage11_worker ON meta_ads.%I TO meta_ads_unified_worker USING(true) WITH CHECK(true)',t);
 END LOOP;
 CREATE POLICY unified_stage11_report_queue ON meta_ads.unified_aggregation_runs FOR INSERT TO meta_ads_unified_report WITH CHECK(
  status='STAGING' AND lease_token IS NULL AND lease_expires_at IS NULL AND attempts=0
  AND completed_at IS NULL AND published_at IS NULL AND source_fingerprint IS NULL
  AND requested_by IS NOT NULL AND reason IS NOT NULL AND btrim(reason)<>''
  AND versions='{}'::jsonb AND control_totals='[]'::jsonb AND issues='[]'::jsonb
  AND checkpoint->>'phase'='QUEUED');
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relname='source_connections' AND c.relrowsecurity) THEN
  CREATE POLICY unified_stage11_report_connections ON meta_ads.source_connections FOR SELECT TO meta_ads_unified_report USING(true);
 END IF;
 FOR src IN SELECT * FROM (VALUES ('meta_ads','source_connections'),('meta_ads','source_policies'),('meta_ads','source_coverage'),('meta_ads','source_record_links'),('meta_ads','sync_runs'),('meta_ads','run_units'),('meta_ads','meta_adset_daily_metrics'),('meta_ads','google_campaign_daily_costs'),('meta_ads','exchange_rates'),('meta_ads','products'),('meta_ads','product_cost_rules'),('meta_ads','cafe24_order_lines'),('meta_ads','cafe24_upload_batches'),('meta_ads','cafe24_product_rules'),('meta_ads','cafe24_coupon_rules'),('meta_ads','google_performance_mappings'),('meta_ads','cafe24_order_api_versions'),('meta_ads','coupang_products'),('meta_ads','coupang_product_rules'),('meta_ads','coupang_cost_rules'),('meta_ads','coupang_sales_fee_rules'),('meta_ads','coupang_manual_purchases'),('meta_ads','coupang_upload_batches'),('meta_ads','coupang_sale_lines'),('meta_ads','coupang_ad_metrics')) AS allowlist(schema_name,table_name) LOOP
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=src.schema_name AND c.relname=src.table_name AND c.relrowsecurity) THEN
   EXECUTE format('CREATE POLICY unified_stage11_worker_source_select ON %I.%I FOR SELECT TO meta_ads_unified_worker USING(true)',src.schema_name,src.table_name);
  END IF;
 END LOOP;
END $policies$;
RESET ROLE;
GRANT USAGE ON SCHEMA public TO meta_ads_unified_worker;
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
DO $public_policies$
DECLARE src record;
BEGIN
 FOR src IN SELECT * FROM (VALUES ('public','stores'),('public','order_items'),('public','order_source_signatures'),('public','products'),('public','canonical_sales_units'),('public','sales_unit_cost_settings'),('public','sales_unit_cost_snapshots'),('public','sales_unit_cost_snapshot_entries'),('public','ad_excel_uploads'),('public','ad_campaign_daily_costs'),('public','daily_fake_purchases'),('public','daily_store_summaries'),('public','daily_sales_unit_profits'),('public','order_sync_states'),('public','operations'),('public','order_sync_batch_items'),('public','order_sync_batches')) AS allowlist(schema_name,table_name) LOOP
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=src.schema_name AND c.relname=src.table_name AND c.relrowsecurity) THEN
   EXECUTE format('CREATE POLICY unified_stage11_worker_source_select ON %I.%I FOR SELECT TO meta_ads_unified_worker USING(true)',src.schema_name,src.table_name);
  END IF;
 END LOOP;
END $public_policies$;
RESET ROLE;

-- Fail atomically if PUBLIC/old grants would make these new roles read credentials.
DO $denials$
DECLARE role_name text; credential_table record; forbidden text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['meta_ads_unified_report','meta_ads_unified_worker'] LOOP
  FOREACH forbidden IN ARRAY ARRAY['credential_ref','external_account_id'] LOOP
   IF has_column_privilege(role_name,'meta_ads.source_connections',forbidden,'SELECT') THEN RAISE EXCEPTION 'Feature runtime credential/reference column grant leaked: %',role_name; END IF;
  END LOOP;
  FOR credential_table IN SELECT n.nspname,cl.relname,cl.oid FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname IN ('meta_ads','public') AND cl.relname IN ('source_credentials','commerce_api_credentials','connector_credentials','local_credentials','app_auth_sessions') AND cl.relkind IN ('r','p','v') LOOP
   IF has_table_privilege(role_name,credential_table.oid,'SELECT') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=credential_table.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(role_name,credential_table.oid,a.attnum,'SELECT')) THEN RAISE EXCEPTION 'Feature runtime credential/session table grant leaked: %',role_name; END IF;
  END LOOP;
 END LOOP;
END $denials$;
DO $verify_access$
DECLARE spec record; target_table regclass; required_column text;
BEGIN
 FOR spec IN SELECT * FROM (VALUES ('meta_ads','source_connections',ARRAY['currency_code','display_name','id','provider','time_zone']::text[]),('meta_ads','source_policies',ARRAY['changed_by_user_id','connection_id','coupon_input_source','data_kind','effective_at','from_date','id','primary_source','reason','to_date','version']::text[]),('meta_ads','source_coverage',ARRAY['connection_id','data_kind','last_attempt_at','last_attempt_run_id','last_success_at','last_success_run_id','metric_date','reconciliation_status','row_count','source','state','total_amount','warning_codes']::text[]),('meta_ads','source_record_links',ARRAY['binding_method','bound_at','canonical_key_hash','connection_id','data_kind','id','is_current','record_id','record_table','source','sync_run_id','version']::text[]),('meta_ads','sync_runs',ARRAY['connection_id','id']::text[]),('meta_ads','run_units',ARRAY['attempts','checkpoint_value','completed_at','fetched_count','published_count','run_id','status','unit_key']::text[]),('meta_ads','meta_adset_daily_metrics',ARRAY['adset_name','connection_id','created_at','id','import_version','is_current','meta_adset_id','metric_date','purchase_value_usd','source','source_revision','spend_usd','sync_run_id','updated_at','upload_batch_id']::text[]),('meta_ads','google_campaign_daily_costs',ARRAY['campaign_id','campaign_name','connection_id','conversion_value','cost_micros','fetched_at','id','is_current','metric_date','source','sync_run_id','version']::text[]),('meta_ads','exchange_rates',ARRAY['base_currency','fallback_type','id','provider','quote_currency','rate','rate_date','source_date']::text[]),('meta_ads','products',ARRAY['display_name','id','is_active']::text[]),('meta_ads','product_cost_rules',ARRAY['created_at','effective_from','effective_to','extra_cost_krw','fx_rate_krw_per_usd','id','note','product_cost_krw','product_id','sale_price_krw','shipping_krw','updated_at','vat_krw']::text[]),('meta_ads','cafe24_order_lines',ARRAY['actual_order_price_krw','actual_shipping_fee_krw','cafe24_product_rule_id','connection_id','created_at','id','import_version','is_current','match_source','option_name','option_value','order_date','order_line_key','order_no','payment_method','product_id','product_name','product_no','provider_coupon_signal','provider_updated_at','quantity','sale_price_krw','source','source_row_hash','sync_run_id','total_order_krw','total_paid_krw','upload_batch_id','validation_status']::text[]),('meta_ads','cafe24_upload_batches',ARRAY['id','imported_at','order_end','order_start','row_count','status']::text[]),('meta_ads','cafe24_product_rules',ARRAY['ad_cost_source_product_id','created_at','display_name','extra_cost_krw_override','id','is_active','match_target','note','option_exclude_keywords','option_include_keywords','priority','product_cost_krw_override','product_id','product_name_aliases','product_name_exclude_keywords','product_name_include_keywords','product_numbers','roas_group','sale_price_krw_override','shipping_krw_override','updated_at','valid_from','valid_to']::text[]),('meta_ads','cafe24_coupon_rules',ARRAY['created_at','discount_krw','id','is_active','name','note','priority','product_id','scope','updated_at','valid_from','valid_to']::text[]),('meta_ads','google_performance_mappings',ARRAY['campaign_id','connection_id','created_at','end_date','extra_cost_krw_override','id','identity_key','kind','option_name','option_scope','product_cost_krw_override','product_id','product_no','sale_price_krw_override','sale_unit_label','shipping_krw_override','start_date','updated_at']::text[]),('meta_ads','cafe24_order_api_versions',ARRAY['canonical_key_hash','connection_id','content_fingerprint','fetched_at','fingerprint_key_version','id','is_current','order_date','version']::text[]),('meta_ads','coupang_products',ARRAY['display_name','id','is_active','standard_name']::text[]),('meta_ads','coupang_product_rules',ARRAY['ad_enabled','coupang_product_id','display_name','exclude_keywords','id','include_keywords','is_active','valid_from','valid_to']::text[]),('meta_ads','coupang_cost_rules',ARRAY['coupang_product_id','effective_from','effective_to','extra_cost_krw','growth_inbound_fee_krw','growth_shipping_fee_krw','hanaro_shipping_fee_krw','id','product_cost_krw','return_cost_per_unit_krw','return_rate','sale_price_krw','seller_shipping_fee_krw']::text[]),('meta_ads','coupang_sales_fee_rules',ARRAY['effective_from','effective_to','id','sales_fee_rate']::text[]),('meta_ads','coupang_manual_purchases',ARRAY['base_sale_price_krw','id','product_display_name','purchase_date','quantity','rule_display_name','sale_method','sales_amount_krw','total_cost_krw','updated_at','vendor_fee_total_krw']::text[]),('meta_ads','coupang_upload_batches',ARRAY['id','imported_at','source_type','status']::text[]),('meta_ads','coupang_sale_lines',ARRAY['cancel_amount_krw','created_at','id','import_version','is_current','net_sales_krw','option_name','order_count','product_name','sale_date','sale_line_key','sale_method','sales_krw','sales_quantity','source_row_hash','upload_batch_id','validation_status']::text[]),('meta_ads','coupang_ad_metrics',ARRAY['ad_execution_product_name','ad_group_name','ad_metric_key','ad_name','ad_spend_krw','campaign_name','created_at','id','import_version','is_current','metric_date','source_row_hash','total_conversion_sales_1d_krw','upload_batch_id','validation_status']::text[]),('meta_ads','unified_products',ARRAY['active','canonical_name','created_at','id','normalized_name','updated_at','version']::text[]),('meta_ads','unified_rules',ARRAY['active','created_at','id','identity_key','kind','payload','platform','product_id','scope_key','updated_at','valid_from','valid_to','version']::text[]),('public','stores',ARRAY['id','payload','updated_at']::text[]),('public','order_items',ARRAY['id','payload','updated_at']::text[]),('public','order_source_signatures',ARRAY['id','payload','updated_at']::text[]),('public','products',ARRAY['id','payload','updated_at']::text[]),('public','canonical_sales_units',ARRAY['id','payload','updated_at']::text[]),('public','sales_unit_cost_settings',ARRAY['id','payload','updated_at']::text[]),('public','sales_unit_cost_snapshots',ARRAY['id','payload','updated_at']::text[]),('public','sales_unit_cost_snapshot_entries',ARRAY['id','payload','updated_at']::text[]),('public','ad_excel_uploads',ARRAY['id','payload','updated_at']::text[]),('public','ad_campaign_daily_costs',ARRAY['id','payload','updated_at']::text[]),('public','daily_fake_purchases',ARRAY['id','payload','updated_at']::text[]),('public','daily_store_summaries',ARRAY['id','payload','updated_at']::text[]),('public','daily_sales_unit_profits',ARRAY['id','payload','updated_at']::text[]),('public','order_sync_states',ARRAY['id','payload','updated_at']::text[]),('public','operations',ARRAY['id','payload']::text[]),('public','order_sync_batch_items',ARRAY['id','payload']::text[]),('public','order_sync_batches',ARRAY['id','payload']::text[])) AS required(schema_name,table_name,columns) LOOP
  target_table:=to_regclass(format('%I.%I',spec.schema_name,spec.table_name));
  IF target_table IS NULL OR NOT has_schema_privilege('meta_ads_unified_worker',spec.schema_name,'USAGE') THEN RAISE EXCEPTION 'STAGE11_SOURCE_SCHEMA_OR_TABLE_MISSING: %.%',spec.schema_name,spec.table_name; END IF;
  FOREACH required_column IN ARRAY spec.columns LOOP
   IF NOT has_column_privilege('meta_ads_unified_worker',target_table,required_column,'SELECT') THEN RAISE EXCEPTION 'STAGE11_SOURCE_SELECT_NOT_GRANTED: %.%',spec.schema_name,spec.table_name; END IF;
  END LOOP;
  IF has_table_privilege('meta_ads_unified_worker',target_table,'INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=target_table AND a.attnum>0 AND NOT a.attisdropped AND (has_column_privilege('meta_ads_unified_worker',target_table,a.attnum,'INSERT') OR has_column_privilege('meta_ads_unified_worker',target_table,a.attnum,'UPDATE'))) THEN RAISE EXCEPTION 'STAGE11_SOURCE_DML_LEAK: %.%',spec.schema_name,spec.table_name; END IF;
  IF NOT (spec.schema_name='meta_ads' AND spec.table_name IN ('source_connections','unified_products','unified_rules')) AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=target_table AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('meta_ads_unified_report',target_table,a.attnum,'SELECT')) THEN RAISE EXCEPTION 'STAGE11_REPORT_RAW_SOURCE_LEAK: %.%',spec.schema_name,spec.table_name; END IF;
 END LOOP;
END $verify_access$;
-- No login is enabled here. Parent supplies separate strong passwords as secrets after audit.
-- One-time policy application: duplicate policy names fail/rollback instead of changing old policies.
COMMIT;
