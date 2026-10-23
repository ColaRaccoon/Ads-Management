-- Each observed source component can contain 256 characters. Preserve
-- product_name(option_value) without truncating its business identity.
ALTER TABLE "cafe24_order_api_versions"
  ALTER COLUMN "option_name" TYPE VARCHAR(514);
