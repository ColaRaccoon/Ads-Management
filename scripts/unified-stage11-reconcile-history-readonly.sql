WITH params AS (SELECT DATE '2026-09-29' AS from_date,DATE '2026-10-27' AS to_date,'be140e7e-3994-406e-94ff-b50dfc7ac7b2'::uuid AS scope_id),
selected_product AS (SELECT id,name,display_name,is_active,created_at,updated_at FROM meta_ads.products WHERE display_name='풀업바'),
cost_rules AS (
 SELECT c.id,c.product_id,c.sale_price_krw::text,c.product_cost_krw::text,c.vat_krw::text,c.shipping_krw::text,c.extra_cost_krw::text,c.effective_from,c.effective_to,c.created_at,c.updated_at
 FROM meta_ads.product_cost_rules c WHERE c.product_id IN(SELECT id FROM selected_product)
), cafe_rules AS (
 SELECT r.id,r.product_id,r.is_active,r.match_target,r.product_name_include_keywords,r.product_name_exclude_keywords,r.option_include_keywords,r.option_exclude_keywords,
 r.sale_price_krw_override::text,r.product_cost_krw_override::text,r.shipping_krw_override::text,r.extra_cost_krw_override::text,r.valid_from,r.valid_to,r.created_at,r.updated_at
 FROM meta_ads.cafe24_product_rules r WHERE r.product_id IN(SELECT id FROM selected_product)
), target_audit AS (
 SELECT a.created_at,a.action,a.result::text,a.target_type,
 (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(coalesce(a.before_json,'{}'::jsonb)) k) AS before_field_names,
 (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(coalesce(a.after_json,'{}'::jsonb)) k) AS after_field_names,
 jsonb_build_object('salePriceKrw',a.before_json->'salePriceKrw','productCostKrw',a.before_json->'productCostKrw','effectiveFrom',a.before_json->'effectiveFrom','effectiveTo',a.before_json->'effectiveTo','isActive',a.before_json->'isActive','optionIncludeKeywords',a.before_json->'optionIncludeKeywords','productNameExcludeKeywords',a.before_json->'productNameExcludeKeywords') AS before_selected,
 jsonb_build_object('salePriceKrw',a.after_json->'salePriceKrw','productCostKrw',a.after_json->'productCostKrw','effectiveFrom',a.after_json->'effectiveFrom','effectiveTo',a.after_json->'effectiveTo','isActive',a.after_json->'isActive','optionIncludeKeywords',a.after_json->'optionIncludeKeywords','productNameExcludeKeywords',a.after_json->'productNameExcludeKeywords') AS after_selected
 FROM meta_ads.security_audit_events a WHERE a.target_type IN('PRODUCT','PRODUCT_COST_RULE','CAFE24_PRODUCT_RULE') AND
 (a.target_id IN(SELECT id::text FROM selected_product UNION ALL SELECT id::text FROM cost_rules UNION ALL SELECT id::text FROM cafe_rules)
 OR a.before_json->>'productId' IN(SELECT id::text FROM selected_product) OR a.after_json->>'productId' IN(SELECT id::text FROM selected_product))
), selected_notes AS (
 SELECT action_date,created_at,updated_at,position('34900' IN log_text)>0 OR position('34,900' IN log_text)>0 AS mentions_sale_34900,
 position('10000' IN log_text)>0 OR position('10,000' IN log_text)>0 AS mentions_cost_10000
 FROM meta_ads.product_change_logs WHERE product_id IN(SELECT id FROM selected_product)
), per_day_config AS (
 SELECT d::date AS business_date,count(c.id) AS currently_stored_applicable_cost_rules,
 bool_and(c.sale_price_krw::numeric=34900 AND c.product_cost_krw::numeric=10000) AS all_applicable_costs_34900_10000
 FROM params p CROSS JOIN LATERAL generate_series(p.from_date,p.to_date,interval '1 day') d
 LEFT JOIN cost_rules c ON c.effective_from<=d::date AND(c.effective_to IS NULL OR c.effective_to>=d::date) GROUP BY d
), source_option_evidence AS (
 SELECT l.order_date,l.source::text,count(*) AS product_name_rows,
 count(*) FILTER(WHERE position('풀업바(72~97cm)' IN coalesce(l.option_value,l.option_name,''))>0) AS exact_target_option_rows,
 count(*) FILTER(WHERE position('[유튜브]' IN l.product_name)>0) AS youtube_label_rows,
 min(l.sale_price_krw)::text AS minimum_stored_source_unit_price,max(l.sale_price_krw)::text AS maximum_stored_source_unit_price,
 min(l.created_at) AS earliest_row_created_at,max(l.created_at) AS latest_row_created_at
 FROM meta_ads.cafe24_order_lines l,params p WHERE l.is_current AND l.connection_id=p.scope_id AND l.order_date BETWEEN p.from_date AND p.to_date AND position('풀업바' IN l.product_name)>0 GROUP BY l.order_date,l.source
)
SELECT jsonb_build_object('requestedRange',(SELECT jsonb_build_object('from',from_date,'through',to_date) FROM params),
 'legacyProducts',(SELECT jsonb_agg(to_jsonb(x)) FROM selected_product x),
 'allStoredLegacyCostRules',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY effective_from,created_at),'[]'::jsonb) FROM cost_rules x),
 'allStoredLegacyCafeRules',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY valid_from,created_at),'[]'::jsonb) FROM cafe_rules x),
 'relatedSecurityAudit',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY created_at),'[]'::jsonb) FROM target_audit x),
 'productNotesMetadata',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY created_at),'[]'::jsonb) FROM selected_notes x),
 'currentDatedConfigurationCoverage',(SELECT jsonb_build_object('days',count(*),'firstDay',min(business_date),'lastDay',max(business_date),'exactlyOne34900_10000RuleDays',count(*) FILTER(WHERE currently_stored_applicable_cost_rules=1 AND all_applicable_costs_34900_10000),'missingOrAmbiguousDays',count(*) FILTER(WHERE currently_stored_applicable_cost_rules<>1 OR NOT coalesce(all_applicable_costs_34900_10000,false))) FROM per_day_config),
 'sourceOptionEvidence',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY order_date,source),'[]'::jsonb) FROM source_option_evidence x),
 'sourceRuleAuditTriggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'trigger',t.tgname)),'[]'::jsonb) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='meta_ads' AND c.relname IN('products','product_cost_rules','cafe24_product_rules')),
 'privacy','No order identifiers, customer fields, free-text notes, actor identity, credential or raw audit payload returned; audit JSON is explicit business-field projection only.',
 'limitation','Current dated configuration and mutable record timestamps are not by themselves immutable evidence of which value was stored or applied on each historical transaction day. No historical revenue/profit is recomputed.') AS history_evidence;
