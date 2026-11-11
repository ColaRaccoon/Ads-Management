BEGIN;

ALTER TABLE influencer_projection_days ADD COLUMN manager_matching_attempted boolean NOT NULL DEFAULT false;
ALTER TABLE influencer_daily_performances ADD COLUMN matching_version integer NOT NULL DEFAULT 1;

-- Scope existing reservations to the collaboration's handler while preserving the displayed number.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM influencer_number_reservations r JOIN influencer_collaborations c ON c.id = r.collaboration_id
    WHERE c.product_id IS NULL OR c.manager_name IS NULL OR btrim(c.manager_name) = ''
  ) THEN RAISE EXCEPTION 'A numbered collaboration requires a product and handler'; END IF;
END $$;

UPDATE influencer_number_reservations r
SET number_key = c.product_id::text || ':' || lower(btrim(regexp_replace(normalize(c.manager_name, NFKC), '[[:space:]]+', ' ', 'g')))
  || ':' || regexp_replace(r.material_no, '^0+(?=[0-9])', '')
FROM influencer_collaborations c WHERE c.id = r.collaboration_id;

-- Reject writes from the previous release during rollout instead of saving an unscoped number.
ALTER TABLE influencer_number_reservations ADD CONSTRAINT influencer_number_reservations_manager_scope_check
  CHECK (number_key ~ '^[0-9a-f-]{36}:.+:[0-9]{1,16}$');

-- Hide the superseded snapshot immediately. The independent worker publishes corrected stored totals.
UPDATE influencer_collaborations
SET ad_spend_krw = 0, ad_margin_krw = 0, net_performance_krw = -fee_krw,
  data_through = NULL, aggregated_at = NULL, creative_count = 0, creative_totals = '[]'::jsonb,
  needs_backfill = true, last_job_at = NULL
WHERE deleted_at IS NULL;

COMMIT;
