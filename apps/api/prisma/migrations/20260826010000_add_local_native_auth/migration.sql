-- Additive local-native authentication schema. Existing provider identities remain
-- nullable compatibility fields so the migration is reversible before cutover.
BEGIN;

ALTER TABLE "app_users"
  ADD COLUMN "username" VARCHAR(64),
  ADD COLUMN "normalized_username" VARCHAR(64);

CREATE UNIQUE INDEX "app_users_username_key" ON "app_users"("username");
CREATE UNIQUE INDEX "app_users_normalized_username_key" ON "app_users"("normalized_username");

ALTER TABLE "app_auth_sessions"
  ALTER COLUMN "provider_session_id" DROP NOT NULL,
  ADD COLUMN "local_token_hash" CHAR(64),
  ADD COLUMN "previous_local_token_hash" CHAR(64),
  ADD COLUMN "previous_token_valid_until" TIMESTAMPTZ(3),
  ADD COLUMN "idle_expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "absolute_expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "onboarding_only" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "app_auth_sessions_identity_check" CHECK (
    ("provider_session_id" IS NOT NULL AND "local_token_hash" IS NULL
      AND "idle_expires_at" IS NULL AND "absolute_expires_at" IS NULL)
    OR
    ("provider_session_id" IS NULL AND "local_token_hash" IS NOT NULL
      AND "idle_expires_at" IS NOT NULL AND "absolute_expires_at" IS NOT NULL
      AND "idle_expires_at" <= "absolute_expires_at")
  );

ALTER TABLE "app_auth_sessions"
  ADD CONSTRAINT "app_auth_sessions_previous_token_check" CHECK (
    ("previous_local_token_hash" IS NULL AND "previous_token_valid_until" IS NULL)
    OR ("previous_local_token_hash" IS NOT NULL AND "previous_token_valid_until" IS NOT NULL
      AND "local_token_hash" IS NOT NULL)
  );

ALTER TABLE "app_auth_sessions"
  ADD CONSTRAINT "app_auth_sessions_local_hash_format_check" CHECK (
    ("local_token_hash" IS NULL OR "local_token_hash" ~ '^[0-9a-f]{64}$')
    AND ("previous_local_token_hash" IS NULL OR "previous_local_token_hash" ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX "app_auth_sessions_local_token_hash_key"
  ON "app_auth_sessions"("local_token_hash");
CREATE INDEX "app_auth_sessions_previous_local_token_hash_previous_token_valid_until_idx"
  ON "app_auth_sessions"("previous_local_token_hash", "previous_token_valid_until");

CREATE TABLE "local_credentials" (
  "app_user_id" UUID NOT NULL,
  "algorithm" VARCHAR(16) NOT NULL DEFAULT 'scrypt',
  "version" INTEGER NOT NULL DEFAULT 1,
  "cost_n" INTEGER NOT NULL,
  "block_size_r" INTEGER NOT NULL,
  "parallelization_p" INTEGER NOT NULL,
  "key_length" INTEGER NOT NULL,
  "salt" VARCHAR(128) NOT NULL,
  "password_hash" VARCHAR(256) NOT NULL,
  "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "local_credentials_pkey" PRIMARY KEY ("app_user_id"),
  CONSTRAINT "local_credentials_parameters_check" CHECK (
    "algorithm" = 'scrypt' AND "version" = 1
    AND "cost_n" = 65536
    AND "block_size_r" = 8
    AND "parallelization_p" = 1
    AND "key_length" = 32
    AND "salt" ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
    AND "password_hash" ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
  ),
  CONSTRAINT "local_credentials_app_user_id_fkey"
    FOREIGN KEY ("app_user_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "local_account_setup_tokens" (
  "id" UUID NOT NULL,
  "app_user_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "used_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "local_account_setup_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "local_account_setup_tokens_lifecycle_check" CHECK (
    "expires_at" > "created_at" AND NOT ("used_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
  ),
  CONSTRAINT "local_account_setup_tokens_hash_format_check" CHECK (
    "token_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "local_account_setup_tokens_app_user_id_fkey"
    FOREIGN KEY ("app_user_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "local_account_setup_tokens_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "local_account_setup_tokens_token_hash_key"
  ON "local_account_setup_tokens"("token_hash");
CREATE INDEX "local_account_setup_tokens_app_user_id_expires_at_idx"
  ON "local_account_setup_tokens"("app_user_id", "expires_at");
CREATE INDEX "local_account_setup_tokens_created_by_idx"
  ON "local_account_setup_tokens"("created_by");

COMMIT;
