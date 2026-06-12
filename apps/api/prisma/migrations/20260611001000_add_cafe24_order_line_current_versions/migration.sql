ALTER TABLE "cafe24_order_lines"
  ADD COLUMN IF NOT EXISTS "order_line_key" TEXT;

UPDATE "cafe24_order_lines"
SET "order_line_key" = concat_ws(
  ':',
  trim(coalesce("order_no", '')),
  trim(coalesce("line_order_no", '')),
  trim(coalesce("product_no", '')),
  trim(coalesce("option_name", ''))
)
WHERE "order_line_key" IS NULL OR "order_line_key" = '';

ALTER TABLE "cafe24_order_lines"
  ALTER COLUMN "order_line_key" SET NOT NULL;

ALTER TABLE "cafe24_order_lines"
  ADD COLUMN IF NOT EXISTS "import_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "cafe24_order_lines"
  ADD COLUMN IF NOT EXISTS "is_current" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "cafe24_order_lines"
  ADD COLUMN IF NOT EXISTS "superseded_by_order_line_id" UUID;

WITH ranked AS (
  SELECT
    "id",
    "order_line_key",
    row_number() OVER (
      PARTITION BY "order_line_key"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS rn,
    count(*) OVER (PARTITION BY "order_line_key") AS version_count
  FROM "cafe24_order_lines"
  WHERE "validation_status" <> 'ERROR'
)
UPDATE "cafe24_order_lines" AS line
SET
  "is_current" = ranked.rn = 1,
  "import_version" = ranked.version_count - ranked.rn + 1
FROM ranked
WHERE ranked."id" = line."id";

UPDATE "cafe24_order_lines"
SET "is_current" = false
WHERE "validation_status" = 'ERROR';

CREATE INDEX IF NOT EXISTS "cafe24_order_lines_order_line_key_idx"
  ON "cafe24_order_lines"("order_line_key");

CREATE INDEX IF NOT EXISTS "cafe24_order_lines_order_line_key_is_current_idx"
  ON "cafe24_order_lines"("order_line_key", "is_current");

CREATE INDEX IF NOT EXISTS "cafe24_order_lines_is_current_order_date_idx"
  ON "cafe24_order_lines"("is_current", "order_date");

CREATE INDEX IF NOT EXISTS "cafe24_order_lines_superseded_by_order_line_id_idx"
  ON "cafe24_order_lines"("superseded_by_order_line_id");

CREATE UNIQUE INDEX IF NOT EXISTS "cafe24_order_lines_current_order_line_key_key"
  ON "cafe24_order_lines"("order_line_key")
  WHERE "is_current" = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cafe24_order_lines_superseded_by_order_line_id_fkey'
  ) THEN
    ALTER TABLE "cafe24_order_lines"
      ADD CONSTRAINT "cafe24_order_lines_superseded_by_order_line_id_fkey"
      FOREIGN KEY ("superseded_by_order_line_id") REFERENCES "cafe24_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
