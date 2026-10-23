-- Retain the same canonical origin/current/lease constraints as the application.
-- The narrow OAuth receiver used SYSTEM-only audits. Actual common CSV/policy
-- services retain their USER actor semantics, so the verified old constraint is
-- explicitly replaced in this atomic DDL. Existing audit rows remain unchanged.
ALTER TABLE security_audit_events DROP CONSTRAINT security_audit_events_system_only_check,
  ADD CONSTRAINT security_audit_events_system_or_user_check CHECK (
    (actor_type = 'SYSTEM' AND actor_user_id IS NULL) OR
    (actor_type = 'USER' AND actor_user_id IS NOT NULL)),
  ADD CONSTRAINT security_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id)
    REFERENCES app_users(id) ON DELETE RESTRICT;
ALTER TABLE source_policies ADD CONSTRAINT source_policies_date_range_check
  CHECK (to_date IS NULL OR to_date > from_date),
  ADD CONSTRAINT phase06_source_policy_kind CHECK (data_kind::TEXT = 'CAFE24_ORDER');
ALTER TABLE sync_runs ADD CONSTRAINT phase06_sync_one_day_check
  CHECK (to_date = from_date AND trigger::TEXT = 'MANUAL'),
  ADD CONSTRAINT sync_runs_count_check
  CHECK (attempt_count >= 0 AND rows_fetched >= 0 AND rows_published >= 0);
ALTER TABLE run_units ADD CONSTRAINT run_units_count_check
  CHECK (attempts >= 0 AND fetched_count >= 0 AND published_count >= 0);
ALTER TABLE source_coverage ADD CONSTRAINT source_coverage_count_check
  CHECK (row_count IS NULL OR row_count >= 0),
  ADD CONSTRAINT phase06_coverage_kind CHECK (data_kind::TEXT = 'CAFE24_ORDER');
ALTER TABLE source_record_links ADD CONSTRAINT phase06_source_record_kind
  CHECK (data_kind::TEXT = 'CAFE24_ORDER' AND record_table = 'cafe24_order_lines');
ALTER TABLE cafe24_order_api_versions ADD CONSTRAINT cafe24_order_api_versions_nonnegative_check
  CHECK (quantity >= 0 AND sale_price_krw >= 0 AND total_paid_krw >= 0 AND version > 0),
  ADD CONSTRAINT cafe24_day_fingerprint_pair
  CHECK ((content_fingerprint IS NULL AND fingerprint_key_version IS NULL) OR
    (content_fingerprint IS NOT NULL AND fetched_at IS NOT NULL AND
     fingerprint_key_version BETWEEN 1 AND 99));
ALTER TABLE cafe24_order_lines ADD CONSTRAINT cafe24_order_lines_origin_check CHECK (
  (source::TEXT = 'CSV' AND upload_batch_id IS NOT NULL AND row_number IS NOT NULL
    AND source_row_hash IS NOT NULL AND sync_run_id IS NULL) OR
  (source::TEXT = 'API' AND upload_batch_id IS NULL AND row_number IS NULL
    AND source_row_hash IS NULL AND raw_row IS NULL AND connection_id IS NOT NULL
    AND sync_run_id IS NOT NULL)),
  ADD CONSTRAINT cafe24_order_lines_connection_id_fkey FOREIGN KEY (connection_id)
    REFERENCES source_connections(id) ON DELETE RESTRICT,
  ADD CONSTRAINT cafe24_order_lines_sync_run_id_fkey FOREIGN KEY (sync_run_id)
    REFERENCES sync_runs(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX cafe24_order_api_versions_one_current
  ON cafe24_order_api_versions (connection_id, canonical_key_hash) WHERE is_current;
CREATE UNIQUE INDEX cafe24_order_lines_csv_legacy_current_key ON cafe24_order_lines (order_line_key)
  WHERE source = 'CSV' AND connection_id IS NULL AND is_current;
CREATE UNIQUE INDEX cafe24_order_lines_csv_account_current_key ON cafe24_order_lines (connection_id, order_line_key)
  WHERE source = 'CSV' AND connection_id IS NOT NULL AND is_current;
CREATE UNIQUE INDEX cafe24_order_lines_api_current_key ON cafe24_order_lines (connection_id, order_line_key)
  WHERE source = 'API' AND is_current;
CREATE UNIQUE INDEX cafe24_order_lines_api_version_key ON cafe24_order_lines (connection_id, order_line_key, import_version)
  WHERE source = 'API';
CREATE FUNCTION phase06_guard_policy_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM source_connections WHERE id = NEW.connection_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM source_policies p WHERE p.connection_id = NEW.connection_id
    AND p.data_kind = NEW.data_kind AND p.id <> NEW.id
    AND p.from_date < COALESCE(NEW.to_date, 'infinity'::DATE)
    AND COALESCE(p.to_date, 'infinity'::DATE) > NEW.from_date) THEN
    RAISE EXCEPTION 'CAFE24_LIVE_POLICY_OVERLAP';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER phase06_source_policy_overlap BEFORE INSERT OR UPDATE ON source_policies
  FOR EACH ROW EXECUTE FUNCTION phase06_guard_policy_overlap();
