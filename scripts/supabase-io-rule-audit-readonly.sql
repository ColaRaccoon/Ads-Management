SELECT created_at,action,
  before_json ? 'validFrom' AND after_json ? 'validFrom' AS date_fields_captured,
  before_json ? 'salePriceKrwOverride' AND after_json ? 'salePriceKrwOverride' AS price_fields_captured,
  ARRAY(SELECT key FROM jsonb_each(before_json) b WHERE b.value IS DISTINCT FROM after_json->b.key) AS captured_changed_fields
FROM meta_ads.security_audit_events
WHERE action IN ('CAFE24_MAPPING_RULE_UPDATED','CAFE24_MAPPING_RULE_DEACTIVATED','CAFE24_MAPPING_RULE_CREATED')
  AND created_at>=TIMESTAMP '2026-11-04 05:11:50.923'
ORDER BY created_at DESC LIMIT 5;
