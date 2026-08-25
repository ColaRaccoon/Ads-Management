BEGIN;

CREATE TYPE "storage_tombstone_domain" AS ENUM ('META_UPLOAD', 'REPORT');
CREATE TYPE "storage_tombstone_state" AS ENUM ('PENDING', 'RETAINED', 'RESTORED', 'PURGED', 'FAILED');

CREATE TABLE "storage_tombstones" (
  "id" UUID NOT NULL,
  "domain" "storage_tombstone_domain" NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "original_key" VARCHAR(1024) NOT NULL,
  "trash_key" VARCHAR(1024) NOT NULL,
  "hash_sha256" CHAR(64) NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "business_record_id" UUID NOT NULL,
  "state" "storage_tombstone_state" NOT NULL DEFAULT 'PENDING',
  "deleted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "purge_after" TIMESTAMPTZ(3) NOT NULL,
  "restored_at" TIMESTAMPTZ(3),
  "purged_at" TIMESTAMPTZ(3),
  "actor_user_id" UUID,
  "failure_code" VARCHAR(64),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "storage_tombstones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "storage_tombstones_hash_check" CHECK ("hash_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "storage_tombstones_byte_size_check" CHECK ("byte_size" >= 0),
  CONSTRAINT "storage_tombstones_purge_after_check" CHECK ("purge_after" > "deleted_at"),
  CONSTRAINT "storage_tombstones_key_check" CHECK (
    length("original_key") > 0 AND
    length("trash_key") > 0 AND
    "trash_key" LIKE 'trash/%'
  )
);

CREATE UNIQUE INDEX "storage_tombstones_domain_business_record_id_key"
  ON "storage_tombstones"("domain", "business_record_id");
CREATE UNIQUE INDEX "storage_tombstones_provider_trash_key_key"
  ON "storage_tombstones"("provider", "trash_key");
CREATE INDEX "storage_tombstones_state_purge_after_idx"
  ON "storage_tombstones"("state", "purge_after");
CREATE INDEX "storage_tombstones_actor_user_id_created_at_idx"
  ON "storage_tombstones"("actor_user_id", "created_at");

ALTER TABLE "storage_tombstones"
  ADD CONSTRAINT "storage_tombstones_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
