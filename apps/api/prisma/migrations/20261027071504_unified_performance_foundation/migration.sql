-- Generated offline from the existing Prisma 6 schema; no source ownership changes.
-- CreateTable
CREATE TABLE "unified_products" (
    "id" UUID NOT NULL,
    "canonical_name" VARCHAR(256) NOT NULL,
    "normalized_name" VARCHAR(256) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "unified_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_rules" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "product_id" UUID,
    "platform" VARCHAR(16),
    "scope_key" VARCHAR(256),
    "identity_key" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "unified_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_mapping_audits" (
    "id" UUID NOT NULL,
    "entity_type" VARCHAR(32) NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(1024) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unified_mapping_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_aggregation_runs" (
    "id" UUID NOT NULL,
    "source_system" VARCHAR(64) NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "scope_key" VARCHAR(256) NOT NULL,
    "business_date" DATE NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'STAGING',
    "contract_version" VARCHAR(64) NOT NULL,
    "versions" JSONB NOT NULL,
    "read_snapshot_id" VARCHAR(128) NOT NULL,
    "source_fingerprint" VARCHAR(128),
    "source_watermarks" JSONB NOT NULL,
    "checkpoint" JSONB,
    "control_totals" JSONB NOT NULL,
    "issues" JSONB NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "unified_aggregation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_source_publications" (
    "source_system" VARCHAR(64) NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "scope_key" VARCHAR(256) NOT NULL,
    "business_date" DATE NOT NULL,
    "run_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "unified_source_publications_pkey" PRIMARY KEY ("source_system","platform","scope_key","business_date")
);

-- CreateTable
CREATE TABLE "unified_daily_facts" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "component" VARCHAR(32) NOT NULL,
    "fact_key" VARCHAR(256) NOT NULL,
    "product_name" VARCHAR(256),
    "sale_unit_name" VARCHAR(256),
    "amount_krw" DECIMAL(30,6),
    "original_amount" DECIMAL(30,6),
    "currency" VARCHAR(8),
    "quantity" DECIMAL(24,6),
    "attribution" VARCHAR(16) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "unified_daily_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_source_coverage" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "component" VARCHAR(32) NOT NULL,
    "participation" VARCHAR(32) NOT NULL,
    "collection_state" VARCHAR(32) NOT NULL,
    "zero_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "rows_present" INTEGER NOT NULL,
    "source_as_of" TIMESTAMPTZ(3),
    "is_estimate" BOOLEAN NOT NULL,
    "details" JSONB NOT NULL,

    CONSTRAINT "unified_source_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_product_match_results" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "source_key" VARCHAR(256) NOT NULL,
    "name_input_hash" VARCHAR(64) NOT NULL,
    "rule_version" VARCHAR(128) NOT NULL,
    "match_status" VARCHAR(32) NOT NULL,
    "product_name" VARCHAR(256),
    "evidence" JSONB NOT NULL,

    CONSTRAINT "unified_product_match_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unified_products_normalized_name_key" ON "unified_products"("normalized_name");

-- CreateIndex
CREATE INDEX "unified_rules_kind_platform_scope_key_valid_from_idx" ON "unified_rules"("kind", "platform", "scope_key", "valid_from");

-- CreateIndex
CREATE INDEX "unified_rules_product_id_valid_from_idx" ON "unified_rules"("product_id", "valid_from");

-- CreateIndex
CREATE INDEX "unified_mapping_audits_entity_type_entity_id_created_at_idx" ON "unified_mapping_audits"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "unified_mapping_audits_actor_user_id_created_at_idx" ON "unified_mapping_audits"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "unified_aggregation_runs_platform_scope_key_business_date_s_idx" ON "unified_aggregation_runs"("platform", "scope_key", "business_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "unified_run_partition_key" ON "unified_aggregation_runs"("id", "source_system", "platform", "scope_key", "business_date");

-- CreateIndex
CREATE INDEX "unified_daily_facts_product_name_run_id_component_idx" ON "unified_daily_facts"("product_name", "run_id", "component");

-- CreateIndex
CREATE UNIQUE INDEX "unified_daily_facts_run_id_component_fact_key_key" ON "unified_daily_facts"("run_id", "component", "fact_key");

-- CreateIndex
CREATE UNIQUE INDEX "unified_source_coverage_run_id_component_key" ON "unified_source_coverage"("run_id", "component");

-- CreateIndex
CREATE INDEX "unified_product_match_results_match_status_run_id_idx" ON "unified_product_match_results"("match_status", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "unified_product_match_results_run_id_source_key_name_input__key" ON "unified_product_match_results"("run_id", "source_key", "name_input_hash");

-- AddForeignKey
ALTER TABLE "unified_rules" ADD CONSTRAINT "unified_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "unified_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_source_publications" ADD CONSTRAINT "unified_source_publications_run_id_source_system_platform__fkey" FOREIGN KEY ("run_id", "source_system", "platform", "scope_key", "business_date") REFERENCES "unified_aggregation_runs"("id", "source_system", "platform", "scope_key", "business_date") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_daily_facts" ADD CONSTRAINT "unified_daily_facts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "unified_aggregation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_source_coverage" ADD CONSTRAINT "unified_source_coverage_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "unified_aggregation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_product_match_results" ADD CONSTRAINT "unified_product_match_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "unified_aggregation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma cannot express check/exclusion constraints. These are deliberately additive.
ALTER TABLE unified_products ADD CONSTRAINT unified_products_valid CHECK
  (version > 0 AND btrim(canonical_name) <> '' AND btrim(normalized_name) <> '');
ALTER TABLE unified_rules ADD CONSTRAINT unified_rules_valid CHECK (
  kind IN ('NAME','SALE_UNIT','ALLOCATION','SCOPE_POLICY')
  AND (platform IS NULL OR platform IN ('META','GOOGLE','NAVER','COUPANG','CAFE24'))
  AND (scope_key IS NULL OR (platform IS NOT NULL AND btrim(scope_key) <> ''))
  AND ((kind='ALLOCATION' AND product_id IS NULL AND platform IS NOT NULL)
    OR (kind IN ('NAME','SALE_UNIT','SCOPE_POLICY') AND product_id IS NOT NULL))
  AND (valid_to IS NULL OR valid_to >= valid_from)
  AND version > 0 AND identity_key ~ '^[0-9a-f]{64}$' AND jsonb_typeof(payload)='object');
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE unified_rules ADD CONSTRAINT unified_rules_no_identical_overlap EXCLUDE USING gist
  (kind WITH =, (coalesce(platform,'')) WITH =, (coalesce(scope_key,'')) WITH =,
   identity_key WITH =, daterange(valid_from,valid_to,'[]') WITH &&) WHERE (active);
ALTER TABLE unified_mapping_audits ADD CONSTRAINT unified_audit_actor_fkey
  FOREIGN KEY (actor_user_id) REFERENCES app_users(id) ON DELETE RESTRICT;
ALTER TABLE unified_mapping_audits ADD CONSTRAINT unified_audit_valid CHECK
  (entity_type IN ('PRODUCT','RULE') AND action IN ('CREATE','UPDATE','DEACTIVATE') AND btrim(reason) <> '');
ALTER TABLE unified_aggregation_runs ADD CONSTRAINT unified_run_valid CHECK (
  platform IN ('META','GOOGLE','NAVER','COUPANG','CAFE24') AND btrim(scope_key) <> ''
  AND status IN ('STAGING','READY','PUBLISHED','FAILED')
  AND (status NOT IN ('READY','PUBLISHED') OR completed_at IS NOT NULL)
  AND (status <> 'PUBLISHED' OR published_at IS NOT NULL)
  AND jsonb_typeof(versions)='object' AND jsonb_typeof(control_totals)='array' AND jsonb_typeof(issues)='array');
ALTER TABLE unified_source_publications ADD CONSTRAINT unified_publication_revision CHECK (revision > 0);
ALTER TABLE unified_daily_facts ADD CONSTRAINT unified_fact_valid CHECK (
  component IN ('SALE','AD_SPEND','COMMON_EXPENSE','SHIPPING_INCOME')
  AND attribution IN ('DIRECT','ALLOCATED','UNALLOCATED') AND btrim(fact_key) <> '' AND jsonb_typeof(payload)='object');
ALTER TABLE unified_source_coverage ADD CONSTRAINT unified_coverage_valid CHECK (
  component IN ('SALE','AD_SPEND','DIRECT_COST','COMMON_EXPENSE')
  AND participation IN ('INCLUDED','NOT_APPLICABLE')
  AND collection_state IN ('COMPLETE','PARTIAL','NOT_COLLECTED','STALE','MAPPING_REQUIRED')
  AND rows_present >= 0 AND (NOT zero_confirmed OR (rows_present=0 AND collection_state='COMPLETE'))
  AND jsonb_typeof(details)='object');
ALTER TABLE unified_product_match_results ADD CONSTRAINT unified_match_valid CHECK (
  match_status IN ('MATCHED','UNMATCHED','AMBIGUOUS','NAME_MISSING','UNIT_REQUIRED')
  AND name_input_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(evidence)='object');

-- Publication cannot expose a staging/failed revision. No SECURITY DEFINER or public source access.
CREATE FUNCTION unified_check_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM unified_aggregation_runs WHERE id=NEW.run_id AND status IN ('READY','PUBLISHED'))
    OR NOT EXISTS (SELECT 1 FROM unified_source_coverage WHERE run_id=NEW.run_id) THEN
    RAISE EXCEPTION 'unified revision is not ready' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unified_publication_ready BEFORE INSERT OR UPDATE ON unified_source_publications
  FOR EACH ROW EXECUTE FUNCTION unified_check_publication();

-- Feature is default-off. Step 11 supplies reviewed minimum grants/policies.
-- Revoke inherited/default grants as well as PUBLIC access. No production grants here.
DO $$
DECLARE tab text; role_name text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['unified_products','unified_rules','unified_mapping_audits',
    'unified_aggregation_runs','unified_source_publications','unified_daily_facts',
    'unified_source_coverage','unified_product_match_results'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',tab);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','meta_ads_app',
      'meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_prod_runtime','meta_ads_prod_migration'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',tab,role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;

