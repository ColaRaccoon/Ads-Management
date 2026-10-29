WITH p AS (SELECT DATE '2026-10-28' AS business_date), product AS (SELECT id,display_name FROM meta_ads.products WHERE is_active AND display_name='풀업바')
SELECT jsonb_build_object('businessDate',(SELECT business_date FROM p),'canonicalProduct','풀업바',
 'CAFE24',(SELECT jsonb_build_object('existingMappedRows',count(*),'nameOptionDraftMatches',count(*) FILTER(WHERE position('풀업바' IN l.product_name)>0 AND position('풀업바' IN coalesce(l.option_value,l.option_name))>0 AND position('[유튜브]' IN l.product_name)=0),
 'youtubeNamedRows',count(*) FILTER(WHERE position('[유튜브]' IN l.product_name)>0),'missingSeparateOption',count(*) FILTER(WHERE l.option_value IS NULL),'orderedQuantity',sum(l.quantity)::text,
 'completeProviderCouponInputRows',count(*) FILTER(WHERE l.provider_coupon_signal IS NOT NULL AND l.actual_order_price_krw IS NOT NULL AND l.actual_shipping_fee_krw IS NOT NULL),
 'registeredGrossAt34900',(sum(l.quantity)*34900)::text,'productCostAt10000',(sum(l.quantity)*10000)::text,'registeredVatAt10pct',(sum(l.quantity)*3490)::text)
 FROM meta_ads.cafe24_order_lines l JOIN product x ON x.id=l.product_id,p WHERE l.is_current AND l.order_date=p.business_date AND l.source::text='API'),
 'CAFE24DraftAdditionalCandidates',(SELECT count(*) FROM meta_ads.cafe24_order_lines l,p WHERE l.is_current AND l.order_date=p.business_date AND l.source::text='API' AND position('풀업바' IN l.product_name)>0 AND position('풀업바' IN coalesce(l.option_value,l.option_name))>0 AND position('[유튜브]' IN l.product_name)=0 AND (l.product_id IS NULL OR l.product_id NOT IN (SELECT id FROM product))),
 'META',(SELECT jsonb_build_object('existingMappedRows',count(*),'nameDraftMatches',count(*) FILTER(WHERE position('풀업바' IN m.adset_name)>0),'spendUsd',sum(m.spend_usd)::text)
 FROM meta_ads.meta_adset_daily_metrics m JOIN product x ON x.id=m.product_id,p WHERE m.is_current AND m.metric_date=p.business_date AND m.source::text='API'),
 'METADraftAdditionalCandidates',(SELECT count(*) FROM meta_ads.meta_adset_daily_metrics m,p WHERE m.is_current AND m.metric_date=p.business_date AND m.source::text='API' AND position('풀업바' IN m.adset_name)>0 AND (m.product_id IS NULL OR m.product_id NOT IN (SELECT id FROM product))),
 'privacy','Only pre-existing canonical name and aggregate draft-condition counts. No source-name/order/payload values.') AS bootstrap_match;
