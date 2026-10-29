WITH params AS (SELECT DATE '2026-10-28' AS business_date,'풀업바'::text AS product_name),
cafe_lines AS (
 SELECT l.* FROM meta_ads.cafe24_order_lines l,params p WHERE l.is_current AND l.order_date=p.business_date AND l.source::text='API'
), cafe_lineage AS (
 SELECT count(DISTINCT l.id) AS current_rows,count(r.id) AS linked_rows,
 count(r.id) FILTER(WHERE r.version=l.import_version) AS valid_version_links,
 count(v.id) FILTER(WHERE v.version=l.import_version) AS valid_api_versions,
 count(*) FILTER(WHERE (l.validation_status::text='VALID' AND l.match_source::text='RULE' AND l.product_id IS NOT NULL AND l.cafe24_product_rule_id IS NOT NULL)
   OR (l.validation_status::text='UNMATCHED' AND l.match_source::text='UNMATCHED' AND l.product_id IS NULL AND l.cafe24_product_rule_id IS NULL)) AS valid_mapping_rows
 FROM cafe_lines l LEFT JOIN meta_ads.source_record_links r ON r.record_id=l.id AND r.connection_id=l.connection_id AND r.data_kind::text='CAFE24_ORDER' AND r.source::text='API' AND r.record_table='cafe24_order_lines' AND r.is_current
 LEFT JOIN meta_ads.cafe24_order_api_versions v ON v.connection_id=l.connection_id AND v.canonical_key_hash=r.canonical_key_hash AND v.version=r.version AND v.order_date=l.order_date AND v.is_current AND v.fetched_at IS NOT NULL AND v.content_fingerprint IS NOT NULL AND v.fingerprint_key_version IS NOT NULL
), meta_lineage AS (
 SELECT count(DISTINCT m.id) AS current_rows,count(r.id) AS all_links,
 count(DISTINCT m.id) FILTER(WHERE r.version=m.import_version) AS linked_rows,
 count(r.id) FILTER(WHERE r.version=m.import_version) AS valid_links
 FROM meta_ads.meta_adset_daily_metrics m LEFT JOIN meta_ads.source_record_links r ON r.record_id=m.id AND r.connection_id=m.connection_id AND r.data_kind::text='META_ADSET' AND r.source::text='API' AND r.record_table='meta_adset_daily_metrics' AND r.is_current,params p
 WHERE m.is_current AND m.metric_date=p.business_date AND m.source::text='API'
), google_lineage AS (
 SELECT count(DISTINCT g.id) AS current_rows,count(r.id) AS all_links,
 count(r.id) FILTER(WHERE r.version=g.version AND r.sync_run_id=g.sync_run_id) AS valid_links
 FROM meta_ads.google_campaign_daily_costs g LEFT JOIN meta_ads.source_record_links r ON r.record_id=g.id AND r.connection_id=g.connection_id AND r.data_kind::text='GOOGLE_CAMPAIGN' AND r.source::text='API' AND r.record_table='google_campaign_daily_costs' AND r.is_current,params p
 WHERE g.is_current AND g.metric_date=p.business_date AND g.source::text='API'
), unit_receipts AS (
 SELECT c.data_kind::text AS data_kind,c.row_count,c.last_success_at,
 EXISTS(SELECT 1 FROM meta_ads.run_units u JOIN meta_ads.sync_runs r ON r.id=u.run_id WHERE u.run_id=c.last_success_run_id AND u.status::text='SUCCEEDED' AND r.connection_id=c.connection_id AND u.unit_key=c.metric_date::text) AS succeeded_day_unit,
 (SELECT u.published_count FROM meta_ads.run_units u WHERE u.run_id=c.last_success_run_id AND u.unit_key=c.metric_date::text LIMIT 1) AS published_count
 FROM meta_ads.source_coverage c,params p WHERE c.metric_date=p.business_date AND c.data_kind::text IN ('META_ADSET','GOOGLE_CAMPAIGN','CAFE24_ORDER')
), selected_product AS (SELECT pr.id,pr.display_name FROM meta_ads.products pr,params p WHERE pr.is_active AND pr.display_name=p.product_name),
cafe_rules AS (
 SELECT r.display_name,r.match_target,r.product_name_aliases,r.product_name_include_keywords,r.product_name_exclude_keywords,r.option_include_keywords,r.option_exclude_keywords,
 r.sale_price_krw_override::text,r.product_cost_krw_override::text,r.shipping_krw_override::text,r.extra_cost_krw_override::text,r.valid_from,r.valid_to,r.priority
 FROM meta_ads.cafe24_product_rules r JOIN selected_product pr ON pr.id=r.product_id,params p
 WHERE r.is_active AND r.valid_from<=p.business_date AND (r.valid_to IS NULL OR r.valid_to>=p.business_date)
), costs AS (
 SELECT c.sale_price_krw::text,c.product_cost_krw::text,c.shipping_krw::text,c.extra_cost_krw::text,c.fx_rate_krw_per_usd::text,c.effective_from,c.effective_to
 FROM meta_ads.product_cost_rules c JOIN selected_product pr ON pr.id=c.product_id,params p
 WHERE c.effective_from<=p.business_date AND (c.effective_to IS NULL OR c.effective_to>=p.business_date)
), meta_rules AS (
 SELECT r.match_type::text,r.pattern,r.valid_from,r.valid_to,r.priority FROM meta_ads.product_match_rules r JOIN selected_product pr ON pr.id=r.product_id,params p
 WHERE r.is_active AND r.valid_from<=p.business_date AND (r.valid_to IS NULL OR r.valid_to>=p.business_date)
), coupon_rules AS (
 SELECT r.scope::text,r.discount_krw::text,r.priority,r.valid_from,r.valid_to FROM meta_ads.cafe24_coupon_rules r,params p
 WHERE (r.product_id IN (SELECT id FROM selected_product) OR r.product_id IS NULL) AND r.is_active AND r.valid_from<=p.business_date AND (r.valid_to IS NULL OR r.valid_to>=p.business_date)
)
SELECT jsonb_build_object('businessDate',(SELECT business_date FROM params),'canonicalProduct',(SELECT product_name FROM params),
 'lineage',jsonb_build_object('CAFE24',(SELECT to_jsonb(x) FROM cafe_lineage x),'META',(SELECT to_jsonb(x) FROM meta_lineage x),'GOOGLE',(SELECT to_jsonb(x) FROM google_lineage x)),
 'publishedDayReceipts',(SELECT jsonb_agg(to_jsonb(x)) FROM unit_receipts x),
 'cafe24LegacyRules',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM cafe_rules x),
 'productCostRules',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM costs x),
 'metaLegacyRules',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM meta_rules x),
 'cafe24CouponRules',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM coupon_rules x),
 'cronMetadata',(SELECT coalesce(jsonb_agg(jsonb_build_object('jobId',jobid,'schedule',schedule,'active',active,'database',database,'username',username,'jobName',jobname) ORDER BY jobid),'[]'::jsonb) FROM cron.job),
 'cronRecentRuns',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT j.jobname,d.status,max(d.start_time) AS latest_start_time,max(d.end_time) AS latest_end_time,count(*) AS runs FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid,params p WHERE d.start_time>=(p.business_date::timestamp AT TIME ZONE 'Asia/Seoul') GROUP BY j.jobname,d.status ORDER BY j.jobname,d.status) x),
 'privacy','No order identifier, customer field, raw payload, cron command or credential field returned.') AS bootstrap_readiness;
