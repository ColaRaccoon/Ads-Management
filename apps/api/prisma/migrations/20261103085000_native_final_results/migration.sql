-- Extend the immutable fact ledger with the original platform's final results.
-- No source data, historical payloads, policies or publication pointers change.
ALTER TABLE meta_ads.unified_daily_facts DROP CONSTRAINT unified_fact_valid,
  ADD CONSTRAINT unified_fact_valid CHECK (
    component IN ('SALE','AD_SPEND','COMMON_EXPENSE','SHIPPING_INCOME','STOREFRONT_RESULT','NATIVE_RESULT')
    AND attribution IN ('DIRECT','ALLOCATED','UNALLOCATED')
    AND btrim(fact_key) <> '' AND jsonb_typeof(payload) = 'object'
  );
