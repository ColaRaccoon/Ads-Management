WITH naver_orders AS (
 SELECT o.payload->>'storeId' store_id,o.payload->>'paymentDate' business_date,
 position('풀업바' IN concat_ws(' ',o.payload->>'rawProductName',s.payload->>'rawProductNameSnapshot',p.payload->>'productName',u.payload->>'displayName',parent.payload->>'displayName'))>0 target_name
 FROM public.order_items o
 LEFT JOIN public.order_source_signatures s ON s.id=o.payload->>'orderSourceSignatureId'
 LEFT JOIN public.products p ON p.id=o.payload->>'productId'
 LEFT JOIN public.canonical_sales_units u ON u.id=o.payload->>'canonicalSalesUnitId'
 LEFT JOIN public.canonical_sales_units parent ON parent.id=u.payload->>'parentSalesUnitId'
 WHERE o.payload->>'storeId' IN('5ba1d3cf-7aee-4cd1-aecd-d44352f665dd','78f8cb08-ffe3-481a-94d7-be87ae93ed79') AND o.payload->>'paymentDate' BETWEEN '2000-01-01' AND '2026-10-29'
), source_days AS (
 SELECT 'META' platform,coalesce(m.connection_id::text,'LEGACY_UNBOUND') scope_key,m.metric_date::text business_date,m.source::text source,count(*) rows,
 count(*) FILTER(WHERE position('풀업바' IN m.adset_name)>0) named_rows,
 count(*) FILTER(WHERE p.display_name='풀업바') legacy_assigned_rows
 FROM meta_ads.meta_adset_daily_metrics m LEFT JOIN meta_ads.products p ON p.id=m.product_id WHERE m.is_current AND m.metric_date<=DATE '2026-10-29' GROUP BY m.connection_id,m.metric_date,m.source
 UNION ALL
 SELECT 'GOOGLE',g.connection_id::text,g.metric_date::text,g.source::text,count(*),count(*) FILTER(WHERE position('풀업바' IN g.campaign_name)>0),0
 FROM meta_ads.google_campaign_daily_costs g WHERE g.is_current AND g.metric_date<=DATE '2026-10-29' GROUP BY g.connection_id,g.metric_date,g.source
 UNION ALL
 SELECT 'CAFE24',coalesce(l.connection_id::text,'LEGACY_UNBOUND'),l.order_date::text,l.source::text,count(*),count(*) FILTER(WHERE position('풀업바' IN l.product_name)>0),count(*) FILTER(WHERE p.display_name='풀업바')
 FROM meta_ads.cafe24_order_lines l LEFT JOIN meta_ads.products p ON p.id=l.product_id WHERE l.is_current AND l.order_date<=DATE '2026-10-29' GROUP BY l.connection_id,l.order_date,l.source
 UNION ALL
 SELECT 'COUPANG','LEGACY_COUPANG_SINGLE_UPLOAD',l.sale_date::text,'SALE_CSV',count(*),count(*) FILTER(WHERE position('풀업바' IN l.product_name)>0),0
 FROM meta_ads.coupang_sale_lines l JOIN meta_ads.coupang_upload_batches b ON b.id=l.upload_batch_id WHERE l.is_current AND b.status::text='IMPORTED' AND l.sale_date<=DATE '2026-10-29' GROUP BY l.sale_date
 UNION ALL
 SELECT 'COUPANG','LEGACY_COUPANG_SINGLE_UPLOAD',a.metric_date::text,'AD_CSV',count(*),count(*) FILTER(WHERE position('풀업바' IN a.ad_execution_product_name)>0 OR position('풀업바' IN a.conversion_product_name)>0),0
 FROM meta_ads.coupang_ad_metrics a JOIN meta_ads.coupang_upload_batches b ON b.id=a.upload_batch_id WHERE a.is_current AND b.status::text='IMPORTED' AND a.metric_date<=DATE '2026-10-29' GROUP BY a.metric_date
 UNION ALL
 SELECT 'NAVER',store_id,business_date,'SALE_JSON',count(*),count(*) FILTER(WHERE target_name),0 FROM naver_orders GROUP BY store_id,business_date
 UNION ALL
 SELECT 'NAVER',a.payload->>'storeId',a.payload->>'reportDate','AD_JSON',count(*),count(*) FILTER(WHERE position('풀업바' IN coalesce(a.payload->>'campaignName',''))>0),0
 FROM public.ad_campaign_daily_costs a WHERE a.payload->>'storeId' IN('5ba1d3cf-7aee-4cd1-aecd-d44352f665dd','78f8cb08-ffe3-481a-94d7-be87ae93ed79') AND a.payload->>'reportDate' BETWEEN '2000-01-01' AND '2026-10-29' GROUP BY a.payload->>'storeId',a.payload->>'reportDate'
), names AS (
 SELECT 'META' platform,m.adset_name original_name,count(*) rows,count(*) FILTER(WHERE p.display_name='풀업바') legacy_assigned_rows FROM meta_ads.meta_adset_daily_metrics m LEFT JOIN meta_ads.products p ON p.id=m.product_id WHERE m.is_current AND(position('풀업바' IN m.adset_name)>0 OR p.display_name='풀업바') GROUP BY m.adset_name
 UNION ALL SELECT 'GOOGLE',g.campaign_name,count(*),0 FROM meta_ads.google_campaign_daily_costs g WHERE g.is_current AND position('풀업바' IN g.campaign_name)>0 GROUP BY g.campaign_name
 UNION ALL SELECT 'CAFE24',l.product_name,count(*),count(*) FILTER(WHERE p.display_name='풀업바') FROM meta_ads.cafe24_order_lines l LEFT JOIN meta_ads.products p ON p.id=l.product_id WHERE l.is_current AND(position('풀업바' IN l.product_name)>0 OR p.display_name='풀업바') GROUP BY l.product_name
)
SELECT jsonb_build_object('observedAt',now(),'sourceDays',(SELECT jsonb_agg(to_jsonb(d) ORDER BY platform,scope_key,business_date,source) FROM source_days d),
 'productNames',(SELECT jsonb_agg(to_jsonb(n) ORDER BY platform,original_name) FROM names n),
 'existingMetaNameRules',(SELECT coalesce(jsonb_agg(jsonb_build_object('matchType',r.match_type,'pattern',r.pattern,'validFrom',r.valid_from,'validTo',r.valid_to,'active',r.is_active)),'[]'::jsonb) FROM meta_ads.product_match_rules r JOIN meta_ads.products p ON p.id=r.product_id WHERE p.display_name='풀업바'),
 'unifiedRules',(SELECT jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'productId',r.product_id,'platform',r.platform,'scopeKey',r.scope_key,'validFrom',r.valid_from,'validTo',r.valid_to,'payload',r.payload,'active',r.active,'version',r.version)) FROM meta_ads.unified_rules r),
 'policies',(SELECT jsonb_agg(jsonb_build_object('platform',c.provider,'scopeKey',s.connection_id,'kind',s.data_kind,'from',s.from_date,'to',s.to_date,'source',s.primary_source)) FROM meta_ads.source_policies s JOIN meta_ads.source_connections c ON c.id=s.connection_id),
 'legacyCostHistory',(SELECT jsonb_agg(jsonb_build_object('from',c.effective_from,'to',c.effective_to,'salePrice',c.sale_price_krw,'productCost',c.product_cost_krw,'vat',c.vat_krw,'shipping',c.shipping_krw,'otherCost',c.extra_cost_krw,'fx',c.fx_rate_krw_per_usd)) FROM meta_ads.product_cost_rules c JOIN meta_ads.products p ON p.id=c.product_id WHERE p.display_name='풀업바'),
 'fxDateRange',(SELECT jsonb_build_object('from',min(rate_date),'to',max(rate_date),'days',count(DISTINCT rate_date)) FROM meta_ads.exchange_rates WHERE base_currency='USD' AND quote_currency='KRW' AND provider='KOREA_EXIM'),
 'publishedPartitions',(SELECT coalesce(jsonb_agg(jsonb_build_object('platform',platform,'scopeKey',scope_key,'date',business_date)),'[]'::jsonb) FROM meta_ads.unified_source_publications),
 'privacy','Aggregate dates/counts and product rule/name projections only; no customer identifiers, source payloads, authentication or credential values.') AS history;
