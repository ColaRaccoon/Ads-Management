-- Add creative-level objects and change logs while preserving ad/adset import identities.

CREATE TYPE "creative_parse_status" AS ENUM ('PARSED', 'FALLBACK');

CREATE TYPE "creative_log_action_type" AS ENUM (
  'NOTE',
  'TURN_ON',
  'TURN_OFF',
  'KEEP',
  'WATCH',
  'SCALE',
  'REDUCE',
  'CREATIVE_TEST',
  'CREATIVE_EXCLUDE',
  'OTHER'
);

ALTER TABLE "meta_ads" ADD COLUMN "creative_id" UUID;

ALTER TABLE "meta_ad_daily_metrics" ADD COLUMN "creative_id" UUID;

CREATE TABLE "creatives" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'META',
    "creative_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "product_name" TEXT,
    "material_no" TEXT,
    "first_seen_on" DATE,
    "last_seen_on" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creatives_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_aliases" (
    "id" UUID NOT NULL,
    "creative_id" UUID NOT NULL,
    "original_name" TEXT NOT NULL,
    "original_key" TEXT NOT NULL,
    "date_code" TEXT,
    "setting" TEXT,
    "parse_status" "creative_parse_status" NOT NULL DEFAULT 'PARSED',
    "first_seen_on" DATE,
    "last_seen_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creative_aliases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_placements" (
    "id" UUID NOT NULL,
    "creative_id" UUID NOT NULL,
    "meta_campaign_id" TEXT NOT NULL,
    "meta_adset_id" TEXT NOT NULL,
    "meta_ad_ref_id" UUID,
    "campaign_ref_id" UUID,
    "meta_adset_ref_id" UUID,
    "campaign_name" TEXT NOT NULL,
    "adset_name" TEXT NOT NULL,
    "original_ad_name" TEXT NOT NULL,
    "setting" TEXT,
    "first_seen_on" DATE,
    "last_seen_on" DATE,
    "last_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creative_placements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_change_logs" (
    "id" UUID NOT NULL,
    "creative_id" UUID NOT NULL,
    "action_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action_type" "creative_log_action_type" NOT NULL DEFAULT 'NOTE',
    "reason" TEXT NOT NULL,
    "memo" TEXT,
    "related_adset_ids" JSONB NOT NULL DEFAULT '[]',
    "next_check_date" DATE,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creative_change_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creatives_platform_creative_key_key"
  ON "creatives"("platform", "creative_key");

CREATE INDEX "creatives_display_name_idx"
  ON "creatives"("display_name");

CREATE UNIQUE INDEX "creative_aliases_creative_id_original_key_key"
  ON "creative_aliases"("creative_id", "original_key");

CREATE INDEX "creative_aliases_original_key_idx"
  ON "creative_aliases"("original_key");

CREATE UNIQUE INDEX "creative_placements_creative_id_meta_campaign_id_meta_adset_id_original_ad_name_key"
  ON "creative_placements"("creative_id", "meta_campaign_id", "meta_adset_id", "original_ad_name");

CREATE INDEX "creative_placements_creative_id_last_seen_on_idx"
  ON "creative_placements"("creative_id", "last_seen_on");

CREATE INDEX "creative_placements_meta_campaign_id_meta_adset_id_idx"
  ON "creative_placements"("meta_campaign_id", "meta_adset_id");

CREATE INDEX "creative_change_logs_creative_id_action_date_idx"
  ON "creative_change_logs"("creative_id", "action_date");

CREATE INDEX "creative_change_logs_action_date_action_type_idx"
  ON "creative_change_logs"("action_date", "action_type");

CREATE INDEX "meta_ads_creative_id_idx"
  ON "meta_ads"("creative_id");

CREATE INDEX "meta_ad_daily_metrics_creative_id_metric_date_idx"
  ON "meta_ad_daily_metrics"("creative_id", "metric_date");

ALTER TABLE "meta_ads"
  ADD CONSTRAINT "meta_ads_creative_id_fkey"
  FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "meta_ad_daily_metrics"
  ADD CONSTRAINT "meta_ad_daily_metrics_creative_id_fkey"
  FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "creative_aliases"
  ADD CONSTRAINT "creative_aliases_creative_id_fkey"
  FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_placements"
  ADD CONSTRAINT "creative_placements_creative_id_fkey"
  FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_placements"
  ADD CONSTRAINT "creative_placements_meta_ad_ref_id_fkey"
  FOREIGN KEY ("meta_ad_ref_id") REFERENCES "meta_ads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "creative_placements"
  ADD CONSTRAINT "creative_placements_campaign_ref_id_fkey"
  FOREIGN KEY ("campaign_ref_id") REFERENCES "meta_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "creative_placements"
  ADD CONSTRAINT "creative_placements_meta_adset_ref_id_fkey"
  FOREIGN KEY ("meta_adset_ref_id") REFERENCES "meta_adsets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "creative_change_logs"
  ADD CONSTRAINT "creative_change_logs_creative_id_fkey"
  FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
