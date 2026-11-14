-- Preserve concatenated Cafe24 options verbatim; product names retain their 256-character bound.
ALTER TABLE "cafe24_order_lines"
  ALTER COLUMN "option_value" TYPE VARCHAR(1024);
ALTER TABLE "cafe24_order_api_versions"
  ALTER COLUMN "option_value" TYPE VARCHAR(1024),
  ALTER COLUMN "option_name" TYPE VARCHAR(1282);
