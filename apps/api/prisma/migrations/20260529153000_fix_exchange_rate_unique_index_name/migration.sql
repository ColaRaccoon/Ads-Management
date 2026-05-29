-- Keep the generated unique index name within PostgreSQL's 63 byte limit.
ALTER INDEX IF EXISTS "exchange_rates_rate_date_base_currency_quote_currency_provider_"
  RENAME TO "exchange_rates_rate_date_base_currency_quote_currency_provi_key";
