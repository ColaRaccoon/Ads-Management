BEGIN;

CREATE TABLE "local_edge_request_nonces" (
  "nonce_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "local_edge_request_nonces_pkey" PRIMARY KEY ("nonce_hash")
);

CREATE INDEX "local_edge_request_nonces_expires_at_idx"
  ON "local_edge_request_nonces"("expires_at");

COMMIT;
