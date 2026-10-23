-- REVIEW ONLY. NO EXECUTION APPROVAL. Transaction ends with ROLLBACK.
BEGIN;
SET LOCAL search_path = meta_ads, pg_catalog, extensions;
GRANT SELECT, INSERT, UPDATE ON TABLE meta_ads."cafe24_observed_epoch_day_checkpoints" TO meta_ads_prod_runtime;
CREATE POLICY "prod_runtime_select" ON meta_ads."cafe24_observed_epoch_day_checkpoints" FOR SELECT TO meta_ads_prod_runtime USING (true);
CREATE POLICY "prod_runtime_insert" ON meta_ads."cafe24_observed_epoch_day_checkpoints" FOR INSERT TO meta_ads_prod_runtime WITH CHECK (true);
CREATE POLICY "prod_runtime_update" ON meta_ads."cafe24_observed_epoch_day_checkpoints" FOR UPDATE TO meta_ads_prod_runtime USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON TABLE meta_ads."cafe24_observed_epoch_order_revisions" TO meta_ads_prod_runtime;
CREATE POLICY "prod_runtime_select" ON meta_ads."cafe24_observed_epoch_order_revisions" FOR SELECT TO meta_ads_prod_runtime USING (true);
CREATE POLICY "prod_runtime_insert" ON meta_ads."cafe24_observed_epoch_order_revisions" FOR INSERT TO meta_ads_prod_runtime WITH CHECK (true);
CREATE POLICY "prod_runtime_update" ON meta_ads."cafe24_observed_epoch_order_revisions" FOR UPDATE TO meta_ads_prod_runtime USING (true) WITH CHECK (true);
ROLLBACK;
