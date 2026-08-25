CREATE TABLE "security_rate_limit_buckets" (
    "key_hash" CHAR(64) NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_ms" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_rate_limit_buckets_pkey"
      PRIMARY KEY ("key_hash", "window_start", "window_ms"),
    CONSTRAINT "security_rate_limit_buckets_window_ms_check"
      CHECK ("window_ms" BETWEEN 1000 AND 86400000),
    CONSTRAINT "security_rate_limit_buckets_count_check"
      CHECK ("count" > 0),
    CONSTRAINT "security_rate_limit_buckets_expiry_check"
      CHECK ("expires_at" > "window_start")
);

CREATE INDEX "security_rate_limit_buckets_expires_at_idx"
  ON "security_rate_limit_buckets"("expires_at");
