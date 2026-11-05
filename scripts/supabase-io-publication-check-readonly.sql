WITH recent AS (
 SELECT id,platform,business_date,checkpoint,versions,source_fingerprint
 FROM meta_ads.unified_aggregation_runs
 WHERE status='PUBLISHED' AND started_at >= TIMESTAMPTZ '2026-11-04T06:05:00Z'
   AND started_at < TIMESTAMPTZ '2026-11-04T06:23:08Z'
 ORDER BY started_at DESC LIMIT 10
)
SELECT n.platform,n.business_date,n.id,
  p.id IS NOT NULL AS previous_found,
  n.source_fingerprint IS DISTINCT FROM p.source_fingerprint AS fingerprint_changed,
  n.versions IS DISTINCT FROM p.versions AS versions_changed,
  NOT EXISTS (
    (SELECT component,fact_key,product_name,sale_unit_name,amount_krw,original_amount,currency,quantity,attribution,
      payload->'nativeResult'->'revenue' revenue,payload->'nativeResult'->'adSpend' ad_spend,
      payload->'nativeResult'->'netProfit' net_profit,payload->'nativeResult'->'profitBeforeAds' profit_before_ads
     FROM meta_ads.unified_daily_facts WHERE run_id=n.id
     EXCEPT ALL
     SELECT component,fact_key,product_name,sale_unit_name,amount_krw,original_amount,currency,quantity,attribution,
      payload->'nativeResult'->'revenue',payload->'nativeResult'->'adSpend',
      payload->'nativeResult'->'netProfit',payload->'nativeResult'->'profitBeforeAds'
     FROM meta_ads.unified_daily_facts WHERE run_id=p.id)
    UNION ALL
    (SELECT component,fact_key,product_name,sale_unit_name,amount_krw,original_amount,currency,quantity,attribution,
      payload->'nativeResult'->'revenue',payload->'nativeResult'->'adSpend',
      payload->'nativeResult'->'netProfit',payload->'nativeResult'->'profitBeforeAds'
     FROM meta_ads.unified_daily_facts WHERE run_id=p.id
     EXCEPT ALL
     SELECT component,fact_key,product_name,sale_unit_name,amount_krw,original_amount,currency,quantity,attribution,
      payload->'nativeResult'->'revenue',payload->'nativeResult'->'adSpend',
      payload->'nativeResult'->'netProfit',payload->'nativeResult'->'profitBeforeAds'
     FROM meta_ads.unified_daily_facts WHERE run_id=n.id)
  ) AS financial_facts_equal
FROM recent n LEFT JOIN meta_ads.unified_aggregation_runs p ON p.id=(n.checkpoint->>'previousRunId')::uuid;
