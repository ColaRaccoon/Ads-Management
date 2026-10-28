-- Additive stage06 queue and immutable source/day publications. No runtime grants.
ALTER TABLE unified_aggregation_runs
  ADD COLUMN idempotency_key varchar(64),
  ADD COLUMN requested_by uuid,
  ADD COLUMN reason varchar(1024),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz(3),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT unified_attempts_valid CHECK (attempts >= 0),
  ADD CONSTRAINT unified_lease_valid CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));
CREATE UNIQUE INDEX unified_aggregation_runs_idempotency_key_key ON unified_aggregation_runs(idempotency_key);
CREATE INDEX unified_aggregation_runs_status_lease_expires_at_started_at_idx
  ON unified_aggregation_runs(status,lease_expires_at,started_at);
CREATE INDEX unified_source_publications_platform_scope_key_business_date_idx
  ON unified_source_publications(platform,scope_key,business_date);

CREATE FUNCTION unified_immutable_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='PUBLISHED' THEN
    RAISE EXCEPTION 'published unified run is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='READY' THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'ready unified run is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.status<>'PUBLISHED' OR
      (to_jsonb(NEW)-ARRAY['status','published_at','lease_token','lease_expires_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','published_at','lease_token','lease_expires_at']) THEN
      RAISE EXCEPTION 'ready unified run can only publish' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF (NEW.id,NEW.source_system,NEW.platform,NEW.scope_key,NEW.business_date)
    IS DISTINCT FROM (OLD.id,OLD.source_system,OLD.platform,OLD.scope_key,OLD.business_date) THEN
    RAISE EXCEPTION 'unified partition is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unified_run_immutable BEFORE UPDATE OR DELETE ON unified_aggregation_runs
  FOR EACH ROW EXECUTE FUNCTION unified_immutable_run();

-- Lock the parent before any child mutation, serializing edits with READY/publication.
CREATE FUNCTION unified_immutable_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid; parent_status text;
BEGIN
  parent_id := CASE WHEN TG_OP='DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  IF TG_OP='UPDATE' AND OLD.run_id<>NEW.run_id THEN
    RAISE EXCEPTION 'unified fact run cannot change' USING ERRCODE='23514';
  END IF;
  SELECT status INTO parent_status FROM unified_aggregation_runs WHERE id=parent_id FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'STAGING' THEN
    RAISE EXCEPTION 'completed unified facts are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unified_fact_immutable BEFORE INSERT OR UPDATE OR DELETE ON unified_daily_facts
  FOR EACH ROW EXECUTE FUNCTION unified_immutable_child();
CREATE TRIGGER unified_coverage_immutable BEFORE INSERT OR UPDATE OR DELETE ON unified_source_coverage
  FOR EACH ROW EXECUTE FUNCTION unified_immutable_child();
CREATE TRIGGER unified_match_immutable BEFORE INSERT OR UPDATE OR DELETE ON unified_product_match_results
  FOR EACH ROW EXECUTE FUNCTION unified_immutable_child();
