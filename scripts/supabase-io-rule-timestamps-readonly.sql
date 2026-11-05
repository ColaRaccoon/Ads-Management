SELECT
 (SELECT max(updated_at) FROM meta_ads.cafe24_product_rules) AS latest_cafe_product_rule_update,
 (SELECT jsonb_agg(x) FROM (SELECT updated_at,is_active,valid_from,valid_to FROM meta_ads.cafe24_product_rules
   WHERE updated_at>TIMESTAMP '2026-11-04 05:11:50.923' ORDER BY updated_at DESC LIMIT 10) x) AS recently_changed_rule_dates,
 (SELECT jsonb_build_object('rules_updated_after_previous_publication',count(*),'currently_inactive',count(*) FILTER(WHERE NOT is_active),'latest_update',max(updated_at))
   FROM meta_ads.cafe24_product_rules WHERE updated_at>TIMESTAMP '2026-11-04 05:12:01.660'
     AND (valid_from IS NULL OR valid_from<=DATE '2026-11-03')
     AND (valid_to IS NULL OR valid_to>=DATE '2026-11-03')) AS updated_rules_overlapping_changed_day,
 (SELECT max(updated_at) FROM meta_ads.cafe24_coupon_rules) AS latest_cafe_coupon_rule_update,
 (SELECT max(updated_at) FROM meta_ads.product_cost_rules) AS latest_product_cost_rule_update,
 (SELECT max(updated_at) FROM meta_ads.products) AS latest_product_update,
 (SELECT max(updated_at) FROM meta_ads.google_performance_mappings) AS latest_google_mapping_update,
 (SELECT jsonb_agg(x) FROM (SELECT created_at,action FROM meta_ads.unified_mapping_audits
   WHERE created_at>=TIMESTAMPTZ '2026-11-04T05:12:00Z' ORDER BY created_at DESC LIMIT 5) x) AS recent_unified_audits;
