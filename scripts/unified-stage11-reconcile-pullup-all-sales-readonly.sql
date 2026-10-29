WITH p AS (SELECT DATE '2026-10-28' AS business_date),
matched AS (
 SELECT l.product_name,l.option_value,l.option_name,l.quantity,l.sale_price_krw,l.provider_coupon_signal,l.actual_order_price_krw,l.actual_shipping_fee_krw,
 l.validation_status::text AS validation_status,l.product_id,l.connection_id
 FROM meta_ads.cafe24_order_lines l,p WHERE l.is_current AND l.source::text='API' AND l.order_date=p.business_date
 AND position('풀업바' IN l.product_name)>0 AND position('풀업바' IN coalesce(l.option_value,l.option_name))>0
), grouped AS (
 SELECT CASE WHEN position('[유튜브]' IN product_name)>0 THEN 'YOUTUBE_LABEL' ELSE 'GENERAL_LABEL' END AS source_label,
 count(*) AS rows,sum(quantity)::text AS ordered_quantity,sum(quantity*sale_price_krw)::text AS collected_list_gross,
 count(*) FILTER(WHERE validation_status<>'ERROR') AS nonerror_rows,
 count(*) FILTER(WHERE provider_coupon_signal IS NOT NULL AND actual_order_price_krw IS NOT NULL AND actual_shipping_fee_krw IS NOT NULL) AS complete_coupon_input_rows,
 count(*) FILTER(WHERE product_id IS NULL) AS legacy_unmapped_rows
 FROM matched GROUP BY CASE WHEN position('[유튜브]' IN product_name)>0 THEN 'YOUTUBE_LABEL' ELSE 'GENERAL_LABEL' END
), safe_names AS (
 SELECT product_name,coalesce(option_value,option_name) AS option_name,count(*) AS rows,sum(quantity)::text AS ordered_quantity
 FROM matched WHERE length(product_name)<=256 AND length(coalesce(option_value,option_name))<=256
 AND product_name !~ '([0-9]{2,3}[- .]?[0-9]{3,4}[- .]?[0-9]{4}|@|[0-9]{8,})'
 AND coalesce(option_value,option_name) !~ '([0-9]{2,3}[- .]?[0-9]{3,4}[- .]?[0-9]{4}|@|[0-9]{8,})'
 GROUP BY product_name,coalesce(option_value,option_name) ORDER BY count(*) DESC LIMIT 20
), mappings AS (
 SELECT g.connection_id,g.option_scope,g.option_name,g.sale_unit_label,pr.display_name AS canonical_name,
 g.sale_price_krw_override::text,g.product_cost_krw_override::text,g.shipping_krw_override::text,g.extra_cost_krw_override::text,g.start_date,g.end_date
 FROM meta_ads.google_performance_mappings g JOIN meta_ads.products pr ON pr.id=g.product_id,p
 WHERE g.kind::text='SALE' AND pr.display_name='풀업바' AND g.start_date<=p.business_date AND (g.end_date IS NULL OR g.end_date>=p.business_date)
)
SELECT jsonb_build_object('businessDate',(SELECT business_date FROM p),'canonicalName','풀업바',
 'matchedGroups',(SELECT jsonb_agg(to_jsonb(x)) FROM grouped x),'safeProductOptionNames',(SELECT jsonb_agg(to_jsonb(x)) FROM safe_names x),
 'googleSaleMappings',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM mappings x),
 'total',(SELECT jsonb_build_object('rows',count(*),'orderedQuantity',sum(quantity)::text,'collectedListGross',sum(quantity*sale_price_krw)::text) FROM matched),
 'privacy','Only phone/email-free product and option names, no order/customer identifiers or raw payload.') AS all_pullup_sales;
