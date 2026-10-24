-- Keep legacy CSV entities distinct from connection-scoped API entities.
-- Account uniqueness must already be enforced before narrowing the legacy index.
DO $meta_adset_scope_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('meta_adsets_account_external_key')
      AND i.indrelid = 'meta_adsets'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnkeyatts = 3 AND i.indnatts = 3
      AND pg_get_indexdef(i.indexrelid, 1, true) = 'connection_id'
      AND pg_get_indexdef(i.indexrelid, 2, true) = 'platform'
      AND pg_get_indexdef(i.indexrelid, 3, true) = 'external_adset_id'
      AND pg_get_expr(i.indpred, i.indrelid) =
        '((connection_id IS NOT NULL) AND (external_adset_id IS NOT NULL))'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('meta_adsets_platform_external_adset_id_not_null_uidx')
      AND i.indrelid = 'meta_adsets'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnkeyatts = 2 AND i.indnatts = 2
      AND pg_get_indexdef(i.indexrelid, 1, true) = 'platform'
      AND pg_get_indexdef(i.indexrelid, 2, true) = 'external_adset_id'
      AND pg_get_expr(i.indpred, i.indrelid) = '(external_adset_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'META_ADSET_INDEX_SCOPE_PRECONDITION_FAILED';
  END IF;
END $meta_adset_scope_guard$;

DROP INDEX "meta_adsets_platform_external_adset_id_not_null_uidx";
CREATE UNIQUE INDEX "meta_adsets_platform_external_adset_id_not_null_uidx"
  ON "meta_adsets"("platform", "external_adset_id")
  WHERE "connection_id" IS NULL AND "external_adset_id" IS NOT NULL;
