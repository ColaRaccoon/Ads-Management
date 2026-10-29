WITH parameters AS (SELECT DATE '2026-10-28' AS business_date,'be140e7e-3994-406e-94ff-b50dfc7ac7b2'::uuid AS scope_id,'9f71c8bb-b34d-4c0f-adcf-fc74aa1d2f3c'::uuid AS run_id),
current_source AS (
 SELECT l.order_no,l.order_line_key,l.quantity,l.sale_price_krw,l.provider_coupon_signal,l.actual_order_price_krw,l.actual_shipping_fee_krw,l.total_paid_krw,l.validation_status,
   CASE WHEN position('[유튜브]' IN l.product_name)>0 THEN 'YOUTUBE_LABEL' ELSE 'GENERAL_LABEL' END AS source_label,
   (position('풀업바' IN l.product_name)>0 AND position('풀업바' IN coalesce(l.option_value,l.option_name))>0) AS name_draft_matches,
   encode(extensions.digest('['||to_jsonb('CAFE24'::text)::text||','||to_jsonb(p.scope_id::text)::text||','||to_jsonb('ORDER_LINE'::text)::text||','||to_jsonb(l.source::text||':'||l.order_line_key)::text||']','sha256'),'hex') AS private_join_hash
 FROM meta_ads.cafe24_order_lines l,parameters p WHERE l.is_current AND l.source::text='API' AND l.connection_id=p.scope_id AND l.order_date=p.business_date
), order_contexts AS (
 SELECT order_no,count(*) AS context_rows,count(*) FILTER(WHERE NOT name_draft_matches) AS unclassified_context_rows,
 count(*) FILTER(WHERE provider_coupon_signal IS NULL) AS missing_signal_rows,count(DISTINCT provider_coupon_signal) AS signal_values,bool_or(provider_coupon_signal) AS coupon_signal,
 count(*) FILTER(WHERE validation_status::text='ERROR') AS invalid_context_rows,
 count(*) FILTER(WHERE actual_order_price_krw IS NULL OR actual_shipping_fee_krw IS NULL) AS missing_actual_total_rows,
 max(actual_order_price_krw+actual_shipping_fee_krw)-min(actual_order_price_krw+actual_shipping_fee_krw) AS actual_total_spread,
 max(total_paid_krw)-min(total_paid_krw) AS paid_total_spread,
 min(actual_order_price_krw+actual_shipping_fee_krw)-min(total_paid_krw) AS payment_gap
 FROM current_source GROUP BY order_no
), matched AS (
 SELECT s.quantity,s.sale_price_krw,s.provider_coupon_signal,s.name_draft_matches,s.source_label,
 m.evidence->>'operatingRevenue' AS operating_revenue,m.evidence->>'profitBeforeAds' AS profit_before_ads,
 c.context_rows,c.unclassified_context_rows,c.missing_signal_rows,c.signal_values,c.coupon_signal,c.invalid_context_rows,c.missing_actual_total_rows,c.actual_total_spread,c.paid_total_spread,c.payment_gap,
 s.order_no
 FROM current_source s JOIN meta_ads.unified_product_match_results m ON m.source_key=s.private_join_hash JOIN order_contexts c ON c.order_no=s.order_no,parameters p
 WHERE m.run_id=p.run_id AND m.product_name='풀업바'
), cohorts AS (
 SELECT CASE WHEN operating_revenue IS NULL THEN 'REVENUE_UNKNOWN' WHEN profit_before_ads IS NULL THEN 'REVENUE_KNOWN_PROFIT_UNKNOWN' ELSE 'REVENUE_AND_PROFIT_KNOWN' END AS cohort,
 count(*) AS rows,sum(quantity)::text AS ordered_quantity,sum(quantity*34900)::text AS registered_gross,
 sum(quantity*10000)::text AS registered_product_cost,sum(quantity*3490)::text AS registered_vat,
 sum(operating_revenue::numeric)::text AS published_operating_revenue,sum(profit_before_ads::numeric)::text AS published_profit_before_ads,
 count(*) FILTER(WHERE coupon_signal) AS coupon_signal_rows,
 count(*) FILTER(WHERE unclassified_context_rows>0) AS rows_with_unclassified_order_siblings,
 count(*) FILTER(WHERE missing_signal_rows>0 OR signal_values<>1) AS rows_with_unknown_signal_context,
 count(*) FILTER(WHERE invalid_context_rows>0 OR missing_actual_total_rows>0) AS rows_with_other_context_gaps
 FROM matched GROUP BY CASE WHEN operating_revenue IS NULL THEN 'REVENUE_UNKNOWN' WHEN profit_before_ads IS NULL THEN 'REVENUE_KNOWN_PROFIT_UNKNOWN' ELSE 'REVENUE_AND_PROFIT_KNOWN' END
), active_coupon_rules AS (
 SELECT r.scope::text,r.discount_krw::text,r.priority FROM meta_ads.cafe24_coupon_rules r,parameters p
 WHERE r.is_active AND r.valid_from<=p.business_date AND (r.valid_to IS NULL OR r.valid_to>=p.business_date)
 AND (r.product_id IS NULL OR r.product_id IN(SELECT id FROM meta_ads.products WHERE name='풀업바' AND is_active))
), eligible_coupon_orders AS (
 SELECT DISTINCT order_no FROM matched WHERE operating_revenue IS NOT NULL AND coupon_signal
 AND unclassified_context_rows=0 AND missing_signal_rows=0 AND signal_values=1 AND invalid_context_rows=0 AND missing_actual_total_rows=0
 AND actual_total_spread<=1 AND paid_total_spread<=1 AND payment_gap>0 AND payment_gap+1>=1000
), published_product AS (
 SELECT count(*) AS fact_groups,sum(quantity)::text AS ordered_quantity,sum(amount_krw)::text AS known_revenue,
 sum((payload->>'profitBeforeAds')::numeric)::text AS known_profit,sum((payload->>'rowsCount')::int) AS source_rows
 FROM meta_ads.unified_daily_facts f,parameters p WHERE f.run_id=p.run_id AND f.product_name='풀업바' AND f.component='SALE'
)
SELECT jsonb_build_object('businessDate',(SELECT business_date FROM parameters),'runId',(SELECT run_id FROM parameters),'canonicalProduct','풀업바',
 'sourceMatchAuditJoinedRows',(SELECT count(*) FROM matched),'sourceMatchesWithoutAudit',(SELECT count(*) FROM current_source s WHERE s.name_draft_matches AND NOT EXISTS(SELECT 1 FROM meta_ads.unified_product_match_results m,parameters p WHERE m.run_id=p.run_id AND m.source_key=s.private_join_hash AND m.product_name='풀업바')),
 'cohorts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY cohort) FROM cohorts x),
 'labelCohorts',(SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT source_label,operating_revenue IS NOT NULL AS revenue_known,count(*) AS rows,sum(quantity)::text AS ordered_quantity,sum(quantity*34900)::text AS registered_gross,sum(operating_revenue::numeric)::text AS known_revenue FROM matched GROUP BY source_label,operating_revenue IS NOT NULL ORDER BY source_label,operating_revenue IS NOT NULL) x),
 'independentGlobalCouponCalculation',jsonb_build_object('activeRules',(SELECT jsonb_agg(to_jsonb(x)) FROM active_coupon_rules x),'singleGlobal1000RuleConfirmed',(SELECT count(*)=1 AND bool_and(scope='GLOBAL' AND discount_krw::numeric=1000) FROM active_coupon_rules),'eligibleOrders',(SELECT count(*) FROM eligible_coupon_orders),'configuredRuleAmount','1000','knownCouponTotal',((SELECT count(*) FROM eligible_coupon_orders)*1000)::text),
 'publishedProduct',(SELECT to_jsonb(x) FROM published_product x),
 'independentKnownArithmetic',jsonb_build_object('knownRevenue',((SELECT sum(quantity*34900) FROM matched WHERE operating_revenue IS NOT NULL)-(SELECT count(*) FROM eligible_coupon_orders)*1000)::text,
 'knownProfit',((SELECT sum(quantity*(34900-10000-3490)) FROM matched WHERE operating_revenue IS NOT NULL)-(SELECT count(*) FROM eligible_coupon_orders)*1000)::text),
 'privacy','All order identifiers and source join hashes stay inside CTEs; only cohort counts/quantities/money and safe published run ID returned.') AS cafe24_cohorts;
