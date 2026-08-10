import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const apiRoot = resolve(__dirname, "../..");
const migration = readFileSync(resolve(
  apiRoot,
  "prisma/migrations/20260810170000_add_meta_video_play_counts/migration.sql"
), "utf8");
const audit = readFileSync(resolve(apiRoot, "prisma/meta-video-play-counts-audit.sql"), "utf8");

describe("Meta video count migration", () => {
  it("adds only nullable source counts and backfills from raw JSON safely", () => {
    for (const column of [
      "video_play_3s_count",
      "video_play_25_count",
      "video_play_50_count",
      "video_play_75_count",
      "video_play_100_count"
    ]) {
      expect(migration).toContain(`ADD COLUMN "${column}" INTEGER`);
      expect(migration).toContain(`CHECK ("${column}" IS NULL OR "${column}" >= 0)`);
    }
    expect(migration).toContain(`"raw_row" ? '동영상 3초 이상 재생'`);
    expect(migration).toContain(`TRUNC(normalized."number_3s") BETWEEN 0 AND 2147483647`);
    expect(migration).toContain(`LENGTH(REPLACE("raw_3s", ',', '')) <= 32`);
    expect(migration).toContain(`TRUNC(normalized."number_3s")::integer`);
    expect(migration).not.toMatch(/ADD COLUMN[^;]*(rate|pct)/i);
    expect(migration).not.toContain(`WHERE "is_current" = true`);
  });

  it("ships preflight and post-backfill audit queries", () => {
    expect(audit).toContain("invalid_value_count");
    expect(audit).toContain("negative_value_count");
    expect(audit).toContain("rows_with_any_video_header");
    expect(audit).toContain("expected_value IS DISTINCT FROM actual_value");
  });
});
