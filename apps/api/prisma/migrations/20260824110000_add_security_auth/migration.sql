BEGIN;

-- Refuse to guess how unknown legacy roles should map. The exception aborts the
-- migration before the existing column is altered.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "app_users"
    WHERE "role" IS NULL
       OR "role" NOT IN ('SUPER_ADMIN', 'ADMIN', 'USER', 'GUEST')
  ) THEN
    RAISE EXCEPTION 'SECURITY_AUTH_MIGRATION_UNKNOWN_ROLE';
  END IF;
END $$;

CREATE TYPE "app_role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'USER', 'GUEST');
CREATE TYPE "invite_status" AS ENUM (
  'PENDING_PROVIDER',
  'INVITED',
  'VERIFIED_PENDING_PASSWORD',
  'ACTIVE',
  'RECONCILE_REQUIRED',
  'CANCELLED'
);

ALTER TABLE "app_users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "app_users"
  ALTER COLUMN "role" TYPE "app_role"
  USING CASE
    WHEN "role" = 'SUPER_ADMIN' THEN 'SUPER_ADMIN'::"app_role"
    WHEN "role" = 'ADMIN' THEN 'ADMIN'::"app_role"
    WHEN "role" = 'USER' THEN 'USER'::"app_role"
    WHEN "role" = 'GUEST' THEN 'GUEST'::"app_role"
  END;
ALTER TABLE "app_users" ALTER COLUMN "role" SET DEFAULT 'GUEST';

ALTER TABLE "app_users"
  ADD COLUMN "invite_status" "invite_status",
  ADD COLUMN "auth_user_id" UUID,
  ADD COLUMN "normalized_email" TEXT,
  ADD COLUMN "last_login_at" TIMESTAMP(3),
  ADD COLUMN "deactivated_at" TIMESTAMP(3),
  ADD COLUMN "authz_version" INTEGER NOT NULL DEFAULT 1;

-- Rows that predate invitation onboarding keep their previous application
-- access state, but remain unable to authenticate until explicitly linked.
UPDATE "app_users" SET "invite_status" = 'ACTIVE';
ALTER TABLE "app_users"
  ALTER COLUMN "invite_status" SET NOT NULL,
  ALTER COLUMN "invite_status" SET DEFAULT 'PENDING_PROVIDER';

-- Email identity policy is printable ASCII local/domain text, U+0020 edge trim,
-- then ASCII lowercase. IDNs must be supplied in provider-canonical punycode.
-- This makes application and PostgreSQL normalization byte-for-byte identical.
-- We do not remove plus-addresses or dots.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "app_users"
    WHERE "email" IS NULL
       OR (
        btrim("email") = ''
        OR char_length(btrim("email")) > 320
        OR octet_length(btrim("email")) <> char_length(btrim("email"))
        OR btrim("email") !~ '^[!-~]+$'
        OR btrim("email") !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
  ) THEN
    RAISE EXCEPTION 'SECURITY_AUTH_MIGRATION_INVALID_EMAIL';
  END IF;

  IF EXISTS (
    SELECT lower(btrim("email"))
    FROM "app_users"
    WHERE "email" IS NOT NULL
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SECURITY_AUTH_MIGRATION_NORMALIZED_EMAIL_COLLISION';
  END IF;
END $$;

UPDATE "app_users"
SET "normalized_email" = lower(btrim("email"))
WHERE "email" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "app_users"
    WHERE "normalized_email" IS NULL
  ) OR EXISTS (
    SELECT "normalized_email"
    FROM "app_users"
    WHERE "normalized_email" IS NOT NULL
    GROUP BY "normalized_email"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SECURITY_AUTH_MIGRATION_NORMALIZED_EMAIL_POSTCHECK_FAILED';
  END IF;
END $$;

CREATE UNIQUE INDEX "app_users_auth_user_id_key" ON "app_users"("auth_user_id");
CREATE UNIQUE INDEX "app_users_normalized_email_key" ON "app_users"("normalized_email");

CREATE TABLE "app_auth_sessions" (
  "id" UUID NOT NULL,
  "app_user_id" UUID NOT NULL,
  "provider_session_id" TEXT NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "last_seen_at" TIMESTAMP(3),
  "refreshed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "app_auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "app_auth_sessions_provider_session_id_key"
  ON "app_auth_sessions"("provider_session_id");
CREATE INDEX "app_auth_sessions_app_user_id_revoked_at_idx"
  ON "app_auth_sessions"("app_user_id", "revoked_at");
ALTER TABLE "app_auth_sessions"
  ADD CONSTRAINT "app_auth_sessions_app_user_id_fkey"
  FOREIGN KEY ("app_user_id") REFERENCES "app_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
