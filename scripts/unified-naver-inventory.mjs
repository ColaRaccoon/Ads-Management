import { writeFileSync } from 'node:fs';
const queries = [
  { name: 'identity', sql: "SELECT current_database() db,current_user role,current_setting('transaction_read_only') read_only" },
  { name: 'stores', sql: "SELECT id,payload->>'name' name,payload->>'platformType' platform,payload->>'deliveryUnitCost' delivery_unit_cost FROM public.stores ORDER BY id LIMIT 20" },
  { name: 'runtime_access', sql: "SELECT table_name,has_table_privilege('meta_ads_app',format('%I.%I',table_schema,table_name),'SELECT') can_read FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('stores','order_items','order_source_signatures','products','canonical_sales_units','sales_unit_cost_settings','sales_unit_cost_snapshots','sales_unit_cost_snapshot_entries','ad_excel_uploads','ad_campaign_daily_costs','daily_fake_purchases','daily_store_summaries','daily_sales_unit_profits','order_sync_states','order_sync_batches','order_sync_batch_items','operations') ORDER BY table_name" },
  { name: 'operation_shape', sql: "SELECT DISTINCT jsonb_object_keys(payload->'resultJson') result_key FROM public.operations WHERE payload->>'operationType'='ORDER_SYNC' AND payload->>'status'='SUCCEEDED' LIMIT 50" },
  { name: 'sync_counts', sql: "SELECT 'states' kind,count(*)::text count FROM public.order_sync_states UNION ALL SELECT 'batches',count(*)::text FROM public.order_sync_batches UNION ALL SELECT 'items',count(*)::text FROM public.order_sync_batch_items" }
];
writeFileSync('docs/product-performance/research/05-inventory-queries.json', JSON.stringify(queries, null, 2) + '\n');
