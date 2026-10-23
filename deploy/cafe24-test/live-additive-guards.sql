-- Review-only DDL: sixteen new 06 tables and the existing audit actor CHECK/FK.
-- All existing rows and the single credential store are preserved. The root executor must first verify the exact
-- isolated Railway project/environment/callback/Postgres service and the
-- read-only existing-six-table integrity baseline. No token dump is required:
-- additive DDL runs atomically and failure rolls back the entire transaction.
-- Never apply full application migrations to the callback database.
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE inventory TEXT[];
        actor_check TEXT;
BEGIN
  SELECT array_agg(table_name ORDER BY table_name) INTO inventory
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
  IF inventory IS DISTINCT FROM ARRAY[
    'cafe24_oauth_attempts', 'cafe24_observed_day_checkpoints',
    'cafe24_observed_order_revisions', 'security_audit_events',
    'source_connections', 'source_credentials'
  ]::TEXT[] THEN RAISE EXCEPTION 'CAFE24_LIVE_EXISTING_TABLE_INVENTORY_MISMATCH'; END IF;
  IF (SELECT COUNT(*) FROM source_connections) <> 1 OR
     NOT EXISTS (SELECT 1 FROM source_connections WHERE provider::TEXT = 'CAFE24'
       AND external_account_id = 'didadi0729' AND shop_key = 'shop1'
       AND currency_code = 'KRW' AND time_zone = 'Asia/Seoul'
       AND enabled = false AND access_state::TEXT = 'READY') THEN
    RAISE EXCEPTION 'CAFE24_LIVE_EXISTING_CONNECTION_MISMATCH';
  END IF;
  IF (SELECT COUNT(*) FROM source_credentials) <> 2 OR
     EXISTS (SELECT 1 FROM source_credentials c LEFT JOIN source_connections s
       ON s.id = c.connection_id WHERE s.id IS NULL OR
       c.kind NOT IN ('CAFE24_ACCESS','CAFE24_REFRESH') OR
       c.revision < 1 OR c.key_version < 1 OR c.refresh_owner IS NOT NULL OR
       c.refresh_until IS NOT NULL) THEN
    RAISE EXCEPTION 'CAFE24_LIVE_EXISTING_CREDENTIAL_OWNER_MISMATCH';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO actor_check FROM pg_constraint
    WHERE conrelid='public.security_audit_events'::regclass AND contype='c'
      AND conname='security_audit_events_system_only_check';
  IF actor_check IS DISTINCT FROM
    'CHECK (((actor_type = ''SYSTEM''::security_audit_actor_type) AND (actor_user_id IS NULL)))' THEN
    RAISE EXCEPTION 'CAFE24_LIVE_EXISTING_AUDIT_ACTOR_CHECK_MISMATCH';
  END IF;
END $$;
