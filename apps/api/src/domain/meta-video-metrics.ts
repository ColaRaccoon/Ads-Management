export const META_VIDEO_PLAY_COLUMNS = [
  {
    csvColumn: "동영상 3초 이상 재생",
    countField: "videoPlay3sCount",
    rateField: "videoPlay3sRatePct"
  },
  {
    csvColumn: "동영상 25% 재생",
    countField: "videoPlay25Count",
    rateField: "videoPlay25RatePct"
  },
  {
    csvColumn: "동영상 50% 재생",
    countField: "videoPlay50Count",
    rateField: "videoPlay50RatePct"
  },
  {
    csvColumn: "동영상 75% 재생",
    countField: "videoPlay75Count",
    rateField: "videoPlay75RatePct"
  },
  {
    csvColumn: "동영상 100% 재생",
    countField: "videoPlay100Count",
    rateField: "videoPlay100RatePct"
  }
] as const;

export type MetaVideoPlayCountField = (typeof META_VIDEO_PLAY_COLUMNS)[number]["countField"];
export type MetaVideoPlayRateField = (typeof META_VIDEO_PLAY_COLUMNS)[number]["rateField"];

export type MetaVideoMetricRow = {
  reach: number;
} & Record<MetaVideoPlayCountField, number | null>;

export type MetaVideoMetricTotals = MetaVideoMetricRow & Record<MetaVideoPlayRateField, number | null>;

/**
 * Period reach is the sum of ad/day reach rows, because the source data does not
 * contain user identifiers that would allow cross-row reach deduplication.
 */
export function aggregateMetaVideoMetrics(rows: readonly MetaVideoMetricRow[]): MetaVideoMetricTotals {
  const reach = rows.reduce((sum, row) => sum + row.reach, 0);
  const totals: MetaVideoMetricTotals = {
    reach,
    videoPlay3sCount: null,
    videoPlay25Count: null,
    videoPlay50Count: null,
    videoPlay75Count: null,
    videoPlay100Count: null,
    videoPlay3sRatePct: null,
    videoPlay25RatePct: null,
    videoPlay50RatePct: null,
    videoPlay75RatePct: null,
    videoPlay100RatePct: null
  };

  for (const column of META_VIDEO_PLAY_COLUMNS) {
    const complete = rows.length > 0 && rows.every(
      (row) => row[column.countField] !== null || row.reach === 0
    );
    const count = complete
      ? rows.reduce((sum, row) => sum + (row[column.countField] ?? 0), 0)
      : null;
    totals[column.countField] = count;
    totals[column.rateField] = count === null || reach === 0 ? null : count / reach * 100;
  }

  return totals;
}
