BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
WITH active_uploads AS (
  SELECT id FROM public.ad_excel_uploads
  WHERE payload->>'isActive' = 'true' AND payload->>'state' = 'CONFIRMED'
    AND payload->>'weekdayValidationStatus' = 'PASSED'
), rows AS (
  SELECT 'META_CURRENT' AS source, metric_date::text AS day, product_id IS NOT NULL AS mapped
    FROM meta_ads.meta_adset_daily_metrics WHERE is_current
  UNION ALL SELECT 'GOOGLE_CURRENT', metric_date::text, NULL::boolean
    FROM meta_ads.google_campaign_daily_costs WHERE is_current
  UNION ALL SELECT 'CAFE24_CURRENT', order_date::text, product_id IS NOT NULL
    FROM meta_ads.cafe24_order_lines WHERE is_current
  UNION ALL SELECT 'COUPANG_SALES_CURRENT', sale_date::text, coupang_product_id IS NOT NULL
    FROM meta_ads.coupang_sale_lines WHERE is_current
  UNION ALL SELECT 'COUPANG_ADS_CURRENT', metric_date::text, spend_product_id IS NOT NULL
    FROM meta_ads.coupang_ad_metrics WHERE is_current
  UNION ALL SELECT 'NAVER_SALE', payload->>'paymentDate', NULLIF(payload->>'canonicalSalesUnitId','') IS NOT NULL
    FROM public.order_items WHERE payload->>'saleStatus' = 'SALE'
  UNION ALL SELECT 'NAVER_ADS_CONFIRMED', a.payload->>'reportDate', NULLIF(a.payload->>'canonicalSalesUnitId','') IS NOT NULL
    FROM public.ad_campaign_daily_costs a JOIN active_uploads u ON u.id = a.payload->>'sourceUploadId'
  UNION ALL SELECT 'NAVER_PROFIT_STORED', payload->>'date', NULL::boolean
    FROM public.daily_sales_unit_profits
)
SELECT 'source_inventory' AS category, source AS name,
  jsonb_build_object('rows',count(*),'minDate',min(day),'maxDate',max(day),
    'recentRows',count(*) FILTER(WHERE day BETWEEN '2026-07-29' AND '2026-10-26'),
    'recentDates',count(DISTINCT day) FILTER(WHERE day BETWEEN '2026-07-29' AND '2026-10-26'),
    'recentMappedRows',count(*) FILTER(WHERE day BETWEEN '2026-07-29' AND '2026-10-26' AND mapped),
    'recentUnmappedRows',count(*) FILTER(WHERE day BETWEEN '2026-07-29' AND '2026-10-26' AND NOT mapped)) AS detail
FROM rows GROUP BY source
UNION ALL
SELECT 'runtime_access', table_schema || '.' || table_name,
  jsonb_build_object('schemaUsage',has_schema_privilege('meta_ads_app',table_schema,'USAGE'),
    'select',has_table_privilege('meta_ads_app',format('%I.%I',table_schema,table_name),'SELECT'))
FROM information_schema.tables WHERE table_schema='public'
  AND table_name IN ('order_items','canonical_sales_units','ad_campaign_daily_costs','ad_excel_uploads','daily_sales_unit_profits','daily_store_summaries','daily_fake_purchases','order_sync_states')
UNION ALL
SELECT 'naver_profit_version', coalesce(payload->>'calculationVersion','NULL'),
  jsonb_build_object('rows',count(*),'latestCalculatedAt',max(payload->>'calculatedAt'))
FROM public.daily_sales_unit_profits GROUP BY payload->>'calculationVersion'
ORDER BY category,name;
ROLLBACK;
