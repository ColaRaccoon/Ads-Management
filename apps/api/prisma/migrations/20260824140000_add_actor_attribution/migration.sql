BEGIN;

-- Existing Cafe24 and Coupang upload rows remain NULL because their historical
-- uploader is unknown. New imports set the authenticated AppUser id.
ALTER TABLE "cafe24_upload_batches"
  ADD COLUMN "uploaded_by" UUID;

ALTER TABLE "coupang_upload_batches"
  ADD COLUMN "uploaded_by" UUID;

-- Refuse to install referential constraints when any legacy attribution value
-- points outside app_users. This deliberately avoids inventing a seed/admin
-- attribution for historical rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "created_by" AS actor_id FROM "creative_change_logs" WHERE "created_by" IS NOT NULL
      UNION ALL
      SELECT "created_by" FROM "product_change_logs" WHERE "created_by" IS NOT NULL
      UNION ALL
      SELECT "created_by" FROM "product_match_rules" WHERE "created_by" IS NOT NULL
      UNION ALL
      SELECT "created_by" FROM "adset_product_histories" WHERE "created_by" IS NOT NULL
      UNION ALL
      SELECT "created_by" FROM "adset_stage_histories" WHERE "created_by" IS NOT NULL
      UNION ALL
      SELECT "uploaded_by" FROM "upload_batches" WHERE "uploaded_by" IS NOT NULL
      UNION ALL
      SELECT "uploaded_by" FROM "cafe24_upload_batches" WHERE "uploaded_by" IS NOT NULL
      UNION ALL
      SELECT "uploaded_by" FROM "coupang_upload_batches" WHERE "uploaded_by" IS NOT NULL
      UNION ALL
      SELECT "created_by" FROM "decision_runs" WHERE "created_by" IS NOT NULL
      UNION ALL
      SELECT "created_by" FROM "decision_logs" WHERE "created_by" IS NOT NULL
      UNION ALL
      SELECT "created_by" FROM "change_logs" WHERE "created_by" IS NOT NULL
      UNION ALL
      SELECT "created_by" FROM "report_exports" WHERE "created_by" IS NOT NULL
      UNION ALL
      SELECT "updated_by" FROM "app_settings" WHERE "updated_by" IS NOT NULL
    ) actor_refs
    LEFT JOIN "app_users" ON "app_users"."id" = actor_refs.actor_id
    WHERE "app_users"."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'SECURITY_ACTOR_ATTRIBUTION_ORPHAN';
  END IF;
END
$$;

CREATE INDEX "creative_change_logs_created_by_idx" ON "creative_change_logs"("created_by");
CREATE INDEX "product_change_logs_created_by_idx" ON "product_change_logs"("created_by");
CREATE INDEX "product_match_rules_created_by_idx" ON "product_match_rules"("created_by");
CREATE INDEX "adset_product_histories_created_by_idx" ON "adset_product_histories"("created_by");
CREATE INDEX "adset_stage_histories_created_by_idx" ON "adset_stage_histories"("created_by");
CREATE INDEX "upload_batches_uploaded_by_idx" ON "upload_batches"("uploaded_by");
CREATE INDEX "cafe24_upload_batches_uploaded_by_idx" ON "cafe24_upload_batches"("uploaded_by");
CREATE INDEX "coupang_upload_batches_uploaded_by_idx" ON "coupang_upload_batches"("uploaded_by");
CREATE INDEX "decision_runs_created_by_idx" ON "decision_runs"("created_by");
CREATE INDEX "decision_logs_created_by_idx" ON "decision_logs"("created_by");
CREATE INDEX "change_logs_created_by_idx" ON "change_logs"("created_by");
CREATE INDEX "report_exports_created_by_idx" ON "report_exports"("created_by");
CREATE INDEX "app_settings_updated_by_idx" ON "app_settings"("updated_by");

ALTER TABLE "creative_change_logs"
  ADD CONSTRAINT "creative_change_logs_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_change_logs"
  ADD CONSTRAINT "product_change_logs_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_match_rules"
  ADD CONSTRAINT "product_match_rules_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "adset_product_histories"
  ADD CONSTRAINT "adset_product_histories_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "adset_stage_histories"
  ADD CONSTRAINT "adset_stage_histories_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "upload_batches"
  ADD CONSTRAINT "upload_batches_uploaded_by_fkey"
  FOREIGN KEY ("uploaded_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cafe24_upload_batches"
  ADD CONSTRAINT "cafe24_upload_batches_uploaded_by_fkey"
  FOREIGN KEY ("uploaded_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coupang_upload_batches"
  ADD CONSTRAINT "coupang_upload_batches_uploaded_by_fkey"
  FOREIGN KEY ("uploaded_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "decision_runs"
  ADD CONSTRAINT "decision_runs_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "decision_logs"
  ADD CONSTRAINT "decision_logs_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "change_logs"
  ADD CONSTRAINT "change_logs_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_exports"
  ADD CONSTRAINT "report_exports_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app_settings"
  ADD CONSTRAINT "app_settings_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
