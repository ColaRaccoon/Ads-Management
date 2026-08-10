import { describe, expect, it } from "vitest";
import { aggregateMetaVideoMetrics, type MetaVideoMetricRow } from "./meta-video-metrics";

describe("aggregateMetaVideoMetrics", () => {
  it("calculates a single row without rounding", () => {
    const totals = aggregateMetaVideoMetrics([videoRow({
      reach: 84,
      videoPlay3sCount: 41,
      videoPlay25Count: 8,
      videoPlay50Count: 5,
      videoPlay75Count: 2,
      videoPlay100Count: 2
    })]);

    expect(totals).toMatchObject({
      reach: 84,
      videoPlay3sCount: 41,
      videoPlay25Count: 8,
      videoPlay50Count: 5,
      videoPlay75Count: 2,
      videoPlay100Count: 2
    });
    expect(totals.videoPlay3sRatePct).toBeCloseTo(48.80952380952381, 12);
  });

  it("uses sum(count) / sum(reach), not the mean of row rates", () => {
    const totals = aggregateMetaVideoMetrics([
      videoRow({ reach: 100, videoPlay3sCount: 50 }),
      videoRow({ reach: 20, videoPlay3sCount: 20 })
    ]);

    expect(totals.videoPlay3sCount).toBe(70);
    expect(totals.videoPlay3sRatePct).toBeCloseTo(70 / 120 * 100, 12);
    expect(totals.videoPlay3sRatePct).not.toBe(75);
  });

  it("returns zero percent for complete zero counts and null rate for zero reach", () => {
    expect(aggregateMetaVideoMetrics([videoRow({ reach: 10, videoPlay3sCount: 0 })]))
      .toMatchObject({ videoPlay3sCount: 0, videoPlay3sRatePct: 0 });
    expect(aggregateMetaVideoMetrics([videoRow({ reach: 0, videoPlay3sCount: 4 })]))
      .toMatchObject({ videoPlay3sCount: 4, videoPlay3sRatePct: null });
  });

  it("nulls only an incomplete stage when old and new rows are mixed", () => {
    const totals = aggregateMetaVideoMetrics([
      videoRow({ reach: 10, videoPlay3sCount: 5, videoPlay25Count: 2 }),
      videoRow({ reach: 20, videoPlay3sCount: 10, videoPlay25Count: null })
    ]);

    expect(totals).toMatchObject({
      reach: 30,
      videoPlay3sCount: 15,
      videoPlay3sRatePct: 50,
      videoPlay25Count: null,
      videoPlay25RatePct: null
    });
  });

  it("does not clamp rates or correct non-monotonic stages", () => {
    const totals = aggregateMetaVideoMetrics([
      videoRow({ reach: 10, videoPlay3sCount: 12, videoPlay50Count: 5, videoPlay75Count: 7 })
    ]);

    expect(totals.videoPlay3sRatePct).toBe(120);
    expect(totals.videoPlay50Count).toBe(5);
    expect(totals.videoPlay75Count).toBe(7);
  });

  it("returns an empty, unknown metric set for no rows", () => {
    expect(aggregateMetaVideoMetrics([])).toEqual({
      reach: 0,
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
    });
  });
});

function videoRow(overrides: Partial<MetaVideoMetricRow> = {}): MetaVideoMetricRow {
  return {
    reach: 0,
    videoPlay3sCount: 0,
    videoPlay25Count: 0,
    videoPlay50Count: 0,
    videoPlay75Count: 0,
    videoPlay100Count: 0,
    ...overrides
  };
}
