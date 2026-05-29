-- CreateEnum
CREATE TYPE "exchange_rate_fallback_type" AS ENUM ('EXACT', 'PREVIOUS_AVAILABLE', 'LATEST_AVAILABLE', 'MANUAL');

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "rate_date" DATE NOT NULL,
    "source_date" DATE NOT NULL,
    "base_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "quote_currency" VARCHAR(3) NOT NULL DEFAULT 'KRW',
    "rate" DECIMAL(14,6) NOT NULL,
    "provider" VARCHAR(32) NOT NULL DEFAULT 'KOREA_EXIM',
    "provider_payload" JSONB,
    "fallback_type" "exchange_rate_fallback_type" NOT NULL DEFAULT 'EXACT',
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_rate_date_base_currency_quote_currency_provider_key"
  ON "exchange_rates"("rate_date", "base_currency", "quote_currency", "provider");

-- CreateIndex
CREATE INDEX "exchange_rates_base_currency_quote_currency_rate_date_idx"
  ON "exchange_rates"("base_currency", "quote_currency", "rate_date");
