BEGIN;

CREATE TYPE "security_audit_actor_type" AS ENUM ('USER', 'SYSTEM', 'ANONYMOUS');
CREATE TYPE "security_audit_result" AS ENUM ('REQUESTED', 'PROVIDER_SUCCEEDED', 'SUCCESS', 'FAILURE', 'PARTIAL');

ALTER TABLE "app_users"
  ADD COLUMN "invited_at" TIMESTAMP(3),
  ADD COLUMN "invited_by" UUID,
  ADD COLUMN "invitation_request_id" UUID,
  ADD COLUMN "invitation_error_code" VARCHAR(64);

CREATE UNIQUE INDEX "app_users_invitation_request_id_key"
  ON "app_users"("invitation_request_id");
CREATE INDEX "app_users_invited_by_idx" ON "app_users"("invited_by");
CREATE INDEX "app_users_invite_status_created_at_idx"
  ON "app_users"("invite_status", "created_at");

ALTER TABLE "app_users"
  ADD CONSTRAINT "app_users_invited_by_fkey"
  FOREIGN KEY ("invited_by") REFERENCES "app_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "security_audit_events" (
  "id" UUID NOT NULL,
  "actor_user_id" UUID,
  "actor_type" "security_audit_actor_type" NOT NULL,
  "action" VARCHAR(96) NOT NULL,
  "target_type" VARCHAR(64) NOT NULL,
  "target_id" VARCHAR(128),
  "result" "security_audit_result" NOT NULL,
  "before_json" JSONB,
  "after_json" JSONB,
  "request_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "security_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "security_audit_events_created_at_id_idx"
  ON "security_audit_events"("created_at", "id");
CREATE INDEX "security_audit_events_action_created_at_idx"
  ON "security_audit_events"("action", "created_at");
CREATE INDEX "security_audit_events_actor_user_id_created_at_idx"
  ON "security_audit_events"("actor_user_id", "created_at");
CREATE INDEX "security_audit_events_request_id_idx"
  ON "security_audit_events"("request_id");

ALTER TABLE "security_audit_events"
  ADD CONSTRAINT "security_audit_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "security_audit_events_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'security_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "security_audit_events_append_only_trigger"
BEFORE UPDATE OR DELETE ON "security_audit_events"
FOR EACH ROW EXECUTE FUNCTION "security_audit_events_append_only"();

-- Seed the historical bootstrap marker exactly once without assuming a
-- particular user id or email. The event contains no credentials or provider data.
INSERT INTO "security_audit_events" (
  "id", "actor_user_id", "actor_type", "action", "target_type", "target_id",
  "result", "before_json", "after_json", "request_id", "created_at"
)
SELECT gen_random_uuid(), NULL, 'SYSTEM', 'BOOTSTRAP_SUPER_ADMIN_IMPORTED',
       'APP_USER', u."id"::text, 'SUCCESS', NULL,
       jsonb_build_object('role', 'SUPER_ADMIN', 'isActive', TRUE), NULL, CURRENT_TIMESTAMP
FROM "app_users" u
WHERE u."role" = 'SUPER_ADMIN'
  AND u."is_active" = TRUE
  AND u."invite_status" = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_events" e
    WHERE e."action" = 'BOOTSTRAP_SUPER_ADMIN_IMPORTED'
      AND e."target_id" = u."id"::text
  );

COMMIT;
