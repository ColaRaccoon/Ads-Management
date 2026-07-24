-- This migration is intentionally defensive. Run the read-only audit first and
-- take an external pg_dump as well when applying it outside a disposable DB.

BEGIN;

LOCK TABLE coupang_cost_rules IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  duplicate_group_count integer;
  unexpected_duplicate_group_count integer;
  unexpected_shipping_count integer;
  total_row_count integer;
  july_01_row_count integer;
  july_22_row_count integer;
  july_01_canonical_id uuid;
  july_22_canonical_id uuid;
  approved_duplicate_fingerprint text;
  actual_duplicate_fingerprint text;
BEGIN
  SELECT count(*) INTO duplicate_group_count
  FROM (
    SELECT coupang_product_id, effective_from
    FROM coupang_cost_rules
    GROUP BY coupang_product_id, effective_from
    HAVING count(*) > 1
  ) duplicate_groups;

  SELECT count(*) INTO unexpected_duplicate_group_count
  FROM (
    SELECT coupang_product_id, effective_from
    FROM coupang_cost_rules
    GROUP BY coupang_product_id, effective_from
    HAVING count(*) > 1
  ) duplicate_groups
  WHERE coupang_product_id <> '2ef42677-d4b9-4d11-aae8-9b79c0c952bd'::uuid
     OR effective_from NOT IN (DATE '2026-07-01', DATE '2026-07-22');

  -- A fresh/clean database has no duplicates and needs no production-specific
  -- baseline assertion. Once any duplicate exists, however, require the exact
  -- audited production snapshot before deleting a single row.
  IF duplicate_group_count > 0 THEN
    IF unexpected_duplicate_group_count > 0 OR duplicate_group_count <> 2 THEN
      RAISE EXCEPTION 'COST_RULE_AUDIT_ABORT: expected exactly 2 audited duplicate groups and found % total (% unexpected)', duplicate_group_count, unexpected_duplicate_group_count;
    END IF;

    SELECT count(*) INTO total_row_count FROM coupang_cost_rules;
    IF total_row_count <> 122 THEN
      RAISE EXCEPTION 'COST_RULE_AUDIT_ABORT: expected exactly 122 audited cost-rule rows and found %', total_row_count;
    END IF;

    SELECT count(*) INTO july_01_row_count
    FROM coupang_cost_rules
    WHERE coupang_product_id = '2ef42677-d4b9-4d11-aae8-9b79c0c952bd'::uuid
      AND effective_from = DATE '2026-07-01';

    SELECT count(*) INTO july_22_row_count
    FROM coupang_cost_rules
    WHERE coupang_product_id = '2ef42677-d4b9-4d11-aae8-9b79c0c952bd'::uuid
      AND effective_from = DATE '2026-07-22';

    IF july_01_row_count <> 3 OR july_22_row_count <> 2 THEN
      RAISE EXCEPTION 'COST_RULE_AUDIT_ABORT: expected audited row counts 2026-07-01=3 and 2026-07-22=2, found % and %', july_01_row_count, july_22_row_count;
    END IF;

    -- The five approved duplicate rows must be authorized out of band after a
    -- read-only preflight. The fingerprint covers every persisted value and is
    -- stable because rows are serialized in deterministic chronological/id order.
    SELECT md5(string_agg(
      jsonb_build_array(
        id, coupang_product_id, sale_price_krw, supply_price_krw, product_cost_krw,
        sales_fee_rate, sales_fee_krw, seller_shipping_fee_krw, hanaro_shipping_fee_krw,
        growth_inbound_fee_krw, growth_shipping_fee_krw, return_rate,
        return_cost_per_unit_krw, extra_cost_krw, effective_from, effective_to,
        note, created_at, updated_at
      )::text,
      E'\n' ORDER BY effective_from, created_at, id
    )) INTO actual_duplicate_fingerprint
    FROM coupang_cost_rules
    WHERE coupang_product_id = '2ef42677-d4b9-4d11-aae8-9b79c0c952bd'::uuid
      AND effective_from IN (DATE '2026-07-01', DATE '2026-07-22');

    approved_duplicate_fingerprint := nullif(
      current_setting('meta_ads.approved_coupang_cost_rule_duplicate_fingerprint', true),
      ''
    );
    IF approved_duplicate_fingerprint IS NULL THEN
      RAISE EXCEPTION 'COST_RULE_AUDIT_ABORT: approved duplicate fingerprint is missing; run the read-only preflight and set meta_ads.approved_coupang_cost_rule_duplicate_fingerprint (actual=%)', actual_duplicate_fingerprint;
    END IF;
    IF approved_duplicate_fingerprint <> actual_duplicate_fingerprint THEN
      RAISE EXCEPTION 'COST_RULE_AUDIT_ABORT: approved duplicate fingerprint mismatch (approved=%, actual=%)', approved_duplicate_fingerprint, actual_duplicate_fingerprint;
    END IF;

    SELECT id INTO july_01_canonical_id
    FROM coupang_cost_rules
    WHERE coupang_product_id = '2ef42677-d4b9-4d11-aae8-9b79c0c952bd'::uuid
      AND effective_from = DATE '2026-07-01'
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    SELECT id INTO july_22_canonical_id
    FROM coupang_cost_rules
    WHERE coupang_product_id = '2ef42677-d4b9-4d11-aae8-9b79c0c952bd'::uuid
      AND effective_from = DATE '2026-07-22'
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    IF july_01_canonical_id <> '9b2cb398-f0f9-4e8a-bbb8-85d90a71c659'::uuid
       OR july_22_canonical_id <> '099139d9-1586-47fa-a7ed-73fe8c354b19'::uuid THEN
      RAISE EXCEPTION 'COST_RULE_AUDIT_ABORT: canonical ids differ from the approved baseline: % and %', july_01_canonical_id, july_22_canonical_id;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM coupang_cost_rules
      WHERE id = '9b2cb398-f0f9-4e8a-bbb8-85d90a71c659'::uuid
        AND sale_price_krw = 49800
        AND supply_price_krw = 0
        AND product_cost_krw = 12800
        AND seller_shipping_fee_krw = 2800
        AND hanaro_shipping_fee_krw = 260
        AND growth_inbound_fee_krw = 0
        AND growth_shipping_fee_krw = 2250
    ) THEN
      RAISE EXCEPTION 'COST_RULE_AUDIT_ABORT: 2026-07-01 canonical values differ from the approved baseline';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM coupang_cost_rules
      WHERE id = '099139d9-1586-47fa-a7ed-73fe8c354b19'::uuid
        AND product_cost_krw = 0
        AND seller_shipping_fee_krw = 2800
    ) THEN
      RAISE EXCEPTION 'COST_RULE_AUDIT_ABORT: 2026-07-22 canonical values differ from the approved baseline';
    END IF;
  END IF;

  SELECT count(*) INTO unexpected_shipping_count
  FROM coupang_cost_rules
  WHERE seller_shipping_fee_krw IS NULL OR seller_shipping_fee_krw <> 2800;

  IF unexpected_shipping_count > 0 THEN
    RAISE EXCEPTION 'COST_RULE_AUDIT_ABORT: found % seller shipping fees that are not 2800; inspect before migration', unexpected_shipping_count;
  END IF;
END $$;

CREATE TABLE coupang_cost_rules_backup_20260723 AS
SELECT rules.*, products.display_name AS product_display_name, clock_timestamp() AS backed_up_at
FROM coupang_cost_rules rules
JOIN coupang_products products ON products.id = rules.coupang_product_id;

DO $$
DECLARE
  source_count bigint;
  backup_count bigint;
  source_fingerprint text;
  backup_fingerprint text;
BEGIN
  SELECT count(*) INTO source_count FROM coupang_cost_rules;
  SELECT count(*) INTO backup_count FROM coupang_cost_rules_backup_20260723;
  IF source_count <> backup_count THEN
    RAISE EXCEPTION 'COST_RULE_BACKUP_ABORT: source count % differs from backup count %', source_count, backup_count;
  END IF;

  SELECT md5(string_agg(
    jsonb_build_array(
      id, coupang_product_id, sale_price_krw, supply_price_krw, product_cost_krw,
      sales_fee_rate, sales_fee_krw, seller_shipping_fee_krw, hanaro_shipping_fee_krw,
      growth_inbound_fee_krw, growth_shipping_fee_krw, return_rate,
      return_cost_per_unit_krw, extra_cost_krw, effective_from, effective_to,
      note, created_at, updated_at
    )::text,
    E'\n' ORDER BY id
  )) INTO source_fingerprint
  FROM coupang_cost_rules;

  SELECT md5(string_agg(
    jsonb_build_array(
      id, coupang_product_id, sale_price_krw, supply_price_krw, product_cost_krw,
      sales_fee_rate, sales_fee_krw, seller_shipping_fee_krw, hanaro_shipping_fee_krw,
      growth_inbound_fee_krw, growth_shipping_fee_krw, return_rate,
      return_cost_per_unit_krw, extra_cost_krw, effective_from, effective_to,
      note, created_at, updated_at
    )::text,
    E'\n' ORDER BY id
  )) INTO backup_fingerprint
  FROM coupang_cost_rules_backup_20260723;

  IF source_fingerprint IS DISTINCT FROM backup_fingerprint THEN
    RAISE EXCEPTION 'COST_RULE_BACKUP_ABORT: source fingerprint differs from backup fingerprint';
  END IF;
END $$;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY coupang_product_id, effective_from
           ORDER BY created_at DESC, id DESC
         ) AS canonical_rank
  FROM coupang_cost_rules
)
DELETE FROM coupang_cost_rules rules
USING ranked
WHERE rules.id = ranked.id
  AND ranked.canonical_rank > 1;

WITH normalized AS (
  SELECT id,
         lead(effective_from) OVER (
           PARTITION BY coupang_product_id
           ORDER BY effective_from ASC, created_at ASC, id ASC
         ) AS next_effective_from
  FROM coupang_cost_rules
)
UPDATE coupang_cost_rules rules
SET effective_to = CASE
  WHEN normalized.next_effective_from IS NULL THEN NULL
  ELSE (normalized.next_effective_from - INTERVAL '1 day')::date
END
FROM normalized
WHERE rules.id = normalized.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM coupang_cost_rules
    GROUP BY coupang_product_id, effective_from
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'COST_RULE_NORMALIZE_ABORT: duplicate start dates remain';
  END IF;

  IF EXISTS (
    SELECT 1 FROM coupang_cost_rules
    WHERE effective_to IS NOT NULL AND effective_to < effective_from
  ) THEN
    RAISE EXCEPTION 'COST_RULE_NORMALIZE_ABORT: invalid effective ranges remain';
  END IF;
END $$;

ALTER TABLE coupang_cost_rules
ADD CONSTRAINT coupang_cost_rules_coupang_product_id_effective_from_key
UNIQUE (coupang_product_id, effective_from);

ALTER TABLE coupang_cost_rules
ADD CONSTRAINT coupang_cost_rules_effective_range_check
CHECK (effective_to IS NULL OR effective_to >= effective_from);

COMMIT;
