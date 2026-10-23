-- Provider revision is absent in the observed Orders response. Observation metadata
-- is separate from the provider timestamp; existing rows retain their values.
ALTER TABLE "cafe24_order_api_versions"
  ALTER COLUMN "provider_updated_at" DROP NOT NULL,
  ADD COLUMN "fetched_at" TIMESTAMPTZ(3),
  ADD COLUMN "content_fingerprint" CHAR(64),
  ADD COLUMN "fingerprint_key_version" INTEGER;

ALTER TABLE "cafe24_order_api_versions"
  ADD CONSTRAINT "cafe24_day_fingerprint_pair"
  CHECK ((content_fingerprint IS NULL AND fingerprint_key_version IS NULL)
      OR (content_fingerprint IS NOT NULL AND fetched_at IS NOT NULL
          AND fingerprint_key_version BETWEEN 1 AND 99));
