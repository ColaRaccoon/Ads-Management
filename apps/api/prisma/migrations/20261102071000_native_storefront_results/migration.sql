-- Add the canonical native result alongside the unchanged immutable source ledger.
-- Preserve attribution, fact-key and JSON validation; existing publications remain valid.
ALTER TABLE meta_ads.unified_daily_facts
  DROP CONSTRAINT unified_fact_valid,
  ADD CONSTRAINT unified_fact_valid CHECK (
    component IN ('SALE','AD_SPEND','COMMON_EXPENSE','SHIPPING_INCOME','STOREFRONT_RESULT')
    AND attribution IN ('DIRECT','ALLOCATED','UNALLOCATED')
    AND btrim(fact_key) <> '' AND jsonb_typeof(payload)='object'
  );
