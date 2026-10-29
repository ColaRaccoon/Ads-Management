WITH params AS (SELECT DATE '2026-10-28' AS business_date),
sources AS (
 SELECT 'META' AS platform,coalesce(m.connection_id::text,'LEGACY_UNBOUND') AS scope_key,m.source::text AS source,
 count(*) AS current_rows,count(*) FILTER(WHERE m.spend_usd IS NOT NULL) AS amount_rows,sum(m.spend_usd)::text AS amount,
 'USD' AS currency,max(m.updated_at)::text AS latest_source_at
 FROM meta_ads.meta_adset_daily_metrics m,params p WHERE m.is_current AND m.metric_date=p.business_date GROUP BY m.connection_id,m.source
 UNION ALL
 SELECT 'GOOGLE',g.connection_id::text,g.source::text,count(*),count(*) FILTER(WHERE g.cost_micros IS NOT NULL),
 (sum(g.cost_micros)/1000000::numeric)::text,'KRW',max(g.fetched_at)::text
 FROM meta_ads.google_campaign_daily_costs g,params p WHERE g.is_current AND g.metric_date=p.business_date GROUP BY g.connection_id,g.source
 UNION ALL
 SELECT 'CAFE24',coalesce(l.connection_id::text,'LEGACY_UNBOUND'),l.source::text,count(*),count(*) FILTER(WHERE l.validation_status::text<>'ERROR'),
 sum(l.sale_price_krw*l.quantity)::text,'KRW',max(coalesce(l.provider_updated_at,l.created_at))::text
 FROM meta_ads.cafe24_order_lines l,params p WHERE l.is_current AND l.order_date=p.business_date GROUP BY l.connection_id,l.source
 UNION ALL
 SELECT 'COUPANG_SALE','LEGACY_COUPANG_SINGLE_UPLOAD','CSV',count(*),count(*) FILTER(WHERE l.validation_status::text<>'ERROR' AND b.status::text='IMPORTED'),
 sum(l.net_sales_krw)::text,'KRW',max(b.imported_at)::text
 FROM meta_ads.coupang_sale_lines l JOIN meta_ads.coupang_upload_batches b ON b.id=l.upload_batch_id,params p
 WHERE l.is_current AND l.sale_date=p.business_date
 UNION ALL
 SELECT 'COUPANG_AD','LEGACY_COUPANG_SINGLE_UPLOAD','CSV',count(*),count(*) FILTER(WHERE a.validation_status::text<>'ERROR' AND b.status::text='IMPORTED'),
 sum(a.ad_spend_krw)::text,'KRW',max(b.imported_at)::text
 FROM meta_ads.coupang_ad_metrics a JOIN meta_ads.coupang_upload_batches b ON b.id=a.upload_batch_id,params p
 WHERE a.is_current AND a.metric_date=p.business_date
 UNION ALL
 SELECT 'NAVER_SALE',o.payload->>'storeId','JSONB',count(*),count(*) FILTER(WHERE o.payload->>'saleStatus'='SALE'),
 sum(CASE WHEN o.payload->>'saleStatus'='SALE' AND (o.payload->>'productPaymentAmount') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (o.payload->>'productPaymentAmount')::numeric ELSE NULL END)::text,'KRW',max(o.updated_at)::text
 FROM public.order_items o,params p WHERE o.payload->>'paymentDate'=p.business_date::text GROUP BY o.payload->>'storeId'
 UNION ALL
 SELECT 'NAVER_AD',a.payload->>'storeId','JSONB',count(*),count(*) FILTER(WHERE (a.payload->>'totalCost') ~ '^-?[0-9]+([.][0-9]+)?$'),
 sum(CASE WHEN (a.payload->>'totalCost') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (a.payload->>'totalCost')::numeric ELSE NULL END)::text,'KRW',max(a.updated_at)::text
 FROM public.ad_campaign_daily_costs a,params p WHERE a.payload->>'reportDate'=p.business_date::text GROUP BY a.payload->>'storeId'
), cafe_candidates AS (
 SELECT pr.display_name AS canonical_name,count(*) AS current_rows,
 count(*) FILTER(WHERE lower(regexp_replace(trim(l.product_name),'\s+',' ','g'))=lower(regexp_replace(trim(pr.display_name),'\s+',' ','g'))) AS exact_name_rows,
 count(*) FILTER(WHERE l.validation_status::text<>'ERROR') AS nonerror_rows,
 count(*) FILTER(WHERE l.provider_coupon_signal IS NOT NULL) AS coupon_signal_rows,
 count(*) FILTER(WHERE l.actual_order_price_krw IS NOT NULL AND l.actual_shipping_fee_krw IS NOT NULL) AS actual_coupon_inputs_rows,
 sum(l.sale_price_krw*l.quantity)::text AS collected_list_gross,
 (SELECT count(*) FROM meta_ads.product_cost_rules cr,params pd WHERE cr.product_id=pr.id AND cr.effective_from<=pd.business_date AND (cr.effective_to IS NULL OR cr.effective_to>=pd.business_date)) AS valid_cost_rules,
 (SELECT count(*) FROM meta_ads.cafe24_product_rules r,params pd WHERE r.product_id=pr.id AND r.is_active AND r.valid_from<=pd.business_date AND (r.valid_to IS NULL OR r.valid_to>=pd.business_date)) AS valid_unit_name_rules,
 (SELECT count(*) FROM meta_ads.cafe24_coupon_rules r,params pd WHERE (r.product_id=pr.id OR r.product_id IS NULL) AND r.is_active AND r.valid_from<=pd.business_date AND (r.valid_to IS NULL OR r.valid_to>=pd.business_date)) AS valid_coupon_rules
 FROM meta_ads.cafe24_order_lines l JOIN meta_ads.products pr ON pr.id=l.product_id,params p
 WHERE l.is_current AND l.order_date=p.business_date AND pr.is_active
 GROUP BY pr.id,pr.display_name ORDER BY count(*) DESC LIMIT 10
), meta_candidates AS (
 SELECT pr.display_name AS canonical_name,count(*) AS current_rows,
 count(*) FILTER(WHERE lower(regexp_replace(trim(m.adset_name),'\s+',' ','g'))=lower(regexp_replace(trim(pr.display_name),'\s+',' ','g'))) AS exact_name_rows,
 count(*) FILTER(WHERE position(lower(pr.display_name) IN lower(m.adset_name))>0) AS contains_name_rows,
 sum(m.spend_usd)::text AS spend_usd,
 (SELECT count(*) FROM meta_ads.product_cost_rules cr,params pd WHERE cr.product_id=pr.id AND cr.effective_from<=pd.business_date AND (cr.effective_to IS NULL OR cr.effective_to>=pd.business_date) AND cr.fx_rate_krw_per_usd>0) AS fx_fallback_cost_rules
 FROM meta_ads.meta_adset_daily_metrics m JOIN meta_ads.products pr ON pr.id=m.product_id,params p
 WHERE m.is_current AND m.metric_date=p.business_date AND pr.is_active
 GROUP BY pr.id,pr.display_name ORDER BY sum(m.spend_usd) DESC LIMIT 10
), active_catalog AS (
 SELECT display_name AS canonical_name,count(*) AS duplicate_count FROM meta_ads.products WHERE is_active GROUP BY display_name ORDER BY display_name
), collection_runs AS (
 SELECT c.provider::text AS provider,r.trigger::text AS trigger,r.status::text AS status,count(*) AS runs,
 min(r.from_date)::text AS minimum_requested_date,max(r.to_date)::text AS maximum_requested_date,
 max(r.started_at)::text AS latest_started_at,max(r.finished_at)::text AS latest_finished_at,
 sum(r.rows_fetched) AS rows_fetched,sum(r.rows_published) AS rows_published
 FROM meta_ads.sync_runs r JOIN meta_ads.source_connections c ON c.id=r.connection_id,params p
 WHERE r.started_at >= (p.business_date::timestamp AT TIME ZONE 'Asia/Seoul')
 GROUP BY c.provider,r.trigger,r.status
)
SELECT jsonb_build_object(
 'businessDate',(SELECT business_date::text FROM params),'observedAt',now(),'managementReadOnly',true,
 'connections',(SELECT coalesce(jsonb_agg(jsonb_build_object('provider',provider,'scopeKey',id,'currency',currency_code,'timeZone',time_zone,'enabled',enabled,'accessState',access_state,'updatedAt',updated_at) ORDER BY provider),'[]'::jsonb) FROM meta_ads.source_connections),
 'sourceDayRows',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY platform,scope_key,source),'[]'::jsonb) FROM sources s),
 'coverage',(SELECT coalesce(jsonb_agg(jsonb_build_object('scopeKey',connection_id,'dataKind',data_kind,'source',source,'state',state,'rowCount',row_count,'totalAmount',total_amount,'reconciliationStatus',reconciliation_status,'warningCodes',warning_codes,'lastSuccessAt',last_success_at,'lastAttemptAt',last_attempt_at) ORDER BY data_kind),'[]'::jsonb) FROM meta_ads.source_coverage c,params p WHERE c.metric_date=p.business_date),
 'sourcePolicies',(SELECT coalesce(jsonb_agg(jsonb_build_object('scopeKey',connection_id,'dataKind',data_kind,'from',from_date,'to',to_date,'primarySource',primary_source,'couponInputSource',coupon_input_source,'version',version) ORDER BY data_kind,from_date),'[]'::jsonb) FROM meta_ads.source_policies s,params p WHERE s.from_date<=p.business_date AND (s.to_date IS NULL OR s.to_date>p.business_date)),
 'exchangeRates',(SELECT coalesce(jsonb_agg(jsonb_build_object('base',base_currency,'quote',quote_currency,'rate',rate,'sourceDate',source_date,'provider',provider,'fallbackType',fallback_type)),'[]'::jsonb) FROM meta_ads.exchange_rates e,params p WHERE e.rate_date=p.business_date),
 'activeCatalog',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM active_catalog x),
 'cafe24Candidates',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM cafe_candidates x),
 'metaCandidates',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM meta_candidates x),
 'recentCollectionRuns',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY provider,trigger,status),'[]'::jsonb) FROM collection_runs x),
 'scheduleSettingKeys',(SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'updatedAt',updated_at) ORDER BY key),'[]'::jsonb) FROM meta_ads.app_settings WHERE key ~* '(schedule|sync|daily|cron)'),
 'cronCatalogExists',to_regclass('cron.job') IS NOT NULL,
 'unifiedCatalogExists',to_regclass('meta_ads.unified_products') IS NOT NULL,
 'limits','Aggregates only; no raw order identifiers, names, payloads or credentials. Current rows do not by themselves prove API lineage or numeric completeness.'
) AS readiness;
