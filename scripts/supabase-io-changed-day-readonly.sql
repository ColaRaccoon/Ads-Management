WITH new_run AS (
 SELECT * FROM meta_ads.unified_aggregation_runs WHERE id='435fd7bd-a24c-4145-a803-020ee1ce9317'::uuid
), old_run AS (
 SELECT p.* FROM meta_ads.unified_aggregation_runs p JOIN new_run n ON p.id=(n.checkpoint->>'previousRunId')::uuid
), differences AS (
 SELECT coalesce(n.component,p.component) AS component,coalesce(n.payload->'nativeResult'->>'group',p.payload->'nativeResult'->>'group') AS native_group,
   count(*) AS rows_compared,
   count(*) FILTER(WHERE n.id IS NULL OR p.id IS NULL) AS added_or_removed,
   bool_and(n.amount_krw IS NOT DISTINCT FROM p.amount_krw) AS amount_equal,
   bool_and(n.quantity IS NOT DISTINCT FROM p.quantity) AS quantity_equal,
   bool_and(n.product_name IS NOT DISTINCT FROM p.product_name) AS product_equal,
   bool_and(n.attribution IS NOT DISTINCT FROM p.attribution) AS attribution_equal,
   bool_and(n.payload->'nativeResult'->'revenue' IS NOT DISTINCT FROM p.payload->'nativeResult'->'revenue') AS revenue_equal,
   bool_and(n.payload->'nativeResult'->'adSpend' IS NOT DISTINCT FROM p.payload->'nativeResult'->'adSpend') AS ad_spend_equal,
   bool_and(n.payload->'nativeResult'->'netProfit' IS NOT DISTINCT FROM p.payload->'nativeResult'->'netProfit') AS net_profit_equal
 FROM (SELECT * FROM meta_ads.unified_daily_facts WHERE run_id=(SELECT id FROM new_run)) n
 FULL JOIN (SELECT * FROM meta_ads.unified_daily_facts WHERE run_id=(SELECT id FROM old_run)) p
   ON n.component=p.component AND n.fact_key=p.fact_key
 GROUP BY 1,2
)
SELECT (SELECT jsonb_build_object('old_started_at',p.started_at,'old_published_at',p.published_at,'new_started_at',n.started_at,
   'previous_phase',p.checkpoint->>'phase','old_was_mapping_replay',p.checkpoint ? 'mappingPlanHash',
   'source_control_totals_equal',n.control_totals IS NOT DISTINCT FROM p.control_totals,
   'watermarks_equal',n.source_watermarks IS NOT DISTINCT FROM p.source_watermarks)
 FROM new_run n CROSS JOIN old_run p) AS runs,
 (SELECT jsonb_agg(d) FROM differences d) AS differences,
 (SELECT jsonb_build_object('compared',count(*),
   'source_payload_hash_changes',count(*) FILTER(WHERE n.evidence->'sourcePayloadHash' IS DISTINCT FROM p.evidence->'sourcePayloadHash'),
   'source_version_changes',count(*) FILTER(WHERE n.evidence->'sourceVersion' IS DISTINCT FROM p.evidence->'sourceVersion'),
   'selected_source_changes',count(*) FILTER(WHERE n.evidence->'selectedSource' IS DISTINCT FROM p.evidence->'selectedSource'),
   'name_input_changes',count(*) FILTER(WHERE n.name_input_hash IS DISTINCT FROM p.name_input_hash),
   'name_rule_version_changes',count(*) FILTER(WHERE n.rule_version IS DISTINCT FROM p.rule_version),
   'operating_revenue_changes',count(*) FILTER(WHERE n.evidence->'operatingRevenue' IS DISTINCT FROM p.evidence->'operatingRevenue'))
   FROM (SELECT * FROM meta_ads.unified_product_match_results WHERE run_id=(SELECT id FROM new_run)) n
   JOIN (SELECT * FROM meta_ads.unified_product_match_results WHERE run_id=(SELECT id FROM old_run)) p ON n.source_key=p.source_key) AS match_input_evidence,
 (SELECT jsonb_build_object('current_lines',count(*),'latest_provider_update',max(provider_updated_at),'latest_source_create',max(created_at))
   FROM meta_ads.cafe24_order_lines WHERE order_date='2026-11-03' AND is_current) AS storefront_source,
 (SELECT max(updated_at) FROM meta_ads.meta_adset_daily_metrics WHERE metric_date='2026-11-03' AND is_current) AS latest_meta_update,
 (SELECT max(fetched_at) FROM meta_ads.google_campaign_daily_costs WHERE metric_date='2026-11-03' AND is_current) AS latest_google_fetch;
