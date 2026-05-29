ALTER TABLE "product_cost_rules" DROP COLUMN IF EXISTS "ad_cost_multiplier";

DELETE FROM "app_settings"
WHERE "key" = 'default_ad_cost_multiplier';
