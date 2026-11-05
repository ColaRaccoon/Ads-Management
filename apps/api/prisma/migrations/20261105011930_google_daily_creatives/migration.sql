-- Retain historical campaign versions; child facts publish atomically with the parent.
ALTER TABLE google_campaign_daily_costs ADD COLUMN creative_metrics JSONB;
