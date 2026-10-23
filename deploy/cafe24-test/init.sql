-- Dedicated empty Railway PostgreSQL only. This is not an application migration.
-- Run once after verifying the isolated project, environment and database service.
BEGIN;

CREATE TYPE "SourceProvider" AS ENUM ('GOOGLE', 'META', 'CAFE24');
CREATE TYPE "SourceAccessState" AS ENUM ('PENDING', 'READY', 'REAUTH_REQUIRED', 'BLOCKED');
CREATE TYPE "security_audit_actor_type" AS ENUM ('USER', 'SYSTEM', 'ANONYMOUS');
CREATE TYPE "security_audit_result" AS ENUM
  ('REQUESTED', 'PROVIDER_SUCCEEDED', 'SUCCESS', 'FAILURE', 'PARTIAL');

CREATE TABLE "source_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "provider" "SourceProvider" NOT NULL,
  "external_account_id" VARCHAR(256) NOT NULL,
  "shop_key" VARCHAR(256) NOT NULL DEFAULT 'default',
  "display_name" VARCHAR(256) NOT NULL,
  "currency_code" VARCHAR(3) NOT NULL,
  "time_zone" VARCHAR(128) NOT NULL,
  "credential_ref" VARCHAR(256),
  "credential_expires_at" TIMESTAMPTZ(3),
  "access_state" "SourceAccessState" NOT NULL DEFAULT 'PENDING',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "source_connections_provider_external_account_id_shop_key_key"
    UNIQUE ("provider", "external_account_id", "shop_key")
);

CREATE TABLE "cafe24_oauth_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "connection_id" UUID NOT NULL REFERENCES "source_connections"("id") ON DELETE RESTRICT,
  "state_hash" CHAR(64) NOT NULL UNIQUE,
  "actor_user_id" UUID,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "cafe24_oauth_attempts_connection_id_expires_at_idx"
  ON "cafe24_oauth_attempts"("connection_id", "expires_at");

CREATE TABLE "source_credentials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "connection_id" UUID NOT NULL REFERENCES "source_connections"("id") ON DELETE RESTRICT,
  "kind" VARCHAR(32) NOT NULL CHECK ("kind" IN ('CAFE24_REFRESH', 'CAFE24_ACCESS')),
  "ciphertext" BYTEA NOT NULL,
  "iv" BYTEA NOT NULL,
  "auth_tag" BYTEA NOT NULL,
  "key_version" INTEGER NOT NULL CHECK ("key_version" > 0),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "refresh_owner" UUID,
  "refresh_until" TIMESTAMPTZ(3),
  "expires_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "source_credentials_connection_id_kind_key" UNIQUE ("connection_id", "kind")
);

CREATE TABLE "security_audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "actor_user_id" UUID,
  "actor_type" "security_audit_actor_type" NOT NULL,
  "action" VARCHAR(96) NOT NULL,
  "target_type" VARCHAR(64) NOT NULL,
  "target_id" VARCHAR(128),
  "result" "security_audit_result" NOT NULL,
  "before_json" JSONB,
  "after_json" JSONB,
  "request_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "security_audit_events_system_only_check"
    CHECK ("actor_type" = 'SYSTEM' AND "actor_user_id" IS NULL)
);
CREATE INDEX "security_audit_events_created_at_id_idx"
  ON "security_audit_events"("created_at", "id");

CREATE TABLE "cafe24_observed_order_revisions" (
  "connection_id" UUID NOT NULL REFERENCES "source_connections"("id") ON DELETE RESTRICT,
  "order_key_hash" CHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL,
  "order_date" DATE NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "first_observed_at" TIMESTAMPTZ(3) NOT NULL,
  "last_observed_at" TIMESTAMPTZ(3) NOT NULL,
  "observation_id" UUID NOT NULL,
  "is_current" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "cafe24_observed_order_revisions_pkey"
    PRIMARY KEY ("connection_id", "order_key_hash", "revision")
);
CREATE UNIQUE INDEX "cafe24_observed_order_revisions_current_key"
  ON "cafe24_observed_order_revisions"("connection_id", "order_key_hash")
  WHERE "is_current" = true;
CREATE INDEX "cafe24_observed_order_revisions_day_idx"
  ON "cafe24_observed_order_revisions"("connection_id", "order_date", "is_current");

CREATE TABLE "cafe24_observed_day_checkpoints" (
  "connection_id" UUID NOT NULL REFERENCES "source_connections"("id") ON DELETE RESTRICT,
  "order_date" DATE NOT NULL,
  "query_started_at" TIMESTAMPTZ(3) NOT NULL,
  "completed_at" TIMESTAMPTZ(3) NOT NULL,
  "observation_id" UUID NOT NULL,
  "key_version" INTEGER NOT NULL,
  "order_count" INTEGER NOT NULL,
  "item_count" INTEGER NOT NULL,
  "snapshot_hash" CHAR(64) NOT NULL,
  CONSTRAINT "cafe24_observed_day_checkpoints_pkey"
    PRIMARY KEY ("connection_id", "order_date")
);

REVOKE ALL ON TABLE "source_connections", "cafe24_oauth_attempts",
  "source_credentials", "security_audit_events",
  "cafe24_observed_order_revisions", "cafe24_observed_day_checkpoints" FROM PUBLIC;
COMMIT;
