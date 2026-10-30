SELECT id,platform,scope_key,business_date,attempts,lease_expires_at FROM meta_ads.unified_aggregation_runs WHERE status='STAGING' AND attempts>0 ORDER BY business_date,platform;
